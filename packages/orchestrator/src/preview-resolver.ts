// ---------------------------------------------------------------------------
// PreviewResolver — unified preview URL resolution logic.
//
// Both agent-session (worker-level) and result-finalizer (team-level) use the
// same cascading fallback chain to resolve a preview URL. This module is the
// single source of truth for that chain, eliminating duplication.
// ---------------------------------------------------------------------------

import { existsSync } from "fs";
import path from "path";
import { CONFIG } from "./config.js";
import { resolveAgentPath } from "./resolve-path.js";
import { previewServer } from "./preview-server.js";

export interface PreviewInput {
  /** Structured ENTRY_FILE from agent output */
  entryFile?: string;
  /** Structured PREVIEW_CMD from agent output */
  previewCmd?: string;
  /** Structured PREVIEW_PORT from agent output */
  previewPort?: number;
  /** List of changed files reported by the agent */
  changedFiles?: string[];
  /** Raw stdout buffer (for regex-based URL/path extraction) */
  stdout?: string;
  /** Primary working directory for path resolution */
  cwd: string;
  /** Workspace root (fallback for path resolution) */
  workspace: string;
}

export interface PreviewResult {
  previewUrl: string | undefined;
  previewPath: string | undefined;
}

const EMPTY: PreviewResult = { previewUrl: undefined, previewPath: undefined };

/**
 * Cascading preview URL resolution — try each fallback in order.
 *
 * 1. PREVIEW_CMD with port → run server, proxy
 * 2. PREVIEW_CMD without port → desktop/CLI app (no URL, user launches manually)
 * 3. ENTRY_FILE (.html) → static serve
 * 4. Explicit "PREVIEW: http://..." in stdout
 * 5. .html file path mentioned in stdout
 * 6. .html in changedFiles → static serve
 * 7. Build output candidates scan (dist/index.html, etc.)
 */
export function resolvePreview(input: PreviewInput): PreviewResult {
  const { cwd, workspace } = input;

  // 1. PREVIEW_CMD with port
  if (input.previewCmd && input.previewPort) {
    const url = previewServer.runCommand(input.previewCmd, cwd, input.previewPort);
    if (url) return { previewUrl: url, previewPath: undefined };
  }

  // 2. PREVIEW_CMD without port — desktop/CLI app, no auto-launch
  if (input.previewCmd && !input.previewPort) {
    console.log(`[PreviewResolver] Desktop app ready (user can Launch): ${input.previewCmd}`);
    return EMPTY;
  }

  // 3. ENTRY_FILE (.html)
  if (input.entryFile && /\.html?$/i.test(input.entryFile)) {
    const absPath = resolveAgentPath(input.entryFile, cwd, workspace);
    if (absPath) {
      const url = previewServer.serve(absPath);
      if (url) return { previewUrl: url, previewPath: absPath };
    }
  }

  // 4. Explicit "PREVIEW: http://..." in stdout
  if (input.stdout) {
    const match = input.stdout.match(/PREVIEW:\s*(https?:\/\/[^\s*)\]>]+)/i);
    if (match) {
      return { previewUrl: match[1].replace(/[*)\]>]+$/, ""), previewPath: undefined };
    }
  }

  // 5. .html file path mentioned in stdout
  if (input.stdout) {
    const fileMatch = input.stdout.match(/(?:open\s+)?((?:\/[\w./_-]+|[\w./_-]+)\.html?)\b/i);
    if (fileMatch) {
      const absPath = resolveAgentPath(fileMatch[1], cwd, workspace);
      if (absPath) {
        const url = previewServer.serve(absPath);
        if (url) return { previewUrl: url, previewPath: absPath };
      }
    }
  }

  // 6. .html in changedFiles
  if (input.changedFiles) {
    for (const f of input.changedFiles) {
      if (!/\.html?$/i.test(f)) continue;
      const absPath = resolveAgentPath(f, cwd, workspace);
      if (absPath) {
        const url = previewServer.serve(absPath);
        if (url) return { previewUrl: url, previewPath: absPath };
      }
    }
  }

  // 7. Build output candidates scan
  for (const candidate of CONFIG.preview.buildOutputCandidates) {
    const absPath = path.join(cwd, candidate);
    if (existsSync(absPath)) {
      const url = previewServer.serve(absPath);
      if (url) return { previewUrl: url, previewPath: absPath };
    }
  }

  return EMPTY;
}
