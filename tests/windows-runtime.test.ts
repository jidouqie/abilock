import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { windowsPaths, sameWindowsPath, windowsHostEnvironment } from "../src/windows-paths.js";
import { readWindowsBootstrapRequest } from "../src/windows-bootstrap.js";
import { readBootstrapPassword } from "../src/isolation-bootstrap.js";
import { assertWindowsEnvironment } from "../src/windows-environment.js";
import { windowsBootstrapFailure, type WindowsBootstrapStage } from "../src/windows-worker.js";
import { AppError } from "../src/schema.js";

test("Windows paths accept native folders with spaces and reject ambiguous roots", () => {
  const result = windowsPaths({
    ProgramFiles: "D:\\Program Files",
    ProgramData: "D:\\ProgramData",
    SystemRoot: "D:\\Windows",
  });
  assert.equal(result.host, "D:\\Program Files\\Abilock\\Abilock.Host.exe");
  assert.equal(result.data, "D:\\ProgramData\\Abilock\\private");
  for (const value of [
    "relative",
    "\\\\server\\share",
    "C:\\safe\\..\\other",
    "C:\\safe\nother",
  ])
    assert.throws(() => windowsPaths({ ProgramFiles: value }));
  assert.equal(
    sameWindowsPath(
      "C:\\Program Files\\Abilock\\",
      "c:\\program files\\abilock",
    ),
    true,
  );
  assert.equal(
    sameWindowsPath(
      "C:\\Program Files\\Abilock-other",
      "C:\\Program Files\\Abilock",
    ),
    false,
  );
});

test("Windows clean environments derive the system drive and discard inherited overrides", async () => {
  const moduleUrl = new URL("../bin/windows-platform.mjs", import.meta.url).href;
  const { windowsClientEnvironment } = await import(moduleUrl) as {
    windowsClientEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  };
  const input = {
    SystemRoot: "D:\\Windows",
    SystemDrive: "Z:",
    ProgramFiles: "E:\\Program Files",
    ProgramData: "F:\\ProgramData",
    NODE_OPTIONS: "--import synthetic-untrusted-module",
    ABILOCK_MASTER_KEY: "synthetic-value-not-forwarded",
    PATH: "Z:\\untrusted",
  };
  for (const environment of [windowsClientEnvironment(input), windowsHostEnvironment(input)]) {
    assert.equal(environment.SystemDrive, "D:");
    assert.equal(environment.SystemRoot, input.SystemRoot);
    assert.equal(environment.ProgramFiles, input.ProgramFiles);
    assert.equal(environment.ProgramData, input.ProgramData);
    assert.equal(environment.PATH, "D:\\Windows\\System32");
    assert.equal("NODE_OPTIONS" in environment, false);
    assert.equal("ABILOCK_MASTER_KEY" in environment, false);
  }
});

test("Windows bootstrap accepts only the closed password or verification contract", async () => {
  assert.deepEqual(
    await readWindowsBootstrapRequest(Readable.from(['{"verify":true}'])),
    { verify: true },
  );
  const value = "🔒".repeat(130);
  assert.deepEqual(
    await readWindowsBootstrapRequest(
      Readable.from([JSON.stringify({ password: value })]),
    ),
    { password: value },
  );
  for (const value of [
    { verify: false },
    { verify: true, password: "synthetic-password" },
    { password: "short" },
    { password: "x".repeat(257) },
    { reset: true },
    { password: "synthetic-password", path: "C:\\other" },
  ])
    await assert.rejects(
      readWindowsBootstrapRequest(Readable.from([JSON.stringify(value)])),
    );
  await assert.rejects(
    readWindowsBootstrapRequest(Readable.from([" ".repeat(8193)])),
  );
  await assert.rejects(
    readBootstrapPassword(Readable.from(['{"verify":true}'])),
  );
});

test("Windows worker cannot run as an ordinary development process", async () => {
  await assert.rejects(assertWindowsEnvironment(), {
    code: "ISOLATION_INVALID",
  });
});

test("Windows bootstrap diagnostics disclose only fixed stages and approved codes", () => {
  const fakeCredential = "FAKE_BOOTSTRAP_CREDENTIAL_MUST_NOT_APPEAR";
  const codes = [
    "CONFIG_REQUIRED", "LOCAL_CONFIG_INVALID", "CONFIG_BUSY", "BOOTSTRAP_BUSY",
    "PRIVATE_PATH_INVALID", "LOCK_FAILED", "ISOLATION_INVALID", "BOOTSTRAP_FAILED",
  ];
  for (const stage of ["environment", "input", "verify", "initialize"] as const) {
    for (const code of codes) {
      const error = new AppError(503, code, `password=${fakeCredential}; C:\\private\\service.env`);
      error.stack = `Error: ${fakeCredential}\n    at C:\\private\\service.env:1`;
      error.cause = { password: fakeCredential, path: "C:\\private\\service.env" };
      const diagnostic = windowsBootstrapFailure(stage, error);
      assert.deepEqual(diagnostic, { ok: false, event: "bootstrap-failed", stage, code });
      const output = JSON.stringify(diagnostic);
      assert.equal(output.includes(fakeCredential), false);
      assert.equal(output.includes("service.env"), false);
    }
  }
  for (const error of [
    new Error(fakeCredential),
    new AppError(503, fakeCredential, fakeCredential),
    { code: "CONFIG_REQUIRED", message: fakeCredential },
    fakeCredential,
  ]) {
    assert.deepEqual(windowsBootstrapFailure("initialize", error), {
      ok: false, event: "bootstrap-failed", stage: "initialize", code: "BOOTSTRAP_FAILED",
    });
  }
  assert.equal(windowsBootstrapFailure(fakeCredential as WindowsBootstrapStage, new Error(fakeCredential)).stage, "environment");
});

test("standalone bootstrap failure uses its closed JSON channel and ordinary modes keep stderr", () => {
  const fakeCredential = "FAKE_STDIN_CREDENTIAL_MUST_NOT_APPEAR";
  const worker = fileURLToPath(new URL("../src/windows-worker.ts", import.meta.url));
  for (const mode of ["bootstrap", "execute"]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", worker, mode], {
      encoding: "utf8",
      input: JSON.stringify({ password: fakeCredential }),
      timeout: 20000,
      maxBuffer: 16384,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 3);
    assert.equal((result.stdout + result.stderr).includes(fakeCredential), false);
    if (mode === "bootstrap") {
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: false, event: "bootstrap-failed", stage: "environment", code: "ISOLATION_INVALID",
      });
    } else {
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /ISOLATION_INVALID: The protected Windows runtime is unavailable\./);
    }
  }
});
