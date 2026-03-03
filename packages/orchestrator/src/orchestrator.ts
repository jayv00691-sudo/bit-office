import { EventEmitter } from "events";
import { existsSync } from "fs";
import path from "path";
import { nanoid } from "nanoid";
import { AgentSession } from "./agent-session.js";
import { AgentManager } from "./agent-manager.js";
import { DelegationRouter } from "./delegation.js";
import { PromptEngine } from "./prompt-templates.js";
import { previewServer } from "./preview-server.js";
import { RetryTracker } from "./retry.js";
import { createWorktree, mergeWorktree, removeWorktree } from "./worktree.js";
import type { AIBackend } from "./ai-backend.js";
import type {
  OrchestratorOptions,
  CreateAgentOpts,
  CreateTeamOpts,
  RunTaskOpts,
  OrchestratorEvent,
  OrchestratorEventMap,
  Decision,
} from "./types.js";

export class Orchestrator extends EventEmitter<OrchestratorEventMap> {
  private agentManager = new AgentManager();
  private delegationRouter: DelegationRouter;
  private promptEngine: PromptEngine;
  private retryTracker: RetryTracker | null;
  private backends = new Map<string, AIBackend>();
  private defaultBackendId: string;
  private workspace: string;
  private sandboxMode: "full" | "safe";
  private worktreeEnabled: boolean;
  private worktreeMerge: boolean;
  /** Preview info captured from the first dev worker that produces one — not from QA/reviewer */
  private teamPreview: { previewUrl?: string; previewPath?: string; entryFile?: string; previewCmd?: string; previewPort?: number } | null = null;
  /** Accumulated changedFiles from all workers in the current team session */
  private teamChangedFiles = new Set<string>();
  /** Guard against emitting isFinalResult more than once per execute cycle. */
  private teamFinalized = false;

  constructor(opts: OrchestratorOptions) {
    super();
    this.workspace = opts.workspace;
    this.sandboxMode = opts.sandboxMode ?? "full";

    // Register backends
    for (const b of opts.backends) {
      this.backends.set(b.id, b);
    }
    this.defaultBackendId = opts.defaultBackend ?? opts.backends[0]?.id ?? "claude";

    // Prompt engine
    this.promptEngine = new PromptEngine(opts.promptsDir);
    this.promptEngine.init();

    // Delegation
    this.delegationRouter = new DelegationRouter(
      this.agentManager,
      this.promptEngine,
      (e) => this.emitEvent(e),
    );

    // Retry
    if (opts.retry === false) {
      this.retryTracker = null;
    } else {
      const r = opts.retry ?? {};
      this.retryTracker = new RetryTracker(r.maxRetries, r.escalateToLeader);
    }

    // Worktree
    if (opts.worktree === false) {
      this.worktreeEnabled = false;
      this.worktreeMerge = false;
    } else {
      this.worktreeEnabled = true;
      this.worktreeMerge = opts.worktree?.mergeOnComplete ?? true;
    }
  }

  // ---------------------------------------------------------------------------
  // Agent lifecycle
  // ---------------------------------------------------------------------------

  createAgent(opts: CreateAgentOpts): void {
    const backend = this.backends.get(opts.backend ?? this.defaultBackendId)
      ?? this.backends.get(this.defaultBackendId)!;

    const session = new AgentSession({
      agentId: opts.agentId,
      name: opts.name,
      role: opts.role,
      personality: opts.personality,
      workspace: this.workspace,
      resumeHistory: opts.resumeHistory,
      backend,
      sandboxMode: this.sandboxMode,
      isTeamLead: this.agentManager.isTeamLead(opts.agentId),
      teamId: opts.teamId,
      onEvent: (e) => this.handleSessionEvent(e, opts.agentId),
      renderPrompt: (name, vars) => this.promptEngine.render(name, vars),
    });
    session.palette = opts.palette;

    this.agentManager.add(session);
    this.delegationRouter.wireAgent(session);

    this.emitEvent({
      type: "agent:created",
      agentId: opts.agentId,
      name: opts.name,
      role: opts.role,
      palette: opts.palette,
      personality: opts.personality,
      backend: backend.id,
      isTeamLead: this.agentManager.isTeamLead(opts.agentId),
      teamId: opts.teamId,
    });
    this.emitEvent({
      type: "agent:status",
      agentId: opts.agentId,
      status: "idle",
    });
  }

  removeAgent(agentId: string): void {
    this.cancelTask(agentId);
    this.delegationRouter.clearAgent(agentId);
    this.agentManager.delete(agentId);
    this.emitEvent({ type: "agent:fired", agentId });
  }

  setTeamLead(agentId: string): void {
    this.agentManager.setTeamLead(agentId);
    // Update the session's isTeamLead flag
    const session = this.agentManager.get(agentId);
    if (session) session.isTeamLead = true;
  }

  createTeam(opts: CreateTeamOpts): void {
    const presets = [
      { ...opts.memberPresets[opts.leadPresetIndex] ?? opts.memberPresets[0], isLead: true },
      ...opts.memberPresets.filter((_, i) => i !== opts.leadPresetIndex).map(p => ({ ...p, isLead: false })),
    ];

    let leadAgentId: string | null = null;

    for (const preset of presets) {
      const agentId = `agent-${nanoid(6)}`;
      const backendId = opts.backends?.[String(opts.memberPresets.indexOf(preset))] ?? this.defaultBackendId;

      this.createAgent({
        agentId,
        name: preset.name,
        role: preset.role,
        personality: preset.personality,
        palette: preset.palette,
        backend: backendId,
      });

      if ((preset as { isLead: boolean }).isLead) {
        leadAgentId = agentId;
        this.agentManager.setTeamLead(agentId);
      }
    }

    if (leadAgentId) {
      this.emitEvent({
        type: "team:chat",
        fromAgentId: leadAgentId,
        message: `Team created! ${presets.length} members ready.`,
        messageType: "status",
        timestamp: Date.now(),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Task execution
  // ---------------------------------------------------------------------------

  runTask(agentId: string, taskId: string, prompt: string, opts?: RunTaskOpts): void {
    const session = this.agentManager.get(agentId);
    if (!session) {
      this.emitEvent({
        type: "task:failed",
        agentId,
        taskId,
        error: "Agent not found. Create it first.",
      });
      return;
    }

    // User-initiated task on team lead: store original task + reset delegation counters
    if (this.agentManager.isTeamLead(agentId) && !this.delegationRouter.isDelegated(taskId)) {
      // Don't overwrite originalTask if it was pre-set (e.g. plan captured during create→design, or approved plan before execute)
      // In design/complete phases, originalTask holds the plan — user feedback is just the prompt, not a replacement.
      if (!session.originalTask || !opts?.phaseOverride || (opts.phaseOverride !== "execute" && opts.phaseOverride !== "design" && opts.phaseOverride !== "complete")) {
        session.originalTask = prompt;
      }
      // Preserve team project dir across execute cycles (set by gateway before runTask)
      const savedProjectDir = this.delegationRouter.getTeamProjectDir();
      this.delegationRouter.clearAll();
      if (savedProjectDir) this.delegationRouter.setTeamProjectDir(savedProjectDir);
      this.teamPreview = null;
      this.teamChangedFiles.clear();
      this.teamFinalized = false;
    }

    // Track for retry
    this.retryTracker?.track(taskId, prompt);

    // Worktree setup
    if (this.worktreeEnabled && !session.worktreePath) {
      const wt = createWorktree(this.workspace, agentId, taskId, session.name);
      if (wt) {
        const branch = `agent/${session.name.toLowerCase().replace(/\s+/g, "-")}/${taskId}`;
        session.worktreePath = wt;
        session.worktreeBranch = branch;
        this.emitEvent({
          type: "worktree:created",
          agentId,
          taskId,
          worktreePath: wt,
          branch,
        });
      }
    }

    const repoPath = session.worktreePath ?? opts?.repoPath;
    // Only the team lead gets the full roster (to decide delegation).
    // Workers don't need it — they just do their assigned task.
    const teamContext = this.agentManager.isTeamLead(agentId)
      ? this.agentManager.getTeamRoster()
      : undefined;

    session.runTask(taskId, prompt, repoPath, teamContext, true /* isUserInitiated */, opts?.phaseOverride);
  }

  cancelTask(agentId: string): void {
    const session = this.agentManager.get(agentId);
    if (!session) return;

    // Clean up worktree on cancel
    if (session.worktreePath && session.worktreeBranch) {
      removeWorktree(session.worktreePath, session.worktreeBranch, this.workspace);
      session.worktreePath = null;
      session.worktreeBranch = null;
    }

    session.cancelTask();
  }

  /**
   * Stop all team agents — cancel their tasks but keep them alive.
   * Safe to call before fireTeam, or to just pause work.
   */
  stopTeam(): void {
    this.delegationRouter.stop();
    const teamAgents = this.agentManager.getAll().filter(a => !!a.teamId);
    for (const agent of teamAgents) {
      this.cancelTask(agent.agentId);
    }
    this.emitEvent({
      type: "team:chat",
      fromAgentId: teamAgents.find(a => this.agentManager.isTeamLead(a.agentId))?.agentId ?? "system",
      message: "Team work stopped. All tasks cancelled.",
      messageType: "status",
      timestamp: Date.now(),
    });
  }

  /**
   * Fire the entire team — stop all work silently, then remove all agents.
   */
  fireTeam(): void {
    this.delegationRouter.stop();
    const teamAgents = this.agentManager.getAll().filter(a => !!a.teamId);
    for (const agent of teamAgents) {
      this.cancelTask(agent.agentId);
    }
    for (const agent of teamAgents) {
      this.agentManager.delete(agent.agentId);
      this.emitEvent({ type: "agent:fired", agentId: agent.agentId });
    }
  }

  sendMessage(agentId: string, message: string): boolean {
    const session = this.agentManager.get(agentId);
    if (!session) return false;
    return session.sendMessage(message);
  }

  resolveApproval(approvalId: string, decision: Decision): void {
    for (const agent of this.agentManager.getAll()) {
      agent.resolveApproval(approvalId, decision);
    }
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  getAgent(agentId: string) {
    const s = this.agentManager.get(agentId);
    if (!s) return undefined;
    return { agentId: s.agentId, name: s.name, role: s.role, status: s.status, palette: s.palette, backend: s.backend.id, pid: s.pid };
  }

  getAllAgents() {
    return this.agentManager.getAll().map(s => ({
      agentId: s.agentId, name: s.name, role: s.role, status: s.status,
      palette: s.palette, backend: s.backend.id, pid: s.pid,
      isTeamLead: this.agentManager.isTeamLead(s.agentId),
      teamId: s.teamId,
    }));
  }

  getTeamRoster(): string {
    return this.agentManager.getTeamRoster();
  }

  /** Return PIDs of all managed (gateway-spawned) agent processes */
  getManagedPids(): number[] {
    const pids: number[] = [];
    for (const session of this.agentManager.getAll()) {
      const pid = session.pid;
      if (pid !== null) pids.push(pid);
    }
    return pids;
  }

  isTeamLead(agentId: string): boolean {
    return this.agentManager.isTeamLead(agentId);
  }

  /** Get the leader's last full output (used to capture the approved plan). */
  getLeaderLastOutput(agentId: string): string | null {
    const session = this.agentManager.get(agentId);
    return session?.lastFullOutput ?? null;
  }

  /** Set team-wide project directory — all delegations will use this as cwd. */
  setTeamProjectDir(dir: string | null): void {
    this.delegationRouter.setTeamProjectDir(dir);
  }

  getTeamProjectDir(): string | null {
    return this.delegationRouter.getTeamProjectDir();
  }

  /** Set the original task context for the leader (e.g. the approved plan). */
  setOriginalTask(agentId: string, task: string): void {
    const session = this.agentManager.get(agentId);
    if (session) session.originalTask = task;
  }

  /** Clear ALL team members' conversation history for a fresh project cycle. */
  clearLeaderHistory(agentId: string): void {
    const session = this.agentManager.get(agentId);
    if (session) {
      // Clear leader
      session.clearHistory();
      // Clear ALL team members (workers keep stale session IDs from previous project)
      for (const agent of this.agentManager.getAll()) {
        if (agent.agentId !== agentId) {
          agent.clearHistory();
        }
      }
      this.delegationRouter.clearAll();
      this.teamPreview = null;
      this.teamChangedFiles.clear();
      this.teamFinalized = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  destroy(): void {
    for (const agent of this.agentManager.getAll()) {
      if (agent.worktreePath && agent.worktreeBranch) {
        removeWorktree(agent.worktreePath, agent.worktreeBranch, this.workspace);
      }
      agent.destroy();
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private handleSessionEvent(event: OrchestratorEvent, agentId: string): void {
    // Handle retry logic on task failure (skip if timeout — retrying won't help)
    if (event.type === "task:failed" && this.retryTracker) {
      const taskId = event.taskId;
      const session = this.agentManager.get(agentId);
      const wasCancelled = event.error === "Task cancelled by user";
      const wasTimeout = session?.wasTimeout ?? false;
      if (!wasCancelled && !wasTimeout && this.retryTracker.shouldRetry(taskId) && !this.delegationRouter.isDelegated(taskId)) {
        const state = this.retryTracker.recordAttempt(taskId, event.error);
        if (state) {
          this.emitEvent({
            type: "task:retrying",
            agentId,
            taskId,
            attempt: state.attempt,
            maxRetries: state.maxRetries,
            error: event.error,
          });
          const retryPrompt = this.retryTracker.getRetryPrompt(taskId);
          if (retryPrompt) {
            const session = this.agentManager.get(agentId);
            if (session) {
              setTimeout(() => session.runTask(taskId, retryPrompt), 500);
              return; // Don't emit the task:failed — we're retrying
            }
          }
        }
      }

      // Retries exhausted — check for escalation (skip on cancel)
      const escalation = wasCancelled ? null : this.retryTracker.getEscalation(taskId);
      if (escalation) {
        const leadId = this.agentManager.getTeamLead();
        if (leadId && leadId !== agentId) {
          const leadSession = this.agentManager.get(leadId);
          if (leadSession) {
            const escalationTaskId = nanoid();
            const teamContext = this.agentManager.getTeamRoster();
            leadSession.runTask(escalationTaskId, escalation.prompt, undefined, teamContext);
          }
        }
      }
      this.retryTracker.clear(taskId);
    }

    // Handle worktree merge on task completion
    if (event.type === "task:done") {
      const session = this.agentManager.get(agentId);
      if (session?.worktreePath && session.worktreeBranch) {
        if (this.worktreeMerge) {
          const result = mergeWorktree(this.workspace, session.worktreePath, session.worktreeBranch);
          this.emitEvent({
            type: "worktree:merged",
            agentId,
            taskId: event.taskId,
            branch: session.worktreeBranch,
            success: result.success,
            conflictFiles: result.conflictFiles,
          });
        } else {
          removeWorktree(session.worktreePath, session.worktreeBranch, this.workspace);
        }
        session.worktreePath = null;
        session.worktreeBranch = null;
      }

      this.retryTracker?.clear(event.taskId);

      // Accumulate changedFiles from all workers (not leader, not QA/reviewer)
      if (!this.agentManager.isTeamLead(agentId) && event.result?.changedFiles) {
        for (const f of event.result.changedFiles) {
          this.teamChangedFiles.add(f);
        }
      }

      // Capture preview fields from dev workers (not reviewer, not leader).
      // These are the ground truth — the worker created the actual files.
      // Always update — later fix iterations may produce a newer/fixed build.
      if (!this.agentManager.isTeamLead(agentId)) {
        const role = session?.role?.toLowerCase() ?? "";
        const isDevWorker = !role.includes("review");
        if (isDevWorker && event.result && (event.result.previewUrl || event.result.entryFile || event.result.previewCmd)) {
          this.teamPreview = {
            previewUrl: event.result.previewUrl,
            previewPath: event.result.previewPath,
            entryFile: event.result.entryFile,
            previewCmd: event.result.previewCmd,
            previewPort: event.result.previewPort,
          };
          console.log(`[Orchestrator] Preview captured from ${session?.name}: url=${this.teamPreview.previewUrl}, entry=${this.teamPreview.entryFile}, cmd=${this.teamPreview.previewCmd}`);
        }
      }

      // For team leaders: determine if this is the final result.
      if (this.agentManager.isTeamLead(agentId)) {
        const isResultTask = this.delegationRouter.isResultTask(event.taskId);

        // Did the leader process results WITHOUT creating new delegations?
        // This uses a delegation counter snapshot, not hasPendingFrom (which is
        // polluted by old/straggler workers still running from previous rounds).
        const leaderDidNotDelegateNewWork = isResultTask
          && this.delegationRouter.resultTaskDidNotDelegate(event.taskId);

        // Safety net: budget exhausted and no new delegations pending
        const budgetForced = this.delegationRouter.isBudgetExhausted()
          && !this.delegationRouter.hasPendingFrom(agentId);

        // Don't finalize if any worker is still actively working (safety timeout may have
        // flushed partial results while QA/reviewer is still running)
        const hasWorkingWorkers = this.agentManager.getAll().some(w =>
          w.agentId !== agentId && w.status === "working"
        );
        if (hasWorkingWorkers && !budgetForced) {
          console.log(`[Orchestrator] Deferring finalization — workers still running`);
        }
        const shouldFinalize = (leaderDidNotDelegateNewWork || budgetForced) && !this.teamFinalized && (!hasWorkingWorkers || budgetForced);

        if (shouldFinalize) {
          this.teamFinalized = true;
          event.isFinalResult = true;

          // Clear any straggler delegations so they don't restart the leader later
          this.delegationRouter.clearAgent(agentId);

          // Merge accumulated worker changedFiles into the leader's final result
          if (event.result && this.teamChangedFiles.size > 0) {
            const merged = new Set(event.result.changedFiles ?? []);
            for (const f of this.teamChangedFiles) merged.add(f);
            event.result.changedFiles = Array.from(merged);
          }

          // Always inject the correct project directory — leader's self-reported PROJECT_DIR is unreliable
          if (event.result) {
            const teamDir = this.delegationRouter.getTeamProjectDir();
            if (teamDir) {
              event.result.projectDir = teamDir;
            }
          }

          // Use preview fields captured from dev workers — these are ground truth.
          // Worker created the actual files, so its fields are always more reliable than the leader's.
          if (this.teamPreview && event.result) {
            if (this.teamPreview.previewUrl) {
              event.result.previewUrl = this.teamPreview.previewUrl;
              event.result.previewPath = this.teamPreview.previewPath;
            }
            // Always prefer worker's entry/cmd/port over leader's (leader often hallucinates filenames)
            if (this.teamPreview.entryFile) event.result.entryFile = this.teamPreview.entryFile;
            if (this.teamPreview.previewCmd) event.result.previewCmd = this.teamPreview.previewCmd;
            if (this.teamPreview.previewPort) event.result.previewPort = this.teamPreview.previewPort;
          }

          // Validate entryFile against disk — agents (both dev and leader) often hallucinate filenames.
          // changedFiles is ground truth because it comes from actual file operations.
          if (event.result?.entryFile) {
            const projectDir = this.delegationRouter.getTeamProjectDir() ?? this.workspace;
            const absEntry = path.isAbsolute(event.result.entryFile)
              ? event.result.entryFile
              : path.join(projectDir, event.result.entryFile);
            if (!existsSync(absEntry)) {
              const allFiles = event.result.changedFiles ?? [];
              const ext = path.extname(event.result.entryFile).toLowerCase();
              const candidate = allFiles
                .map(f => path.basename(f))
                .find(f => path.extname(f).toLowerCase() === ext);
              if (candidate) {
                console.log(`[Orchestrator] entryFile "${event.result.entryFile}" not found on disk, using "${candidate}" from changedFiles`);
                event.result.entryFile = candidate;
              } else {
                console.log(`[Orchestrator] entryFile "${event.result.entryFile}" not found on disk, clearing`);
                event.result.entryFile = undefined;
              }
            }
          }

          // Auto-construct previewCmd for non-HTML entryFile if no previewCmd was provided
          if (event.result?.entryFile && !event.result.previewCmd && !/\.html?$/i.test(event.result.entryFile)) {
            const ext = path.extname(event.result.entryFile).toLowerCase();
            const runners: Record<string, string> = { ".py": "python3", ".js": "node", ".rb": "ruby", ".sh": "bash" };
            const runner = runners[ext];
            if (runner) {
              event.result.previewCmd = `${runner} ${event.result.entryFile}`;
              console.log(`[Orchestrator] Auto-constructed previewCmd: ${event.result.previewCmd}`);
            }
          }

          // Fallback: no dev worker had a preview — scan all workers' changedFiles for .html
          if (!event.result?.previewUrl && event.result) {
            for (const worker of this.agentManager.getAll()) {
              if (worker.agentId === agentId) continue;
              const { previewUrl, previewPath } = worker.detectPreview();
              if (previewUrl) {
                event.result.previewUrl = previewUrl;
                event.result.previewPath = previewPath;
                break;
              }
            }
          }

          // Fallback: leader's PREVIEW_CMD
          if (!event.result?.previewUrl && event.result?.previewCmd) {
            const projectDir = this.delegationRouter.getTeamProjectDir() ?? this.workspace;
            if (event.result.previewPort) {
              // Web server: run command, proxy via port
              const url = previewServer.runCommand(event.result.previewCmd, projectDir, event.result.previewPort);
              if (url) {
                event.result.previewUrl = url;
                console.log(`[Orchestrator] Preview from leader PREVIEW_CMD (port ${event.result.previewPort}): ${url}`);
              }
            } else {
              // Desktop/CLI app: don't auto-launch — user clicks Launch button on the frontend
              console.log(`[Orchestrator] Desktop app ready (user can Launch): ${event.result.previewCmd}`);
            }
          }

          // Fallback: leader's ENTRY_FILE
          if (!event.result?.previewUrl && event.result?.entryFile) {
            const entryFile = event.result.entryFile;
            const projectDir = this.delegationRouter.getTeamProjectDir() ?? this.workspace;
            if (/\.html?$/i.test(entryFile)) {
              // Static HTML: serve via file server
              const absPath = path.isAbsolute(entryFile)
                ? entryFile
                : path.join(projectDir, entryFile);
              const url = previewServer.serve(absPath);
              if (url) {
                event.result.previewUrl = url;
                event.result.previewPath = absPath;
                console.log(`[Orchestrator] Preview from leader ENTRY_FILE: ${url}`);
              }
            }
            // Non-HTML entry file: don't auto-launch — user clicks Launch button
          }

          // Fallback: scan accumulated changedFiles for .html
          if (!event.result?.previewUrl && event.result && this.teamChangedFiles.size > 0) {
            const projectDir = this.delegationRouter.getTeamProjectDir() ?? this.workspace;
            const htmlFile = Array.from(this.teamChangedFiles).find(f => /\.html?$/i.test(f));
            if (htmlFile) {
              const absPath = path.isAbsolute(htmlFile) ? htmlFile : path.join(projectDir, htmlFile);
              const url = previewServer.serve(absPath);
              if (url) {
                event.result.previewUrl = url;
                event.result.previewPath = absPath;
                console.log(`[Orchestrator] Preview from teamChangedFiles: ${url}`);
              }
            }
          }

          // Last resort: scan project directory for common build output (Vite, CRA, etc.)
          // Only scan if we have a specific project directory — never scan the entire workspace root
          if (!event.result?.previewUrl && event.result) {
            const projectDir = this.delegationRouter.getTeamProjectDir();
            if (projectDir) {
              const candidates = [
                "dist/index.html", "build/index.html", "out/index.html",   // common build dirs
                "index.html", "public/index.html",                          // static projects
              ];
              for (const candidate of candidates) {
                const absPath = path.join(projectDir, candidate);
                if (existsSync(absPath)) {
                  const url = previewServer.serve(absPath);
                  if (url) {
                    event.result.previewUrl = url;
                    event.result.previewPath = absPath;
                    console.log(`[Orchestrator] Preview from project scan: ${absPath}`);
                    break;
                  }
                }
              }
            }
          }

          const summary = event.result?.summary?.slice(0, 200) ?? "All tasks completed.";
          this.emitEvent({
            type: "team:chat",
            fromAgentId: agentId,
            message: `Project complete: ${summary}`,
            messageType: "status",
            timestamp: Date.now(),
          });
        } else if (!isResultTask && !this.delegationRouter.hasPendingFrom(agentId)) {
          console.warn(`[Orchestrator] Leader ${agentId} completed initial task with no delegations. Output may have failed to parse.`);
        }
      }
    }

    // Handle worktree cleanup on task failure (after retry logic)
    if (event.type === "task:failed") {
      const session = this.agentManager.get(agentId);
      if (session?.worktreePath && session.worktreeBranch) {
        removeWorktree(session.worktreePath, session.worktreeBranch, this.workspace);
        session.worktreePath = null;
        session.worktreeBranch = null;
      }
    }

    this.emitEvent(event);
  }

  private emitEvent(event: OrchestratorEvent): void {
    this.emit(event.type, event as never);
  }
}
