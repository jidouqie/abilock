import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { getEventListeners, once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ssh2, { type Attributes, type Connection as SSHConnection } from "ssh2";
import type { AdapterContext, Operation } from "../src/connections.js";
import { openTerminal, sshAdapter } from "../src/protocols/ssh.js";
import { AppError } from "../src/schema.js";

const { Server, utils } = ssh2;
const { STATUS_CODE: S, OPEN_MODE: O } = utils.sftp;
const password = "synthetic-ssh-password-733184";
type SyntheticKeys = { private: string; public: string };
type SyntheticKeyOptions = {
  cipher: string;
  passphrase: string;
  rounds: number;
};
function syntheticEd25519Keys(
  options?: SyntheticKeyOptions,
  generate: () => SyntheticKeys = () =>
    utils.generateKeyPairSync("ed25519", options),
): SyntheticKeys {
  // ssh2 1.17.0's test key generator strips every leading zero from the ASN.1
  // BIT STRING instead of only its unused-bits byte. A valid Ed25519 public
  // key beginning with zero consequently becomes <32 bytes and is rejected by
  // its own parser. Only regenerate this identifiable fixture-generation bug;
  // never ignore other parsing failures or weaken the product key parser.
  for (let attempt = 0; attempt < 16; attempt++) {
    const pair = generate();
    const parsed = utils.parseKey(pair.public);
    if (!(parsed instanceof Error)) return pair;
    const [type, encoded] = pair.public.trim().split(/\s+/);
    const blob = Buffer.from(encoded ?? "", "base64");
    const shortened =
      parsed.message === "Malformed OpenSSH public key" &&
      type === "ssh-ed25519" &&
      blob.length >= 19 &&
      blob.readUInt32BE(0) === 11 &&
      blob.subarray(4, 15).toString() === "ssh-ed25519" &&
      blob.readUInt32BE(15) > 0 &&
      blob.readUInt32BE(15) < 32 &&
      blob.length === 19 + blob.readUInt32BE(15);
    assert(shortened, `unexpected synthetic keygen failure: ${parsed.message}`);
  }
  throw new Error(
    "synthetic Ed25519 keygen remained truncated after 16 attempts",
  );
}
type Entry = { bytes?: Buffer; mode: number; target?: string };
async function fixture(stall?: "shell" | "exec" | "sftp" | "lstat" | "close" | "rename-failure") {
  let notifyStall!: () => void;
  const stalled = new Promise<void>((resolve) => {
    notifyStall = resolve;
  });
  const keys = syntheticEd25519Keys();
  const privateKeys = syntheticEd25519Keys({
    cipher: "aes256-ctr",
    passphrase: "synthetic-passphrase-1340",
    rounds: 16,
  });
  const parsedPublic = utils.parseKey(privateKeys.public);
  assert(!(parsedPublic instanceof Error) && !Array.isArray(parsedPublic));
  const entries = new Map<string, Entry>([
    ["/", { mode: 0o40755 }],
    ["/srv", { mode: 0o40755 }],
    ["/srv/work", { mode: 0o40700 }],
    ["/srv/work/hello.txt", { bytes: Buffer.from("hello\n"), mode: 0o100600 }],
    ["/outside", { bytes: Buffer.from("outside"), mode: 0o100600 }],
    ["/srv/work/link", { mode: 0o120777, target: "/outside" }],
  ]);
  const clients = new Set<SSHConnection>();
  const commands: string[] = [];
  const windows: number[][] = [];
  const attrs = (entry: Entry): Attributes => ({
    mode: entry.mode,
    size: entry.bytes?.length ?? 0,
    uid: 1000,
    gid: 1000,
    atime: 1,
    mtime: 1,
  });
  const server = new Server({ hostKeys: [keys.private] }, (client) => {
    clients.add(client);
    client.once("close", () => clients.delete(client));
    client.on("error", () => undefined);
    client.on("authentication", (ctx) => {
      if (ctx.username !== "fixture") return ctx.reject();
      if (ctx.method === "password" && ctx.password === password)
        return ctx.accept();
      if (
        ctx.method === "publickey" &&
        ctx.key.data.equals(parsedPublic.getPublicSSH()) &&
        (!ctx.signature ||
          (ctx.blob &&
            parsedPublic.verify(ctx.blob, ctx.signature, ctx.hashAlgo)))
      )
        return ctx.accept();
      ctx.reject();
    });
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (accept, _reject, info) => {
          windows.push([info.rows, info.cols]);
          accept();
        });
        session.on("window-change", (_accept, _reject, info) =>
          windows.push([info.rows, info.cols]),
        );
        session.on("shell", (accept) => {
          if (stall === "shell") {
            notifyStall();
            return;
          }
          const stream = accept();
          stream.write("fixture-terminal\n");
          stream.on("error", () => undefined);
          stream.once("end", () => {
            stream.exit(0);
            stream.end("eof\n");
          });
          stream.on("data", (chunk: Buffer) => {
            const input = chunk.toString();
            if (input.includes("\u0003")) {
              stream.exit(130);
              stream.end("interrupted\n");
            } else if (input.includes("exit7")) {
              stream.exit(7);
              stream.end("bye7\n");
            } else if (input.includes("exit")) {
              stream.exit(0);
              stream.end("bye\n");
            } else {
              stream.write("echo:");
              stream.write(chunk);
            }
          });
        });
        session.on("exec", (accept, _reject, info) => {
          if (stall === "exec") {
            notifyStall();
            return;
          }
          commands.push(info.command);
          const stream = accept();
          stream.on("error", () => undefined);
          if (info.command === "slow") return;
          if (info.command === "missing-status") {
            stream.end("channel closed without exit-status\n", () =>
              stream.close(),
            );
            return;
          }
          if (info.command === "fail") {
            stream.stderr.write("remote failure");
            stream.exit(7);
            stream.end();
            return;
          }
          if (info.command === "leak") {
            stream.write(password.slice(0, 10));
            stream.write(password.slice(10));
            stream.stderr.write(Buffer.from(password).toString("base64"));
            stream.exit(0);
            stream.end();
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (b: Buffer) => chunks.push(b));
          stream.on("end", () => {
            stream.write(
              `${info.command}\n${Buffer.concat(chunks).toString()}`,
            );
            stream.exit(0);
            stream.end();
          });
        });
        session.on("sftp", (accept) => {
          if (stall === "sftp") {
            notifyStall();
            return;
          }
          const sftp = accept();
          let id = 0;
          const handles = new Map<string, { path: string; listed?: boolean }>();
          const handle = (filename: string) => {
            const h = Buffer.from(`h${id++}`);
            handles.set(h.toString(), { path: filename });
            return h;
          };
          const canonical = (filename: string): string => {
            const normalized = path.posix.normalize(filename);
            const parts = normalized.split("/").filter(Boolean);
            let current = "/";
            for (let i = 0; i < parts.length; i++) {
              current = path.posix.join(current, parts[i]);
              const item = entries.get(current);
              if (item?.target)
                return canonical(
                  path.posix.join(item.target, ...parts.slice(i + 1)),
                );
            }
            return current;
          };
          const leafPath = (filename: string) =>
            filename === "/"
              ? "/"
              : path.posix.join(
                  canonical(path.posix.dirname(filename)),
                  path.posix.basename(filename),
                );
          sftp.on("REALPATH", (req, filename) => {
            const file = canonical(filename);
            if (!entries.has(file)) return sftp.status(req, S.NO_SUCH_FILE);
            sftp.name(req, [
              {
                filename: file,
                longname: file,
                attrs: attrs(entries.get(file)!),
              },
            ]);
          });
          sftp.on("LSTAT", (req, filename) => {
            if (stall === "lstat") {
              notifyStall();
              return;
            }
            const e = entries.get(leafPath(filename));
            if (!e) return sftp.status(req, S.NO_SUCH_FILE);
            sftp.attrs(req, attrs(e));
          });
          sftp.on("STAT", (req, filename) => {
            const e = entries.get(canonical(filename));
            if (!e) return sftp.status(req, S.NO_SUCH_FILE);
            sftp.attrs(req, attrs(e));
          });
          sftp.on("FSTAT", (req, h) => {
            const entry = handles.get(h.toString());
            if (!entry || !entries.has(entry.path))
              return sftp.status(req, S.FAILURE);
            sftp.attrs(req, attrs(entries.get(entry.path)!));
          });
          sftp.on("OPEN", (req, filename, flags) => {
            const existed = entries.has(filename);
            if (flags & O.EXCL && existed) return sftp.status(req, S.FAILURE);
            if (flags & O.WRITE && flags & O.CREAT) {
              if (!entries.has(path.posix.dirname(filename)))
                return sftp.status(req, S.NO_SUCH_FILE);
              entries.set(filename, { mode: 0o100600, bytes: Buffer.alloc(0) });
            }
            if (!entries.has(filename)) return sftp.status(req, S.NO_SUCH_FILE);
            sftp.handle(req, handle(filename));
          });
          sftp.on("WRITE", (req, h, offset, data) => {
            const e = handles.get(h.toString());
            if (!e) return sftp.status(req, S.FAILURE);
            const entry = entries.get(e.path)!;
            const bytes = Buffer.alloc(
              Math.max(entry.bytes?.length ?? 0, offset + data.length),
            );
            entry.bytes?.copy(bytes);
            data.copy(bytes, offset);
            entry.bytes = bytes;
            sftp.status(req, S.OK);
          });
          sftp.on("READ", (req, h, offset, length) => {
            const e = handles.get(h.toString());
            if (!e) return sftp.status(req, S.FAILURE);
            const bytes = entries.get(e.path)?.bytes ?? Buffer.alloc(0);
            if (offset >= bytes.length) return sftp.status(req, S.EOF);
            sftp.data(req, bytes.subarray(offset, offset + length));
          });
          sftp.on("CLOSE", (req, h) => {
            if (stall === "close") {
              notifyStall();
              return;
            }
            handles.delete(h.toString());
            sftp.status(req, S.OK);
          });
          sftp.on("SETSTAT", (req) => sftp.status(req, S.OK));
          sftp.on("FSETSTAT", (req) => sftp.status(req, S.OK));
          sftp.on("OPENDIR", (req, filename) => {
            const entry = entries.get(filename);
            if (!entry) return sftp.status(req, S.NO_SUCH_FILE);
            if ((entry.mode & 0o170000) !== 0o040000)
              return sftp.status(req, S.FAILURE);
            sftp.handle(req, handle(filename));
          });
          sftp.on("READDIR", (req, h) => {
            const e = handles.get(h.toString());
            if (!e) return sftp.status(req, S.FAILURE);
            if (e.listed) return sftp.status(req, S.EOF);
            e.listed = true;
            const rows = [...entries]
              .filter(([p]) => p !== e.path && path.posix.dirname(p) === e.path)
              .map(([p, entry]) => ({
                filename: path.posix.basename(p),
                longname: path.posix.basename(p),
                attrs: attrs(entry),
              }));
            if (!rows.length) return sftp.status(req, S.EOF);
            sftp.name(req, rows);
          });
          sftp.on("MKDIR", (req, filename) => {
            if (entries.has(filename)) return sftp.status(req, S.FAILURE);
            if (!entries.has(path.posix.dirname(filename)))
              return sftp.status(req, S.NO_SUCH_FILE);
            entries.set(filename, { mode: 0o40700 });
            sftp.status(req, S.OK);
          });
          sftp.on("REMOVE", (req, filename) => {
            if (!entries.has(filename)) return sftp.status(req, S.NO_SUCH_FILE);
            entries.delete(filename);
            sftp.status(req, S.OK);
          });
          sftp.on("RMDIR", (req, filename) => {
            if (!entries.has(filename)) return sftp.status(req, S.NO_SUCH_FILE);
            if (
              [...entries.keys()].some(
                (p) => p !== filename && p.startsWith(`${filename}/`),
              )
            )
              return sftp.status(req, S.FAILURE);
            entries.delete(filename);
            sftp.status(req, S.OK);
          });
          sftp.on("RENAME", (req, oldname, newname) => {
            if (stall === "rename-failure") return sftp.status(req, S.FAILURE);
            const e = entries.get(oldname);
            if (!e) return sftp.status(req, S.NO_SUCH_FILE);
            entries.set(newname, e);
            entries.delete(oldname);
            sftp.status(req, S.OK);
          });
          sftp.on("EXTENDED", (req) => sftp.status(req, S.OP_UNSUPPORTED));
        });
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const context: AdapterContext = {
    connection: {
      alias: "SSH_FIXTURE",
      name: "temporary SSH protocol fixture",
      kind: "ssh",
      enabled: true,
      description: "",
      config: {
        host: "127.0.0.1",
        port,
        username: "fixture",
        remoteRoot: "/srv/work",
        fileAccess: "readwrite",
      },
    },
    secret: { password },
    signal: new AbortController().signal,
    allowLocal: true,
    dataDir: "/unused",
  };
  return {
    context,
    stalled,
    commands,
    entries,
    windows,
    privateKeys,
    async close() {
      for (const c of clients) c.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
function operation(args: string[], extra: Partial<Operation> = {}): Operation {
  return { args, timeoutMs: 5000, ...extra };
}

test("合成Ed25519 fixture仅重生成已识别的上游截断错误，有界且不吞其他错误", () => {
  const valid = syntheticEd25519Keys();
  const blob = Buffer.from(valid.public.split(/\s+/)[1], "base64");
  const shortened = Buffer.concat([blob.subarray(0, 19), blob.subarray(20)]);
  shortened.writeUInt32BE(31, 15);
  const bad = {
    private: "unused synthetic key",
    public: `ssh-ed25519 ${shortened.toString("base64")}`,
  };
  let attempts = 0;
  const recovered = syntheticEd25519Keys(undefined, () =>
    ++attempts === 1 ? bad : valid,
  );
  assert.equal(recovered, valid);
  assert.equal(attempts, 2);
  attempts = 0;
  assert.throws(
    () =>
      syntheticEd25519Keys(undefined, () => {
        attempts++;
        return bad;
      }),
    /after 16 attempts/,
  );
  assert.equal(attempts, 16);
  assert.throws(
    () =>
      syntheticEd25519Keys(undefined, () => ({
        private: "unused",
        public: "malformed synthetic key",
      })),
    /unexpected synthetic keygen failure/,
  );
  for (let i = 0; i < 1024; i++) {
    const pair = syntheticEd25519Keys();
    assert(!(utils.parseKey(pair.public) instanceof Error));
  }
});

function dnsOnlyContext(signal = new AbortController().signal): AdapterContext {
  return {
    connection: {
      alias: "SSH_DNS_SYNTHETIC",
      name: "synthetic unresolved SSH target",
      kind: "ssh",
      enabled: true,
      description: "no transport is created",
      config: {
        host: "pending.abilock.invalid",
        username: "fixture",
      },
    },
    secret: { password },
    signal,
    allowLocal: true,
    dataDir: "/unused",
  };
}

test("SSH exec/SFTP/PTY在未完成DNS时超时或取消，迟到结果不建socket且卸载abort监听", async (t) => {
  const finish: ((rows: { address: string; family: number }[]) => void)[] = [];
  const lookup = t.mock.method(
    dns,
    "lookup",
    () => new Promise((resolve) => finish.push(resolve)),
  );
  const sockets = t.mock.method(net, "connect", () => {
    throw new Error("unexpected socket during cancelled DNS");
  });
  const phases: AbortSignal[] = [];
  const originalAny = AbortSignal.any;
  const composites = t.mock.method(
    AbortSignal,
    "any",
    (signals: AbortSignal[]) => {
      const phase = originalAny.call(AbortSignal, signals);
      phases.push(phase);
      return phase;
    },
  );
  const controller = new AbortController();
  const brokerController = new AbortController();
  const bounded = async <T>(promise: Promise<T>) => {
    let timer: NodeJS.Timeout;
    const guard = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("SSH DNS wait ignored its deadline")),
        1000,
      );
    });
    try {
      return await Promise.race([promise, guard]);
    } finally {
      clearTimeout(timer!);
    }
  };
  try {
    for (const args of [
      ["echo", "synthetic"],
      ["sftp", "stat", "synthetic.txt"],
    ]) {
      const start = Date.now();
      await assert.rejects(
        bounded(
          sshAdapter.run(dnsOnlyContext(), operation(args, { timeoutMs: 100 })),
        ),
        { code: "SSH_CANCELLED", status: 499 },
      );
      assert(Date.now() - start < 1000);
    }
    const terminal = openTerminal(dnsOnlyContext(controller.signal), {
      rows: 24,
      cols: 80,
    });
    controller.abort();
    await assert.rejects(bounded(terminal), {
      code: "SSH_CANCELLED",
      status: 499,
    });
    const brokerReason = new AppError(
      504,
      "UPSTREAM_TIMEOUT",
      "synthetic broker deadline",
    );
    const brokerTerminal = openTerminal(
      dnsOnlyContext(brokerController.signal),
      { rows: 24, cols: 80 },
    );
    brokerController.abort(brokerReason);
    await assert.rejects(
      bounded(brokerTerminal),
      (error) => error === brokerReason,
    );
    assert.equal(lookup.mock.callCount(), 4);
    assert.equal(sockets.mock.callCount(), 0);
    for (const phase of phases)
      assert.equal(getEventListeners(phase, "abort").length, 0);
    for (const resolve of finish)
      resolve([{ address: "127.0.0.1", family: 4 }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sockets.mock.callCount(), 0);
  } finally {
    controller.abort();
    brokerController.abort();
    lookup.mock.restore();
    sockets.mock.restore();
    composites.mock.restore();
  }
});

test("SSH/PTY的15秒连接期限从DNS前开始，超时后迟到DNS不能创建socket", async (t) => {
  let finish!: (rows: { address: string; family: number }[]) => void;
  const lookup = t.mock.method(
    dns,
    "lookup",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const sockets = t.mock.method(net, "connect", () => {
    throw new Error("unexpected socket after DNS deadline");
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const waiting = openTerminal(dnsOnlyContext(), { rows: 24, cols: 80 });
    assert.equal(lookup.mock.callCount(), 1);
    t.mock.timers.tick(15000);
    await assert.rejects(waiting, { code: "SSH_CONNECT_TIMEOUT", status: 504 });
    assert.equal(sockets.mock.callCount(), 0);
    finish([{ address: "127.0.0.1", family: 4 }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sockets.mock.callCount(), 0);
  } finally {
    lookup.mock.restore();
    sockets.mock.restore();
    t.mock.timers.reset();
  }
});

test("SSH真实协议fixture：命令、stdin、退出状态、私钥身份与秘密过滤", async () => {
  const f = await fixture();
  try {
    const run = await sshAdapter.run(
      f.context,
      operation(["--", "printf", "'%s'", "business"], {
        input: "stdin-content",
      }),
    );
    assert.equal(run.exitCode, 0);
    assert.equal(run.stdout, "printf '%s' business\nstdin-content");
    const fail = await sshAdapter.run(f.context, operation(["fail"]));
    assert.equal(fail.exitCode, 7);
    assert.match(fail.stderr!, /remote failure/);
    const leak = await sshAdapter.run(f.context, operation(["leak"]));
    assert(!JSON.stringify(leak).includes(password));
    assert(
      !JSON.stringify(leak).includes(Buffer.from(password).toString("base64")),
    );
    const privateContext = {
      ...f.context,
      secret: {
        privateKey: f.privateKeys.private,
        passphrase: "synthetic-passphrase-1340",
      },
    };
    const authenticated = await sshAdapter.run(
      privateContext,
      operation(["private-key-test"]),
    );
    assert.equal(authenticated.exitCode, 0);
  } finally {
    await f.close();
  }
});

test("SSH固定目标/身份、兼容旧指纹、取消与超时", async () => {
  const f = await fixture();
  try {
    for (const args of [
      ["-o", "ProxyCommand=sh"],
      ["-F", "/tmp/config"],
      ["-A"],
      ["--password", "value"],
    ])
      await assert.rejects(
        sshAdapter.run(f.context, operation(args)),
        /SSH|命令/,
      );
    assert.deepEqual(f.commands, []);
    const wrong = {
      ...f.context,
      connection: {
        ...f.context.connection,
        config: {
          ...f.context.connection.config,
          hostKeySHA256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    };
    assert.equal((await sshAdapter.run(wrong, operation(["echo"]))).exitCode, 0);
    await assert.rejects(
      sshAdapter.run(
        { ...f.context, secret: { password: "wrong-synthetic-password" } },
        operation(["echo"]),
      ),
      /authentication|SSH/i,
    );
    const controller = new AbortController();
    const slow = sshAdapter.run(
      { ...f.context, signal: controller.signal },
      operation(["slow"]),
    );
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(slow, /取消/);
    await assert.rejects(
      sshAdapter.run(f.context, operation(["slow"], { timeoutMs: 100 })),
      /取消/,
    );
    await assert.rejects(
      sshAdapter.run({ ...f.context, allowLocal: false }, operation(["echo"])),
      /目标/,
    );
  } finally {
    await f.close();
  }
});

test("SSH channel未发送exit-status时返回255，明确非零状态仍保留", async () => {
  const f = await fixture();
  try {
    const missing = await sshAdapter.run(
      f.context,
      operation(["missing-status"]),
    );
    assert.equal(missing.exitCode, 255);
    assert.match(missing.stdout!, /without exit-status/);
    assert.match(missing.stderr!, /未报告/);
    const nonzero = await sshAdapter.run(f.context, operation(["fail"]));
    assert.equal(nonzero.exitCode, 7);
  } finally {
    await f.close();
  }
});

test("SSH交互PTY、resize、跨chunk秘密过滤与关闭", async () => {
  const f = await fixture();
  try {
    const terminal = await openTerminal(f.context, { rows: 24, cols: 80 });
    let output = "";
    terminal.stream.on("data", (b: Buffer) => {
      output += b.toString();
    });
    terminal.resize(30, 100);
    terminal.stream.write(`${password}\n`);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    terminal.stream.write("exit\n");
    await once(terminal.stream, "end");
    assert.match(output, /fixture-terminal/);
    assert(!output.includes(password));
    assert.match(output, /REDACTED/);
    assert(f.windows.some(([r, c]) => r === 24 && c === 80));
    assert(f.windows.some(([r, c]) => r === 30 && c === 100));
    terminal.close();
  } finally {
    await f.close();
  }
});

test("SSH终端Ctrl-C/EOF/非零退出和主动中断", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    for (const [input, code] of [
      ["\u0003", 130],
      ["exit7\n", 7],
    ] as const) {
      const terminal = await openTerminal(f.context, { rows: 24, cols: 80 });
      terminal.stream.resume();
      const exited = once(terminal.stream, "exit");
      const ended = once(terminal.stream, "end");
      terminal.stream.write(input);
      assert.equal((await exited)[0], code);
      await ended;
      terminal.close();
    }
    const eof = await openTerminal(f.context, { rows: 24, cols: 80 });
    eof.stream.resume();
    const exited = once(eof.stream, "exit");
    const ended = once(eof.stream, "end");
    eof.stream.end();
    assert.equal((await exited)[0], 0);
    await ended;
    eof.close();
    const controller = new AbortController();
    const cancellable = await openTerminal(
      { ...f.context, signal: controller.signal },
      { rows: 24, cols: 80 },
    );
    const failed = once(cancellable.stream, "error");
    controller.abort();
    assert.match(String((await failed)[0]), /取消/);
  } finally {
    await f.close();
  }
});

test("SFTP without atomic rename keeps original files even when ordinary rename would fail", async () => {
  const f = await fixture("rename-failure");
  try {
    const original = Buffer.from(f.entries.get("/srv/work/hello.txt")!.bytes!);
    await assert.rejects(sshAdapter.run(f.context,
      operation(["sftp", "put", "upload.txt", "hello.txt"], {
        files: [{ path: "upload.txt", base64: Buffer.from("replacement").toString("base64") }],
      })), { code: "SSH_ATOMIC_OVERWRITE_REQUIRED" });
    assert.deepEqual(f.entries.get("/srv/work/hello.txt")!.bytes, original);
    assert.ok(![...f.entries.keys()].some((filename) => filename.includes(".abl-")));
  } finally { await f.close(); }
});

test("SFTP协议往返、目录操作、SCP与增量同步", async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from([0, 1, 2, 255, 13, 10]);
    const files = [{ path: "local.bin", base64: bytes.toString("base64") }];
    await sshAdapter.run(f.context, operation(["sftp", "mkdir", "nested"]));
    await sshAdapter.run(
      f.context,
      operation(["sftp", "put", "local.bin", "nested/file.bin"], { files }),
    );
    const downloaded = await sshAdapter.run(
      f.context,
      operation(["sftp", "get", "nested/file.bin", "download.bin"]),
    );
    assert(Buffer.from(downloaded.files![0].base64, "base64").equals(bytes));
    const stats = await sshAdapter.run(
      f.context,
      operation(["sftp", "stat", "nested/file.bin"]),
    );
    assert.equal((stats.data as { size: number }).size, bytes.length);
    const listing = await sshAdapter.run(
      f.context,
      operation(["sftp", "ls", "nested"]),
    );
    assert.equal((listing.data as { name: string }[])[0].name, "file.bin");
    await sshAdapter.run(
      f.context,
      operation(["scp", "local.bin", ":copy.bin"], { files }),
    );
    const scp = await sshAdapter.run(
      f.context,
      operation(["scp", ":copy.bin", "copied.bin"]),
    );
    assert(Buffer.from(scp.files![0].base64, "base64").equals(bytes));
    const manifest = [
      { path: "bundle/a.txt", base64: Buffer.from("aaa").toString("base64") },
      {
        path: "bundle/sub/b.txt",
        base64: Buffer.from("bbb").toString("base64"),
      },
    ];
    const first = await sshAdapter.run(
      f.context,
      operation(["rsync", "-r", "bundle", ":sync"], { files: manifest }),
    );
    assert.equal((first.data as { changed: string[] }).changed.length, 2);
    const second = await sshAdapter.run(
      f.context,
      operation(["rsync", "--checksum", "bundle", ":sync"], {
        files: manifest,
      }),
    );
    assert.equal((second.data as { skipped: string[] }).skipped.length, 2);
    const changedFiles = [
      {
        path: "bundle/a.txt",
        base64: Buffer.from("changed").toString("base64"),
      },
    ];
    const dry = await sshAdapter.run(
      f.context,
      operation(["rsync", "--dry-run", "--delete", "bundle", ":sync"], {
        files: changedFiles,
      }),
    );
    assert.equal((dry.data as { changed: string[] }).changed.length, 1);
    assert(f.entries.has("/srv/work/sync/sub/b.txt"));
    await assert.rejects(sshAdapter.run(
      f.context,
      operation(["rsync", "--delete", "bundle", ":sync"], {
        files: changedFiles,
      }),
    ), { code: "SSH_ATOMIC_OVERWRITE_REQUIRED" });
    assert(f.entries.has("/srv/work/sync/sub/b.txt"));
    assert.equal(
      f.entries.get("/srv/work/sync/a.txt")?.bytes?.toString(),
      "aaa",
    );
    const directory = await sshAdapter.run(
      f.context,
      operation(["scp", "-r", ":sync", "localdir"]),
    );
    assert.equal(directory.files![0].path, "localdir/a.txt");
    await sshAdapter.run(
      f.context,
      operation(["sftp", "rm", "nested/file.bin"]),
    );
    await sshAdapter.run(f.context, operation(["sftp", "rmdir", "nested"]));
    assert(!f.entries.has("/srv/work/nested"));
  } finally {
    await f.close();
  }
});

test("SFTP路径穿越/链接/只读/本机执行扩展/秘密二进制泄漏失败", async () => {
  const f = await fixture();
  try {
    for (const args of [
      ["sftp", "get", "../outside"],
      ["sftp", "get", "/outside"],
      ["sftp", "get", "link"],
      ["sftp", "stat", "link"],
      ["scp", "-S", "/bin/sh"],
      ["rsync", "-e", "ssh"],
      ["sftp", "!", "sh"],
    ])
      await assert.rejects(sshAdapter.run(f.context, operation(args)));
    await assert.rejects(
      sshAdapter.run(
        f.context,
        operation(["sftp", "put", "/etc/passwd", "target"]),
      ),
      /封装|files/,
    );
    const readonly = {
      ...f.context,
      connection: {
        ...f.context.connection,
        config: { ...f.context.connection.config, fileAccess: "read" },
      },
    };
    await assert.rejects(
      sshAdapter.run(readonly, operation(["sftp", "rm", "hello.txt"])),
      /读取/,
    );
    f.entries.set("/srv/work/leak.bin", {
      mode: 0o100600,
      bytes: Buffer.concat([
        Buffer.from([0, 255]),
        Buffer.from(password),
        Buffer.from([128]),
      ]),
    });
    const get = await sshAdapter.run(
      f.context,
      operation(["sftp", "get", "leak.bin"]),
    );
    const result = Buffer.from(get.files![0].base64, "base64");
    assert(!result.includes(Buffer.from(password)));
    assert.equal(result[0], 0);
    assert.equal(result[1], 255);
    assert.equal(result[result.length - 1], 128);
  } finally {
    await f.close();
  }
});

test("SCP目录/特殊路径与rsync exclude保护、dry-run和增量", async () => {
  const f = await fixture();
  try {
    const files = [
      {
        path: "bundle/a 文件.txt",
        base64: Buffer.from("unicode filename").toString("base64"),
      },
      {
        path: "bundle/sub/b.bin",
        base64: Buffer.from([0, 255, 8]).toString("base64"),
      },
      {
        path: "bundle/debug.log",
        base64: Buffer.from("do not upload").toString("base64"),
      },
      {
        path: "bundle/cache/nested.txt",
        base64: Buffer.from("excluded directory").toString("base64"),
      },
    ];
    await sshAdapter.run(
      f.context,
      operation(["scp", "-r", "bundle", ":copy dir"], { files }),
    );
    const copy = await sshAdapter.run(
      f.context,
      operation(["scp", "-r", ":copy dir", "download dir"]),
    );
    assert(copy.files?.some((file) => file.path === "download dir/a 文件.txt"));
    assert(
      Buffer.from(
        copy.files!.find((file) => file.path.endsWith("b.bin"))!.base64,
        "base64",
      ).equals(Buffer.from([0, 255, 8])),
    );
    const initial = await sshAdapter.run(
      f.context,
      operation(
        [
          "rsync",
          "--exclude=*.log",
          "--exclude",
          "cache/",
          "bundle",
          ":excluded dir",
        ],
        { files },
      ),
    );
    assert.equal((initial.data as { excluded: string[] }).excluded.length, 2);
    assert(!f.entries.has("/srv/work/excluded dir/debug.log"));
    f.entries.set("/srv/work/excluded dir/debug.log", {
      mode: 0o100600,
      bytes: Buffer.from("keep excluded"),
    });
    const unchanged = await sshAdapter.run(
      f.context,
      operation(
        [
          "rsync",
          "--delete",
          "--exclude=*.log",
          "--exclude=cache/",
          "bundle",
          ":excluded dir",
        ],
        { files },
      ),
    );
    assert.equal((unchanged.data as { skipped: string[] }).skipped.length, 2);
    assert(f.entries.has("/srv/work/excluded dir/debug.log"));
    const dryFiles = files.map((file) =>
      file.path.endsWith("b.bin")
        ? { ...file, base64: Buffer.from("changed").toString("base64") }
        : file,
    );
    const dry = await sshAdapter.run(
      f.context,
      operation(
        [
          "rsync",
          "--dry-run",
          "--exclude=*.log",
          "--exclude=cache/",
          "bundle",
          ":excluded dir",
        ],
        { files: dryFiles },
      ),
    );
    assert.equal((dry.data as { changed: string[] }).changed.length, 1);
    assert(
      f.entries
        .get("/srv/work/excluded dir/sub/b.bin")
        ?.bytes?.equals(Buffer.from([0, 255, 8])),
    );
    await assert.rejects(
      sshAdapter.run(
        f.context,
        operation(["rsync", "--exclude=[ab]", "bundle", ":excluded dir"], {
          files,
        }),
      ),
      /exclude/,
    );
  } finally {
    await f.close();
  }
});

test("SFTP拒绝root内外祖先链接及remoteRoot自己的链接祖先", async () => {
  const f = await fixture();
  try {
    f.entries.set("/srv/work/inside", { mode: 0o40700 });
    f.entries.set("/srv/work/inside/data.txt", {
      mode: 0o100600,
      bytes: Buffer.from("business"),
    });
    f.entries.set("/outside-dir", { mode: 0o40700 });
    f.entries.set("/outside-dir/data.txt", {
      mode: 0o100600,
      bytes: Buffer.from("outside business"),
    });
    f.entries.set("/srv/work/inside-link", {
      mode: 0o120777,
      target: "/srv/work/inside",
    });
    f.entries.set("/srv/work/outside-link", {
      mode: 0o120777,
      target: "/outside-dir",
    });
    const files = [
      {
        path: "synthetic.txt",
        base64: Buffer.from("upload").toString("base64"),
      },
    ];
    for (const link of ["inside-link", "outside-link"]) {
      for (const args of [
        ["sftp", "get", `${link}/data.txt`],
        ["sftp", "stat", `${link}/data.txt`],
        ["sftp", "put", "synthetic.txt", `${link}/new.txt`],
        ["sftp", "mkdir", `${link}/new-directory`],
        ["scp", "-r", "bundle", `:${link}/upload`],
      ])
        await assert.rejects(
          sshAdapter.run(f.context, operation(args, { files })),
          /符号链接|路径/,
        );
    }
    f.entries.set("/srv-link", { mode: 0o120777, target: "/srv" });
    const linkedRoot = {
      ...f.context,
      connection: {
        ...f.context.connection,
        config: {
          ...f.context.connection.config,
          remoteRoot: "/srv-link/work",
        },
      },
    };
    await assert.rejects(
      sshAdapter.run(linkedRoot, operation(["sftp", "get", "hello.txt"])),
      /符号链接|路径/,
    );
    assert.equal(
      f.entries.get("/srv/work/inside/data.txt")?.bytes?.toString(),
      "business",
    );
    assert(!f.entries.has("/srv/work/inside/new.txt"));
    assert(!f.entries.has("/outside-dir/new.txt"));
  } finally {
    await f.close();
  }
});

test("SFTP目录上传与下载一致限制16层，17层整份manifest在写入前拒绝", async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from("depth-boundary").toString("base64");
    const nested16 = Array.from({ length: 16 }, (_, i) => `d${i}`).join("/");
    const nested17 = `${nested16}/d16`;
    const accepted = [{ path: `bundle/${nested16}/data.txt`, base64: bytes }];
    await sshAdapter.run(
      f.context,
      operation(["scp", "-r", "bundle", ":depth16"], {
        files: accepted,
        timeoutMs: 15000,
      }),
    );
    const download = await sshAdapter.run(
      f.context,
      operation(["scp", "-r", ":depth16", "download"], { timeoutMs: 15000 }),
    );
    assert.equal(download.files![0].path, `download/${nested16}/data.txt`);
    const rejected = [
      { path: "bundle/first.txt", base64: bytes },
      { path: `bundle/${nested17}/data.txt`, base64: bytes },
    ];
    for (const args of [
      ["scp", "-r", "bundle", ":depth17"],
      ["rsync", "bundle", ":depth17"],
      ["rsync", "--dry-run", "bundle", ":depth17"],
      ["rsync", "--exclude=**", "bundle", ":depth17"],
    ])
      await assert.rejects(
        sshAdapter.run(f.context, operation(args, { files: rejected })),
        /16层/,
      );
    assert(!f.entries.has("/srv/work/depth17"));
    f.entries.set(`/srv/work/depth16/${nested17}`, { mode: 0o40700 });
    f.entries.set(`/srv/work/depth16/${nested17}/file.txt`, {
      mode: 0o100600,
      bytes: Buffer.from("too deep"),
    });
    await assert.rejects(
      sshAdapter.run(
        f.context,
        operation(["scp", "-r", ":depth16", "download"], { timeoutMs: 15000 }),
      ),
      /16层/,
    );
  } finally {
    await f.close();
  }
});

test("系统OpenSSH临时sshd：能力检查与可用时真实exec/SFTP", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux")
    return t.skip("系统sshd不在支持测试路径");
  const executable =
    process.platform === "darwin" ? "/usr/sbin/sshd" : "/usr/sbin/sshd";
  try {
    await fs.access(executable);
  } catch {
    return t.skip("系统sshd不存在；未安装或修改系统");
  }
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "abl-openssh-fixture-")),
  );
  const host = syntheticEd25519Keys();
  const identity = syntheticEd25519Keys();
  const hostPath = path.join(directory, "host");
  const authorized = path.join(directory, "authorized");
  const configuration = path.join(directory, "sshd_config");
  const reserving = net.createServer();
  await new Promise<void>((resolve) =>
    reserving.listen(0, "127.0.0.1", resolve),
  );
  const port = (reserving.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reserving.close(() => resolve()));
  await fs.writeFile(hostPath, host.private, { mode: 0o600 });
  await fs.writeFile(authorized, identity.public, { mode: 0o600 });
  await fs.writeFile(
    configuration,
    `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${hostPath}\nPidFile ${directory}/pid\nAuthorizedKeysFile ${authorized}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nUsePAM no\nStrictModes no\nPermitRootLogin no\nAllowUsers ${os.userInfo().username}\nSubsystem sftp internal-sftp\nLogLevel ERROR\n`,
    { mode: 0o600 },
  );
  // All settings and keys are temporary. No global sshd configuration is read or changed.
  const child = spawn(executable, ["-D", "-e", "-f", configuration], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { PATH: "/usr/bin:/bin" },
  });
  let errors = "";
  child.stderr.on("data", (b: Buffer) => {
    errors += b.toString();
  });
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    if (child.exitCode !== null)
      return t.skip(
        `临时sshd无法启动，未安装/改权限：${errors.trim().slice(0, 400)}`,
      );
    const context: AdapterContext = {
      connection: {
        alias: "OPENSSH_LOCAL",
        name: "temporary real OpenSSH",
        kind: "ssh",
        enabled: true,
        description: "",
        config: {
          host: "127.0.0.1",
          port,
          username: os.userInfo().username,
          remoteRoot: directory,
          fileAccess: "readwrite",
        },
      },
      secret: { privateKey: identity.private },
      signal: new AbortController().signal,
      allowLocal: true,
      dataDir: "/unused",
    };
    const execute = await sshAdapter.run(
      context,
      operation(["printf", "abl-openssh-ok"]),
    );
    assert.equal(execute.stdout, "abl-openssh-ok");
    assert.equal(execute.exitCode, 0);
    const bytes = Buffer.from("real-openssh-sftp");
    await sshAdapter.run(
      context,
      operation(["sftp", "put", "synthetic.txt", "transferred.txt"], {
        files: [{ path: "synthetic.txt", base64: bytes.toString("base64") }],
      }),
    );
    const downloaded = await sshAdapter.run(
      context,
      operation(["sftp", "get", "transferred.txt"]),
    );
    assert(Buffer.from(downloaded.files![0].base64, "base64").equals(bytes));
    const manifest = [
      {
        path: "bundle/a 文件.txt",
        base64: Buffer.from("openssh-directory").toString("base64"),
      },
      {
        path: "bundle/sub/b.bin",
        base64: Buffer.from([0, 255, 128]).toString("base64"),
      },
    ];
    await sshAdapter.run(
      context,
      operation(["scp", "-r", "bundle", ":copy dir"], { files: manifest }),
    );
    const scp = await sshAdapter.run(
      context,
      operation(["scp", "-r", ":copy dir", "retrieved"]),
    );
    assert(scp.files?.some((file) => file.path === "retrieved/a 文件.txt"));
    assert(
      Buffer.from(
        scp.files!.find((file) => file.path.endsWith("b.bin"))!.base64,
        "base64",
      ).equals(Buffer.from([0, 255, 128])),
    );
    // Exercise the parent-link regression on the real temporary filesystem as
    // well as the in-memory SFTP wire fixture. Both targets stay synthetic.
    await fs.symlink("sub", path.join(directory, "copy dir/inside-link"));
    await assert.rejects(
      sshAdapter.run(
        context,
        operation(["sftp", "get", "copy dir/inside-link/b.bin"]),
      ),
      /符号链接|路径/,
    );
    await assert.rejects(
      sshAdapter.run(
        context,
        operation(
          ["sftp", "put", "synthetic.txt", "copy dir/inside-link/new.txt"],
          {
            files: [
              { path: "synthetic.txt", base64: bytes.toString("base64") },
            ],
          },
        ),
      ),
      /符号链接|路径/,
    );
    await assert.rejects(
      fs.access(path.join(directory, "copy dir/sub/new.txt")),
    );
    const initial = await sshAdapter.run(
      context,
      operation(["rsync", "bundle", ":sync dir"], { files: manifest }),
    );
    assert.equal((initial.data as { changed: string[] }).changed.length, 2);
    const repeated = await sshAdapter.run(
      context,
      operation(["rsync", "bundle", ":sync dir"], { files: manifest }),
    );
    assert.equal((repeated.data as { skipped: string[] }).skipped.length, 2);
    const changed = [
      {
        ...manifest[0],
        base64: Buffer.from("openssh-changed").toString("base64"),
      },
    ];
    const dry = await sshAdapter.run(
      context,
      operation(["rsync", "--dry-run", "--delete", "bundle", ":sync dir"], {
        files: changed,
      }),
    );
    assert.equal((dry.data as { changed: string[] }).changed.length, 1);
    assert.equal(
      await fs.readFile(path.join(directory, "sync dir/a 文件.txt"), "utf8"),
      "openssh-directory",
    );
    await sshAdapter.run(
      context,
      operation(["rsync", "--delete", "bundle", ":sync dir"], {
        files: changed,
      }),
    );
    assert.equal(
      await fs.readFile(path.join(directory, "sync dir/a 文件.txt"), "utf8"),
      "openssh-changed",
    );
    await assert.rejects(fs.access(path.join(directory, "sync dir/sub/b.bin")));
    t.diagnostic(
      "真实系统OpenSSH exec、SFTP祖先链接拒绝、SCP目录及rsync增量通过，身份/配置/文件均临时",
    );
  } finally {
    child.kill("SIGTERM");
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test(
  "SSH pending channel and SFTP callbacks settle on cancel without continuing requests",
  { timeout: 10000 },
  async () => {
    for (const phase of ["exec", "sftp", "lstat", "shell", "close"] as const) {
      const f = await fixture(phase);
      const controller = new AbortController();
      const context = {
        ...f.context,
        signal: controller.signal,
        connection: {
          ...f.context.connection,
          config: { ...f.context.connection.config, allowShell: true },
        },
      };
      try {
        const waiting =
          phase === "shell"
            ? openTerminal(context, { rows: 24, cols: 80 })
            : sshAdapter.run(
                context,
                operation(
                  phase === "exec"
                    ? ["printf", "synthetic"]
                    : phase === "close"
                      ? ["sftp", "put", "synthetic.txt", "held-close.txt"]
                      : ["sftp", "stat", "hello.txt"],
                  phase === "close"
                    ? {
                        files: [
                          {
                            path: "synthetic.txt",
                            base64: Buffer.from(
                              "synthetic close test",
                            ).toString("base64"),
                          },
                        ],
                      }
                    : {},
                ),
              );
        const rejected = assert.rejects(waiting, {
          code: "UPSTREAM_TIMEOUT",
          status: 504,
        });
        await Promise.race([
          f.stalled,
          new Promise<never>((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("fixture did not reach pending callback")),
              2000,
            );
            timer.unref();
          }),
        ]);
        const start = Date.now();
        controller.abort(
          new AppError(504, "UPSTREAM_TIMEOUT", "synthetic callback deadline"),
        );
        await rejected;
        assert(Date.now() - start < 500);
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      } finally {
        controller.abort();
        await f.close();
      }
    }
  },
);
