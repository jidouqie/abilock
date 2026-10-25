import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

test("prebuilt native assets match current reviewed sources and both CPU architectures", async () => {
  const root = path.resolve("native/prebuilt");
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8")) as {
    version: number;
    platform: string;
    minimumNativeMacOS: string;
    installerSha256: string;
    sources: Array<{ path: string; sha256: string }>;
    architectures: Record<string, { files: Array<{ path: string; sha256: string; mode: number }> }>;
  };
  assert.equal(manifest.version, 1);
  assert.equal(manifest.platform, "darwin");
  assert.equal(manifest.minimumNativeMacOS, "13.0");
  assert.deepEqual(Object.keys(manifest.architectures).sort(), ["arm64", "x64"]);
  for (const source of manifest.sources) {
    const hash = crypto.createHash("sha256").update(await fs.readFile(source.path)).digest("hex");
    assert.equal(hash, source.sha256, `${source.path} needs its native assets rebuilt`);
    if (source.path === "scripts/isolation-install.py") assert.equal(hash, manifest.installerSha256);
  }
  for (const [architecture, specification] of Object.entries(manifest.architectures)) {
    assert.deepEqual(specification.files.map((file) => file.path), ["launch", "password", "authorize", "verify-launch", "file-lock"]);
    for (const file of specification.files) {
      const filename = path.join(root, architecture, file.path);
      const info = await fs.lstat(filename);
      assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
      assert.equal(info.mode & 0o7777, 0o755);
      assert.equal(file.mode, 0o755);
      const contents = await fs.readFile(filename);
      assert.equal(crypto.createHash("sha256").update(contents).digest("hex"), file.sha256);
      assert.equal(contents.readUInt32LE(0), 0xfeedfacf);
      assert.equal(contents.readUInt32LE(4), architecture === "arm64" ? 0x100000c : 0x1000007);
      if (file.path === "verify-launch") {
        assert(contents.includes(Buffer.from("/private/var/db/.abilock-isolation-fixture/install")));
        assert(contents.includes(Buffer.from("/private/var/db/.abilock-isolation-fixture/private")));
        assert(!contents.includes(Buffer.from("/usr/local/libexec/abilock")));
        assert(!contents.includes(Buffer.from("_nobody")));
      }
      if (process.platform === "darwin")
        execFileSync("/usr/bin/codesign", ["--verify", "--strict", filename], { stdio: "pipe" });
    }
  }
});
