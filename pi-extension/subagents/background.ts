/**
 * Background mode: run subagents in a hidden (detached) tmux session.
 *
 * One background session per pi process, named pi-bg-<pid>-<timestamp>.
 * The session is created lazily on first subagent spawn.
 * A periodic cleanup checker kills stale sessions (>24h, dead parent, no active subagents).
 *
 * Surface operations (sendCommand, readScreen, closeSurface, pollForExit) use the
 * existing cmux.ts tmux codepath — tmux pane IDs are global across all sessions
 * on the same server, so no special handling is needed.
 */
import { execSync, execFileSync } from "node:child_process";

const BACKGROUND_SESSION_PREFIX = "pi-bg-";

/**
 * Cached session name for this pi process.
 * One background session per pi process, set on first use.
 */
let backgroundSessionName: string | null = null;
let sessionCreated = false;
let exitHandlerRegistered = false;
let cleanupTimerId: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// tmux binary detection
// ---------------------------------------------------------------------------

let tmuxAvailable: boolean | null = null;

function hasTmuxCommand(): boolean {
  if (tmuxAvailable !== null) return tmuxAvailable;
  try {
    execSync("command -v tmux", { stdio: "ignore" });
    tmuxAvailable = true;
  } catch {
    tmuxAvailable = false;
  }
  return tmuxAvailable;
}

/**
 * Check if background mode is available (tmux binary exists on PATH).
 * Background mode works regardless of whether the user is currently inside tmux —
 * we create a detached session that runs independently.
 */
export function isBackgroundAvailable(): boolean {
  return hasTmuxCommand();
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Get (or generate) the background session name for this pi process.
 * Format: pi-bg-<pid>-<unixTimestamp>
 */
export function getBackgroundSessionName(): string {
  if (!backgroundSessionName) {
    const pid = process.pid;
    const timestamp = Math.floor(Date.now() / 1000);
    backgroundSessionName = `${BACKGROUND_SESSION_PREFIX}${pid}-${timestamp}`;
  }
  return backgroundSessionName;
}

/**
 * Ensure the background tmux session exists. Creates it lazily on first call.
 * Returns the session name.
 */
export function ensureBackgroundSession(): string {
  const name = getBackgroundSessionName();

  if (sessionCreated) {
    // Verify session still exists (could have been killed externally)
    try {
      execFileSync("tmux", ["has-session", "-t", name], { stdio: "ignore" });
      return name;
    } catch {
      sessionCreated = false;
    }
  }

  // Check if it already exists (e.g. from a previous call path)
  try {
    execFileSync("tmux", ["has-session", "-t", name], { stdio: "ignore" });
    sessionCreated = true;
    registerExitCleanup(name);
    return name;
  } catch {
    // Does not exist yet — create it
  }

  execFileSync("tmux", [
    "new-session", "-d", "-s", name, "-x", "200", "-y", "50",
  ]);
  sessionCreated = true;
  registerExitCleanup(name);
  return name;
}

/**
 * Register a process exit handler to kill the background session on normal exit.
 * Only registers once.
 */
function registerExitCleanup(sessionName: string): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;

  process.on("exit", () => {
    try {
      execFileSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
    } catch {
      // Session already gone — fine
    }
  });
}

// ---------------------------------------------------------------------------
// Surface creation
// ---------------------------------------------------------------------------

/**
 * Create a new window in the background session for a subagent.
 * Returns a global pane ID (e.g. %42) that works with all existing
 * cmux.ts tmux operations (sendCommand, readScreen, closeSurface, pollForExit).
 */
export function createBackgroundSurface(name: string): string {
  const sessionName = ensureBackgroundSession();

  const paneId = execFileSync("tmux", [
    "new-window", "-t", sessionName, "-P", "-F", "#{pane_id}", "-n", name,
  ], { encoding: "utf8" }).trim();

  if (!paneId.startsWith("%")) {
    throw new Error(`Unexpected tmux new-window output: ${paneId}`);
  }

  return paneId;
}

// ---------------------------------------------------------------------------
// Stale session cleanup
// ---------------------------------------------------------------------------

/**
 * Parse a background session name into its PID and timestamp components.
 * Returns null if the name doesn't match the pi-bg-<pid>-<timestamp> format.
 */
export function parseBackgroundSessionName(name: string): { pid: number; timestamp: number } | null {
  const match = name.match(/^pi-bg-(\d+)-(\d+)$/);
  if (!match) return null;
  return {
    pid: parseInt(match[1], 10),
    timestamp: parseInt(match[2], 10),
  };
}

/**
 * Check if a process with the given PID is still alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a tmux session has panes running subagent processes (pi or node).
 */
function sessionHasActiveSubagents(sessionName: string): boolean {
  try {
    const output = execFileSync("tmux", [
      "list-panes", "-s", "-t", sessionName, "-F", "#{pane_current_command}",
    ], { encoding: "utf8" }).trim();

    if (!output) return false;

    const commands = output.split("\n").filter((l) => l.trim());
    return commands.some((cmd) => {
      const trimmed = cmd.trim();
      return trimmed === "pi" || trimmed === "node";
    });
  } catch {
    return false;
  }
}

/**
 * Find and kill stale background sessions.
 *
 * A session is stale when ALL of the following are true:
 * 1. It is older than 24 hours
 * 2. Its parent pi process is no longer alive
 * 3. It has no panes running subagent processes
 */
export function cleanupStaleSessions(): void {
  if (!hasTmuxCommand()) return;

  try {
    const output = execFileSync("tmux", [
      "list-sessions", "-F", "#{session_name}",
    ], { encoding: "utf8" }).trim();

    if (!output) return;

    const sessions = output.split("\n")
      .filter((s) => s.startsWith(BACKGROUND_SESSION_PREFIX));

    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    for (const session of sessions) {
      // Never kill our own session
      if (session === backgroundSessionName) continue;

      const parsed = parseBackgroundSessionName(session);
      if (!parsed) continue;

      const ageMs = now - parsed.timestamp * 1000;
      if (ageMs < TWENTY_FOUR_HOURS_MS) continue;

      if (isProcessAlive(parsed.pid)) continue;

      if (sessionHasActiveSubagents(session)) continue;

      // All checks passed — session is stale, kill it
      try {
        execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
      } catch {
        // Ignore errors (session might have been killed between check and kill)
      }
    }
  } catch {
    // tmux server not running or no sessions — nothing to clean up
  }
}

/**
 * Start a periodic cleanup checker.
 * Runs cleanup once soon after startup, then every hour.
 * The timer is unref'd so it doesn't prevent process exit.
 */
export function startCleanupChecker(): void {
  if (cleanupTimerId !== null) return;

  // Run once soon (don't block extension init)
  setTimeout(() => cleanupStaleSessions(), 5000);

  // Then every hour
  const ONE_HOUR_MS = 60 * 60 * 1000;
  cleanupTimerId = setInterval(() => cleanupStaleSessions(), ONE_HOUR_MS);

  // Don't prevent process exit
  if (cleanupTimerId && typeof cleanupTimerId === "object" && "unref" in cleanupTimerId) {
    cleanupTimerId.unref();
  }
}
