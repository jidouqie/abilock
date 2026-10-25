#include <CommonCrypto/CommonDigest.h>
#include <Security/Authorization.h>
#include <Security/AuthorizationTags.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef INSTALL_SCRIPT_SHA256
#error The reviewed installer source digest must be pinned at build time
#endif

static int fail(void) {
  fputs("ISOLATION_INSTALL: Abilock installation did not complete.\n", stderr);
  return 78;
}

static int digest_string(const char *value) {
  if (strlen(value) != 64) return 0;
  for (int i = 0; i < 64; ++i)
    if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return 0;
  return 1;
}

static int consume_output(const char *line) {
  if (strcmp(line, "Abilock isolated runtime installed.\n") == 0) return 1;
  /* Keep stdout a single completion receipt for the existing CLI contract. */
  if (strcmp(line, "ISOLATION_VERIFICATION_OK\n") == 0) fputs(line, stderr);
  const char *phases[] = {"initial", "prepared", "verification", "identity", "private-snapshot", "migrate",
                          "owner-transfer", "backup", "rewrite", "install", "bootstrap", "commit", NULL};
  for (int i = 0; phases[i]; ++i) {
    char failure[128];
    snprintf(failure, sizeof(failure), "ISOLATION_INSTALL_FAILED:%s\n", phases[i]);
    if (strcmp(line, failure) == 0) fputs(failure, stderr);
  }
  const char *stages[] = {"prerequisites", "freeze-public-bundle", "compile-native-fixture", "prepare-native-fixture",
                          "protected-bootstrap", "synthetic-credential-setup", "kernel-read-write-denial",
                          "existing-cli-list", "existing-cli-doc", "authorized-api-and-redaction",
                          "execution-management-denial", "argument-and-bootstrap-denial", "environment-injection",
                          "target-auth-override-denial", "worker-identity-and-eof", "worker-identity-and-cancel",
                          "temporary-configuration", "complete", "cleanup", "unknown", NULL};
  for (int i = 0; stages[i]; ++i) {
    char failure[128];
    snprintf(failure, sizeof(failure), "ISOLATION_VERIFICATION_FAILED:%s\n", stages[i]);
    if (strcmp(line, failure) == 0) fputs(failure, stderr);
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 3 || getuid() < 500 || geteuid() != getuid() || !digest_string(argv[2]))
    return fail();
  char bundle[PATH_MAX], script_path[PATH_MAX];
  if (!realpath(argv[1], bundle) ||
      snprintf(script_path, sizeof(script_path), "%s/runtime/scripts/isolation-install.py", bundle) >= (int)sizeof(script_path))
    return fail();
  int descriptor = open(script_path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  struct stat info;
  if (descriptor < 0 || fstat(descriptor, &info) != 0 || !S_ISREG(info.st_mode) ||
      info.st_nlink != 1 || info.st_size < 1 || info.st_size > 128 * 1024) {
    if (descriptor >= 0) close(descriptor);
    return fail();
  }
  char *source = calloc((size_t)info.st_size + 1, 1);
  if (!source) { close(descriptor); return fail(); }
  size_t offset = 0;
  while (offset < (size_t)info.st_size) {
    ssize_t count = read(descriptor, source + offset, (size_t)info.st_size - offset);
    if (count <= 0) { close(descriptor); free(source); return fail(); }
    offset += (size_t)count;
  }
  close(descriptor);
  unsigned char hash[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(source, (CC_LONG)offset, hash);
  char hexadecimal[65];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; ++i)
    snprintf(hexadecimal + i * 2, 3, "%02x", hash[i]);
  if (strcmp(hexadecimal, INSTALL_SCRIPT_SHA256) != 0 || memchr(source, '\0', offset)) {
    free(source); return fail();
  }

  AuthorizationRef authorization = NULL;
  OSStatus status = AuthorizationCreate(NULL, kAuthorizationEmptyEnvironment,
                                        kAuthorizationFlagDefaults, &authorization);
  if (status != errAuthorizationSuccess) { free(source); return fail(); }
  const char *interpreter = "/usr/bin/python3";
  AuthorizationItem item = {kAuthorizationRightExecute, strlen(interpreter), (void *)interpreter, 0};
  AuthorizationRights rights = {1, &item};
  const char *prompt = "Abilock 安装或更新权限隔离。";
  AuthorizationItem prompt_item = {kAuthorizationEnvironmentPrompt, strlen(prompt), (void *)prompt, 0};
  AuthorizationEnvironment environment = {1, &prompt_item};
  status = AuthorizationCopyRights(authorization, &rights, &environment,
                                   kAuthorizationFlagInteractionAllowed | kAuthorizationFlagExtendRights, NULL);
  FILE *communication = NULL;
  char owner[32];
  snprintf(owner, sizeof(owner), "%lu", (unsigned long)getuid());
  char *arguments[] = {"-I", "-c", source, "--bundle", bundle, "--digest", argv[2],
                       "--owner", owner, "--verify-first", NULL};
  if (status == errAuthorizationSuccess) {
    /* Installer-only one-shot use. Unlike AppleScript, we own this reference
       and explicitly destroy its shared credentials immediately after launch.
       No arbitrary command, Python option, script path, or caller UID is accepted. */
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    status = AuthorizationExecuteWithPrivileges(authorization, interpreter,
                                               kAuthorizationFlagDefaults, arguments, &communication);
#pragma clang diagnostic pop
  }
  AuthorizationFree(authorization, kAuthorizationFlagDestroyRights);
  free(source);
  if (status != errAuthorizationSuccess || !communication) return fail();
  int completed = 0;
  char line[2048];
  while (fgets(line, sizeof(line), communication)) {
    if (consume_output(line)) completed = 1;
    /* Root output is never forwarded wholesale. The protected installer has
       no reason to send credentials; retain only a fixed completion marker. */
  }
  fclose(communication);
  if (!completed) return fail();
  fputs("Abilock isolated runtime installed.\n", stdout);
  return 0;
}
