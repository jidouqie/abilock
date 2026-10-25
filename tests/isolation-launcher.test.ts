import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

test("native launcher accepts only fixed modes and checks immutable regular files", { skip: process.platform !== "darwin" }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-launch-tests-"));
  try {
    const source = path.resolve("native/abilock-launch.c");
    const harness = `
#define main abilock_native_main
#include ${JSON.stringify(source)}
#undef main
#include <assert.h>
int main(int argc, char **argv) {
  if (argc == 3) {
    char regular[PATH_MAX];
    snprintf(regular, sizeof(regular), "%s/regular", argv[1]);
    assert(!trusted(regular, getuid(), 0, 0600));
    return 0;
  }
  assert(argc == 2);
  char *execute[] = {"launch", "execute"};
  char *config[] = {"launch", "config"};
  char *bootstrap[] = {"launch", "bootstrap-admin"};
  char *extra[] = {"launch", "execute", "/tmp/malicious.js"};
  char *unknown[] = {"launch", "node"};
  assert(parse_operation(2, execute) == OP_EXECUTE);
  assert(parse_operation(2, config) == OP_CONFIG);
  assert(parse_operation(2, bootstrap) == OP_BOOTSTRAP);
  assert(parse_operation(3, extra) == OP_INVALID);
  assert(parse_operation(2, unknown) == OP_INVALID);
  char regular[PATH_MAX], linked[PATH_MAX], hard[PATH_MAX];
  snprintf(regular, sizeof(regular), "%s/regular", argv[1]);
  snprintf(linked, sizeof(linked), "%s/symlink", argv[1]);
  snprintf(hard, sizeof(hard), "%s/hardlink", argv[1]);
  int descriptor = open(regular, O_WRONLY | O_CREAT | O_EXCL, 0600);
  assert(descriptor >= 0); close(descriptor);
  assert(trusted(regular, getuid(), 0, 0600));
  assert(!trusted(regular, getuid() + 1, 0, 0600));
  assert(chmod(regular, 0660) == 0);
  assert(!trusted(regular, getuid(), 0, 0));
  assert(chmod(regular, 0600) == 0);
  assert(symlink(regular, linked) == 0);
  assert(!trusted(linked, getuid(), 0, 0600));
  assert(link(regular, hard) == 0);
  assert(!trusted(regular, getuid(), 0, 0600));
  assert(unlink(hard) == 0);
  assert(!trusted(regular, getuid(), 1, 0));
  assert(!trusted_chain("relative/path"));
  return 0;
}
`;
    await fs.writeFile(path.join(directory, "harness.c"), harness);
    execFileSync("/usr/bin/cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", path.join(directory, "harness.c"), "-o", path.join(directory, "harness")]);
    execFileSync(path.join(directory, "harness"), [directory]);
    execFileSync("/bin/chmod", ["+a", "everyone allow read", path.join(directory, "regular")]);
    execFileSync(path.join(directory, "harness"), [directory, "acl-denied"]);
    execFileSync("/usr/bin/cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", source, "-o", path.join(directory, "launch")]);
    const noRoot = spawnSync(path.join(directory, "launch"), ["execute"], {
      env: { NODE_OPTIONS: "--eval=process.stdout.write('fake-secret')" },
      encoding: "utf8",
    });
    assert.equal(noRoot.status, 78);
    assert.equal(noRoot.stdout, "");
    assert.match(noRoot.stderr, /ISOLATION_NOT_INSTALLED/);
    assert(!noRoot.stderr.includes("fake-secret"));
    const extra = spawnSync(path.join(directory, "launch"), ["execute", "--target", "elsewhere"], { encoding: "utf8" });
    assert.equal(extra.status, 78);
    assert.match(extra.stderr, /ISOLATION_USAGE/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("release launcher has no runtime path overrides or credential-taking arguments", async () => {
  const source = await fs.readFile("native/abilock-launch.c", "utf8");
  assert(!source.includes("getenv("));
  assert(!source.includes("system("));
  assert(!source.includes("popen("));
  assert(!source.includes("execvp("));
  assert.match(source, /setgroups\(0, NULL\)/);
  assert.match(source, /struct rlimit core = \{0, 0\}/);
  assert.match(source, /waitpid\(child, &status, 0\)/);
  assert.match(source, /signum == SIGALRM \? SIGKILL : SIGTERM/);
  assert.match(source, /operation == OP_BOOTSTRAP \? caller != 0 : caller != owner/);
  assert.match(source, /operation != OP_BOOTSTRAP && !prepared_management/);
  assert(!/execve\([^,]*argv/.test(source));
});

test("native installation receipt keeps verification progress on stderr and suppresses untrusted text", { skip: process.platform !== "darwin" }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-receipt-tests-"));
  try {
    const harness = `
#define INSTALL_SCRIPT_SHA256 "0000000000000000000000000000000000000000000000000000000000000000"
#define main abilock_authorizer_main
#include ${JSON.stringify(path.resolve("native/abilock-authorize.c"))}
#undef main
#include <assert.h>
int main(void) {
 assert(!consume_output("ISOLATION_VERIFICATION_OK\\n"));
 assert(!consume_output("ISOLATION_INSTALL_FAILED:verification\\n"));
 assert(!consume_output("ISOLATION_VERIFICATION_FAILED:prerequisites\\n"));
 assert(!consume_output("ISOLATION_INSTALL_FAILED:private-secret-value\\n"));
 assert(!consume_output("untrusted native exception text\\n"));
 assert(consume_output("Abilock isolated runtime installed.\\n"));
 fputs("Abilock isolated runtime installed.\\n", stdout);
 return 0;
}
`;
    await fs.writeFile(path.join(directory, "harness.c"), harness);
    execFileSync("/usr/bin/cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-framework", "Security", path.join(directory, "harness.c"), "-o", path.join(directory, "harness")]);
    const result = spawnSync(path.join(directory, "harness"), [], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "Abilock isolated runtime installed.");
    assert.equal(result.stderr, "ISOLATION_VERIFICATION_OK\nISOLATION_INSTALL_FAILED:verification\nISOLATION_VERIFICATION_FAILED:prerequisites\n");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
