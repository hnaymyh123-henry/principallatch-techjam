#!/usr/bin/env node

import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const excluded = new Set([".git", "node_modules", "dist", ".local", ".playwright-cli"]);
const markdownFiles = [];

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excluded.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(absolute);
    else if (entry.name.endsWith(".md")) markdownFiles.push(absolute);
  }
}

await collect(root);
const failures = [];
let checked = 0;
for (const file of markdownFiles) {
  const markdown = await readFile(file, "utf8");
  for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
    const rawTarget = match[1]?.trim() ?? "";
    if (
      !rawTarget ||
      rawTarget.startsWith("#") ||
      /^(?:https?:|mailto:)/i.test(rawTarget)
    ) {
      continue;
    }
    const withoutTitle = rawTarget.replace(/^<|>$/g, "").split(/\s+["']/u, 1)[0];
    const relativeTarget = decodeURIComponent(withoutTitle.split("#", 1)[0] ?? "");
    if (!relativeTarget) continue;
    const absoluteTarget = path.resolve(path.dirname(file), relativeTarget);
    checked += 1;
    try {
      await access(absoluteTarget);
    } catch {
      failures.push(
        `${path.relative(root, file)} -> ${relativeTarget}`,
      );
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`Broken local Markdown links:\n${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Checked ${checked} local links across ${markdownFiles.length} Markdown files.\n`,
  );
}
