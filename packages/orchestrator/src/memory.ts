// ---------------------------------------------------------------------------
// AgentMemory — persistent learning across team sessions.
//
// Stores:
// - Review patterns: common FAIL reasons from reviewers (injected into dev prompts)
// - Tech preferences: user's preferred tech stack choices
// - Project history: brief summaries of completed projects
//
// Storage: ~/.bit-office/memory/ (JSON files, human-readable)
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import { homedir } from "os";

const MEMORY_DIR = path.join(homedir(), ".bit-office", "memory");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewPattern {
  /** The issue pattern (e.g. "missing error handling") */
  pattern: string;
  /** How many times this was flagged by reviewers */
  count: number;
  /** Last seen timestamp */
  lastSeen: number;
}

export interface ProjectRecord {
  /** Short description of what was built */
  summary: string;
  /** Tech stack used */
  tech: string;
  /** Timestamp */
  completedAt: number;
  /** Whether the project passed review */
  reviewPassed: boolean;
}

interface MemoryStore {
  reviewPatterns: ReviewPattern[];
  techPreferences: string[];
  projectHistory: ProjectRecord[];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function ensureDir(): void {
  if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

function loadStore(): MemoryStore {
  const filePath = path.join(MEMORY_DIR, "memory.json");
  try {
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, "utf-8"));
    }
  } catch { /* corrupt file, start fresh */ }
  return { reviewPatterns: [], techPreferences: [], projectHistory: [] };
}

function saveStore(store: MemoryStore): void {
  ensureDir();
  const filePath = path.join(MEMORY_DIR, "memory.json");
  writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record review patterns from a reviewer's FAIL verdict.
 * Extracts individual issues and tracks their frequency.
 */
export function recordReviewFeedback(reviewOutput: string): void {
  const verdictMatch = reviewOutput.match(/VERDICT[:\s]*(\w+)/i);
  if (!verdictMatch || verdictMatch[1].toUpperCase() !== "FAIL") return;

  // Extract numbered issues (e.g. "1. Missing error handling\n2. No input validation")
  const issueLines: string[] = [];
  const issueRe = /^\s*\d+[.)]\s*(.+)/gm;
  let match;
  while ((match = issueRe.exec(reviewOutput)) !== null) {
    const issue = match[1].trim();
    if (issue.length > 10 && issue.length < 200) {
      issueLines.push(issue);
    }
  }

  if (issueLines.length === 0) return;

  const store = loadStore();
  const now = Date.now();

  for (const issue of issueLines) {
    const normalized = normalizeIssue(issue);
    const existing = store.reviewPatterns.find(p => normalizeIssue(p.pattern) === normalized);
    if (existing) {
      existing.count++;
      existing.lastSeen = now;
    } else {
      store.reviewPatterns.push({ pattern: issue, count: 1, lastSeen: now });
    }
  }

  // Keep only top 20 patterns, sorted by frequency
  store.reviewPatterns.sort((a, b) => b.count - a.count);
  store.reviewPatterns = store.reviewPatterns.slice(0, 20);

  saveStore(store);
  console.log(`[Memory] Recorded ${issueLines.length} review pattern(s), total=${store.reviewPatterns.length}`);
}

/**
 * Record a completed project for history.
 */
export function recordProjectCompletion(summary: string, tech: string, reviewPassed: boolean): void {
  const store = loadStore();

  store.projectHistory.push({
    summary: summary.slice(0, 300),
    tech: tech.slice(0, 100),
    completedAt: Date.now(),
    reviewPassed,
  });

  // Keep last 50 projects
  if (store.projectHistory.length > 50) {
    store.projectHistory = store.projectHistory.slice(-50);
  }

  saveStore(store);
  console.log(`[Memory] Recorded project completion: ${summary.slice(0, 80)}`);
}

/**
 * Record tech preference (extracted from approved plan's TECH line).
 */
export function recordTechPreference(tech: string): void {
  const store = loadStore();
  const normalized = tech.trim().toLowerCase();

  if (!store.techPreferences.some(t => t.toLowerCase() === normalized)) {
    store.techPreferences.push(tech.trim());
    // Keep last 10
    if (store.techPreferences.length > 10) {
      store.techPreferences = store.techPreferences.slice(-10);
    }
    saveStore(store);
    console.log(`[Memory] Recorded tech preference: ${tech}`);
  }
}

/**
 * Get memory context to inject into agent prompts.
 * Returns a formatted string, or empty string if no relevant memory.
 */
export function getMemoryContext(): string {
  const store = loadStore();
  const sections: string[] = [];

  // Top review patterns (count >= 2 means it's a recurring issue)
  const recurring = store.reviewPatterns.filter(p => p.count >= 2);
  if (recurring.length > 0) {
    const lines = recurring.slice(0, 5).map(p => `- ${p.pattern} (flagged ${p.count}x)`);
    sections.push(`COMMON REVIEW ISSUES (avoid these):\n${lines.join("\n")}`);
  }

  // Recent tech preferences
  if (store.techPreferences.length > 0) {
    const recent = store.techPreferences.slice(-3);
    sections.push(`USER'S PREFERRED TECH: ${recent.join(", ")}`);
  }

  if (sections.length === 0) return "";
  return `\n===== LEARNED FROM PREVIOUS PROJECTS =====\n${sections.join("\n\n")}\n`;
}

/**
 * Get full memory store (for debugging/inspection).
 */
export function getMemoryStore(): MemoryStore {
  return loadStore();
}

/**
 * Clear all memory (for testing or reset).
 */
export function clearMemory(): void {
  ensureDir();
  saveStore({ reviewPatterns: [], techPreferences: [], projectHistory: [] });
  console.log(`[Memory] All memory cleared`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize an issue string for deduplication (lowercase, strip punctuation) */
function normalizeIssue(issue: string): string {
  return issue.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}
