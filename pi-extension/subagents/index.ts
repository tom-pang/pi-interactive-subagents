import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { basename, dirname, join } from "node:path";
import {
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  sendCommand,
  pollForExit,
  closeSurface,
  shellEscape,
  exitStatusVar,
} from "./cmux.ts";
import { getNewEntries, findLastAssistantMessage, findNewestSessionFile } from "./session.ts";
import {
  isBackgroundAvailable,
  createBackgroundSurface,
  startCleanupChecker,
} from "./background.ts";
import {
  resolveModelForSubagent,
  formatResolutionError,
  type ModelInfo,
} from "./model-resolver.ts";

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name to load defaults from (e.g. 'worker', 'scout', 'reviewer'). Reads ~/.pi/agent/agents/<name>.md for model, tools, skills.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Appended to system prompt (role instructions)" }),
  ),
  model: Type.Optional(Type.String({ description: "Model override. Use 'provider/modelId' (e.g. 'anthropic/claude-sonnet-4-6', 'openai-codex/gpt-5.4') or a unique bare ID (e.g. 'claude-opus-4-6'). Ambiguous bare IDs like 'gpt-5.4' (exists in openai + openai-codex) require the provider prefix. Omit to inherit the current session model." })),
  skills: Type.Optional(
    Type.String({ description: "Comma-separated skills (overrides agent default)" }),
  ),
  tools: Type.Optional(
    Type.String({ description: "Comma-separated tools (overrides agent default)" }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Fork the current session — sub-agent gets full conversation context. Use for iterate/bugfix patterns.",
    }),
  ),
});

interface AgentDefaults {
  model?: string;
  lockModel?: boolean;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  cwd?: string;
  body?: string;
}

/** Tools that are gated by `spawning: false` */
const SPAWNING_TOOLS = new Set(["subagent", "subagents_list", "subagent_resume"]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  // spawning: false → deny all spawning tools
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // deny-tools: explicit list
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  const paths = [
    join(process.cwd(), ".pi", "agents", `${agentName}.md`),
    join(homedir(), ".pi", "agent", "agents", `${agentName}.md`),
    join(dirname(new URL(import.meta.url).pathname), "../../agents", `${agentName}.md`),
  ];
  for (const path of paths) {
    try {
      if (!existsSync(path)) continue;
      const raw = readFileSync(path, "utf8");
      const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      if (!m) return { body: raw.trim() };
      const yaml = m[1];
      const body = m[2].trim();
      const defaults: AgentDefaults = { body };
      for (const line of yaml.split("\n")) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (!value) continue;
        switch (key) {
          case "model":
            defaults.model = value;
            break;
          case "lock-model":
            defaults.lockModel = value === "true";
            break;
          case "tools":
            defaults.tools = value;
            break;
          case "skills":
            defaults.skills = value;
            break;
          case "thinking":
            defaults.thinking = value;
            break;
          case "deny-tools":
            defaults.denyTools = value;
            break;
          case "spawning":
            defaults.spawning = value === "true";
            break;
          case "auto-exit":
            defaults.autoExit = value === "true";
            break;
          case "cwd":
            defaults.cwd = value;
            break;
        }
      }
      return defaults;
    } catch {
      // ignore malformed agent files and try next path
    }
  }
  return null;
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile?: string;
  sessionDir?: string;
  sessionCreatedAfterMs?: number;
  entries?: number;
  bytes?: number;
  forkCleanupFile?: string;
  abortController?: AbortController;
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number): string {
  const contentWidth = Math.max(0, width - 2);
  const rightVis = visibleWidth(right);
  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  const inner = Math.max(0, width - 2);
  const titleText = ` ${title} `;
  const infoText = info ? ` ${info} ` : "";
  const used = visibleWidth(titleText) + visibleWidth(infoText);
  const remaining = Math.max(0, inner - used);
  const leftPad = Math.max(1, Math.floor(remaining / 2));
  const rightPad = Math.max(1, remaining - leftPad);
  return `${ACCENT}╭${"─".repeat(leftPad)}${RST}${titleText}${ACCENT}${"─".repeat(rightPad)}${infoText}╮${RST}`;
}

function borderBottom(width: number): string {
  return `${ACCENT}╰${"─".repeat(Math.max(0, width - 2))}╯${RST}`;
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;
  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagents", undefined);
    stopWidgetRefresh();
    return;
  }

  latestCtx.ui.setWidget("subagents", (_tui, theme) => {
    const box = new Box(1, 1, () => "");
    const width = 70;
    const rows = [...runningSubagents.values()].map((agent) => {
      const left = `${agent.name}${agent.agent ? ` (${agent.agent})` : ""}`;
      const right = `${agent.entries ?? 0} entries · ${agent.bytes ?? 0} B · ${formatElapsedMMSS(agent.startTime)}`;
      return borderLine(left, theme.fg("dim", right), width);
    });

    const lines = [
      borderTop("Running subagents", `${runningSubagents.size}`, width),
      ...rows,
      borderBottom(width),
    ];
    box.clear();
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  });
}

function startWidgetRefresh() {
  if (widgetInterval) return;
  widgetInterval = setInterval(updateWidget, 1000);
}

function stopWidgetRefresh() {
  if (!widgetInterval) return;
  clearInterval(widgetInterval);
  widgetInterval = null;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function getArtifactDir(cwd: string, sessionId: string): string {
  const safePath = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return join(homedir(), ".pi", "agent", "sessions", `--${safePath}--`, "session-artifacts", sessionId);
}

async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: {
    sessionManager: { getSessionFile(): string | null; getSessionId(): string };
    cwd: string;
    modelRegistry?: { getAvailable(): ModelInfo[] };
    model?: ModelInfo;
  },
  options?: { surface?: string; background?: boolean },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  const rawModelRef = agentDefs?.lockModel ? agentDefs.model : (params.model ?? agentDefs?.model);
  const effectiveTools = params.tools ?? agentDefs?.tools;
  const effectiveSkills = params.skills ?? agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;

  const availableModels = ctx.modelRegistry?.getAvailable()?.map((m) => ({
    provider: m.provider,
    id: m.id,
  })) ?? [];

  const currentModel = ctx.model
    ? { provider: ctx.model.provider, id: ctx.model.id }
    : undefined;

  const modelResolution = resolveModelForSubagent(rawModelRef, availableModels, currentModel);

  if (modelResolution && !modelResolution.ok) {
    throw new Error(`Model resolution failed: ${formatResolutionError(modelResolution)}`);
  }

  const resolvedModel = modelResolution?.ok ? modelResolution.model : null;
  const resolvedThinkingSuffix = modelResolution?.ok ? modelResolution.thinkingSuffix : undefined;
  const effectiveThinkingLevel = resolvedThinkingSuffix ?? effectiveThinking;
  const effectiveModel = resolvedModel?.canonical ?? undefined;

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");

  const sessionDir = dirname(sessionFile);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);
  const forkSessionDir = join(sessionDir, `fork-${timestamp}-${id}`);

  const background = options?.background ?? false;
  const surfacePreCreated = !!options?.surface;
  const surface = options?.surface ?? (background ? createBackgroundSurface(params.name) : createSurface(params.name));
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }

  const modeHint = agentDefs?.autoExit
    ? "Complete your task autonomously."
    : "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
  const summaryInstruction = agentDefs?.autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
  const denySet = resolveDenyTools(agentDefs);
  const agentType = params.agent ?? params.name;
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const roleBlock = identity ? `\n\n${identity}` : "";
  const fullTask = params.fork
    ? params.task
    : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;

  const parts: string[] = ["pi"];

  let forkCleanupFile: string | undefined;
  let trackedSessionFile: string | undefined = subagentSessionFile;
  let trackedSessionDir: string | undefined;
  let trackedSessionCreatedAfterMs: number | undefined;

  if (params.fork) {
    const raw = readFileSync(sessionFile, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());

    let truncateAt = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === "message" && entry.message?.role === "user") {
          truncateAt = i;
          break;
        }
      } catch {}
    }

    const cleanLines = lines.slice(0, truncateAt);
    forkCleanupFile = join(tmpdir(), `pi-fork-clean-${Date.now()}.jsonl`);
    writeFileSync(forkCleanupFile, cleanLines.join("\n") + "\n", "utf8");
    mkdirSync(forkSessionDir, { recursive: true });
    parts.push("--session-dir", shellEscape(forkSessionDir));
    parts.push("--fork", shellEscape(forkCleanupFile));
    trackedSessionFile = undefined;
    trackedSessionDir = forkSessionDir;
    trackedSessionCreatedAfterMs = startTime - 1000;
  } else {
    parts.push("--session", shellEscape(subagentSessionFile));
  }

  const subagentDonePath = join(dirname(new URL(import.meta.url).pathname), "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));

  if (effectiveModel) {
    const model = effectiveThinkingLevel ? `${effectiveModel}:${effectiveThinkingLevel}` : effectiveModel;
    parts.push("--model", shellEscape(model));
  }

  if (effectiveTools) {
    const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    const builtins = effectiveTools
      .split(",")
      .map((t) => t.trim())
      .filter((t) => BUILTIN_TOOLS.has(t));
    if (builtins.length > 0) {
      parts.push("--tools", shellEscape(builtins.join(",")));
    }
  }

  if (effectiveSkills) {
    for (const skill of effectiveSkills
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      parts.push(shellEscape(`/skill:${skill}`));
    }
  }

  const envParts: string[] = [];
  if (denySet.size > 0) {
    envParts.push(`PI_DENY_TOOLS=${shellEscape([...denySet].join(","))}`);
  }
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  if (params.agent) {
    envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  if (agentDefs?.autoExit) {
    envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  }
  const envPrefix = envParts.join(" ") + " ";

  if (params.fork) {
    parts.push(shellEscape(fullTask));
  } else {
    const sessionId = ctx.sessionManager.getSessionId();
    const artifactDir = getArtifactDir(ctx.cwd, sessionId);
    const artifactTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = params.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const artifactName = `context/${safeName || "subagent"}-${artifactTimestamp}.md`;
    const artifactPath = join(artifactDir, artifactName);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    parts.push(`@${artifactPath}`);
  }

  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(process.cwd(), rawCwd)
    : null;
  const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";

  const piCommand = cdPrefix + envPrefix + parts.join(" ");
  const command = `${piCommand}; echo '__SUBAGENT_DONE_'${exitStatusVar()}'__'`;
  sendCommand(surface, command);

  const running: RunningSubagent = {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface,
    startTime,
    sessionFile: trackedSessionFile,
    sessionDir: trackedSessionDir,
    sessionCreatedAfterMs: trackedSessionCreatedAfterMs,
    forkCleanupFile,
  };

  runningSubagents.set(id, running);
  return running;
}

async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, forkCleanupFile } = running;

  const resolveSessionFile = (): string | undefined => {
    if (running.sessionFile) return running.sessionFile;
    if (!running.sessionDir) return undefined;
    const discovered = findNewestSessionFile(running.sessionDir, {
      createdAfterMs: running.sessionCreatedAfterMs,
      excludeFiles: forkCleanupFile ? [forkCleanupFile] : undefined,
    });
    if (discovered) {
      running.sessionFile = discovered;
    }
    return running.sessionFile;
  };

  try {
    const exitCode = await pollForExit(surface, signal, {
      interval: 1000,
      onTick() {
        try {
          const sessionFile = resolveSessionFile();
          if (sessionFile && existsSync(sessionFile)) {
            const stat = statSync(sessionFile);
            const raw = readFileSync(sessionFile, "utf8");
            running.entries = raw.split("\n").filter((l) => l.trim()).length;
            running.bytes = stat.size;
          }
        } catch {}
      },
    });

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const sessionFile = resolveSessionFile();

    let summary: string;
    if (sessionFile && existsSync(sessionFile)) {
      const allEntries = getNewEntries(sessionFile, 0);
      summary =
        findLastAssistantMessage(allEntries) ??
        (exitCode !== 0
          ? `Sub-agent exited with code ${exitCode}`
          : "Sub-agent exited without output");
    } else {
      summary =
        exitCode !== 0
          ? `Sub-agent exited with code ${exitCode}`
          : "Sub-agent exited without output";
    }

    closeSurface(surface);
    runningSubagents.delete(running.id);

    if (forkCleanupFile) {
      try {
        unlinkSync(forkCleanupFile);
      } catch {}
    }

    return { name, task, summary, sessionFile, exitCode, elapsed };
  } catch (err: any) {
    if (forkCleanupFile) {
      try {
        unlinkSync(forkCleanupFile);
      } catch {}
    }
    try {
      closeSurface(surface);
    } catch {}
    runningSubagents.delete(running.id);

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "cancelled",
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
    };
  }
}

export default function subagentsExtension(pi: ExtensionAPI) {
  startCleanupChecker();

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
    }
    for (const [_id, agent] of runningSubagents) {
      agent.abortController?.abort();
    }
    runningSubagents.clear();
  });

  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const shouldRegister = (name: string) => !deniedTools.has(name);

  if (shouldRegister("subagent"))
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "IMPORTANT: This tool returns IMMEDIATELY — the sub-agent runs asynchronously in the background. " +
        "You will NOT have results when this tool returns. Results are delivered later via a steer message. " +
        "Do NOT fabricate, assume, or summarize results after calling this tool. " +
        "Either wait for the steer message or move on to other work.",
      promptSnippet:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "IMPORTANT: This tool returns IMMEDIATELY — the sub-agent runs asynchronously in the background. " +
        "You will NOT have results when this tool returns. Results are delivered later via a steer message. " +
        "Do NOT fabricate, assume, or summarize results after calling this tool. " +
        "Either wait for the steer message or move on to other work.",
      promptGuidelines: [
        "When spawning subagents, omit the `model` parameter to inherit the current session's model. " +
        "If you must specify a model, use `provider/modelId` format (e.g. `anthropic/claude-sonnet-4-6`). " +
        "Bare IDs like `gpt-5.4` will fail if they exist in multiple providers.",
      ],
      parameters: SubagentParams,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        if (!isMuxAvailable()) {
          return {
            content: [
              {
                type: "text",
                text: `Subagents require tmux, zellij, or cmux.\n\n${muxSetupHint()}`,
              },
            ],
            details: { error: "mux_unavailable" },
          };
        }

        const useBackground = isBackgroundAvailable();

        let running: RunningSubagent;
        try {
          running = await launchSubagent(params, ctx, { background: useBackground });
        } catch (err: any) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to launch sub-agent "${params.name}": ${err?.message ?? String(err)}`,
              },
            ],
            details: { error: err?.message ?? String(err) },
          };
        }

        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        startWidgetRefresh();

        watchSubagent(running, watcherAbort.signal)
          .then((result) => {
            updateWidget();
            const sessionRef = result.sessionFile
              ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
              : "";
            const content =
              result.exitCode !== 0
                ? `Sub-agent "${running.name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
                : `Sub-agent "${running.name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;

            pi.sendMessage(
              {
                customType: "subagent_result",
                content,
                display: true,
                details: {
                  name: running.name,
                  task: running.task,
                  agent: running.agent,
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: result.sessionFile,
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            updateWidget();
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name: running.name, task: running.task, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const agent = args.agent ? theme.fg("dim", ` (${args.agent})`) : "";
        const cwdHint = args.cwd ? theme.fg("dim", ` in ${args.cwd}`) : "";
        let text =
          "▸ " + theme.fg("toolTitle", theme.bold(args.name ?? "(unnamed)")) + agent + cwdHint;

        if (args.task) {
          const oneLine = String(args.task).replace(/\s+/g, " ").trim();
          const max = 80;
          const clipped = oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
          text += "\n  " + theme.fg("dim", clipped);
        }
        return new Text(text, 0, 0);
      },

      renderResult(result, options, theme, _context) {
        const text = result.content
          ?.filter((c: any) => c.type === "text")
          .map((c: any) => c.text || "")
          .join("\n") ?? "";
        const lines = text.split("\n");
        const shown = options.expanded ? lines : lines.slice(0, 4);
        if (!options.expanded && lines.length > shown.length) {
          shown.push(theme.fg("dim", `… +${lines.length - shown.length} lines (${keyHint("app.tools.expand", "expand")})`));
        }
        return new Text(shown.join("\n"), 0, 0);
      },
    });

  if (shouldRegister("subagents_list"))
    pi.registerTool({
      name: "subagents_list",
      label: "Subagents List",
      description: "List available subagent definitions. Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. Project-local agents override global ones with the same name.",
      promptSnippet: "List all available subagent definitions.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        const dirs = [
          join(process.cwd(), ".pi", "agents"),
          join(homedir(), ".pi", "agent", "agents"),
          join(dirname(new URL(import.meta.url).pathname), "../../agents"),
        ];
        const byName = new Map<string, { path: string; source: string }>();
        for (const dir of dirs) {
          if (!existsSync(dir)) continue;
          for (const file of readdirSync(dir)) {
            if (!file.endsWith(".md")) continue;
            const path = join(dir, file);
            const name = basename(file, ".md");
            byName.set(name, { path, source: dir.includes(`${process.cwd()}/.pi/agents`) ? "project" : dir.includes(`${homedir()}/.pi/agent/agents`) ? "global" : "package" });
          }
        }
        if (byName.size === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const list = [...byName.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, item]) => ({
            name,
            path: item.path,
            source: item.source,
            description: null,
            model: null,
          }));
        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("
") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("
"), 0, 0);
      },
    });

  if (shouldRegister("subagent_resume"))
    pi.registerTool({
      name: "subagent_resume",
      label: "Resume Subagent",
      description:
        "Resume a previous sub-agent session in a new multiplexer pane. " +
        "IMPORTANT: Returns IMMEDIATELY — the resumed session runs asynchronously in the background. " +
        "Results are delivered later via a steer message. Do NOT fabricate or assume results. " +
        "Use when a sub-agent was cancelled or needs follow-up work.",
      promptSnippet:
        "Resume a previous sub-agent session in a new multiplexer pane. " +
        "IMPORTANT: Returns IMMEDIATELY — the resumed session runs asynchronously in the background. " +
        "Results are delivered later via a steer message. Do NOT fabricate or assume results.",
      parameters: Type.Object({
        sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
        name: Type.Optional(Type.String({ description: "Display name for the terminal tab. Default: 'Resume'" })),
        message: Type.Optional(Type.String({ description: "Optional message to send after resuming (e.g. follow-up instructions)" })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        if (!isMuxAvailable()) {
          return {
            content: [{ type: "text", text: `Subagents require tmux, zellij, or cmux.\n\n${muxSetupHint()}` }],
            details: { error: "mux_unavailable" },
          };
        }
        if (!existsSync(params.sessionPath)) {
          return {
            content: [{ type: "text", text: `Session file not found: ${params.sessionPath}` }],
            details: { error: "missing_session" },
          };
        }

        const name = params.name || "Resume";
        const startTime = Date.now();
        const surface = isBackgroundAvailable() ? createBackgroundSurface(name) : createSurface(name);
        await new Promise<void>((resolve) => setTimeout(resolve, 300));

        const parts = ["pi", "--session", shellEscape(params.sessionPath)];
        const subagentDonePath = join(dirname(new URL(import.meta.url).pathname), "subagent-done.ts");
        parts.push("-e", shellEscape(subagentDonePath));

        let cleanupMsgFile: string | undefined;
        if (params.message) {
          const msgFile = join(tmpdir(), `subagent-resume-${Date.now()}.md`);
          writeFileSync(msgFile, params.message, "utf8");
          cleanupMsgFile = msgFile;
          parts.push(`@${msgFile}`);
        }

        const command = `${parts.join(" ")}${cleanupMsgFile ? `; rm -f ${shellEscape(cleanupMsgFile)}` : ""}; echo '__SUBAGENT_DONE_'${exitStatusVar()}'__'`;
        sendCommand(surface, command);

        const id = Math.random().toString(16).slice(2, 10);
        const running: RunningSubagent = {
          id,
          name,
          task: params.message ?? "resumed session",
          surface,
          startTime,
          sessionFile: params.sessionPath,
        };
        runningSubagents.set(id, running);
        startWidgetRefresh();

        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        const entryCountBefore = existsSync(params.sessionPath)
          ? readFileSync(params.sessionPath, "utf8").split("\n").filter((l) => l.trim()).length
          : 0;

        watchSubagent(running, watcherAbort.signal)
          .then((result) => {
            updateWidget();
            const allEntries = getNewEntries(params.sessionPath, entryCountBefore);
            const summary =
              findLastAssistantMessage(allEntries) ??
              (result.exitCode !== 0
                ? `Resumed session exited with code ${result.exitCode}`
                : "Resumed session exited without new output");
            const sessionRef = `\n\nSession: ${params.sessionPath}\nResume: pi --session ${params.sessionPath}`;

            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `${summary}${sessionRef}`,
                display: true,
                details: {
                  name,
                  task: params.message ?? "resumed session",
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: params.sessionPath,
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            updateWidget();
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Resume error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        return {
          content: [{ type: "text", text: `Session "${name}" resumed.` }],
          details: { name, sessionFile: params.sessionPath, status: "started" },
        };
      },
    });
 
   // /iterate command — fork the session into a subagent
   pi.registerCommand("iterate", {
     description: "Fork session into a subagent for focused work (bugfixes, iteration)",
     handler: async (args, _ctx) => {
       const task = args?.trim() || "";
       const toolCall = task
         ? `Use subagent to fork a session. fork: true, name: "Iterate", task: ${JSON.stringify(task)}`
         : `Use subagent to fork a session. fork: true, name: "Iterate", task: "The user wants to do some hands-on work. Help them with whatever they need."`;
       pi.sendUserMessage(toolCall);
     },
   });
 
   // /subagent command — spawn a subagent by name
   pi.registerCommand("subagent", {
     description: "Spawn a subagent: /subagent <agent> <task>",
     handler: async (args, ctx) => {
       const trimmed = (args ?? "").trim();
       if (!trimmed) {
         ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
         return;
       }
 
       const spaceIdx = trimmed.indexOf(" ");
       const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
       const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
 
       const defs = loadAgentDefaults(agentName);
       if (!defs) {
         ctx.ui.notify(
           `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
           "error",
         );
         return;
       }
 
       const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
       const displayName = agentName[0].toUpperCase() + agentName.slice(1);
       const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
       pi.sendUserMessage(toolCall);
     },
   });
 
   // ── subagent_result message renderer ──
   pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
     const details = message.details as any;
     if (!details) return undefined;
 
     return {
       render(width: number): string[] {
         const name = details.name ?? "subagent";
         const exitCode = details.exitCode ?? 0;
         const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
         const bgFn =
           exitCode === 0
             ? (text: string) => theme.bg("toolSuccessBg", text)
             : (text: string) => theme.bg("toolErrorBg", text);
         const icon = exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
         const status = exitCode === 0 ? "completed" : `failed (exit ${exitCode})`;
         const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
 
         const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
         const rawContent = typeof message.content === "string" ? message.content : "";
 
         // Clean summary (remove session ref and leading label for display)
         const summary = rawContent
           .replace(/\n\nSession: .+\nResume: .+$/, "")
           .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
           .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "");
 
         // Build content for the box
         const contentLines = [header];
 
         if (options.expanded) {
           // Full view: complete summary + session info
           if (summary) {
             for (const line of summary.split("\n")) {
               contentLines.push(line.slice(0, width - 6));
             }
           }
           if (details.sessionFile) {
             contentLines.push("");
             contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
             contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
           }
         } else {
           // Collapsed: preview + expand hint
           if (summary) {
             const previewLines = summary.split("\n").slice(0, 5);
             for (const line of previewLines) {
               contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
             }
             const totalLines = summary.split("\n").length;
             if (totalLines > 5) {
               contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
             }
           }
           contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
         }
 
         // Render via Box for background + padding, with blank line above for separation
         const box = new Box(1, 1, bgFn);
         box.addChild(new Text(contentLines.join("\n"), 0, 0));
         return ["", ...box.render(width)];
       },
     };
   });
 
   // /plan command — start the full planning workflow
   pi.registerCommand("plan", {
     description: "Start a planning session: /plan <what to build>",
     handler: async (args, ctx) => {
       const task = (args ?? "").trim();
       if (!task) {
         ctx.ui.notify("Usage: /plan <what to build>", "warning");
         return;
       }
 
-      // Rename workspace and tab to show this is a planning session
-      if (isMuxAvailable()) {
-        try {
-          const label = task.length > 40 ? task.slice(0, 40) + "..." : task;
-          renameWorkspace(`🎯 ${label}`);
-          renameCurrentTab(`🎯 Plan: ${label}`);
-        } catch {
-          // non-critical -- do not block the plan
-        }
-      }
-
       // Load the plan skill from the subagents extension directory
       const planSkillPath = join(dirname(new URL(import.meta.url).pathname), "plan-skill.md");
       let content = readFileSync(planSkillPath, "utf8");
       content = content.replace(/^---\n[\s\S]*?\n---\n*/, "");
       pi.sendUserMessage(
         `<skill name="plan" location="${planSkillPath}">\n${content.trim()}\n</skill>\n\n${task}`,
       );
     },
   });}
