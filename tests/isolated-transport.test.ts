import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { createStdioWorkerTransport } from "../src/isolated-worker.js";
import { readBootstrapPassword } from "../src/isolation-bootstrap.js";
import { assertIsolatedEnvironment } from "../src/isolated-environment.js";

const moduleUrl = pathToFileURL(
  path.resolve("bin/isolated-transport.mjs"),
).href;
const local = "http://abilock.local";
function fixture(source: string) {
  return spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: { PATH: path.dirname(process.execPath) },
    stdio: ["pipe", "pipe", "pipe"],
  });
}
async function transport(source: string) {
  const modes: string[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const { createIsolatedTransport } = await import(moduleUrl);
  const client = createIsolatedTransport({
    launch: async (mode: string) => {
      modes.push(mode);
      const child = fixture(source);
      children.push(child);
      return child;
    },
  });
  return { client, modes, children };
}

test("isolated one-shot frames restore binary bytes and reject truncated output", async () => {
  const { client, modes } = await transport(`
    let input='';
    process.stdin.on('data', chunk => {
      input+=chunk;
      if (!input.includes('\\n')) return;
      const request=JSON.parse(input.split('\\n')[0]);
      const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
      send({type:'headers',status:200,headers:{'content-type':'application/octet-stream'}});
      send({type:'body',data:Buffer.from([0,255,10,13]).toString('base64')});
      send({type:'done',failed:request.url==='/fail'});
      process.stdin.destroy();
    });
  `);
  const response = await client.brokerFetch(local + "/ok");
  assert.deepEqual(
    [...new Uint8Array(await response.arrayBuffer())],
    [0, 255, 10, 13],
  );
  const failed = await client.brokerFetch(local + "/fail");
  await assert.rejects(failed.arrayBuffer(), { code: "ISOLATED_EXECUTION" });
  assert.deepEqual(modes, ["execute", "execute"]);
});

test("isolated input only carries business request and trace, and cancellation ends worker", async () => {
  const { client, children } = await transport(`
    let pending='';
    process.stdin.on('data', chunk => {
      pending+=chunk;
      while (pending.includes('\\n')) {
        const at=pending.indexOf('\\n');
        const message=JSON.parse(pending.slice(0,at)); pending=pending.slice(at+1);
        if(message.type==='cancel'){process.stdin.destroy();return;}
        if(message.url==='/wait')return;
        const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
        send({type:'headers',status:200,headers:{'content-type':'application/json'}});
        send({type:'body',data:Buffer.from(JSON.stringify(message)).toString('base64')});
        send({type:'done'}); process.stdin.destroy();
      }
    });
  `);
  const response = await client.brokerFetch(local + "/record", {
    method: "POST",
    body: '{"business":"input"}',
    headers: {
      authorization: "synthetic-caller-secret",
      "x-abilock-invocation-id": "public-trace",
    },
    dir: "/caller-selected",
    env: { NODE_OPTIONS: "--import evil" },
  });
  assert.deepEqual(await response.json(), {
    type: "request",
    url: "/record",
    method: "POST",
    body: '{"business":"input"}',
    headers: { "x-abilock-invocation-id": "public-trace" },
  });
  const controller = new AbortController();
  const pending = client.brokerFetch(local + "/wait", {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  await new Promise<void>((resolve) =>
    children.at(-1)!.once("close", () => resolve()),
  );
  assert.equal(
    children.at(-1)!.exitCode === null && children.at(-1)!.signalCode === null,
    false,
  );
});

test(
  "cancellation lets the supervisor reap a worker that ignores TERM and EOF",
  { timeout: 15000 },
  async () => {
    const { createIsolatedTransport } = await import(moduleUrl);
    let supervisor: ChildProcessWithoutNullStreams | undefined;
    let workerPid: number | undefined;
    let exited:
      | Promise<{ code: number | null; signal: NodeJS.Signals | null }>
      | undefined;
    let closed: Promise<void> | undefined;
    const controller = new AbortController();
    const workerSource = `
    process.on('SIGTERM', () => {});
    process.stdin.on('data', () => {});
    process.stdin.resume();
    process.stdout.write(JSON.stringify({type:'headers',status:200,
      headers:{'x-synthetic-worker-pid':String(process.pid)}})+'\\n');
    setInterval(() => {}, 1000);
  `;
    const client = createIsolatedTransport({
      launch: async () => {
        // Same-user synthetic processes only. The supervisor mirrors the native
        // launcher's five-second grace period and reaps its direct child.
        supervisor = fixture(`
        import {spawn} from 'node:child_process';
        const worker=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(workerSource)}],
          {stdio:['inherit','inherit','inherit']});
        process.stderr.write(String(worker.pid)+'\\n');
        let fallback;
        const stop=()=>{
          worker.kill('SIGTERM');
          if(!fallback) fallback=setTimeout(()=>worker.kill('SIGKILL'),5000);
        };
        process.on('SIGTERM',stop);
        process.on('SIGINT',stop);
        worker.once('exit',(code,signal)=>{
          clearTimeout(fallback);
          process.exit(signal==='SIGKILL'?137:(code??1));
        });
      `);
        let diagnostic = "";
        supervisor.stderr.on("data", (chunk: Buffer) => {
          diagnostic += chunk.toString();
          const match = /^(\d+)\n/.exec(diagnostic);
          if (match) workerPid = Number(match[1]);
        });
        exited = new Promise((resolve) =>
          supervisor!.once("exit", (code, signal) => resolve({ code, signal })),
        );
        closed = new Promise((resolve) =>
          supervisor!.once("close", () => resolve()),
        );
        return supervisor;
      },
    });
    async function bounded<T>(
      promise: Promise<T>,
      milliseconds: number,
    ): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Synthetic process did not finish")),
              milliseconds,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    function terminate(pid: number | undefined) {
      if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) return;
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    try {
      const response = await bounded<Response>(
        client.brokerFetch(local + "/stubborn", {
          signal: controller.signal,
        }),
        5000,
      );
      // Read readiness and identity from the same stream, independent of the
      // scheduling order between stdout and the cleanup-only stderr record.
      const readyPid = Number(response.headers.get("x-synthetic-worker-pid"));
      assert.ok(Number.isSafeInteger(readyPid) && readyPid > 1);
      workerPid = readyPid;
      assert.ok(workerPid && supervisor?.pid);
      const body = assert.rejects(response.text(), { name: "AbortError" });
      controller.abort();
      await body;
      assert.deepEqual(await bounded(exited!, 8000), {
        code: 137,
        signal: null,
      });
      await bounded(closed!, 1000);
      assert.throws(() => process.kill(workerPid!, 0), { code: "ESRCH" });
      assert.throws(() => process.kill(supervisor!.pid!, 0), { code: "ESRCH" });
    } finally {
      controller.abort();
      // This also removes the orphan produced by the original 1.5-second bug.
      terminate(workerPid);
      if (supervisor?.exitCode === null && supervisor.signalCode === null)
        terminate(supervisor.pid);
      if (closed) await bounded(closed, 1000);
    }
  },
);

test("invalid base64 and unrecognized privileged frames fail without diagnostics", async () => {
  for (const frame of [
    { type: "body", data: "%%%" },
    { type: "private-config", env: "synthetic-secret-never-forwarded" },
  ]) {
    const { client } = await transport(`
      process.stderr.write('synthetic-secret-never-forwarded');
      process.stdin.once('data',()=>{
        process.stdout.write(JSON.stringify({type:'headers',status:200,headers:{}})+'\\n');
        process.stdout.write(${JSON.stringify(JSON.stringify(frame) + "\n")});
        process.stdin.destroy();
      });
    `);
    const response = await client.brokerFetch(local + "/invalid");
    await assert.rejects(response.text(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("synthetic-secret"));
      return true;
    });
  }
});

test("configuration readiness opens only its public loopback URL once under caller transport", async () => {
  const { createIsolatedTransport } = await import(moduleUrl);
  const modes: string[] = [],
    opened: string[] = [];
  const client = createIsolatedTransport({
    launch: async (mode: string) => {
      modes.push(mode);
      const child = fixture(`
        process.stdout.write(JSON.stringify({type:'configuration-ready',url:'http://127.0.0.1:12345/'})+'\\n');
        const timer=setTimeout(()=>{process.stdin.destroy()},150);
        process.stdin.on('end',()=>clearTimeout(timer)); process.stdin.resume();
      `);
      return child;
    },
    open: async (url: string) => {
      opened.push(url);
    },
  });
  assert.equal(await client.localConfiguration({ json: true }), 0);
  assert.deepEqual(modes, ["config"]);
  assert.deepEqual(opened, ["http://127.0.0.1:12345/"]);
});

test("stdio worker frames keep body bytes apart from control and close on malformed input", async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  const wire: Buffer[] = [],
    messages: unknown[] = [];
  output.on("data", (chunk: Buffer) => wire.push(chunk));
  const channel = createStdioWorkerTransport(input, output);
  let disconnected = false;
  channel.onDisconnect(() => {
    disconnected = true;
  });
  channel.onMessage((raw) => messages.push(raw));
  input.write('{"type":"request","body":"business"}\n');
  await channel.send({ type: "headers", status: 200, headers: {} });
  await new Promise<void>((resolve, reject) =>
    channel.output.write(Buffer.from([0, 255, 10]), (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  await channel.send({ type: "done" });
  const frames = Buffer.concat(wire)
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ["headers", "body", "done"],
  );
  assert.deepEqual([...Buffer.from(frames[1].data, "base64")], [0, 255, 10]);
  assert.deepEqual(messages, [{ type: "request", body: "business" }]);
  input.write("not-json\n");
  assert.equal(disconnected, true);
  channel.close();
});

test("installer password input is bounded, strict, and never accepted as an environment option", async () => {
  assert.equal(
    await readBootstrapPassword(
      Readable.from(['{"password":"synthetic-password"}']),
    ),
    "synthetic-password",
  );
  for (const value of [
    '{"password":"short"}',
    '{"password":"synthetic-password","target":"caller-change"}',
    '{"password":"synthetic-password","NODE_OPTIONS":"evil"}',
    "x".repeat(8193),
  ])
    await assert.rejects(readBootstrapPassword(Readable.from([value])));
});

test("isolated runtime refuses an ordinary source execution identity before reading data", async () => {
  await assert.rejects(assertIsolatedEnvironment(), (error: unknown) => {
    assert.ok(error && typeof error === "object");
    assert.equal(Reflect.get(error, "code"), "ISOLATION_INVALID");
    return true;
  });
});
