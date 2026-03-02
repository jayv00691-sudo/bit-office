import { nanoid } from "nanoid";
import path from "path";
import type { AgentManager } from "./agent-manager.js";
import type { AgentSession } from "./agent-session.js";
import type { PromptEngine } from "./prompt-templates.js";
import type { OrchestratorEvent } from "./types.js";

const MAX_DELEGATION_DEPTH = 5;
const MAX_TOTAL_DELEGATIONS = 20;
const DELEGATION_BUDGET_ROUNDS = 5;
const HARD_CEILING_ROUNDS = 10;
// Longer batch window so parallel QA + CodeReview results arrive together in one leader round.
// If QA finishes but CodeReview is still running, wait up to 20s before flushing partial results.
const RESULT_BATCH_WINDOW_MS = 20_000;

interface PendingResult {
  fromName: string;
  statusWord: string;
  summary: string;
}

export class DelegationRouter {
  /** taskId → fromAgentId */
  private delegationOrigin = new Map<string, string>();
  /** taskId → delegation depth (how many hops from original user task) */
  private delegationDepth = new Map<string, number>();
  /** agentId → taskId of the delegated task currently assigned TO this agent */
  private assignedTask = new Map<string, string>();
  /** Total delegations in current team session (reset on clearAll) */
  private totalDelegations = 0;
  /** How many times the leader has been invoked to process results */
  private leaderRounds = 0;
  /** When true, all new delegations and result forwarding are blocked */
  private stopped = false;
  /** TaskIds created by flushResults — only these can produce a final result */
  private resultTaskIds = new Set<string>();
  /** Tracks the totalDelegations count when a resultTask started, so we can detect if new delegations were created */
  private delegationsAtResultStart = new Map<string, number>();
  /** Batch result forwarding: originAgentId → pending results + timer */
  private pendingResults = new Map<string, { results: PendingResult[]; timer: ReturnType<typeof setTimeout> }>();
  /** Team-wide project directory — all delegations use this as repoPath when set */
  private teamProjectDir: string | null = null;
  private agentManager: AgentManager;
  private promptEngine: PromptEngine;
  private emitEvent: (event: OrchestratorEvent) => void;

  constructor(
    agentManager: AgentManager,
    promptEngine: PromptEngine,
    emitEvent: (event: OrchestratorEvent) => void,
  ) {
    this.agentManager = agentManager;
    this.promptEngine = promptEngine;
    this.emitEvent = emitEvent;
  }

  /**
   * Wire delegation and result forwarding callbacks onto a session.
   */
  wireAgent(session: AgentSession): void {
    this.wireDelegation(session);
    this.wireResultForwarding(session);
  }

  /**
   * Check if a taskId was delegated (has an origin).
   */
  isDelegated(taskId: string): boolean {
    return this.delegationOrigin.has(taskId);
  }

  /**
   * True if this taskId was created by flushResults (leader processing worker results).
   * Only result-processing tasks are eligible to be marked as isFinalResult.
   */
  isResultTask(taskId: string): boolean {
    return this.resultTaskIds.has(taskId);
  }

  /**
   * True when the delegation budget is exhausted — leader should finalize even
   * if the current task is not a "resultTask" (safety net for convergence).
   */
  isBudgetExhausted(): boolean {
    return this.leaderRounds >= DELEGATION_BUDGET_ROUNDS;
  }

  /**
   * True if the given resultTask completed WITHOUT creating any new delegations.
   * This means the leader decided to summarize/finish rather than delegate more work.
   */
  resultTaskDidNotDelegate(taskId: string): boolean {
    const startCount = this.delegationsAtResultStart.get(taskId);
    if (startCount === undefined) return false;
    return this.totalDelegations === startCount;
  }

  /**
   * Check if there are any pending delegated tasks originating from a given agent.
   */
  hasPendingFrom(agentId: string): boolean {
    for (const origin of this.delegationOrigin.values()) {
      if (origin === agentId) return true;
    }
    return false;
  }

  /**
   * Remove all delegation tracking for a specific agent (on fire/cancel).
   */
  clearAgent(agentId: string): void {
    for (const [taskId, origin] of this.delegationOrigin) {
      if (origin === agentId) {
        this.delegationOrigin.delete(taskId);
        this.delegationDepth.delete(taskId);
      }
    }
  }

  /**
   * Block all future delegations and result forwarding. Call before cancelling tasks.
   */
  stop(): void {
    this.stopped = true;
    for (const pending of this.pendingResults.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingResults.clear();
  }

  /**
   * Set a team-wide project directory. All delegations will use this as repoPath.
   */
  setTeamProjectDir(dir: string | null): void {
    this.teamProjectDir = dir;
    if (dir) console.log(`[Delegation] Team project dir set: ${dir}`);
  }

  getTeamProjectDir(): string | null {
    return this.teamProjectDir;
  }

  /**
   * Reset all delegation state (on new team task).
   */
  clearAll(): void {
    this.delegationOrigin.clear();
    this.delegationDepth.clear();
    this.assignedTask.clear();
    this.resultTaskIds.clear();
    this.delegationsAtResultStart.clear();
    this.totalDelegations = 0;
    this.leaderRounds = 0;
    this.stopped = false;
    this.teamProjectDir = null;
    for (const pending of this.pendingResults.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingResults.clear();
  }

  private wireDelegation(session: AgentSession): void {
    session.onDelegation = (fromAgentId, targetName, prompt) => {
      if (this.stopped) return;

      // Block delegation in conversational phases (create, design, complete)
      const phaseCheckSession = this.agentManager.get(fromAgentId);
      if (phaseCheckSession?.currentPhase && phaseCheckSession.currentPhase !== "execute") {
        console.log(`[Delegation] BLOCKED: agent ${fromAgentId} is in phase "${phaseCheckSession.currentPhase}", not "execute"`);
        return;
      }

      if (this.leaderRounds >= DELEGATION_BUDGET_ROUNDS) {
        console.log(`[Delegation] BLOCKED: delegation budget exhausted (round ${this.leaderRounds}/${DELEGATION_BUDGET_ROUNDS})`);
        return;
      }

      const target = this.agentManager.findByName(targetName);
      if (!target) {
        console.log(`[Delegation] Target agent "${targetName}" not found, ignoring`);
        return;
      }

      if (this.totalDelegations >= MAX_TOTAL_DELEGATIONS) {
        console.log(`[Delegation] BLOCKED: total delegation limit (${MAX_TOTAL_DELEGATIONS}) reached`);
        this.emitEvent({
          type: "team:chat",
          fromAgentId,
          message: `Delegation blocked: total limit of ${MAX_TOTAL_DELEGATIONS} delegations reached. Summarize current results for the user.`,
          messageType: "status",
          timestamp: Date.now(),
        });
        return;
      }

      const myTaskId = this.assignedTask.get(fromAgentId);
      const parentDepth = myTaskId ? (this.delegationDepth.get(myTaskId) ?? 0) : 0;
      const newDepth = parentDepth + 1;

      if (newDepth > MAX_DELEGATION_DEPTH) {
        console.log(`[Delegation] BLOCKED: depth ${newDepth} exceeds max ${MAX_DELEGATION_DEPTH}`);
        this.emitEvent({
          type: "team:chat",
          fromAgentId,
          message: `Delegation blocked: chain depth (${newDepth}) exceeds limit. Complete current work directly.`,
          messageType: "status",
          timestamp: Date.now(),
        });
        return;
      }

      const taskId = nanoid();
      this.delegationOrigin.set(taskId, fromAgentId);
      this.delegationDepth.set(taskId, newDepth);
      this.totalDelegations++;
      const fromSession = this.agentManager.get(fromAgentId);
      const fromName = fromSession?.name ?? fromAgentId;
      const fromRole = fromSession?.role ?? "Team Lead";

      // Use team project dir if set (created by gateway on APPROVE_PLAN);
      // otherwise fall back to parsing [project-dir] from the delegation prompt.
      let repoPath: string | undefined = this.teamProjectDir ?? undefined;
      let cleanPrompt = prompt;
      const dirMatch = prompt.match(/^\s*\[([^\]]+)\]\s*/);
      if (dirMatch) {
        // Strip [project-dir] prefix from prompt even if we don't use it for repoPath
        cleanPrompt = prompt.slice(dirMatch[0].length);
        if (!repoPath) {
          const dirPart = dirMatch[1].replace(/\/$/, "");
          const leaderSession = this.agentManager.get(fromAgentId);
          if (leaderSession) {
            repoPath = path.resolve(leaderSession.workspaceDir, dirPart);
          }
        }
      }

      const fullPrompt = this.promptEngine.render("delegation-prefix", { fromName, fromRole, prompt: cleanPrompt });

      console.log(`[Delegation] ${fromAgentId} -> ${target.agentId} (${targetName}) depth=${newDepth} total=${this.totalDelegations} repoPath=${repoPath ?? "default"}: ${cleanPrompt.slice(0, 80)}`);
      this.emitEvent({
        type: "task:delegated",
        fromAgentId,
        toAgentId: target.agentId,
        taskId,
        prompt: cleanPrompt,
      });
      this.emitEvent({
        type: "team:chat",
        fromAgentId,
        toAgentId: target.agentId,
        message: prompt,
        messageType: "delegation",
        taskId,
        timestamp: Date.now(),
      });
      this.assignedTask.set(target.agentId, taskId);
      target.runTask(taskId, fullPrompt, repoPath);
    };
  }

  private wireResultForwarding(session: AgentSession): void {
    session.onTaskComplete = (agentId, taskId, summary, success) => {
      if (this.stopped) return;

      const originAgentId = this.delegationOrigin.get(taskId);
      if (!originAgentId) return;
      this.delegationOrigin.delete(taskId);
      this.delegationDepth.delete(taskId);
      if (this.assignedTask.get(agentId) === taskId) {
        this.assignedTask.delete(agentId);
      }

      const originSession = this.agentManager.get(originAgentId);
      if (!originSession) return;

      const fromSession = this.agentManager.get(agentId);
      const fromName = fromSession?.name ?? agentId;
      const statusWord = success ? "completed successfully" : "failed";

      console.log(`[ResultForward] ${agentId} -> ${originAgentId}: ${summary.slice(0, 80)} (success=${success})`);

      this.emitEvent({
        type: "task:result-returned",
        fromAgentId: agentId,
        toAgentId: originAgentId,
        taskId,
        summary,
        success,
      });

      this.emitEvent({
        type: "team:chat",
        fromAgentId: agentId,
        toAgentId: originAgentId,
        message: summary.slice(0, 400),
        messageType: "result",
        taskId,
        timestamp: Date.now(),
      });

      // Batch results: accumulate and flush to leader after a short window
      this.enqueueResult(originAgentId, { fromName, statusWord, summary: summary.slice(0, 400) });
    };
  }

  /**
   * Queue a result for batched forwarding to the origin agent.
   * Flush only when ALL delegated tasks from this origin have returned.
   * The timer is a safety net — if a worker somehow disappears without returning,
   * we don't want the leader to wait forever.
   */
  private enqueueResult(originAgentId: string, result: PendingResult): void {
    let pending = this.pendingResults.get(originAgentId);
    if (pending) {
      clearTimeout(pending.timer);
      pending.results.push(result);
    } else {
      pending = { results: [result], timer: null as unknown as ReturnType<typeof setTimeout> };
      this.pendingResults.set(originAgentId, pending);
    }

    // Flush when ALL delegated tasks have returned — no more guessing with timers
    if (!this.hasPendingFrom(originAgentId)) {
      console.log(`[ResultBatch] All delegated tasks returned for ${originAgentId}, flushing ${pending.results.length} result(s)`);
      this.flushResults(originAgentId);
      return;
    }

    // Safety net: if a worker is still running after the timeout, flush what we have
    // so the leader isn't blocked forever by a hung worker
    console.log(`[ResultBatch] ${originAgentId} still has pending delegations, waiting (safety timeout: ${RESULT_BATCH_WINDOW_MS / 1000}s)`);
    pending.timer = setTimeout(() => {
      console.log(`[ResultBatch] Safety timeout reached for ${originAgentId}, flushing ${pending.results.length} partial result(s)`);
      this.flushResults(originAgentId);
    }, RESULT_BATCH_WINDOW_MS);
  }

  /** Flush all pending results for an origin agent as a single leader prompt. */
  private flushResults(originAgentId: string): void {
    if (this.stopped) return;

    const pending = this.pendingResults.get(originAgentId);
    if (!pending || pending.results.length === 0) return;
    this.pendingResults.delete(originAgentId);
    clearTimeout(pending.timer);

    const originSession = this.agentManager.get(originAgentId);
    if (!originSession) return;

    this.leaderRounds++;

    // Hard ceiling: force-complete instead of silently returning
    if (this.leaderRounds > HARD_CEILING_ROUNDS) {
      console.log(`[ResultBatch] Hard ceiling reached (${HARD_CEILING_ROUNDS} rounds). Force-completing.`);

      const resultLines = pending.results.map(r =>
        `- ${r.fromName} (${r.statusWord}): ${r.summary}`
      ).join("\n");

      this.emitEvent({
        type: "team:chat",
        fromAgentId: originAgentId,
        message: `Team work auto-completed after ${HARD_CEILING_ROUNDS} rounds.`,
        messageType: "status",
        timestamp: Date.now(),
      });

      // Emit a synthetic task:done so the UI gets a proper final result
      this.emitEvent({
        type: "task:done",
        agentId: originAgentId,
        taskId: `auto-complete-${Date.now()}`,
        result: {
          summary: `Auto-completed after ${HARD_CEILING_ROUNDS} rounds.\n${resultLines}`,
          changedFiles: [],
          diffStat: "",
          testResult: "unknown" as const,
        },
        isFinalResult: true,
      });
      return;
    }

    // Build round guidance for the leader prompt
    let roundInfo: string;
    const budgetExhausted = this.leaderRounds >= DELEGATION_BUDGET_ROUNDS;
    if (budgetExhausted) {
      roundInfo = `DELEGATION BUDGET REACHED (round ${this.leaderRounds}). No more delegations will be accepted. You MUST summarize the current results and report to the user NOW. Accept the work as-is — the user can request improvements later.`;
    } else if (this.leaderRounds >= DELEGATION_BUDGET_ROUNDS - 1) {
      roundInfo = `Round ${this.leaderRounds}/${DELEGATION_BUDGET_ROUNDS} — LAST delegation round. Only delegate if something is critically broken. Prefer to accept and summarize.`;
    } else {
      roundInfo = `Round ${this.leaderRounds}/${DELEGATION_BUDGET_ROUNDS}`;
    }

    const resultLines = pending.results.map(r =>
      `- ${r.fromName} (${r.statusWord}): ${r.summary}`
    ).join("\n\n");

    const followUpTaskId = nanoid();
    this.resultTaskIds.add(followUpTaskId);
    this.delegationsAtResultStart.set(followUpTaskId, this.totalDelegations);
    const teamContext = this.agentManager.isTeamLead(originAgentId)
      ? this.agentManager.getTeamRoster()
      : undefined;

    const batchPrompt = this.promptEngine.render("leader-result", {
      fromName: pending.results.length === 1
        ? pending.results[0].fromName
        : `${pending.results.length} team members`,
      resultStatus: pending.results.every(r => r.statusWord.includes("success"))
        ? "completed successfully"
        : "mixed results",
      resultSummary: resultLines,
      originalTask: originSession.originalTask ?? "",
      roundInfo,
    });

    console.log(`[ResultBatch] Flushing ${pending.results.length} result(s) to ${originAgentId} (round ${this.leaderRounds}, budget=${DELEGATION_BUDGET_ROUNDS}, ceiling=${HARD_CEILING_ROUNDS})`);
    originSession.runTask(followUpTaskId, batchPrompt, undefined, teamContext);
  }
}
