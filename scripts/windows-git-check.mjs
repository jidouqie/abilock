import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import https from "node:https";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import ssh2 from "ssh2";
import { createGitAdapter } from "../dist/src/protocols/git.js";

if (process.platform !== "win32") throw new Error("Run this synthetic test on Windows");
const fixtureRoot = path.resolve(process.argv[2] || "");
const architecture = process.argv[3];
if (!fixtureRoot.includes("AbilockHostBuild-") || !["x64", "arm64"].includes(architecture)) throw new Error("Select the owned fixture directory and architecture");
const gitRoot = path.join(fixtureRoot, "git-" + architecture);
const flavor = architecture === "arm64" ? "clangarm64" : "ucrt64";
const binary = path.join(gitRoot, "cmd", "git.exe");
const bridge = path.join(fixtureRoot, "native/windows/prebuilt/Abilock.GitSsh.exe");
const system = process.env.SystemRoot;
const base = await fs.mkdtemp(path.join(fixtureRoot, "git-wire-"));
const dataDir = path.join(base, "data");
const empty = path.join(base, "empty.gitconfig");
await fs.mkdir(dataDir);
await fs.writeFile(empty, "");
const environment = { SystemRoot: system, WINDIR: system,
  PATH: [path.join(gitRoot, "cmd"), path.join(gitRoot, flavor, "bin"), path.join(gitRoot, "usr/bin"), path.join(system, "System32")].join(";"),
  GIT_EXEC_PATH: path.join(gitRoot, flavor, "libexec/git-core"),
  COMSPEC: path.join(system, "System32/cmd.exe") };
const fixtureEnvironment = { ...environment, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: empty,
  GIT_CONFIG_SYSTEM: empty, HOME: base, USERPROFILE: base, GIT_TERMINAL_PROMPT: "0", GIT_ATTR_NOSYSTEM: "1" };
const children = new Set();
const launch = (args, cwd = base) => {
  const child = spawn(binary, args, { cwd, env: fixtureEnvironment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  children.add(child); child.once("close", () => children.delete(child)); return child;
};
const command = (args, cwd = base) => new Promise((resolve, reject) => {
  const child = launch(args, cwd); child.stdin.end(); let out = "", error = "";
  child.stdout.on("data", bytes => out += bytes); child.stderr.on("data", bytes => error += bytes);
  child.once("error", reject); child.once("close", code => code ? reject(new Error("Synthetic Git failed: " + error)) : resolve(out));
});
const activeLocks = new Set();
const adapter = createGitAdapter({ runtime: { windows: true, binary, sshHelper: bridge, environment, validate: async () => {} },
  acquireLock: async filename => {
    if (activeLocks.has(filename)) throw Object.assign(new Error("busy fixture"), { code: "GIT_BUSY" });
    activeLocks.add(filename); return { release: async () => { activeLocks.delete(filename); } };
  } });
const fakePassword = "synthetic-git-password-" + crypto.randomBytes(16).toString("hex");
const source = path.join(base, "source"), bare = path.join(base, "remote.git");
let httpServer, sshServer;
const sshClients = new Set();
let checks = 0, httpCalls = 0, sshCalls = 0, redirect = false, stallSsh = false;
const conn = (alias, config) => ({ alias, name: "Synthetic Git", kind: "git", enabled: true, description: "", trustBoundary: "development-fixture", config });
const context = connection => ({ connection, secret: { username: "fixture", password: fakePassword }, dataDir,
  allowLocal: true, signal: globalThis.AbortSignal.timeout(60000) });
const op = (args, files, deletions) => ({ args, files, deletions, timeoutMs: 60000 });
const content = value => Buffer.from(value).toString("base64");
async function workflow(ctx) {
  const cloned = await adapter.run(ctx, op(["clone", "--branch", "main"]));
  assert.equal(cloned.exitCode, 0, cloned.stderr); checks++;
  const id = cloned.data.repoId;
  const fetched = await adapter.run(ctx, op(["fetch", id])); assert.equal(fetched.exitCode, 0, fetched.stderr); checks++;
  await fs.writeFile(path.join(source, "upstream.txt"), "upstream change\n");
  await command(["add", "upstream.txt"], source);
  await command(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "upstream"], source);
  await command(["push", bare, "main"], source);
  const pulled = await adapter.run(ctx, op(["pull", id, "--ff-only"])); assert.equal(pulled.exitCode, 0, pulled.stderr); checks++;
  const committed = await adapter.run(ctx, op(["commit", id, "-m", "Abilock Windows"], [{ path: "committed.txt", base64: content("Windows Git complete\n") }],
    [{ path: "upstream.txt", sha256: crypto.createHash("sha256").update("upstream change\n").digest("hex") }]));
  assert.equal(committed.exitCode, 0, committed.stderr); checks++;
  const pushed = await adapter.run(ctx, op(["push", id, "HEAD:main"])); assert.equal(pushed.exitCode, 0, pushed.stderr); checks++;
  assert.equal(await command(["show", "main:committed.txt"], bare), "Windows Git complete\n"); checks++;
  assert.ok(!(await command(["ls-tree", "-r", "--name-only", "main"], bare)).includes("upstream.txt")); checks++;
  const status = await adapter.run(ctx, op(["status", id, "--short"])); assert.equal(status.stdout, ""); checks++;
  const log = await adapter.run(ctx, op(["log", id, "--oneline"])); assert.equal(log.exitCode, 0); checks++;
  assert.ok(!JSON.stringify([cloned, fetched, pulled, committed, pushed, status, log]).includes(fakePassword)); checks++;
  return id;
}
try {
  await command(["init", "-b", "main", source]);
  await fs.writeFile(path.join(source, "README.md"), "Synthetic Windows Git\n");
  await command(["add", "README.md"], source);
  await command(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"], source);
  await command(["clone", "--bare", source, bare]);
  const cert = await fs.readFile(path.join(fixtureRoot, "tls-cert.pem"));
  const key = await fs.readFile(path.join(fixtureRoot, "tls-key.pem"));
  const expected = "Basic " + Buffer.from("fixture:" + fakePassword).toString("base64");
  httpServer = https.createServer({ key, cert }, (request, response) => {
    httpCalls++;
    if (redirect) { response.writeHead(302, { location: "https://example.invalid/never" }).end(); request.resume(); return; }
    if (request.headers.authorization !== expected) { response.writeHead(401).end("Synthetic auth denied"); request.resume(); return; }
    const url = new URL(request.url, "https://127.0.0.1");
    const service = url.searchParams.get("service") === "git-receive-pack" || url.pathname.endsWith("git-receive-pack") ? "receive-pack" : "upload-pack";
    const advertisement = request.method === "GET" && url.pathname === "/repo.git/info/refs";
    if (!advertisement && !(request.method === "POST" && url.pathname === "/repo.git/git-" + service)) { response.writeHead(404).end(); request.resume(); return; }
    response.writeHead(200, { "content-type": "application/x-git-" + service + (advertisement ? "-advertisement" : "-result") });
    if (advertisement) {
      const header = "# service=git-" + service + "\n";
      response.write((Buffer.byteLength(header) + 4).toString(16).padStart(4, "0") + header + "0000");
    }
    const child = launch([service, "--stateless-rpc", ...(advertisement ? ["--advertise-refs"] : []), bare]);
    if (advertisement) child.stdin.end(); else request.pipe(child.stdin);
    child.stdout.pipe(response, { end: false }); child.stderr.resume(); child.stdin.on("error", () => {});
    child.once("close", () => response.end()); response.once("close", () => { if (!response.writableEnded) child.kill(); });
  });
  await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
  const httpsConnection = conn("WINHTTP", { transport: "https", url: `https://127.0.0.1:${httpServer.address().port}/repo.git`, authType: "basic", ca: cert.toString() });
  await workflow(context(httpsConnection));
  const wrong = await adapter.run({ ...context(httpsConnection), secret: { username: "fixture", password: "wrong-synthetic" } }, op(["clone"]));
  assert.notEqual(wrong.exitCode, 0); checks++;
  redirect = true;
  const redirected = await adapter.run(context(httpsConnection), op(["clone"])); assert.notEqual(redirected.exitCode, 0); checks++; redirect = false;
  // Reset the synthetic source to the bare tip before the SSH workflow.
  await command(["fetch", bare, "main"], source); await command(["reset", "--hard", "FETCH_HEAD"], source);
  const hostKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs1" });
  const fingerprint = "SHA256:" + crypto.createHash("sha256").update(ssh2.utils.parseKey(hostKey).getPublicSSH()).digest("base64").replace(/=+$/, "");
  sshServer = new ssh2.Server({ hostKeys: [hostKey] }, client => {
    sshClients.add(client); client.on("error", () => {}); client.once("close", () => sshClients.delete(client));
    client.on("authentication", auth => auth.method === "password" && auth.username === "fixture" && auth.password === fakePassword ? auth.accept() : auth.reject());
    client.on("ready", () => client.on("session", accept => accept().on("exec", (acceptExec, reject, info) => {
      const service = info.command === "git-upload-pack '/fixture.git'" ? "upload-pack" : info.command === "git-receive-pack '/fixture.git'" ? "receive-pack" : undefined;
      if (!service) { reject(); return; }
      sshCalls++; const channel = acceptExec(); if (stallSsh) return;
      const child = launch([service, bare]); channel.pipe(child.stdin); child.stdout.pipe(channel); child.stderr.pipe(channel.stderr);
      child.stdin.on("error", () => {}); child.once("close", code => { channel.exit(code || 0); channel.end(); }); channel.once("close", () => child.kill());
    })));
  });
  await new Promise(resolve => sshServer.listen(0, "127.0.0.1", resolve));
  const sshConnection = conn("WINSSH", { transport: "ssh", host: "127.0.0.1", port: sshServer.address().port, username: "fixture", path: "/fixture.git", hostKeySha256: fingerprint });
  const sshContext = { ...context(sshConnection), secret: { password: fakePassword } };
  await workflow(sshContext);
  const invalidPin = { ...sshContext, connection: { ...sshConnection, config: { ...sshConnection.config, hostKeySha256: "SHA256:" + Buffer.alloc(32, 1).toString("base64").replace(/=+$/, "") } } };
  const rejectedPin = await adapter.run(invalidPin, op(["clone"])); assert.notEqual(rejectedPin.exitCode, 0); checks++;
  for (const args of [["clone", "--config", "core.sshCommand=evil"], ["clone", "--upload-pack=evil"], ["clone", "https://evil.invalid/repo.git"]]) {
    await assert.rejects(adapter.run(sshContext, op(args)), error => error.status === 400); checks++;
  }
  stallSsh = true; const abort = new AbortController(); const stalled = adapter.run({ ...sshContext, signal: abort.signal }, op(["clone"]));
  await delay(500); abort.abort(); await assert.rejects(stalled, error => error.code === "CANCELLED"); checks++;
  await delay(100); assert.equal(sshClients.size, 0); checks++;
  assert.ok(httpCalls > 5 && sshCalls > 3); checks++;
  console.log(JSON.stringify({ ok: true, architecture, checks, httpCalls, sshCalls, realCredentials: false, productionInstallation: false }));
} finally {
  for (const child of children) child.kill();
  for (const client of sshClients) client.end();
  if (sshServer) await new Promise(resolve => sshServer.close(resolve));
  if (httpServer) { httpServer.closeAllConnections(); await new Promise(resolve => httpServer.close(resolve)); }
  await fs.rm(base, { recursive: true, force: true });
}
