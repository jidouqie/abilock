import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

test("local IPC restores binary output, distinguishes completion, and cancels without a listener", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-ipc-"));
  try {
    await fs.mkdir(path.join(dir, "bin"));
    await fs.mkdir(path.join(dir, "dist/src"), { recursive: true });
    await fs.copyFile(
      new URL("../bin/local-transport.mjs", import.meta.url),
      path.join(dir, "bin/local-transport.mjs"),
    );
    for (const name of [
      "isolated-transport.mjs",
      "windows-transport.mjs",
      "windows-platform.mjs",
      "open-config.mjs",
      "remote-fetch.mjs",
    ])
      await fs.copyFile(
        new URL(`../bin/${name}`, import.meta.url),
        path.join(dir, "bin", name),
      );
    await fs.copyFile(
      new URL("../request-limits.json", import.meta.url),
      path.join(dir, "request-limits.json"),
    );
    await fs.writeFile(
      path.join(dir, "dist/src/local-worker.js"),
      `
      process.on('message', m => {
        if (m.type === 'cancel') process.exit(0);
        if (m.type !== 'request') return;
        if (m.url === '/wait') return;
        process.send({type:'headers',status:200,headers:{'content-type':'application/octet-stream'}});
        process.stdout.write(Buffer.from([0,255,10,13]));
        if (m.url === '/fail') { process.send({type:'done',failed:true},()=>process.disconnect()); return; }
        process.send({type:'done'},()=>process.disconnect());
      });
    `,
    );
    const source = `
      import assert from 'node:assert/strict';
      import {brokerFetch,localBase,remoteExecution} from './bin/local-transport.mjs';
      assert.equal(remoteExecution(),false);
      const response = await brokerFetch(new URL('/ok',localBase));
      assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[0,255,10,13]);
      const failed = await brokerFetch(new URL('/fail',localBase));
      await assert.rejects(failed.arrayBuffer(), e => e.code === 'LOCAL_EXECUTION');
      const controller = new AbortController();
      const pending = brokerFetch(new URL('/wait',localBase),{signal:controller.signal});
      setTimeout(()=>controller.abort(),100);
      await assert.rejects(pending,e => e.name === 'AbortError' || e.code === 'LOCAL_EXECUTION');
      console.log('verified');
    `;
    const result = await new Promise<{
      code: number | null;
      out: string;
      err: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", source],
        {
          cwd: dir,
          env: {
            ABILOCK_DEVELOPMENT: "1",
            PATH: path.dirname(process.execPath),
            HOME: dir,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "",
        err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, out, err }));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 10000);
      child.once("close", () => clearTimeout(timer));
    });
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out.trim(), "verified");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
