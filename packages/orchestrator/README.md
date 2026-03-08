# @bit-office/orchestrator

Multi-agent team collaboration engine. Manages agent lifecycles, task delegation, phase transitions, preview detection, and result finalization — all behind a typed event-driven API.

## Architecture

```
                        +-----------------------+
                        |    Orchestrator        |
                        |  (EventEmitter)        |
                        +-----------+-----------+
                                    |
          +------------+------------+------------+------------+
          |            |            |            |            |
   AgentManager  DelegationRouter PhaseMachine ResultFinalizer PreviewResolver
   (sessions)    (task routing)   (phases)     (team merge)   (URL resolve)
          |            |
     AgentSession  PromptEngine
     (process mgr) (templates)
```

**Key design decisions:**
- Orchestrator is a **pure logic library** — no I/O, no HTTP, no persistence. The consumer (gateway) handles all external concerns.
- All communication via **typed events** (`EventEmitter<OrchestratorEventMap>`). The consumer subscribes and forwards to its own transport (WebSocket, Ably, etc.).
- **AI-backend agnostic** — any CLI that accepts a prompt and outputs text can be wrapped as an `AIBackend`.

## Module Map

```
src/
  orchestrator.ts      670 lines  Core engine: lifecycle, events, finalization trigger
  agent-session.ts     710 lines  Process management: spawn, stream parse, timeout
  delegation.ts        440 lines  Task routing: depth/budget limits, result batching
  prompt-templates.ts  424 lines  14 typed templates (leader/worker/reviewer phases)
  phase-machine.ts     169 lines  State machine: CREATE -> DESIGN -> EXECUTE -> COMPLETE
  result-finalizer.ts  155 lines  Team-level merge: changedFiles, preview, entryFile
  preview-resolver.ts  116 lines  7-step cascading preview URL resolution
  preview-server.ts    128 lines  Static serve (npx serve) + command execution
  output-parser.ts     101 lines  Structured field extraction from agent stdout
  config.ts             56 lines  Centralized constants (delegation, timing, preview)
  types.ts             264 lines  All event types, options, payloads
  retry.ts             111 lines  Auto-retry with leader escalation
  worktree.ts          105 lines  Git worktree create/merge/remove
  agent-manager.ts      80 lines  Session registry + team lead tracking
  resolve-path.ts       36 lines  4-strategy path resolution for agent-reported paths
  ai-backend.ts         29 lines  AIBackend interface
  index.ts              61 lines  Public exports + factory
```

## Team Collaboration Flow

```
User: "Build a pixel art snake game"
  |
  v
+----------+     [PLAN] detected     +----------+     User approves     +-----------+
|  CREATE  | ----------------------> |  DESIGN  | ------------------->  |  EXECUTE  |
| (vision) |  Leader outputs plan    | (refine) |  approvePlan()        | (build)   |
+----------+                         +----------+                       +-----------+
                                          ^                                  |
                                          |                    isFinalResult |
                                          |                                  v
                                     User sends                       +----------+
                                     feedback                         | COMPLETE |
                                     (loops back)                     | (report) |
                                                                      +----------+
```

### Execute Phase Detail

```
Leader (no tools, delegates only)
  |
  | @Dev: Build the game with PixiJS...
  v
Developer (full tools)
  |  writes code, runs build, reports ENTRY_FILE
  v
Leader receives result
  |
  | @Reviewer: Check the code, verify features...
  v
Code Reviewer (full tools)
  |  VERDICT: PASS or FAIL + ISSUES
  v
Leader receives verdict
  |
  +-- PASS --> FINAL SUMMARY (isFinalResult = true)
  |
  +-- FAIL --> @Dev: Fix these issues... (max 3 review cycles)
```

### Delegation Controls

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `maxDepth` | 5 | Max delegation chain hops |
| `maxTotal` | 20 | Total delegations per session |
| `budgetRounds` | 7 | Leader invocations before forced finalize |
| `hardCeilingRounds` | 10 | Absolute max rounds (synthetic task:done) |
| `maxReviewRounds` | 3 | Code review iterations before accepting |

## Preview Resolution

When a task completes, preview URL is resolved through a **7-step cascading fallback**:

```
1. PREVIEW_CMD + PREVIEW_PORT  -->  Run server, proxy via port
2. PREVIEW_CMD (no port)       -->  Desktop/CLI app (user launches manually)
3. ENTRY_FILE (.html)          -->  Static serve via npx serve:9100
4. "PREVIEW: http://..." in stdout  -->  Explicit URL from agent
5. .html path mentioned in stdout   -->  Regex extraction
6. .html in changedFiles       -->  Static serve
7. Build output scan           -->  dist/index.html, build/index.html, etc.
```

At the team level, `ResultFinalizer` adds two additional layers before this chain:
- **Worker ground truth** — dev worker's preview fields override leader's (leader often hallucinates filenames)
- **Worker detectPreview scan** — iterate all workers' output for preview URLs

## Usage

### Basic Setup

```typescript
import { createOrchestrator } from "@bit-office/orchestrator";
import type { AIBackend } from "@bit-office/orchestrator";

const claude: AIBackend = {
  id: "claude",
  name: "Claude",
  command: "claude",
  buildArgs(prompt, opts) {
    const args = ["-p", prompt, "--output-format", "stream-json"];
    if (opts.continue && opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    if (opts.fullAccess) args.push("--dangerously-skip-permissions");
    if (opts.noTools) args.push("--allowedTools", "");
    return args;
  },
};

const orc = createOrchestrator({
  workspace: "/path/to/workspace",
  backends: [claude],
  retry: { maxRetries: 2, escalateToLeader: true },
  promptsDir: "~/.my-app/prompts",  // optional: override prompt templates on disk
});
```

### Event Handling

```typescript
// All 16 event types are fully typed
orc.on("task:started", (e) => {
  console.log(`${e.agentId} started task ${e.taskId}`);
});

orc.on("task:done", (e) => {
  if (e.isFinalResult) {
    console.log("Team finished!", e.result?.previewUrl);
  }
});

orc.on("team:phase", (e) => {
  console.log(`${e.teamId}: phase -> ${e.phase}`);
});

orc.on("team:chat", (e) => {
  // messageType: "delegation" | "result" | "status"
  console.log(`[${e.messageType}] ${e.fromAgentId}: ${e.message}`);
});
```

### Solo Agent

```typescript
orc.createAgent({
  agentId: "agent-1",
  name: "Dev",
  role: "Developer",
});

orc.runTask("agent-1", "task-1", "Build a landing page");
```

### Team Workflow

```typescript
// 1. Create agents
orc.createAgent({ agentId: "lead-1", name: "PM", role: "Team Lead" });
orc.createAgent({ agentId: "dev-1",  name: "Leo", role: "Developer" });
orc.createAgent({ agentId: "rev-1",  name: "Ada", role: "Code Reviewer" });
orc.setTeamLead("lead-1");

// 2. Start in CREATE phase — leader produces a [PLAN]
orc.setTeamPhase("team-1", "create", "lead-1");
orc.runTask("lead-1", "task-1", "Build a pixel snake game", {
  phaseOverride: "create",
});

// 3. Leader outputs [PLAN] -> auto-transitions to DESIGN phase
// 4. User reviews plan, provides feedback or approves

// 5. Approve plan -> transitions to EXECUTE phase
orc.approvePlan("lead-1");
orc.setTeamProjectDir("/workspace/snake-game");
orc.runTask("lead-1", "task-2", "Start building", {
  phaseOverride: "execute",
});

// 6. Leader delegates to Dev, Dev builds, Reviewer reviews
//    All handled automatically by DelegationRouter

// 7. isFinalResult fires on task:done -> COMPLETE phase
// 8. User sends feedback -> auto-transitions back to EXECUTE
```

### State Persistence (Consumer Side)

```typescript
// Save
const agents = orc.getAllAgents();
const phases = orc.getAllTeamPhases();
const projectDir = orc.getTeamProjectDir();
fs.writeFileSync("state.json", JSON.stringify({ agents, phases, projectDir }));

// Restore
const state = JSON.parse(fs.readFileSync("state.json", "utf-8"));
for (const agent of state.agents) {
  orc.createAgent({ ...agent, resumeHistory: true });
  if (agent.isTeamLead) orc.setTeamLead(agent.agentId);
}
for (const phase of state.phases) {
  orc.setTeamPhase(phase.teamId, phase.phase, phase.leadAgentId);
}
if (state.projectDir) orc.setTeamProjectDir(state.projectDir);
```

## Event Reference

| Event | Key Fields | When |
|-------|-----------|------|
| `task:started` | agentId, taskId, prompt | Agent begins a task |
| `task:done` | agentId, result, isFinalResult? | Agent completes a task |
| `task:failed` | agentId, error | Agent task fails |
| `task:delegated` | fromAgentId, toAgentId, prompt | Leader delegates to worker |
| `task:result-returned` | fromAgentId, toAgentId, summary | Worker result forwarded to leader |
| `task:retrying` | agentId, attempt, maxRetries | Auto-retry in progress |
| `task:queued` | agentId, position | Task queued (agent busy) |
| `agent:status` | agentId, status | Status change (idle/working/done/error) |
| `agent:created` | agentId, name, role, isTeamLead? | New agent registered |
| `agent:fired` | agentId | Agent removed |
| `approval:needed` | approvalId, riskLevel | Agent requests permission |
| `log:append` | agentId, stream, chunk | Real-time output stream |
| `team:chat` | fromAgentId, message, messageType | Team communication |
| `team:phase` | teamId, phase, leadAgentId | Phase transition |
| `worktree:created` | agentId, worktreePath, branch | Git worktree created |
| `worktree:merged` | agentId, success, conflictFiles? | Git worktree merged |

## Configuration

All magic numbers are centralized in `config.ts`:

```typescript
import { CONFIG } from "@bit-office/orchestrator";

CONFIG.delegation.maxDepth          // 5
CONFIG.delegation.maxTotal          // 20
CONFIG.delegation.budgetRounds      // 7
CONFIG.delegation.hardCeilingRounds // 10
CONFIG.delegation.maxReviewRounds   // 3

CONFIG.timing.leaderTimeoutMs       // 3 min
CONFIG.timing.workerTimeoutMs       // 8 min
CONFIG.timing.resultBatchWindowMs   // 20s (safety net for batch flushing)
CONFIG.timing.idleDoneDelayMs       // 5s
CONFIG.timing.idleErrorDelayMs      // 3s

CONFIG.preview.staticPort           // 9100
CONFIG.preview.buildOutputCandidates // ["dist/index.html", ...]
CONFIG.preview.runners              // { ".py": "python3", ".js": "node", ... }
```

## Prompt Templates

14 templates with compile-time typed names (`TemplateName` union). Templates are embedded as defaults and optionally overridden from disk (`promptsDir`).

| Template | Phase | Used When |
|----------|-------|-----------|
| `leader-create` | CREATE | First turn: leader as Creative Director |
| `leader-create-continue` | CREATE | Follow-up conversation |
| `leader-design` | DESIGN | User provides plan feedback |
| `leader-design-continue` | DESIGN | Continued refinement |
| `leader-initial` | EXECUTE | First execute entry (full delegation rules) |
| `leader-continue` | EXECUTE | Follow-up execute (keeps context) |
| `leader-result` | EXECUTE | Leader receives worker/reviewer results |
| `leader-complete` | COMPLETE | Present results to user |
| `leader-complete-continue` | COMPLETE | User feedback on completion |
| `worker-initial` | EXECUTE | Developer task assignment |
| `worker-reviewer-initial` | EXECUTE | Code reviewer task |
| `worker-continue` | EXECUTE | Follow-up to worker |
| `delegation-prefix` | EXECUTE | Wraps delegated task prompts |
| `delegation-hint` | EXECUTE | Delegation syntax helper |

Templates use `{{variable}}` substitution. Override any template by placing a `<template-name>.md` file in `promptsDir`.
