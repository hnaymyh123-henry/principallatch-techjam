import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { agentCodexHomePath } from "./config.js";
import {
  ContainerCodexRunner,
  buildContainerRunArgs,
  containerHelperEnvironment,
  containerName,
  isMissingContainerError,
  pathsOverlap,
} from "./container-codex-runner.js";
import path from "node:path";
import { RunCancelledError } from "./errors.js";

const principalLatch = {
  passport: "raw-passport-must-not-appear-in-argv",
  gatewayUrl: "http://host.docker.internal:3000",
};
const appAuthToken = "test-only-operator-token-1234567890";
const neverCancelled = new AbortController().signal;

describe("Container Codex runner", () => {
  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      APP_AUTH_TOKEN: appAuthToken,
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent/unsafe",
        workspacePath: "/tmp/agent-workspace",
        prompt: "write a small program",
        threadId: null,
        signal: neverCancelled,
        principalLatch,
      },
      config,
    );

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "principallatch-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace");
    expect(args).toContain(
      "type=bind,src=" +
        agentCodexHomePath(config, "agent/unsafe") +
        ",dst=/codex-home",
    );
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args[args.indexOf("--log-driver") + 1]).toBe("none");
    expect(args).toContain("keep-id");
    expect(args).toContain("PRINCIPALLATCH_AGENT_PASSPORT");
    expect(args).toContain("PRINCIPALLATCH_GATEWAY_URL");
    expect(args).toContain("--read-only");
    expect(args).toContain("/tmp:rw,noexec,nosuid,nodev,size=64m");
    expect(args).toContain("--ipc");
    expect(args).toContain("none");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
    expect(args).not.toContain(principalLatch.passport);
    expect(args).not.toContain(principalLatch.gatewayUrl);
  });

  it("keeps Runtime container names distinct when long instance ids share a prefix", () => {
    const sharedPrefix = "a".repeat(32);
    const first = containerName("agent", sharedPrefix + "-first-instance");
    const second = containerName("agent", sharedPrefix + "-second-instance");

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[a-zA-Z0-9_.-]+$/);
    expect(second).toMatch(/^[a-zA-Z0-9_.-]+$/);
  });

  it("preserves Colima's native host gateway while resuming a mounted thread", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      APP_AUTH_TOKEN: appAuthToken,
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: "thread-123",
        signal: neverCancelled,
        principalLatch,
      },
      config,
      "darwin",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
    expect(args).not.toContain("keep-id");
    expect(args).not.toContain("host.docker.internal:host-gateway");
    expect(
      buildContainerRunArgs(
        {
          agentId: "agent",
          workspacePath: "/tmp/workspace",
          prompt: "continue",
          threadId: "thread-123",
          signal: neverCancelled,
          principalLatch,
        },
        config,
        "linux",
      ),
    ).toContain("host.docker.internal:host-gateway");
  });

  it("recognizes a Windows Podman executable path consistently", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      APP_AUTH_TOKEN: appAuthToken,
      CODEX_HOME: "C:\\state\\codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "C:\\Program Files\\RedHat\\Podman\\podman.exe",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "C:\\state\\workspace",
        prompt: "test",
        threadId: null,
        signal: neverCancelled,
        principalLatch,
      },
      config,
      "win32",
    );

    expect(config.principalLatchGatewayUrl).toBe(
      "http://host.containers.internal:3000",
    );
    expect(args).toContain("keep-id");
  });

  it("detects nested sensitive Runtime mounts", () => {
    expect(pathsOverlap("/trusted/data", "/trusted/data/keys")).toBe(true);
    expect(pathsOverlap("/agents/alice", "/trusted/data")).toBe(false);
  });

  it("distinguishes a missing container from an unverifiable engine failure", () => {
    expect(
      isMissingContainerError({ stderr: "Error: No such container: principallatch-x" }),
    ).toBe(true);
    expect(
      isMissingContainerError({ stderr: "Cannot connect to the Docker daemon" }),
    ).toBe(false);
  });

  it("preserves Windows and Docker CLI context without forwarding unrelated secrets", () => {
    const environment = containerHelperEnvironment({
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\judge",
      TEMP: "C:\\Temp",
      PATHEXT: ".COM;.EXE",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      DOCKER_CONTEXT: "desktop-linux",
      CONTAINER_HOST: "ssh://podman-machine",
      CONTAINER_CONNECTION: "judge-machine",
      CONTAINER_SSHKEY: "C:\\Users\\judge\\.ssh\\podman",
      PODMAN_CONNECTIONS_CONF: "C:\\Podman\\connections.json",
      CONTAINERS_CONF: "C:\\Podman\\containers.conf",
      CONTAINERS_REGISTRIES_CONF: "C:\\Podman\\registries.conf",
      CONTAINERS_STORAGE_CONF: "C:\\Podman\\storage.conf",
      XDG_CONFIG_HOME: "C:\\Users\\judge\\.config",
      APPDATA: "C:\\Users\\judge\\AppData\\Roaming",
      ARK_API_KEY: "must-not-be-in-helper-env",
      APP_AUTH_TOKEN: "must-not-be-in-helper-env",
    });

    expect(environment).toMatchObject({
      PATH: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\judge",
      TEMP: "C:\\Temp",
      PATHEXT: ".COM;.EXE",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      DOCKER_CONTEXT: "desktop-linux",
      CONTAINER_HOST: "ssh://podman-machine",
      CONTAINER_CONNECTION: "judge-machine",
      CONTAINER_SSHKEY: "C:\\Users\\judge\\.ssh\\podman",
      PODMAN_CONNECTIONS_CONF: "C:\\Podman\\connections.json",
      CONTAINERS_CONF: "C:\\Podman\\containers.conf",
      CONTAINERS_REGISTRIES_CONF: "C:\\Podman\\registries.conf",
      CONTAINERS_STORAGE_CONF: "C:\\Podman\\storage.conf",
      XDG_CONFIG_HOME: "C:\\Users\\judge\\.config",
      APPDATA: "C:\\Users\\judge\\AppData\\Roaming",
      NO_COLOR: "1",
    });
    expect(environment.ARK_API_KEY).toBeUndefined();
    expect(environment.APP_AUTH_TOKEN).toBeUndefined();
  });

  it("mounts a different Codex home for each Agent", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      APP_AUTH_TOKEN: appAuthToken,
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const first = buildContainerRunArgs(
      {
        agentId: "agent-one",
        workspacePath: "/tmp/one",
        prompt: "one",
        threadId: null,
        signal: neverCancelled,
        principalLatch,
      },
      config,
    );
    const second = buildContainerRunArgs(
      {
        agentId: "agent-two",
        workspacePath: "/tmp/two",
        prompt: "two",
        threadId: null,
        signal: neverCancelled,
        principalLatch,
      },
      config,
    );

    expect(first).toContain(
      "type=bind,src=" + path.join(path.resolve("/tmp/codex-home"), "agents", "agent-one") + ",dst=/codex-home",
    );
    expect(second).toContain(
      "type=bind,src=" + path.join(path.resolve("/tmp/codex-home"), "agents", "agent-two") + ",dst=/codex-home",
    );
    expect(first).not.toEqual(second);
  });

  it("does not spawn a container Runtime after cancellation during setup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "container-runner-cancel-test-"));
    try {
      const workspacePath = path.join(root, "workspace");
      const dataDirectory = path.join(root, "data");
      const keyDirectory = path.join(root, "keys");
      const protectedContent = path.join(root, "protected-content.json");
      await Promise.all([
        mkdir(workspacePath, { recursive: true }),
        mkdir(dataDirectory, { recursive: true }),
        mkdir(keyDirectory, { recursive: true }),
        writeFile(protectedContent, "{}", "utf8"),
      ]);
      const controller = new AbortController();
      const runner = new ContainerCodexRunner(
        loadConfig({
          NODE_ENV: "test",
          RUNTIME_PROVIDER: "container",
          APP_AUTH_TOKEN: "container-test-auth-token-123456",
          APP_DATA_DIR: dataDirectory,
          AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
          CODEX_HOME: path.join(root, "codex-home"),
          PRINCIPALLATCH_KEY_DIR: keyDirectory,
          PRINCIPALLATCH_PROTECTED_CONTENT_FILE: protectedContent,
          CONTAINER_ENGINE: path.join(root, "must-not-spawn"),
          CONTAINER_RUNTIME_IMAGE: "runtime:test",
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
