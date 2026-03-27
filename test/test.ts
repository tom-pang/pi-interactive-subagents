import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  getLeafId,
  getEntryCount,
  getNewEntries,
  findLastAssistantMessage,
  appendBranchSummary,
  copySessionFile,
  mergeNewEntries,
} from "../pi-extension/subagents/session.ts";

import { shellEscape, isCmuxAvailable } from "../pi-extension/subagents/cmux.ts";
import { parseBackgroundSessionName, isBackgroundAvailable } from "../pi-extension/subagents/background.ts";
import {
  resolveModelForSubagent,
  splitThinkingSuffix,
  formatResolutionError,
  type ModelInfo,
} from "../pi-extension/subagents/model-resolver.ts";

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getLeafId", () => {
    it("returns last entry id", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(getLeafId(file), "asst-001");
    });

    it("returns null for empty file", () => {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      assert.equal(getLeafId(file), null);
    });
  });

  describe("getEntryCount", () => {
    it("counts non-empty lines", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG]);
      assert.equal(getEntryCount(file), 3);
    });

    it("returns 0 for empty file", () => {
      const file = join(dir, "empty2.jsonl");
      writeFileSync(file, "\n\n");
      assert.equal(getEntryCount(file), 0);
    });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });
  });

  describe("appendBranchSummary", () => {
    it("appends valid branch_summary entry", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const id = appendBranchSummary(file, "user-001", "asst-001", "The plan was created.");

      assert.ok(id, "should return an id");
      assert.equal(typeof id, "string");

      // Read back and verify
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 4); // 3 original + 1 summary

      const summary = JSON.parse(lines[3]);
      assert.equal(summary.type, "branch_summary");
      assert.equal(summary.id, id);
      assert.equal(summary.parentId, "user-001");
      assert.equal(summary.fromId, "asst-001");
      assert.equal(summary.summary, "The plan was created.");
      assert.ok(summary.timestamp);
    });

    it("uses branchPointId as fromId fallback", () => {
      const file = createSessionFile(dir, [SESSION_HEADER]);
      appendBranchSummary(file, "branch-pt", null, "summary");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      const summary = JSON.parse(lines[1]);
      assert.equal(summary.fromId, "branch-pt");
    });
  });

  describe("copySessionFile", () => {
    it("creates a copy with different path", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const copyDir = join(dir, "copies");
      mkdirSync(copyDir, { recursive: true });
      const copy = copySessionFile(file, copyDir);

      assert.notEqual(copy, file);
      assert.ok(copy.endsWith(".jsonl"));
      assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
    });
  });

  describe("mergeNewEntries", () => {
    it("appends new entries from source to target", () => {
      // Source starts with same base (2 entries), then has 1 new entry
      const sourceFile = join(dir, "merge-source.jsonl");
      const targetFile = join(dir, "merge-target.jsonl");
      writeFileSync(
        sourceFile,
        [SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      writeFileSync(
        targetFile,
        [SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      // Merge entries after line 2 (the shared base)
      const merged = mergeNewEntries(sourceFile, targetFile, 2);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "asst-001");

      // Target should now have 3 entries
      const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
      assert.equal(targetLines.length, 3);
    });
  });
});

describe("cmux.ts", () => {
  describe("shellEscape", () => {
    it("wraps in single quotes", () => {
      assert.equal(shellEscape("hello"), "'hello'");
    });

    it("escapes single quotes", () => {
      assert.equal(shellEscape("it's"), "'it'\\''s'");
    });

    it("handles empty string", () => {
      assert.equal(shellEscape(""), "''");
    });

    it("handles special characters", () => {
      const input = 'echo "hello $world" && rm -rf /';
      const escaped = shellEscape(input);
      assert.ok(escaped.startsWith("'"));
      assert.ok(escaped.endsWith("'"));
      // Inside single quotes, everything is literal
      assert.ok(escaped.includes("$world"));
    });
  });

  describe("isCmuxAvailable", () => {
    it("returns boolean based on CMUX_SOCKET_PATH", () => {
      // Can't easily mock env in node:test, just verify it returns a boolean
      const result = isCmuxAvailable();
      assert.equal(typeof result, "boolean");
    });
  });
});

describe("background.ts", () => {
  describe("parseBackgroundSessionName", () => {
    it("parses valid session name", () => {
      const result = parseBackgroundSessionName("pi-bg-12345-1711014000");
      assert.deepEqual(result, { pid: 12345, timestamp: 1711014000 });
    });

    it("parses large pid and timestamp", () => {
      const result = parseBackgroundSessionName("pi-bg-999999-1742515200");
      assert.deepEqual(result, { pid: 999999, timestamp: 1742515200 });
    });

    it("returns null for non-matching prefix", () => {
      assert.equal(parseBackgroundSessionName("some-session"), null);
    });

    it("returns null for partial match", () => {
      assert.equal(parseBackgroundSessionName("pi-bg-12345"), null);
    });

    it("returns null for extra segments", () => {
      assert.equal(parseBackgroundSessionName("pi-bg-12345-1711014000-extra"), null);
    });

    it("returns null for non-numeric pid", () => {
      assert.equal(parseBackgroundSessionName("pi-bg-abc-1711014000"), null);
    });

    it("returns null for empty string", () => {
      assert.equal(parseBackgroundSessionName(""), null);
    });
  });

  describe("isBackgroundAvailable", () => {
    it("returns boolean based on tmux binary availability", () => {
      const result = isBackgroundAvailable();
      assert.equal(typeof result, "boolean");
    });
  });
});

// --- Model resolver tests ---

describe("model-resolver.ts", () => {
  // Realistic model set matching `pi --list-models` output
  const AVAILABLE_MODELS: ModelInfo[] = [
    { provider: "anthropic", id: "claude-opus-4-6" },
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    { provider: "anthropic", id: "claude-sonnet-4-5" },
    { provider: "anthropic", id: "claude-haiku-4-5" },
    { provider: "anthropic", id: "claude-opus-4-5" },
    { provider: "openai", id: "gpt-5.4" },
    { provider: "openai", id: "gpt-5.4-mini" },
    { provider: "openai", id: "gpt-5.4-pro" },
    { provider: "openai", id: "gpt-5" },
    { provider: "openai", id: "gpt-4o" },
    { provider: "openai", id: "o3" },
    { provider: "openai", id: "o4-mini" },
    { provider: "openai-codex", id: "gpt-5.4" },
    { provider: "openai-codex", id: "gpt-5.4-mini" },
    { provider: "openai-codex", id: "gpt-5.3-codex" },
    { provider: "openai-codex", id: "gpt-5.2-codex" },
    { provider: "openai-codex", id: "gpt-5.1-codex-max" },
  ];

  const CURRENT_MODEL: ModelInfo = { provider: "anthropic", id: "claude-opus-4-6" };

  describe("splitThinkingSuffix", () => {
    it("returns modelRef unchanged when no colon", () => {
      assert.deepEqual(splitThinkingSuffix("gpt-5.4"), {
        modelRef: "gpt-5.4",
      });
    });

    it("strips recognized thinking levels", () => {
      assert.deepEqual(splitThinkingSuffix("gpt-5.4:high"), {
        modelRef: "gpt-5.4",
        thinkingSuffix: "high",
      });
      assert.deepEqual(splitThinkingSuffix("claude-opus-4-6:medium"), {
        modelRef: "claude-opus-4-6",
        thinkingSuffix: "medium",
      });
    });

    it("handles all valid thinking levels", () => {
      for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
        const result = splitThinkingSuffix(`model:${level}`);
        assert.equal(result.thinkingSuffix, level);
        assert.equal(result.modelRef, "model");
      }
    });

    it("does not strip unrecognized suffixes", () => {
      assert.deepEqual(splitThinkingSuffix("openrouter/model:exacto"), {
        modelRef: "openrouter/model:exacto",
      });
    });

    it("handles provider/model:thinking correctly", () => {
      assert.deepEqual(splitThinkingSuffix("anthropic/claude-opus-4-6:high"), {
        modelRef: "anthropic/claude-opus-4-6",
        thinkingSuffix: "high",
      });
    });
  });

  describe("resolveModelForSubagent", () => {
    // --- No model ref: inheritance ---

    it("inherits current model when no modelRef is given", () => {
      const result = resolveModelForSubagent(undefined, AVAILABLE_MODELS, CURRENT_MODEL);
      assert.ok(result !== null);
      assert.ok(result.ok);
      assert.equal(result.model.canonical, "anthropic/claude-opus-4-6");
      assert.equal(result.model.provider, "anthropic");
      assert.equal(result.model.modelId, "claude-opus-4-6");
    });

    it("returns null when no modelRef and no currentModel", () => {
      const result = resolveModelForSubagent(undefined, AVAILABLE_MODELS, undefined);
      assert.equal(result, null);
    });

    // --- Fully qualified: provider/modelId ---

    it("resolves exact provider/modelId", () => {
      const result = resolveModelForSubagent("anthropic/claude-opus-4-6", AVAILABLE_MODELS, CURRENT_MODEL);
      assert.ok(result !== null && result.ok);
      assert.equal(result.model.canonical, "anthropic/claude-opus-4-6");
    });

    it("resolves openai-codex/gpt-5.4 specifically", () => {
      const result = resolveModelForSubagent("openai-codex/gpt-5.4", AVAILABLE_MODELS, CURRENT_MODEL);
      assert.ok(result !== null && result.ok);
      assert.equal(result.model.canonical, "openai-codex/gpt-5.4");
      assert.equal(result.model.provider, "openai-codex");
    });

    it("resolves openai/gpt-5.4 specifically", () => {
      const result = resolveModelForSubagent("openai/gpt-5.4", AVAILABLE_MODELS, CURRENT_MODEL);
      assert.ok(result !== null && result.ok);
      assert.equal(result.model.canonical, "openai/gpt-5.4");
      assert.equal(result.model.provider, "openai");
    });

    it("errors on nonexistent provider/modelId", () => {
      const result = resolveModelForSubagent("anthropic/gpt-5.4", AVAILABLE_MODELS, CURRENT_MODEL);
      assert.ok(result !== null && !result.ok);
      assert.ok(result.error.includes("not found"));
    });

    it("suggests same-id models when provider is wrong", () => {
      const result = resolveModelForSubagent("anthropic/gpt-5.4", AVAILABLE_MODELS, CURRENT_MODEL);
      assert.ok(result !== null && !result.ok);
      // Should suggest the correct providers for gpt-5.4
      assert.ok(result.suggestions);
      assert.ok(result.suggestions.some((s) => s === "openai/gpt-5.4"));
      assert.ok(result.suggestions.some((s) => s === "openai-codex/gpt-5.4"));
    });

    // --- Bare model ID: disambiguation ---

    it("resolves unambiguous bare model ID", () => {
      const result = resolveModelForSubagent("claude-opus-4-6", AVAILABLE_MODELS, CURRENT_MODEL);
      assert.ok(result !== null && result.ok);
      assert.equal(result.model.canonical, "anthropic/claude-opus-4-6");
    });

    it("errors on ambiguous bare model ID", () => {
      const result = resolveModelForSubagent("gpt-5.4", AVAILABLE_MODELS, CURRENT_MODEL);
      assert.ok(result !== null && !result.ok);
      assert.ok(result.error.includes("Ambiguous"));
      assert.ok(result.suggestions);
      assert.ok(result.suggestions.includes("openai/gpt-5.4"));
      assert.ok(result.suggestions.includes("openai-codex/gpt-5.4"));
    });

    it("errors on ambiguous gpt-5.4-mini (exists in both openai and openai-codex)", () => {
      const result = resolveModelForSubagent("gpt-5.4-mini", AVAILABLE_MODELS, CURRENT_MODEL);
      assert.ok(result !== null && !result.ok);
      assert.ok(result.error.includes("Ambiguous"));
    });

    it("resolves unique bare ID like o3", () => {
      const result = resolveModelForSubagent("o3", AVAILABLE_MODELS, CURRENT_MODEL);
      assert.ok(result !== null && result.ok);
      assert.equal(result.model.canonical, "openai/o3");
    });

    it("resolves unique bare ID like gpt-5.3-codex", () => {
      const result = resolveModelForSubagent("gpt-5.3-codex", AVAILABLE_MODELS, CURRENT_MODEL);
      assert.ok(result !== null && result.ok);
      assert.equal(result.model.canonical, "openai-codex/gpt-5.3-codex");
    });

    it("errors on completely unknown model", () => {
      const result = resolveModelForSubagent("llama-99", AVAILABLE_MODELS, CURRENT_MODEL);
      assert.ok(result !== null && !result.ok);
      assert.ok(result.error.includes("not found"));
    });

    // --- Thinking suffix preserved ---

    it("preserves thinking suffix on qualified model", () => {
      const result = resolveModelForSubagent("anthropic/claude-opus-4-6:high", AVAILABLE_MODELS, CURRENT_MODEL);
      assert.ok(result !== null && result.ok);
      assert.equal(result.model.canonical, "anthropic/claude-opus-4-6");
      assert.equal(result.thinkingSuffix, "high");
    });

    it("preserves thinking suffix on bare model", () => {
      const result = resolveModelForSubagent("claude-opus-4-6:medium", AVAILABLE_MODELS, CURRENT_MODEL);
      assert.ok(result !== null && result.ok);
      assert.equal(result.model.canonical, "anthropic/claude-opus-4-6");
      assert.equal(result.thinkingSuffix, "medium");
    });

    // --- Edge cases ---

    it("handles empty string model ref as no-match", () => {
      const result = resolveModelForSubagent("", AVAILABLE_MODELS, CURRENT_MODEL);
      assert.ok(result !== null && !result.ok);
    });

    it("handles empty available models list", () => {
      const result = resolveModelForSubagent("gpt-5.4", [], CURRENT_MODEL);
      assert.ok(result !== null && !result.ok);
    });
  });

  describe("formatResolutionError", () => {
    it("formats error without suggestions", () => {
      const msg = formatResolutionError({ ok: false, error: "Model not found." });
      assert.equal(msg, "Model not found.");
    });

    it("formats error with suggestions", () => {
      const msg = formatResolutionError({
        ok: false,
        error: 'Ambiguous model "gpt-5.4"',
        suggestions: ["openai/gpt-5.4", "openai-codex/gpt-5.4"],
      });
      assert.ok(msg.includes("openai/gpt-5.4"));
      assert.ok(msg.includes("openai-codex/gpt-5.4"));
      assert.ok(msg.includes("Available matches:"));
    });
  });
});
