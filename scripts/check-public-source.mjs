import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { constants } from "node:fs";
import { isIP } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const maximumTextBytes = 8 * 1024 * 1024;
// This exact, explicitly public TLS fixture is documented in fixtures/README.md.
// Never exempt a directory, a PEM filename alone, or an arbitrary changed key.
const publicKeyFixtures = new Map([
  ["tests/fixtures/cloud-selfsigned-key.pem", "055738dc00940662319ccaf555590a80e230b5f2b79a9b82a8d771f021f56662"],
]);
const exampleUsers = new Set(["example", "user", "username", "testuser", "fixture", "runner", "public", "_abilock"]);
// These are existing, reviewed literal inputs for pure network-policy tests.
// New examples should normally use the RFC 5737 documentation ranges instead.
const networkFixtures = new Map([
  ["10.0.0.1", ["docs/protocols/ssh.md", "tests/core.test.ts", "tests/native-cli.test.ts"]],
  ["10.0.0.5", ["tests/git-workspaces.test.ts", "tests/private-targets.test.ts"]],
  ["10.0.0.8", ["tests/private-targets.test.ts"]],
  ["10.1.2.3", ["tests/broker-connections.test.ts"]],
  ["192.168.0.1", ["tests/core.test.ts"]],
  ["192.168.10.20", ["tests/private-targets.test.ts"]],
  ["10.7.0.8", ["tests/resolved-target-policy.test.ts"]],
  ["10.7.0.9", ["tests/resolved-target-policy.test.ts"]],
  ["172.16.0.9", ["tests/resolved-target-policy.test.ts"]],
  ["192.168.10.9", ["tests/resolved-target-policy.test.ts"]],
  ["100.100.100.201", ["tests/resolved-target-policy.test.ts"]],
]);
const tokenRules = [
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ["model-api-key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["google-api-key", /\bAIza[A-Za-z0-9_-]{35}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ["bearer-token", /\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/g],
];
// Exact reviewed test values only. A fake-looking prefix is not an exemption.
const publicTokenFixtures = new Map([
  ["tests/connection-test.test.ts", ["65d0b639c0d7418f0e7a6cc902161b8143f2f5fbb988ccee9f6df677e53f2ad5"]],
  ["tests/container-protocol.test.ts", ["48b445f31962b01dd769b2f2cafa16c63071a6e91d2a25cdce5b0347328c64aa"]],
  ["tests/install-from-source.test.ts", ["a28205e3ed32d7d390e60103fb30d9cef6962513b2419a939af7c45556bea8fe", "0e834a289cb8bcee8e3b3196f8e610405d431205ab65b4190cebc6ffea1540f3"]],
  ["tests/manual-history.test.ts", ["994644c105052b7774d2ed2da96defec52b12e180f026690c4cde05dfb48c9b6", "f90a161f27a4996221a79441f2e2d42e8feefa1699f13694fbeb716056fc28a1"]],
  ["tests/mock-startup.test.ts", ["67233b7bb73f6239f024d8e87847f3b91c23284f32d2fe4a16f5048308a3efae"]],
]);
const publicUriFixtures = new Map([
  ["tests/cli-config.test.ts", ["3b16510f28972a64654bb241268ad6817692db48df889199f2b5ce16554681f5"]],
  ["tests/container-protocol.test.ts", ["43192e743c9c0776b1bc070b9d5742fb6f1c23ee15469c558edd9844a48e4424"]],
  ["tests/database-protocol.test.ts", ["07940b547074c208dc6e66bd3d81a206523f87e3c223a543a8b0a539580dafeb"]],
  ["tests/discovery-cli.test.ts", ["dc4d668924775da347c19ff792d322823b0aa36969c7ad76b67c3e84177606f8"]],
  ["tests/document-metadata.test.ts", ["2731cda92386cfaca40126ef478ca2fa6734c658f031423129d9add749a8d05f"]],
  ["tests/experience-review.test.ts", ["041468734eadd9d05fb7519eb1f92833ea509418803f55ef96a56cd1de15512d"]],
  ["tests/git-protocol.test.ts", ["21c8ca0e9bf44c639900bdd6d9877d54bfd5d94e5beebbd425bd01f56eb15a7a"]],
  ["tests/remote-fetch.test.ts", ["e1d4172da64a9d7789dfdc81dfc4e8bbb6ab2727b8579910dd562ae87e9e95ba"]],
]);
function reviewedToken(name, value) {
  const digest = crypto.createHash("sha256").update(value).digest("hex");
  return publicTokenFixtures.get(name)?.includes(digest) ?? false;
}
function safeLocation(value) {
  const unsafe = tokenRules.some(([, rule]) => new RegExp(rule.source, rule.flags).test(value)) ||
    /(?:\/Users\/|\/home\/|[A-Za-z]:\\|[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@)/i.test(value);
  return unsafe ? `[redacted-location:${crypto.createHash("sha256").update(value).digest("hex").slice(0, 12)}]` : value;
}

export function forbiddenSourcePath(name) {
  const parts = name.split("/");
  const base = parts.at(-1) ?? "";
  return parts.some((part) => [".git", ".aws", ".ssh", ".abilock", "node_modules", "artifacts", "data", "backups", "__pycache__"].includes(part)) ||
    /^(?:\.npmrc|\.netrc|\.git-credentials|service\.env|\.env(?:\..*)?|state\.json|vault\.json|experience\.json|admin-auth(?:\.json|\.v2)?|master\.key|installation\.json|id_(?:rsa|dsa|ecdsa|ed25519))$/i.test(base) && base !== ".env.example" ||
    /\.(?:p12|pfx|keychain(?:-db)?|kdbx|sqlite3?|db|log|zip|tgz|dmg)$/i.test(base);
}

function reviewedAddress(address, name) {
  const octets = address.split(".").map(Number);
  const [a, b, c] = octets;
  if (a === 0 || a === 127 || a >= 224 || a === 169 && b === 254 ||
      a === 192 && b === 0 && c === 2 || a === 198 && b === 51 && c === 100 ||
      a === 203 && b === 0 && c === 113 || a === 198 && (b === 18 || b === 19)) return true;
  // Public DNS and published metadata-service constants are not user assets.
  if (["1.1.1.1", "8.8.8.8", "8.8.4.4", "9.9.9.9", "100.100.100.200"].includes(address)) return true;
  return name === "scripts/check-public-source.mjs" && networkFixtures.has(address) || (networkFixtures.get(address)?.includes(name) ?? false);
}

export function inspectPublicText(name, bytes) {
  const findings = [];
  const add = (category, line) => findings.push({ category, path: safeLocation(name), line });
  if (forbiddenSourcePath(name)) {
    add("private-or-generated-file", 0);
    return findings;
  }
  if (bytes.length > maximumTextBytes) {
    add("file-too-large-to-audit", 0);
    return findings;
  }
  if (bytes.includes(0)) return findings;
  const text = bytes.toString("utf8");
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const approvedKey = publicKeyFixtures.get(name) === digest;
  const pem = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{32,}\s*-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g;
  if (!approvedKey) for (const match of text.matchAll(pem))
    add("private-key", text.slice(0, match.index).split("\n").length);
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    for (const [category, rule] of tokenRules)
      for (const match of line.matchAll(rule)) if (!reviewedToken(name, match[1] ?? match[0])) add(category, index + 1);
    for (const match of line.matchAll(/(?:\/Users\/|\/home\/|[A-Za-z]:\\(?:\\)?Users\\(?:\\)?)([\p{L}\p{N}_.-]+)/gu))
      if (!exampleUsers.has(match[1].toLowerCase())) add("personal-home-path", index + 1);
    // Require a network-looking literal, avoiding dotted versions in package URLs
    // and numeric SVG paths. The endpoint's authority is scanned separately.
    const addresses = [...line.matchAll(/(?:https?|ssh):\/\/(?:[^\s/@]+@)?((?:\d{1,3}\.){3}\d{1,3})(?=[:/\s"'`]|$)|["'`]((?:\d{1,3}\.){3}\d{1,3})["'`]/g)];
    for (const match of addresses) {
      const address = match[1] ?? match[2];
      const before = line.slice(0, match.index);
      const versionAttribute = /\bversion\s*=\s*$/i.test(before);
      if (!versionAttribute && isIP(address) === 4 && !reviewedAddress(address, name)) add("unreviewed-network-address", index + 1);
    }
    for (const match of line.matchAll(/(?:https?|postgres(?:ql)?|mysql|rediss?|mongodb(?:\+srv)?|amqps?|sftp|ssh):\/\/([^\s/:@]+):([^\s/@]+)@([^\s/"'`]+)/g)) {
      const obviousDummy = match[1] === "user" && ["password", "pass", "secret"].includes(match[2]);
      const variableExpression = /^\$\{[A-Za-z_][\w.]*\}$/.test(match[2]);
      const reviewedUri = publicUriFixtures.get(name)?.includes(crypto.createHash("sha256").update(match[0]).digest("hex"));
      if (!obviousDummy && !variableExpression && !reviewedUri)
        add("url-credentials", index + 1);
    }
  }
  return [...new Map(findings.map((finding) => [`${finding.category}:${finding.line}`, finding])).values()];
}

async function git(root, args) {
  try {
    const result = await run("git", ["--no-replace-objects", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root, ...args],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
    return result.stdout;
  } catch {
    // Git errors can contain a command's bytes or machine paths. Never echo them.
    throw new Error("Public source audit could not read the Git source inventory.");
  }
}

function treeEntries(bytes) {
  return bytes.toString("utf8").split("\0").filter(Boolean).map((record) => {
    const split = record.indexOf("\t");
    if (split < 0) throw new Error("Invalid public Git inventory.");
    const [mode, type, oid] = record.slice(0, split).split(" ");
    return { path: record.slice(split + 1), mode, type, oid };
  });
}

async function trackedBytes(root, name) {
  const segments = name.split("/");
  if (path.isAbsolute(name) || segments.some((value) => !value || value === "." || value === ".."))
    throw new Error("Unsafe public Git source path.");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Tracked source parent is not a regular directory.");
  }
  const location = path.join(root, name);
  const before = await fs.lstat(location);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Tracked source is not a regular file.");
  const handle = await fs.open(location, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.nlink !== 1 || info.size > maximumTextBytes)
      throw new Error("Tracked source is not a bounded regular file.");
    return await handle.readFile();
  } finally { await handle.close(); }
}

export async function scanPublicRepository(root) {
  const findings = [];
  const rootPath = path.resolve(root);
  const shallow = (await git(rootPath, ["rev-parse", "--is-shallow-repository"])).toString().trim();
  if (shallow !== "false") throw new Error("Full Git history is required. Fetch with depth 0 before the public source audit.");
  const graftPath = (await git(rootPath, ["rev-parse", "--git-path", "info/grafts"])).toString().trim();
  try {
    const graft = await fs.lstat(path.resolve(rootPath, graftPath));
    if (!graft.isFile() || graft.size > 0) throw new Error("Git grafts make source history ambiguous; remove the local override before auditing.");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const inventory = (await git(rootPath, ["ls-files", "--stage", "-z"])).toString("utf8").split("\0").filter(Boolean);
  const cache = new Map();
  let textVersions = 0, binaryVersions = 0;
  async function inspect(entry, source, revision) {
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
      findings.push({ category: "source-link-or-submodule", path: safeLocation(entry.path), line: 0, source, ...(revision ? { revision } : {}) });
      return;
    }
    if (forbiddenSourcePath(entry.path)) {
      findings.push({ category: "private-or-generated-file", path: safeLocation(entry.path), line: 0, source, ...(revision ? { revision } : {}) });
      return; // Do not open private files, even if someone accidentally tracked one.
    }
    const key = `${entry.path}:${entry.oid}`;
    if (cache.has(key)) return;
    let bytes;
    try { bytes = source === "worktree" ? await trackedBytes(rootPath, entry.path) : await git(rootPath, ["cat-file", "blob", entry.oid]); }
    catch {
      findings.push({ category: "source-unreadable", path: safeLocation(entry.path), line: 0, source, ...(revision ? { revision } : {}) });
      return;
    }
    cache.set(key, true);
    if (bytes.includes(0)) binaryVersions++; else textVersions++;
    for (const finding of inspectPublicText(entry.path, bytes)) findings.push({ ...finding, source, ...(revision ? { revision } : {}) });
  }
  const entries = inventory.map((record) => {
    const split = record.indexOf("\t"), [mode, oid, stage] = record.slice(0, split).split(" ");
    return { path: record.slice(split + 1), mode, type: stage === "0" ? "blob" : "conflict", oid };
  });
  for (const entry of entries) {
    // Worktree bytes can differ from the staged object, so use a distinct cache key.
    await inspect({ ...entry, oid: `worktree-${entry.oid}` }, "worktree");
    await inspect(entry, "index");
  }
  // Only HEAD and publishable branch/tag namespaces belong to a source release.
  // Tool-internal refs are neither opened nor mirror-pushed by this workflow.
  const refs = (await git(rootPath, ["for-each-ref", "--format=%(objecttype)%00%(objectname)%00%(refname)", "refs/heads/", "refs/tags/", "refs/remotes/"])).toString().trim().split("\n").filter(Boolean);
  const allRefs = (await git(rootPath, ["for-each-ref", "--format=%(refname)"])).toString().trim().split("\n").filter(Boolean);
  const roots = new Set();
  try { roots.add((await git(rootPath, ["rev-parse", "--verify", "HEAD"])).toString().trim()); }
  catch { /* An unborn repository has no HEAD history yet. */ }
  const tags = new Set();
  for (const row of refs) {
    const [type, oid, name] = row.split("\0");
    for (const finding of inspectPublicText("[ref-name]", Buffer.from(name))) findings.push({ ...finding, source: "ref", revision: oid });
    if (type === "tag") tags.add(oid);
    else if (type === "commit") roots.add(oid);
    else findings.push({ category: "non-commit-source-ref", path: safeLocation(name), line: 0, source: "ref", revision: oid });
  }
  for (const oid of tags) {
    const metadata = await git(rootPath, ["cat-file", "tag", oid]);
    for (const finding of inspectPublicText("[tag-metadata]", metadata)) findings.push({ ...finding, source: "tag", revision: oid });
    const target = /^object ([a-f0-9]{40,64})\ntype (\w+)\n/m.exec(metadata.toString());
    if (target?.[2] === "tag") tags.add(target[1]);
    else if (target?.[2] === "commit") roots.add(target[1]);
    else findings.push({ category: "non-commit-source-ref", path: "[tag-target]", line: 0, source: "tag", revision: oid });
  }
  const commits = roots.size ? (await git(rootPath, ["rev-list", ...roots])).toString().trim().split("\n").filter(Boolean) : [];
  for (const revision of commits) {
    const metadata = await git(rootPath, ["cat-file", "commit", revision]);
    for (const finding of inspectPublicText("[commit-metadata]", metadata)) findings.push({ ...finding, source: "commit", revision });
    for (const entry of treeEntries(await git(rootPath, ["ls-tree", "-r", "-z", revision]))) await inspect(entry, "history", revision);
  }
  return { ok: findings.length === 0, trackedPaths: entries.length, commits: commits.length, textVersions, binaryVersions,
    internalRefsExcluded: allRefs.length - refs.length,
    binaryReview: "Binary assets still require manual review; this gate detects named private artifacts and common text patterns, not every possible secret.",
    findings };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: node scripts/check-public-source.mjs [--json]\nAudits tracked worktree, index, HEAD and all branch/tag histories (including remote-tracking refs). Tool-internal refs are excluded. No network or private runtime reads.");
    return;
  }
  if (args.length > 1 || args.length === 1 && args[0] !== "--json") throw new Error("Use --help for public source audit options.");
  const result = await scanPublicRepository(process.cwd());
  if (args[0] === "--json") console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Public source audit ${result.ok ? "passed" : "failed"}: ${result.trackedPaths} paths, ${result.commits} commits.`);
    for (const finding of result.findings)
      console.log(`${finding.category}: ${JSON.stringify(finding.path)}:${finding.line} (${finding.source}${finding.revision ? ` ${finding.revision.slice(0, 12)}` : ""})`);
    console.log(result.binaryReview);
  }
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => { console.error("Public source audit could not complete. Check the source inventory and complete Git history; no contents were printed."); process.exitCode = 2; });
