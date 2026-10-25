import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { Writable, type Readable } from "node:stream";
import {
  runLocalWorker,
  type LocalWorkerTransport,
  type WorkerMessage,
} from "./local-worker.js";
import {
  assertIsolatedEnvironment,
  assertIsolatedAdmin,
  isolatedDataRoot,
  isolatedProgramRoot,
} from "./isolated-environment.js";

// A request may contain a 20 MiB UTF-8 body. JSON escaping can enlarge it.
export const isolatedFrameLimit = 128 * 1024 * 1024;
const chunkLimit = 64 * 1024;

/** One-way public frames: this adapter never serializes runtime state. */
export function createStdioWorkerTransport(
  input: Readable,
  output: Writable,
): LocalWorkerTransport {
  const events = new EventEmitter();
  let pending = Buffer.alloc(0),
    closed = false,
    failed = false;
  const send = (message: WorkerMessage) =>
    new Promise<void>((resolve, reject) => {
      if (closed || output.destroyed) {
        reject(new Error("Transport closed"));
        return;
      }
      let text: string;
      try {
        text = JSON.stringify(message) + "\n";
        if (Buffer.byteLength(text) > isolatedFrameLimit)
          throw new Error("Frame too large");
      } catch {
        reject(new Error("Invalid frame"));
        return;
      }
      output.write(text, (error) => (error ? reject(error) : resolve()));
    });
  const disconnect = () => {
    if (failed || closed) return;
    failed = true;
    pending = Buffer.alloc(0);
    events.emit("disconnect");
    input.destroy();
  };
  const onData = (raw: Buffer | string) => {
    if (closed || failed) return;
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    // Bound memory even when no newline is supplied by an untrusted caller.
    if (pending.length + chunk.length > isolatedFrameLimit) {
      disconnect();
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    while (pending.length) {
      const newline = pending.indexOf(10);
      if (newline < 0) break;
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (!line.length || line.length > isolatedFrameLimit) {
        disconnect();
        return;
      }
      try {
        const frame = JSON.parse(line.toString("utf8")) as unknown;
        if (!frame || typeof frame !== "object" || Array.isArray(frame))
          throw new Error("Invalid frame");
        events.emit("message", frame);
      } catch {
        disconnect();
        return;
      }
    }
  };
  const body = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      void (async () => {
        for (let index = 0; index < chunk.length; index += chunkLimit)
          await send({
            type: "body",
            data: chunk.subarray(index, index + chunkLimit).toString("base64"),
          });
      })().then(() => callback(), callback);
    },
  });
  // Reading starts only after runLocalWorker has registered its message handler.
  return {
    output: body,
    send,
    onMessage: (receive) => {
      events.on("message", receive);
      input.on("data", onData);
      input.once("end", disconnect);
      input.once("error", disconnect);
    },
    onDisconnect: (cancel) => events.once("disconnect", cancel),
    offDisconnect: (cancel) => events.off("disconnect", cancel),
    close: () => {
      if (closed) return;
      closed = true;
      pending = Buffer.alloc(0);
      input.off("data", onData);
      input.off("end", disconnect);
      input.off("error", disconnect);
      input.destroy();
      events.removeAllListeners();
    },
  };
}

export async function runIsolatedWorker() {
  if (process.argv.slice(2).length !== 0) {
    process.stderr.write("ISOLATION_INVALID: 隔离执行入口不接受额外参数\n");
    process.exitCode = 2;
    return;
  }
  try {
    await assertIsolatedEnvironment();
    await assertIsolatedAdmin();
    runLocalWorker(createStdioWorkerTransport(process.stdin, process.stdout), {
      dir: isolatedDataRoot,
      programRoot: isolatedProgramRoot,
    });
  } catch {
    // Even an unexpected privileged-runtime error must not print diagnostics.
    process.stderr.write("ISOLATION_INVALID: 隔离执行程序不可用\n");
    process.exitCode = 3;
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
  void runIsolatedWorker();
