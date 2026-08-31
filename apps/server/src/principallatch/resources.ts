import { randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type { ResourceCatalogEntry } from "./contracts.js";
import { DEMO_RESOURCE_CATALOG } from "./fixtures.js";

type ProtectedContent = Record<string, string>;

export class ResourceCatalog {
  private lookupCounter = 0;

  list(): ResourceCatalogEntry[] {
    return DEMO_RESOURCE_CATALOG.map((entry) => structuredClone(entry));
  }

  lookup(resourceId: string): ResourceCatalogEntry | null {
    this.lookupCounter += 1;
    const entry = DEMO_RESOURCE_CATALOG.find((item) => item.id === resourceId);
    return entry ? structuredClone(entry) : null;
  }

  get lookupCount(): number {
    return this.lookupCounter;
  }

  resetCounters(): void {
    this.lookupCounter = 0;
  }
}

export class ProtectedContentProvider {
  private readonly readCounts = new Map<string, number>();
  private readonly forcedFailures = new Set<string>();
  private content: ProtectedContent | null = null;

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      this.content = parseProtectedContent(await readFile(this.filePath, "utf8"));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const generated: ProtectedContent = {
      "alice-doc-001":
        "MOCK PRIVATE CANARY — Alice Project Aurora — " +
        randomBytes(24).toString("hex"),
      "bob-payroll-001":
        "MOCK PRIVATE CANARY — Bob payroll planning — " +
        randomBytes(24).toString("hex"),
    };
    const serialized = JSON.stringify(generated, null, 2) + "\n";
    try {
      const handle = await open(this.filePath, "wx", 0o600);
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.content = generated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      this.content = parseProtectedContent(await readFile(this.filePath, "utf8"));
    }
  }

  async readContent(resourceId: string): Promise<string> {
    this.readCounts.set(resourceId, this.readCount(resourceId) + 1);
    if (this.forcedFailures.has(resourceId)) {
      throw new Error("Protected content provider is unavailable");
    }
    const content = this.content?.[resourceId];
    if (content === undefined) {
      throw new Error("Protected content record not found");
    }
    return content;
  }

  readCount(resourceId: string): number {
    return this.readCounts.get(resourceId) ?? 0;
  }

  counters(): Record<string, number> {
    return Object.fromEntries(
      DEMO_RESOURCE_CATALOG.map((resource) => [
        resource.id,
        this.readCount(resource.id),
      ]),
    );
  }

  setForcedFailure(resourceId: string, enabled: boolean): void {
    if (enabled) this.forcedFailures.add(resourceId);
    else this.forcedFailures.delete(resourceId);
  }

  resetCounters(): void {
    this.readCounts.clear();
  }
}

function parseProtectedContent(serialized: string): ProtectedContent {
  const parsed = JSON.parse(serialized) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Protected content file must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const expectedIds = DEMO_RESOURCE_CATALOG.map((resource) => resource.id).sort();
  if (Object.keys(record).sort().join("\n") !== expectedIds.join("\n")) {
    throw new Error("Protected content file has unexpected resource IDs");
  }
  const content: ProtectedContent = {};
  for (const id of expectedIds) {
    const value = record[id];
    if (typeof value !== "string" || value.length < 32 || value.length > 2_000) {
      throw new Error("Protected content entry is invalid: " + id);
    }
    content[id] = value;
  }
  return content;
}
