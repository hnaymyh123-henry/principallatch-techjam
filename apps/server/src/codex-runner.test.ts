import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexRunner,
  buildCodexArgs,
  parseCodexEventLine,
  redactRuntimeSecrets,
} from "./codex-runner.js";
import { loadConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";

const principalLatch = {
  passport: "header.payload.signature",
  gatewayUrl: "http://127.0.0.1:3000",
};
const neverCancelled = new AbortController().signal;

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
        signal: neverCancelled,
        principalLatch,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
        signal: neverCancelled,
        principalLatch,
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it("redacts every secret injected into the Agent Runtime", () => {
    const passport = "passport.header.payload.signature";
    const arkApiKey = "ark-secret-123";
    const value =
      "passport=" + passport + " key=" + arkApiKey + " again=" + arkApiKey;

    expect(redactRuntimeSecrets(value, passport, arkApiKey)).toBe(
      "passport=[REDACTED_AGENT_PASSPORT] key=[REDACTED_ARK_API_KEY] again=[REDACTED_ARK_API_KEY]",
    );
  });

  it("does not spawn local Codex after cancellation during setup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-runner-cancel-test-"));
    try {
      const workspacePath = path.join(root, "workspace");
      await mkdir(workspacePath, { recursive: true });
      const controller = new AbortController();
      const runner = new CodexRunner(
        loadConfig({
          NODE_ENV: "development",
          RUNTIME_PROVIDER: "local-process",
          PRINCIPALLATCH_ALLOW_INSECURE_LOCAL_PROCESS: "true",
          APP_DATA_DIR: path.join(root, "data"),
          AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
          CODEX_HOME: path.join(root, "codex-home"),
          CODEX_BIN: path.join(root, "must-not-spawn"),
          ARK_API_KEY: "test-key",
          ARK_MODEL: "ep-test",
        }),
      );
      const pending = runner.run({
        agentId: "cancelled-agent",
        workspacePath,
        prompt: "must never start",
        threadId: null,
        signal: controller.signal,
        principalLatch,
      });

      controller.abort();

      await expect(pending).rejects.toBeInstanceOf(RunCancelledError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
