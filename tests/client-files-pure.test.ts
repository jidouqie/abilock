import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectSelectedFiles,
  inspectOutputDestination,
  inspectSelectedPath,
  readSelectedFile,
  readSelectedDirectory,
  verifySelectedPath,
} from "../bin/client-files.mjs";

// These tests use only synthesized temporary files and client algorithms.
// They never run the CLI, a native Git executable, sockets, HTTP or providers.
async function fixture(action: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abl-client-pure-"));
  try {
    await action(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("selected regular JSON, SQL and binary reads preserve bytes and enforce byte limits", async () => {
  await fixture(async (root) => {
    for (const [name, bytes] of [
      ["request.json", Buffer.from('{"body":{"业务":"正常内容"}}')],
      ["query.sql", Buffer.from("select '中文';\n")],
      ["payload.bin", Buffer.from([0, 255, 17, 10])],
      ["empty", Buffer.alloc(0)],
    ] as const) {
      const selected = path.join(root, name);
      await fs.writeFile(selected, bytes);
      assert.deepEqual(
        await readSelectedFile(selected, { maxBytes: bytes.length }),
        bytes,
      );
      if (bytes.length)
        await assert.rejects(
          readSelectedFile(selected, { maxBytes: bytes.length - 1 }),
        );
    }
    await assert.rejects(readSelectedFile(root));
    await assert.rejects(readSelectedFile(path.join(root, "missing")));
  });
});

test("HTTP request files and native inputs share the guarded reader in the CLI source", async () => {
  // Source inspection proves wiring without executing the client or opening HTTP.
  const source = await fs.readFile(
    new URL("../bin/abl.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /await readSelectedText\(flags\.get\("--file"\), 20 \* 1024 \* 1024\)/,
  );
  assert.match(
    source,
    /if \(file\) raw = await readSelectedText\(file, 20 \* 1024 \* 1024\)/,
  );
  assert.match(source, /await readSelectedFile\(source, \{ maxBytes \}\)/);
  assert.match(source, /const collectFiles = collectSelectedFiles/);
  assert.doesNotMatch(source, /fs\.readFile\(/);
});

test("synthetic credential directory aliases and every symlink ancestor are refused", async () => {
  await fixture(async (root) => {
    const credentials = path.join(root, "synthetic", ".ssh");
    await fs.mkdir(credentials, { recursive: true });
    await fs.writeFile(path.join(credentials, "id_rsa"), "fake-key-never-real");
    await fs.symlink(credentials, path.join(root, "innocent-alias"), "dir");
    const aliasFile = path.join(root, "innocent-alias", "id_rsa");
    await assert.rejects(readSelectedFile(aliasFile));
    await assert.rejects(collectSelectedFiles(aliasFile, false));
    await assert.rejects(
      collectSelectedFiles(path.join(root, "innocent-alias"), true),
    );
    await assert.rejects(readSelectedFile(path.join(credentials, "id_rsa")));
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await fs.symlink(credentials, path.join(project, "nested-alias"), "dir");
    await assert.rejects(collectSelectedFiles(project, true));
    const ordinary = path.join(root, "ordinary");
    await fs.mkdir(ordinary);
    await fs.writeFile(path.join(ordinary, "business.json"), "{}");
    await fs.symlink(ordinary, path.join(root, "ordinary-alias"), "dir");
    await assert.rejects(
      readSelectedFile(path.join(root, "ordinary-alias", "business.json")),
    );
  });
});

test("credential filenames, symlink leaves and hardlinked leaves are refused", async () => {
  await fixture(async (root) => {
    for (const name of [
      ".env",
      ".env.local",
      ".netrc",
      ".npmrc",
      ".git-credentials",
    ]) {
      await fs.writeFile(path.join(root, name), "synthetic-only");
      await assert.rejects(readSelectedFile(path.join(root, name)));
      await assert.rejects(collectSelectedFiles(path.join(root, name), false));
    }
    const file = path.join(root, "ordinary.txt");
    await fs.writeFile(file, "ordinary");
    await fs.symlink(file, path.join(root, "leaf-link"));
    await assert.rejects(readSelectedFile(path.join(root, "leaf-link")));
    await fs.link(file, path.join(root, "hard-link"));
    await assert.rejects(readSelectedFile(path.join(root, "hard-link")));
  });
});

test("a leaf replaced by a symlink after inspection is refused by nofollow open", async () => {
  await fixture(async (root) => {
    const selected = path.join(root, "request.json"),
      other = path.join(root, "other.json");
    await fs.writeFile(selected, "original");
    await fs.writeFile(other, "synthetic-other");
    await assert.rejects(
      readSelectedFile(selected, {
        audit: async (phase) => {
          if (phase === "inspected") {
            await fs.unlink(selected);
            await fs.symlink(other, selected);
          }
        },
      }),
    );
  });
});

test("an ancestor replaced by a credential alias before reading fails closed", async () => {
  await fixture(async (root) => {
    const project = path.join(root, "project"),
      fake = path.join(root, "fake", ".ssh");
    await fs.mkdir(project);
    await fs.mkdir(fake, { recursive: true });
    await fs.writeFile(path.join(project, "id_rsa"), "explicit-business-file");
    await fs.writeFile(path.join(fake, "id_rsa"), "synthetic-key");
    await assert.rejects(
      readSelectedFile(path.join(project, "id_rsa"), {
        audit: async (phase) => {
          if (phase === "before-read") {
            await fs.rename(project, path.join(root, "retained-original"));
            await fs.symlink(fake, project, "dir");
          }
        },
      }),
    );
  });
});

test("ancestor inode replacement after read rejects the result even without symlinks", async () => {
  await fixture(async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, "payload"), "business");
    await assert.rejects(
      readSelectedFile(path.join(project, "payload"), {
        audit: async (phase) => {
          if (phase === "after-read") {
            await fs.rename(project, path.join(root, "old-project"));
            await fs.mkdir(project);
            await fs.writeFile(path.join(project, "payload"), "business");
          }
        },
      }),
    );
  });
});

test("same inode content mutation or file growth during read rejects all output", async () => {
  await fixture(async (root) => {
    const selected = path.join(root, "payload");
    for (const replacement of ["changed!", "much longer changed content"]) {
      await fs.writeFile(selected, "original");
      await assert.rejects(
        readSelectedFile(selected, {
          maxBytes: 100,
          audit: async (phase) => {
            if (phase === "after-read")
              await fs.writeFile(selected, replacement);
          },
        }),
      );
    }
    await fs.writeFile(selected, "short");
    await assert.rejects(
      readSelectedFile(selected, {
        maxBytes: 5,
        audit: async (phase) => {
          if (phase === "before-read") await fs.appendFile(selected, "grow");
        },
      }),
    );
  });
});

test("recursive manifests apply excludes before reading and skip Git metadata", async () => {
  await fixture(async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(path.join(project, "nested"), { recursive: true });
    await fs.mkdir(path.join(project, ".git"));
    await fs.mkdir(path.join(project, ".ssh"));
    await fs.writeFile(path.join(project, ".git", "config"), "synthetic-only");
    await fs.writeFile(path.join(project, ".ssh", "id_rsa"), "synthetic-only");
    await fs.writeFile(path.join(project, ".abilock-worktree.json"), "{}");
    await fs.writeFile(
      path.join(project, "nested", "data.bin"),
      Buffer.from([255, 0, 12]),
    );
    await fs.writeFile(path.join(project, "literal+.txt"), "excluded");
    const upload = await collectSelectedFiles(project, true, [
      ".ssh/",
      "literal+.txt",
    ]);
    assert.deepEqual(
      upload.files.map((file) => file.path),
      ["nested/data.bin"],
    );
    assert.deepEqual(
      Buffer.from(upload.files[0].base64, "base64"),
      Buffer.from([255, 0, 12]),
    );
    assert.equal(upload.directory, true);
    await assert.rejects(collectSelectedFiles(project, false));
    await assert.rejects(collectSelectedFiles(project, true));
  });
});

test("directory snapshot detects replacement and manifest count/aggregate limits are bounded", async () => {
  await fixture(async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const snapshot = await inspectSelectedPath(project);
    assert.deepEqual(await readSelectedDirectory(snapshot), []);
    await fs.rename(project, path.join(root, "old"));
    await fs.mkdir(project);
    await assert.rejects(verifySelectedPath(snapshot));
    for (let index = 0; index <= 100; index++)
      await fs.writeFile(path.join(project, `file-${index}`), "");
    await assert.rejects(collectSelectedFiles(project, true));
    await fs.rm(project, { recursive: true });
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, "a"), Buffer.alloc(6 * 1024 * 1024));
    await fs.writeFile(path.join(project, "b"), Buffer.alloc(5 * 1024 * 1024));
    await assert.rejects(collectSelectedFiles(project, true));
  });
});

test("credential selections and recursive metadata exclusions honor case variants", async () => {
  await fixture(async (root) => {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    for (const name of [".SSH", ".AWS", ".KUBE", ".CONFIG", ".CODEx"]) {
      await fs.mkdir(path.join(project, name));
      await fs.writeFile(path.join(project, name, "synthetic"), "fake only");
      await assert.rejects(
        readSelectedFile(path.join(project, name, "synthetic")),
      );
    }
    for (const name of [".ENV.local", ".NPMRC", ".NETRC", ".GIT-CREDENTIALS"]) {
      await fs.writeFile(path.join(root, name), "fake only");
      await assert.rejects(readSelectedFile(path.join(root, name)));
    }
    const clean = path.join(root, "clean");
    await fs.mkdir(path.join(clean, ".GIT"), { recursive: true });
    await fs.writeFile(path.join(clean, ".GIT", "config"), "synthetic");
    await fs.writeFile(path.join(clean, ".ABILOCK-WORKTREE.JSON"), "synthetic");
    await fs.writeFile(path.join(clean, "business"), "business");
    assert.deepEqual(
      (await collectSelectedFiles(clean, true)).files.map((file) => file.path),
      ["business"],
    );
  });
});

test("download destinations reject existing spelling aliases and credential targets", async () => {
  await fixture(async (root) => {
    await fs.mkdir(path.join(root, "A"));
    await fs.writeFile(path.join(root, "A", "business"), "unchanged");
    await assert.rejects(
      inspectOutputDestination(path.join(root, "a", "business")),
      /collision|alias/,
    );
    await assert.rejects(
      inspectOutputDestination(path.join(root, ".SSH", "new")),
      /credential/,
    );
    await assert.rejects(
      inspectOutputDestination(path.join(root, ".ENV.local")),
      /credential/,
    );
    await assert.rejects(
      inspectOutputDestination(path.join(root, "A")),
      /regular file/,
    );
    await assert.doesNotReject(
      inspectOutputDestination(path.join(root, "A", "new-business")),
    );
    assert.equal(
      await fs.readFile(path.join(root, "A", "business"), "utf8"),
      "unchanged",
    );
  });
});

test("ordinary file transfer retains NFC Chinese filenames and bytes", async () => {
  await fixture(async (root) => {
    await fs.writeFile(path.join(root, "业务文件.txt"), "正常业务内容");
    const upload = await collectSelectedFiles(root, true);
    assert.deepEqual(
      upload.files.map((file) => file.path),
      ["业务文件.txt"],
    );
    assert.equal(
      Buffer.from(upload.files[0].base64, "base64").toString(),
      "正常业务内容",
    );
    await assert.doesNotReject(
      inspectOutputDestination(path.join(root, "返回文件.txt")),
    );
  });
});
