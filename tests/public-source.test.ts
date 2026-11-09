import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const { inspectPublicText, scanPublicRepository } = await import(new URL("../scripts/check-public-source.mjs", import.meta.url).href);
const categories = (name: string, value: string) => inspectPublicText(name, Buffer.from(value)).map((finding: { category: string }) => finding.category);
const resemblesKey = () => ["sk", "P".repeat(48)].join("-");

test("public source gate detects credential shapes, home paths and unreviewed endpoints without returning their values", () => {
  const values = [
    resemblesKey(), ["ghp", "Q".repeat(40)].join("_"), ["AKIA", "R".repeat(16)].join(""),
    ["xoxb", "A".repeat(30)].join("-"), ["AIza", "C".repeat(35)].join(""),
  ];
  for (const value of values) {
    const findings = inspectPublicText("ordinary.ts", Buffer.from(`const value = '${value}';`));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 1);
    assert.ok(!JSON.stringify(findings).includes(value));
  }
  const personal = ["", "Users", "personal-owner", "Desktop", "report.md"].join("/");
  assert.deepEqual(categories("guide.md", personal), ["personal-home-path"]);
  const address = ["12", "34", "56", "78"].join(".");
  assert.deepEqual(categories("guide.md", `https://${address}/`), ["unreviewed-network-address"]);
  const credentialUrl = (host: string) => ["https:", "", "owner:" + "L".repeat(24) + "@" + host, ""].join("/");
  assert.deepEqual(categories("guide.md", credentialUrl("business.example.net")), ["url-credentials"]);
  assert.deepEqual(categories("guide.md", credentialUrl("business.invalid-prod.net")), ["url-credentials"]);
});

test("public source gate accepts clear fake samples, hashes, documentation addresses and public author metadata", () => {
  const text = [
    'const checksum = "' + "a".repeat(64) + '";',
    'https://203.0.113.7/ https://192.0.2.2/ https://198.51.100.9/',
    'C:\\Users\\example\\AppData\\Local\\Temp\\fixture',
    'Copyright 2026 jidouqie https://github.com/jidouqie/abilock',
    'https://user:password@api.example.net/ https://127.0.0.1/',
  ].join("\n");
  assert.deepEqual(categories("guide.md", text), []);
  const knownFake = ["sk", "syntheticlongtokenvalue"].join("-");
  assert.deepEqual(categories("tests/install-from-source.test.ts", knownFake), []);
  assert.deepEqual(categories("guide.md", knownFake), ["model-api-key"]);
  assert.deepEqual(categories("tests/install-from-source.test.ts", knownFake + "changed"), ["model-api-key"]);
});

test("public PEM fixture allowance is exact path plus checksum and does not exempt other secrets", async () => {
  const bytes = await fs.readFile(new URL("./fixtures/cloud-selfsigned-key.pem", import.meta.url));
  assert.deepEqual(inspectPublicText("tests/fixtures/cloud-selfsigned-key.pem", bytes), []);
  assert.ok(inspectPublicText("new-key.pem", bytes).some((finding: { category: string }) => finding.category === "private-key"));
  assert.ok(inspectPublicText("tests/fixtures/cloud-selfsigned-key.pem", Buffer.concat([bytes, Buffer.from("\n")]))
    .some((finding: { category: string }) => finding.category === "private-key"));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-public-audit-"));
  const git = (args: string[]) => run("git", ["-c", "core.hooksPath=/dev/null", "-C", root, ...args]);
  await git(["init", "-q"]);
  await git(["config", "user.name", "Synthetic Public Audit"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  return { root, git, async commit(message = "Synthetic source") { await git(["commit", "-qm", message]); },
    async close() { await fs.rm(root, { recursive: true, force: true }); } };
}

test("public source gate checks reachable deleted history and both worktree and staged bytes", async () => {
  const f = await fixture();
  try {
    const secret = resemblesKey();
    await fs.writeFile(path.join(f.root, "old.txt"), secret);
    await f.git(["add", "old.txt"]); await f.commit();
    await f.git(["rm", "-q", "old.txt"]); await f.commit("Remove synthetic value");
    const report = await scanPublicRepository(f.root);
    assert.equal(report.ok, false);
    assert.equal(report.commits, 2);
    assert.ok(report.findings.some((finding: { source: string; category: string }) => finding.source === "history" && finding.category === "model-api-key"));
    assert.ok(!JSON.stringify(report).includes(secret));
    await fs.writeFile(path.join(f.root, "staged.txt"), secret); await f.git(["add", "staged.txt"]);
    await fs.writeFile(path.join(f.root, "staged.txt"), "Now clean");
    assert.ok((await scanPublicRepository(f.root)).findings.some((finding: { source: string }) => finding.source === "index"));
    await f.git(["reset", "-q", "--", "staged.txt"]);
    await fs.writeFile(path.join(f.root, "tracked.txt"), "Clean source"); await f.git(["add", "tracked.txt"]); await f.commit();
    await fs.writeFile(path.join(f.root, "tracked.txt"), secret);
    assert.ok((await scanPublicRepository(f.root)).findings.some((finding: { source: string }) => finding.source === "worktree"));
  } finally { await f.close(); }
});

test("public source gate ignores untracked runtime data and refuses tracked private paths without reading their contents", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, "source.txt"), "Clean source"); await f.git(["add", "source.txt"]); await f.commit();
    await fs.writeFile(path.join(f.root, ".env"), resemblesKey());
    await fs.mkdir(path.join(f.root, "private-data"));
    await fs.writeFile(path.join(f.root, "private-data/vault.json"), resemblesKey());
    assert.equal((await scanPublicRepository(f.root)).ok, true);
    await f.git(["add", ".env"]);
    await fs.chmod(path.join(f.root, ".env"), 0);
    const report = await scanPublicRepository(f.root);
    assert.ok(report.findings.every((finding: { category: string }) => finding.category === "private-or-generated-file"));
    assert.equal(report.findings.length, 2);
  } finally { await fs.chmod(path.join(f.root, ".env"), 0o600); await f.close(); }
});

test("public source gate rejects symlinks without reading their destinations", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, "source.txt"), "Clean source"); await f.git(["add", "source.txt"]); await f.commit();
    const destination = path.join(f.root, "untracked-only.txt");
    await fs.writeFile(destination, resemblesKey());
    await fs.symlink(destination, path.join(f.root, "link.txt")); await f.git(["add", "link.txt"]);
    const report = await scanPublicRepository(f.root);
    assert.ok(report.findings.every((finding: { category: string }) => finding.category === "source-link-or-submodule"));
  } finally { await f.close(); }
});

test("public audit CLI failures print locations only and reject incomplete shallow history", async () => {
  const f = await fixture();
  try {
    const secret = resemblesKey();
    await fs.writeFile(path.join(f.root, "source.txt"), secret); await f.git(["add", "source.txt"]); await f.commit();
    const child = await run(process.execPath, [fileURL(), "--json"], { cwd: f.root }).then(
      () => { throw new Error("Expected a rejected public audit"); },
      (error: { code: number; stdout: string; stderr: string }) => error,
    );
    assert.equal(child.code, 1);
    assert.ok(!`${child.stdout}${child.stderr}`.includes(secret));
    assert.equal(JSON.parse(child.stdout).ok, false);
    const revision = (await f.git(["rev-parse", "HEAD"])).stdout.trim();
    await fs.writeFile(path.join(f.root, ".git/shallow"), revision + "\n");
    await assert.rejects(scanPublicRepository(f.root), /Full Git history is required/);
  } finally { await f.close(); }
});
function fileURL() { return fileURLToPath(new URL("../scripts/check-public-source.mjs", import.meta.url)); }

test("public gate rejects Unicode personal homes and credentials in database URLs even on example hosts", () => {
  for (const owner of ["测试用户", "private-owner"]) {
    for (const value of [["", "Users", owner, "Desktop", "file.txt"].join("/"), ["C:", "Users", owner, "Desktop", "file.txt"].join("\\")])
      assert.deepEqual(categories("guide.md", value), ["personal-home-path"]);
  }
  for (const scheme of ["postgresql", "postgres", "mysql", "redis", "rediss", "mongodb", "mongodb+srv", "amqps", "sftp", "ssh"])
    assert.deepEqual(categories("guide.md", `${scheme}://owner:${"P".repeat(24)}@example.com/db`), ["url-credentials"]);
});

test("public gate refuses credential account containers without reading their tracked content", () => {
  for (const name of [".aws/credentials", ".ssh/config", ".abilock/settings", ".npmrc", ".netrc", ".git-credentials"])
    assert.deepEqual(categories(name, "not opened"), ["private-or-generated-file"]);
});

test("public gate audits commit and annotated tag metadata and redacts secret-shaped locations", async () => {
  const f = await fixture();
  try {
    const secret = resemblesKey();
    await fs.writeFile(path.join(f.root, "source.txt"), "Clean source"); await f.git(["add", "source.txt"]); await f.commit(secret);
    await f.git(["tag", "-a", "synthetic-release", "-m", secret]);
    await fs.writeFile(path.join(f.root, secret + ".txt"), secret); await f.git(["add", secret + ".txt"]);
    const report = await scanPublicRepository(f.root);
    assert.ok(report.findings.some((finding: { source: string }) => finding.source === "commit"));
    assert.ok(report.findings.some((finding: { source: string }) => finding.source === "tag"));
    assert.ok(report.findings.some((finding: { path: string }) => finding.path.startsWith("[redacted-location:")));
    assert.ok(!JSON.stringify(report).includes(secret));
  } finally { await f.close(); }
});

test("public gate ignores local tool checkpoint contents but audits branches with tool-like names", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, "source.txt"), "Clean source"); await f.git(["add", "source.txt"]); await f.commit();
    const blob = (await f.git(["hash-object", "-w", "source.txt"])).stdout.trim();
    await f.git(["update-ref", "refs/codex/turn-diffs/checkpoints/synthetic", blob]);
    const clean = await scanPublicRepository(f.root); assert.equal(clean.ok, true); assert.equal(clean.internalRefsExcluded, 1);
    await fs.writeFile(path.join(f.root, "source.txt"), resemblesKey()); await f.git(["add", "source.txt"]); await f.commit();
    await f.git(["branch", "codex/checkpoint-like-name"]);
    assert.equal((await scanPublicRepository(f.root)).ok, false);
  } finally { await f.close(); }
});

test("public gate ignores replace refs and refuses nonempty graft metadata instead of hiding old secrets", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, "old.txt"), resemblesKey()); await f.git(["add", "old.txt"]); await f.commit();
    const old = (await f.git(["rev-parse", "HEAD"])).stdout.trim();
    await f.git(["rm", "-q", "old.txt"]); await f.commit();
    const empty = (await f.git(["rev-parse", "HEAD^{tree}"])).stdout.trim();
    const replacement = (await f.git(["commit-tree", empty, "-m", "Clean synthetic replacement"])).stdout.trim();
    await f.git(["replace", old, replacement]);
    assert.equal((await scanPublicRepository(f.root)).ok, false);
    await fs.mkdir(path.join(f.root, ".git/info"), { recursive: true });
    await fs.writeFile(path.join(f.root, ".git/info/grafts"), old + "\n");
    await assert.rejects(scanPublicRepository(f.root), /grafts make source history ambiguous/);
  } finally { await f.close(); }
});
