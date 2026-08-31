import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));

function baseEnvironment(stateRoot) {
  return {
    ...process.env,
    ARK_API_KEY: "test-key",
    ARK_MODEL: "test-model",
    APP_AUTH_TOKEN: "0123456789abcdefghijklmn",
    LOCAL_POC_DATA_ROOT: stateRoot,
  };
}

function invokeLauncher(environment) {
  return spawnSync(process.execPath, [path.join(scriptsDirectory, "start-local-poc.mjs")], {
    cwd: path.dirname(scriptsDirectory),
    encoding: "utf8",
    env: environment,
    timeout: 10_000,
  });
}

test("cross-platform POC launcher fails closed before creating state when its engine is absent", () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "principallatch-poc-launcher-"));
  const stateRoot = path.join(temporaryRoot, "must-not-exist");
  try {
    const result = invokeLauncher({
      ...baseEnvironment(stateRoot),
      CONTAINER_ENGINE: "principallatch-engine-that-does-not-exist",
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 2);
    assert.match(`${result.stdout}\n${result.stderr}`, /CONTAINER_ENGINE=.*was not found/i);
    assert.equal(existsSync(stateRoot), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("cross-platform POC launcher rejects reuse of the Agent-readable Ark key", () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "principallatch-poc-secret-separation-"));
  const stateRoot = path.join(temporaryRoot, "must-not-exist");
  try {
    const repeatedSecret = "0123456789abcdefghijklmn";
    const result = invokeLauncher({
      ...baseEnvironment(stateRoot),
      ARK_API_KEY: repeatedSecret,
      APP_AUTH_TOKEN: repeatedSecret,
      CONTAINER_ENGINE: "principallatch-engine-that-does-not-exist",
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 2);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /must be independently generated secrets/i,
    );
    assert.equal(existsSync(stateRoot), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("cross-platform POC launcher rejects a root Agent Runtime identity before creating state", () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "principallatch-poc-root-user-"));
  const stateRoot = path.join(temporaryRoot, "must-not-exist");
  try {
    const result = invokeLauncher({
      ...baseEnvironment(stateRoot),
      CONTAINER_USER: "0:0",
      CONTAINER_ENGINE: "principallatch-engine-that-does-not-exist",
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 2);
    assert.match(`${result.stdout}\n${result.stderr}`, /non-root CONTAINER_USER/i);
    assert.equal(existsSync(stateRoot), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("POC startup and shutdown both report a stale Runtime removal failure", () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "principallatch-poc-cleanup-"));
  const fakeBin = path.join(temporaryRoot, "bin");
  const stateRoot = path.join(temporaryRoot, "must-not-exist");
  try {
    mkdirSync(fakeBin);
    if (process.platform === "win32") {
      writeFileSync(
        path.join(fakeBin, "docker.cmd"),
        [
          "@echo off",
          'if "%1"=="info" exit /b 0',
          'if "%1"=="ps" echo stale-runtime& exit /b 0',
          'if "%1"=="rm" exit /b 9',
          "exit /b 0",
        ].join("\r\n"),
      );
    } else {
      const fakeDocker = path.join(fakeBin, "docker");
      writeFileSync(
        fakeDocker,
        '#!/usr/bin/env sh\ncase "$1" in info) exit 0;; ps) echo stale-runtime; exit 0;; rm) exit 9;; *) exit 0;; esac\n',
      );
      chmodSync(fakeDocker, 0o755);
    }

    const result = invokeLauncher({
      ...baseEnvironment(stateRoot),
      CONTAINER_ENGINE: "docker",
      RUNTIME_INSTANCE_ID: "cleanup-failure-test",
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    });
    const output = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.error, undefined);
    assert.equal(result.status, 2);
    assert.match(output, /Failed to remove Agent Runtime container stale-runtime/i);
    assert.match(output, /stale Agent Runtime cleanup failed; startup is blocked/i);
    assert.match(output, /shutdown cleanup failed/i);
    assert.equal(existsSync(stateRoot), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test(
  "Windows launcher keeps the explicitly preflighted engine first for child processes",
  { skip: process.platform !== "win32" },
  () => {
    const temporaryRoot = mkdtempSync(
      path.join(tmpdir(), "principallatch-poc-explicit-engine-"),
    );
    const wrongBin = path.join(temporaryRoot, "wrong-bin");
    const selectedBin = path.join(temporaryRoot, "selected-bin");
    const stateRoot = path.join(temporaryRoot, "state");
    try {
      mkdirSync(wrongBin);
      mkdirSync(selectedBin);
      writeFileSync(
        path.join(wrongBin, "docker.cmd"),
        [
          "@echo off",
          'if "%1"=="probe" echo WRONG_ENGINE& exit /b 9',
          "exit /b 9",
        ].join("\r\n"),
      );
      writeFileSync(
        path.join(wrongBin, "npm.cmd"),
        ["@echo off", "docker probe", "exit /b %ERRORLEVEL%"].join("\r\n"),
      );
      const selectedDocker = path.join(selectedBin, "docker.cmd");
      writeFileSync(
        selectedDocker,
        [
          "@echo off",
          'if "%1"=="probe" echo SELECTED_ENGINE& exit /b 0',
          'if "%1"=="info" exit /b 0',
          'if "%1"=="ps" exit /b 0',
          "exit /b 0",
        ].join("\r\n"),
      );

      const result = invokeLauncher({
        ...baseEnvironment(stateRoot),
        CONTAINER_ENGINE: selectedDocker,
        RUNTIME_INSTANCE_ID: "explicit-engine-test",
        PATH: `${wrongBin}${path.delimiter}${selectedBin}${path.delimiter}${process.env.PATH ?? ""}`,
      });
      const output = `${result.stdout}\n${result.stderr}`;

      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, output);
      assert.match(output, /SELECTED_ENGINE/);
      assert.doesNotMatch(output, /WRONG_ENGINE/);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);
