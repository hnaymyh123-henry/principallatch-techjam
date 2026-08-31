import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProtectedContentProvider } from "./resources.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("protected mock content", () => {
  it("generates persistent deployment-specific canaries outside source code", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "principallatch-content-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "trusted", "content.json");
    const first = new ProtectedContentProvider(filePath);
    await first.initialize();
    const alice = await first.readContent("alice-doc-001");
    const serialized = await readFile(filePath, "utf8");

    expect(alice).toMatch(/^MOCK PRIVATE CANARY/);
    expect(serialized).toContain(alice);

    const restarted = new ProtectedContentProvider(filePath);
    await restarted.initialize();
    expect(await restarted.readContent("alice-doc-001")).toBe(alice);
  });
});
