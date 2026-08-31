import {
  lstat,
  mkdir,
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
import type { Agent } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("WorkspaceManager trust boundary", () => {
  it("does not follow an Agent-planted link to a managed path outside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "principallatch-workspace-test-"));
    temporaryDirectories.push(root);
    const manager = new WorkspaceManager(path.join(root, "workspaces"));
    await manager.initialize();
    const agent = testAgent(manager.workspacePath("agent-one"));
    await manager.create(agent);

    if (process.platform === "win32") {
      const outsideDirectory = path.join(root, "outside-directory");
      const tools = path.join(agent.workspacePath, "tools");
      const sentinel = path.join(outsideDirectory, "read-document.mjs");
      await mkdir(outsideDirectory);
      await writeFile(sentinel, "outside must remain unchanged", "utf8");
      await rm(tools, { recursive: true });
      await symlink(outsideDirectory, tools, "junction");

      await expect(manager.ensure(agent)).rejects.toThrow(/symbolic link|workspace boundary/i);
      expect(await readFile(sentinel, "utf8")).toBe("outside must remain unchanged");
      return;
    }

    const sentinel = path.join(root, "outside-sentinel.txt");
    const instructions = path.join(agent.workspacePath, "AGENTS.md");
    await writeFile(sentinel, "outside must remain unchanged", "utf8");
    await unlink(instructions);
    await symlink(sentinel, instructions, "file");

    await manager.writeInstructions({
      ...agent,
      instructions: "regenerated trusted instructions",
    });

    expect(await readFile(sentinel, "utf8")).toBe("outside must remain unchanged");
    expect((await lstat(instructions)).isSymbolicLink()).toBe(false);
    expect(await readFile(instructions, "utf8")).toContain(
      "regenerated trusted instructions",
    );
  });
});

function testAgent(workspacePath: string): Agent {
  const now = new Date(0).toISOString();
  return {
    id: "agent-one",
    principalId: "agent:one",
    ownerPrincipalId: "user:alice",
    mandateId: "mandate:one",
    name: "Test Agent",
    description: "",
    instructions: "initial instructions",
    status: "ready",
    workspacePath,
    codexThreadId: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}
