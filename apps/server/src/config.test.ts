import {
  link,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentCodexHomePath,
  loadConfig,
  writeAgentCodexConfig,
} from "./config.js";

const temporaryDirectories: string[] = [];
const validAuthToken = "test-only-operator-token-1234567890";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("PrincipalLatch Runtime trust boundary", () => {
  it("uses the isolated container Runtime by default", () => {
    const config = loadConfig({
      NODE_ENV: "development",
      APP_AUTH_TOKEN: validAuthToken,
    });

    expect(config.runtimeProvider).toBe("container");
    expect(config.insecureLocalProcessAllowed).toBe(false);
  });

  it("rejects a same-process Runtime unless the operator explicitly opts in", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        RUNTIME_PROVIDER: "local-process",
      }),
    ).toThrow(/cannot read control-plane keys or protected content/);
  });

  it("labels an explicit local-process development override", () => {
    const config = loadConfig({
      NODE_ENV: "development",
      RUNTIME_PROVIDER: "local-process",
      PRINCIPALLATCH_ALLOW_INSECURE_LOCAL_PROCESS: "true",
    });

    expect(config.runtimeProvider).toBe("local-process");
    expect(config.insecureLocalProcessAllowed).toBe(true);
  });

  it("never permits the insecure local-process override in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        RUNTIME_PROVIDER: "local-process",
        PRINCIPALLATCH_ALLOW_INSECURE_LOCAL_PROCESS: "true",
      }),
    ).toThrow(/only with NODE_ENV=development/);
  });

  it("requires an outer token even when the container Gateway listener is loopback-bound", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "development",
        HOST: "127.0.0.1",
        RUNTIME_PROVIDER: "container",
      }),
    ).toThrow(/APP_AUTH_TOKEN/);
  });

  it("uses configured origins instead of trusting the request Host header", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      APP_AUTH_TOKEN: validAuthToken,
      APP_ALLOWED_ORIGINS: "https://demo.example.com",
    });

    expect(config.allowedOrigins).toContain("https://demo.example.com");
    expect(config.allowedOrigins).not.toContain("https://attacker.example");
  });

  it("rejects reusing the Agent-readable model key as the Human API token", () => {
    const repeated = "same-independent-secret-1234567890";
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        HOST: "0.0.0.0",
        RUNTIME_PROVIDER: "container",
        APP_AUTH_TOKEN: repeated,
        MODEL_API_KEY: repeated,
      }),
    ).toThrow(/must be independent secrets/);
  });

  it("rejects a root container identity", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "development",
        APP_AUTH_TOKEN: validAuthToken,
        CONTAINER_USER: "0:0",
      }),
    ).toThrow(/non-root CONTAINER_USER/);
  });

  it("replaces an Agent-planted config link without changing its outside target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "principallatch-config-test-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "development",
      APP_AUTH_TOKEN: validAuthToken,
      CODEX_HOME: path.join(root, "codex-home"),
      MODEL_ID: "test-model",
    });
    await writeAgentCodexConfig(config, "agent-one");

    const target = path.join(agentCodexHomePath(config, "agent-one"), "config.toml");
    const sentinel = path.join(root, "outside-sentinel.toml");
    await writeFile(sentinel, "outside must remain unchanged", "utf8");
    await unlink(target);
    if (process.platform === "win32") {
      await link(sentinel, target);
    } else {
      await symlink(sentinel, target, "file");
    }

    await writeAgentCodexConfig(config, "agent-one");

    expect(await readFile(sentinel, "utf8")).toBe("outside must remain unchanged");
    expect(await readFile(target, "utf8")).toContain('model = "test-model"');
    expect(await readFile(target, "utf8")).toContain(
      'base_url = "https://tokendance.space/gateway/v1"',
    );
    expect(await readFile(target, "utf8")).toContain('env_key = "MODEL_API_KEY"');
    expect(await readFile(target, "utf8")).toContain('wire_api = "responses"');
    expect(await readFile(target, "utf8")).toContain(
      'http_headers = { "X-App-URL" = "app://principallatch-techjam" }',
    );
    expect(
      JSON.parse(
        await readFile(
          path.join(agentCodexHomePath(config, "agent-one"), "models.json"),
          "utf8",
        ),
      ).models[0].slug,
    ).toBe("deepseek-v4-flash-0731");
  });
});
