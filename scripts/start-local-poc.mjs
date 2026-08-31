#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const command = isWindows ? "powershell.exe" : "bash";
const scriptPath = path.join(
  scriptsDirectory,
  isWindows ? "start-local-poc.ps1" : "start-local-poc.sh",
);
const args = isWindows
  ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath]
  : [scriptPath];

const result = spawnSync(command, args, {
  cwd: path.dirname(scriptsDirectory),
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  console.error(`[local-poc] Could not launch ${command}: ${result.error.message}`);
  process.exitCode = 2;
} else if (typeof result.status === "number") {
  process.exitCode = result.status;
} else {
  const conventionalSignalExitCodes = { SIGINT: 130, SIGTERM: 143 };
  process.exitCode = conventionalSignalExitCodes[result.signal] ?? 1;
}
