import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadLocalRuntime, localPackageRoot } from "../src/local-state.js";
import { seed } from "../src/seed.js";

const run = promisify(execFile);
const uuid =
  /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
async function bytes(dir: string): Promise<unknown> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return Promise.all(
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const target = path.join(dir, entry.name);
        return [
          entry.name,
          entry.isDirectory()
            ? await bytes(target)
            : (await fs.readFile(target)).toString("base64"),
        ];
      }),
  );
}

test("six concurrent local CLI list/doc calls finish with unique traces while the configuration writer holds its lock", async () => {
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "abilock-local-cli-home-"),
  );
  const root = path.join(home, ".abilock");
  const runtime = await loadLocalRuntime({ dir: root });
  const cli = path.join(localPackageRoot, "bin/abl.mjs");
  const env = {
    ABILOCK_DEVELOPMENT: "1",
    HOME: home,
    USERPROFILE: home,
    LANG: "en_US.UTF-8",
  };
  try {
    await seed(runtime.store, localPackageRoot);
    await fs.access(path.join(root, "data/service.lock"));
    const original = await bytes(root);
    const output = await Promise.all(
      [
        ["list", "--json"],
        ["doc", "DS", "--json"],
        ["list", "--json"],
        ["doc", "ARK", "--json"],
        ["list", "--json"],
        ["doc", "TTS", "--json"],
      ].map((args) =>
        run(process.execPath, [cli, ...args], {
          cwd: home,
          env,
          timeout: 20000,
          maxBuffer: 4 * 1024 * 1024,
        }),
      ),
    );
    const traces = output.map(({ stdout, stderr }, index) => {
      assert.equal(stderr, "");
      assert.ok(!stdout.includes(runtime.execToken));
      assert.ok(!stdout.includes('"sealed"'));
      const result = JSON.parse(stdout) as {
        ok: boolean;
        status: number;
        invocationId: string;
        operationId: string;
        operationIdSource: string;
        data: { capabilities?: unknown[]; docs?: unknown[] };
      };
      assert.equal(result.ok, true);
      assert.equal(result.status, 200);
      assert.match(result.invocationId, uuid);
      assert.match(result.operationId, uuid);
      assert.equal(result.operationIdSource, "server");
      assert.ok(
        index % 2 === 0
          ? result.data.capabilities?.length
          : result.data.docs?.length,
      );
      return result;
    });
    assert.equal(new Set(traces.map((trace) => trace.invocationId)).size, 6);
    assert.equal(new Set(traces.map((trace) => trace.operationId)).size, 6);
    assert.deepEqual(await bytes(root), original);
    await fs.access(path.join(root, "data/service.lock"));

    // A directly addressed disposable worker must finish and close IPC too;
    // this checks termination without inspecting unrelated user processes.
    const child = fork(
      path.join(localPackageRoot, "dist/src/local-worker.js"),
      [],
      {
        cwd: home,
        env: { HOME: home, USERPROFILE: home, LANG: "en_US.UTF-8" },
        execArgv: [],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    let stdout = "",
      stderr = "",
      finished = false;
    const completion = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Synthetic worker did not exit"));
      }, 20000);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("message", (message: unknown) => {
        if (
          message &&
          typeof message === "object" &&
          Reflect.get(message, "type") === "done"
        )
          finished = true;
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        try {
          assert.equal(code, 0);
          assert.ok(finished);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    child.send({
      type: "request",
      url: "/v2/discovery",
      method: "GET",
      headers: {},
    });
    await completion;
    assert.equal(child.connected, false);
    assert.equal(stderr, "");
    assert.ok(JSON.parse(stdout).capabilities.length);
    assert.deepEqual(await bytes(root), original);
  } finally {
    await runtime.store.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});
