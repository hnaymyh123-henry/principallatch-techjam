import { rename } from "node:fs/promises";
import path from "node:path";
import {
  ensureManagedChildDirectory,
  ensureTrustedRoot,
  replaceManagedFile,
  writeManagedFileIfMissing,
} from "./safe-files.js";
import type { Agent } from "./types.js";

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(agentId: string): string {
    return path.join(this.root, agentId);
  }

  async initialize(): Promise<void> {
    await ensureTrustedRoot(this.root, "workspace root");
    await ensureManagedChildDirectory(
      this.root,
      path.join(this.root, ".deleted"),
      "workspace archive",
    );
  }

  async create(agent: Agent): Promise<void> {
    await this.ensure(agent);
  }

  async ensure(agent: Agent): Promise<void> {
    const expectedWorkspace = this.assertManagedWorkspace(agent);
    const workspace = await ensureManagedChildDirectory(
      this.root,
      expectedWorkspace,
      "Agent workspace",
    );
    const tools = await ensureManagedChildDirectory(
      workspace,
      path.join(workspace, "tools"),
      "Agent tools directory",
    );
    await this.writeInstructions(agent);
    await replaceManagedFile(
      tools,
      "read-document.mjs",
      protectedDocumentClient,
    );
    await writeManagedFileIfMissing(
      workspace,
      ".gitignore",
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
    );
    await writeManagedFileIfMissing(
      workspace,
      "README.md",
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
    );
  }

  async writeInstructions(agent: Agent): Promise<void> {
    const expectedWorkspace = this.assertManagedWorkspace(agent);
    const workspace = await ensureManagedChildDirectory(
      this.root,
      expectedWorkspace,
      "Agent workspace",
    );
    const content = [
      "# Platform-managed Agent instructions",
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      "## Workspace rules",
      "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      "## PrincipalLatch protected resources",
      "",
      "- Read protected documents only with `node tools/read-document.mjs <resource-id>`.",
      "- The client gets its short-lived Agent Passport from the process environment.",
      "- A denial is a final backend policy result. Report its exact code; do not bypass it.",
      "",
      "This file is regenerated when the Agent configuration is updated.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await replaceManagedFile(workspace, "AGENTS.md", content);
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    await rename(agent.workspacePath, destination);
    return destination;
  }

  private assertManagedWorkspace(agent: Agent): string {
    const expected = path.resolve(this.workspacePath(agent.id));
    const actual = path.resolve(agent.workspacePath);
    const matches =
      process.platform === "win32"
        ? expected.toLowerCase() === actual.toLowerCase()
        : expected === actual;
    if (!matches) {
      throw new Error("Agent workspace path does not match the managed workspace root");
    }
    return expected;
  }
}

const protectedDocumentClient = `const resourceId = process.argv[2];
if (!resourceId || !/^[A-Za-z0-9._-]{1,120}$/.test(resourceId)) {
  console.error("Usage: node tools/read-document.mjs <resource-id>");
  process.exit(2);
}
const gatewayUrl = process.env.PRINCIPALLATCH_GATEWAY_URL;
const passport = process.env.PRINCIPALLATCH_AGENT_PASSPORT;
if (!gatewayUrl || !passport) {
  console.error("PrincipalLatch runtime identity is unavailable");
  process.exit(3);
}
try {
  const response = await fetch(
    gatewayUrl.replace(/\\\/$/, "") + "/v1/documents/" + encodeURIComponent(resourceId),
    { headers: { Authorization: "AgentPassport " + passport } },
  );
  const payload = await response.json();
  console.log(JSON.stringify({ httpStatus: response.status, ...payload }, null, 2));
} catch {
  console.error("PrincipalLatch gateway could not be reached");
  process.exit(4);
}
`;
