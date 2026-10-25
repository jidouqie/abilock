#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <pwd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <sys/acl.h>
#endif

/* These are deliberately compiled constants, never caller inputs. */
#ifndef ABILOCK_LAUNCH_TEST_FIXTURE
#define INSTALL "/usr/local/libexec/abilock"
#define DATA "/private/var/db/abilock"
#define ACCOUNT "_abilock"
#define UPDATE_GATE "/private/var/db/.abilock-runtime.lock"
#elif !defined(INSTALL) || !defined(DATA) || !defined(ACCOUNT)
#error A separate test build requires all fixed fixture constants
#else
#define UPDATE_GATE INSTALL "/runtime.lock"
#endif
#define RUNTIME INSTALL "/runtime"
#define NODE INSTALL "/node"

enum operation { OP_INVALID, OP_EXECUTE, OP_CONFIG, OP_BOOTSTRAP };

static enum operation parse_operation(int argc, char **argv) {
  if (argc != 2) return OP_INVALID;
  if (strcmp(argv[1], "execute") == 0) return OP_EXECUTE;
  if (strcmp(argv[1], "config") == 0) return OP_CONFIG;
  if (strcmp(argv[1], "bootstrap-admin") == 0) return OP_BOOTSTRAP;
  return OP_INVALID;
}

static int fail(const char *code) {
  /* Never print errno, caller values, inherited environment, or private data. */
  fprintf(stderr, "%s: Abilock isolation unavailable.\n", code);
  return 78;
}

static int trusted(const char *name, uid_t owner, int directory, mode_t private_mode) {
  struct stat st;
  if (lstat(name, &st) != 0 || st.st_uid != owner || S_ISLNK(st.st_mode)) return 0;
  if (directory ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode)) return 0;
  if (st.st_mode & (S_IWGRP | S_IWOTH)) return 0;
  if (!directory && st.st_nlink != 1) return 0;
  if (private_mode && (st.st_mode & 0777) != private_mode) return 0;
#if defined(__APPLE__)
  errno = 0;
  acl_t permissions = acl_get_file(name, ACL_TYPE_EXTENDED);
  /* Darwin reports ENOENT for an existing inode with no extended ACL. The
     lstat above has already established that this is an existing file. */
  if (!permissions) return errno == ENOENT;
  acl_entry_t entry;
  int valid = acl_valid(permissions) == 0;
  errno = 0;
  int found = acl_get_entry(permissions, ACL_FIRST_ENTRY, &entry);
  int no_entries = found == -1 && errno == EINVAL;
  acl_free(permissions);
  if (!valid || !no_entries) return 0;
#endif
  return 1;
}

static int trusted_chain(const char *name) {
  char part[PATH_MAX];
  size_t length = strlen(name);
  if (length >= sizeof(part) || name[0] != '/') return 0;
  if (!trusted("/", 0, 1, 0)) return 0;
  memcpy(part, name, length + 1);
  for (size_t i = 1; i < length; ++i) {
    if (part[i] != '/') continue;
    part[i] = '\0';
    if (!trusted(part, 0, 1, 0)) return 0;
    part[i] = '/';
  }
  return 1;
}

static int installation_owner(uid_t *owner) {
  if (!trusted(INSTALL "/owner", 0, 0, 0444)) return 0;
  int fd = open(INSTALL "/owner", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return 0;
  char buffer[32];
  ssize_t count = read(fd, buffer, sizeof(buffer) - 1);
  close(fd);
  if (count < 2 || count >= (ssize_t)sizeof(buffer) - 1) return 0;
  buffer[count] = '\0';
  char *end = NULL;
  errno = 0;
  unsigned long value = strtoul(buffer, &end, 10);
  if (errno || !end || strcmp(end, "\n") != 0 || value == 0 || value > UINT_MAX)
    return 0;
  /* Reject whitespace, signs, and octal-looking spellings. */
  for (ssize_t i = 0; i < count - 1; ++i)
    if (buffer[i] < '0' || buffer[i] > '9') return 0;
  *owner = (uid_t)value;
  return 1;
}

static int prepared_management(uid_t service_uid) {
  return trusted(DATA "/data", service_uid, 1, 0700) &&
         trusted(DATA "/data/admin-auth.json", service_uid, 0, 0600) &&
         trusted(DATA "/data/admin-auth.v2", service_uid, 0, 0600);
}

static int drop_identity(uid_t uid, gid_t gid) {
  if (setgroups(0, NULL) != 0) return 0;
#if defined(__linux__)
  if (setresgid(gid, gid, gid) != 0 || setresuid(uid, uid, uid) != 0) return 0;
#else
  if (setgid(gid) != 0 || setuid(uid) != 0) return 0;
#endif
  return getuid() == uid && geteuid() == uid && getgid() == gid && getegid() == gid;
}

static volatile sig_atomic_t supervised_child = -1;
static int upgrade_gate = -1;
static volatile sig_atomic_t stopping_child = 0;
static void stop_child(int signum) {
  pid_t child = (pid_t)supervised_child;
  if (child > 0) {
    (void)kill(child, signum == SIGALRM ? SIGKILL : SIGTERM);
    if (signum != SIGALRM && !stopping_child) {
      stopping_child = 1;
      alarm(5);
    }
  }
}

/* Retaining the original real UID makes this tiny supervisor signalable by
   the caller. Only its child loads secrets, under the isolated account. */
static int supervise(uid_t uid, gid_t gid, const char *entry, int config) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = stop_child;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGINT, &action, NULL) != 0 || sigaction(SIGTERM, &action, NULL) != 0 ||
      sigaction(SIGALRM, &action, NULL) != 0) return fail("ISOLATION_SIGNALS");
  sigset_t blocked, previous;
  sigemptyset(&blocked);
  sigaddset(&blocked, SIGINT); sigaddset(&blocked, SIGTERM); sigaddset(&blocked, SIGALRM);
  if (sigprocmask(SIG_BLOCK, &blocked, &previous) != 0) return fail("ISOLATION_SIGNALS");
  pid_t child = fork();
  if (child < 0) return fail("ISOLATION_FORK_FAILED");
  if (child == 0) {
    for (int signum = 1; signum < NSIG; ++signum)
      if (signum != SIGKILL && signum != SIGSTOP) (void)signal(signum, SIG_DFL);
    sigset_t mask;
    sigemptyset(&mask);
    if (sigprocmask(SIG_SETMASK, &mask, NULL) != 0 ||
        !drop_identity(uid, gid)) _exit(fail("ISOLATION_DROP_FAILED"));
    char *environment[] = {
      "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "HOME=" DATA,
      "TMPDIR=" DATA "/tmp/", "USER=" ACCOUNT, "LOGNAME=" ACCOUNT,
      "LANG=en_US.UTF-8", "LC_ALL=en_US.UTF-8", NULL
    };
    char *arguments[] = {(char *)NODE, (char *)entry, config ? "--isolated" : NULL, NULL};
    execve(NODE, arguments, environment);
    _exit(fail("ISOLATION_EXEC_FAILED"));
  }
  supervised_child = (sig_atomic_t)child;
  (void)sigprocmask(SIG_SETMASK, &previous, NULL);
  int status;
  pid_t waited;
  do { waited = waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);
  supervised_child = -1;
  alarm(0);
  if (waited < 0) return fail("ISOLATION_WAIT_FAILED");
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 78;
}

int main(int argc, char **argv) {
  enum operation operation = parse_operation(argc, argv);
  if (operation == OP_INVALID) return fail("ISOLATION_USAGE");
#if !defined(__APPLE__)
  return fail("ISOLATION_PLATFORM_UNSUPPORTED");
#endif
  if (geteuid() != 0) return fail("ISOLATION_NOT_INSTALLED");
  if (!(operation == OP_BOOTSTRAP && getuid() == 0)) {
    if (!trusted_chain(UPDATE_GATE) || !trusted(UPDATE_GATE, 0, 0, 0600))
      return fail("ISOLATION_UPDATE_GATE_INVALID");
    /* Both supervisor and worker retain this readonly, non-secret gate fd.
       Either survivor prevents replacement of its executing runtime. */
    upgrade_gate = open(UPDATE_GATE, O_RDONLY | O_NOFOLLOW);
    struct stat gate_fd, gate_path;
    if (upgrade_gate < 0 || fstat(upgrade_gate, &gate_fd) != 0 ||
        lstat(UPDATE_GATE, &gate_path) != 0 || gate_fd.st_dev != gate_path.st_dev ||
        gate_fd.st_ino != gate_path.st_ino ||
        flock(upgrade_gate, LOCK_SH | LOCK_NB) != 0)
      return fail("ISOLATION_UPGRADING");
  }
  uid_t caller = getuid(), owner;
  if (!trusted_chain(INSTALL "/launch") || !trusted(INSTALL, 0, 1, 0755) ||
      !trusted(INSTALL "/launch", 0, 0, 0) ||
      !trusted(NODE, 0, 0, 0555) || !trusted(RUNTIME, 0, 1, 0755) ||
      !trusted_chain(RUNTIME "/dist/src/isolated-worker.js") ||
      !trusted(RUNTIME "/dist/src/isolated-worker.js", 0, 0, 0444) ||
      !installation_owner(&owner))
    return fail("ISOLATION_INSTALL_INVALID");
  if (operation == OP_BOOTSTRAP ? caller != 0 : caller != owner)
    return fail("ISOLATION_CALLER_DENIED");

  struct passwd *record = getpwnam(ACCOUNT);
  if (!record || record->pw_uid == 0 || record->pw_gid == 0 ||
      strcmp(record->pw_dir, "/var/empty") != 0 ||
      (strcmp(record->pw_shell, "/usr/bin/false") != 0 &&
       strcmp(record->pw_shell, "/sbin/nologin") != 0))
    return fail("ISOLATION_IDENTITY_INVALID");
  uid_t service_uid = record->pw_uid;
  gid_t service_gid = record->pw_gid;
  if (service_uid == owner ||
      !trusted_chain(DATA) || !trusted(DATA, service_uid, 1, 0700))
    return fail("ISOLATION_DATA_INVALID");
  if (operation != OP_BOOTSTRAP && !prepared_management(service_uid))
    return fail("ISOLATION_MANAGEMENT_REQUIRED");

  const char *entry = operation == OP_CONFIG ? RUNTIME "/dist/src/local-config.js" :
                      operation == OP_BOOTSTRAP ? RUNTIME "/dist/src/isolation-bootstrap.js" :
                      RUNTIME "/dist/src/isolated-worker.js";
  if (!trusted(entry, 0, 0, 0444)) return fail("ISOLATION_RUNTIME_INVALID");
  struct rlimit core = {0, 0};
  if (setrlimit(RLIMIT_CORE, &core) != 0) return fail("ISOLATION_CORE_LIMIT");
  /* Preserve only the request and response pipes. No extra file capabilities. */
  for (int fd = 3, maximum = getdtablesize(); fd < maximum; ++fd)
    if (fd != upgrade_gate) close(fd);
  sigset_t mask;
  sigemptyset(&mask);
  if (sigprocmask(SIG_SETMASK, &mask, NULL) != 0) return fail("ISOLATION_SIGNALS");
  for (int signum = 1; signum < NSIG; ++signum)
    if (signum != SIGKILL && signum != SIGSTOP) (void)signal(signum, SIG_DFL);
  umask(0077);
  if (chdir(RUNTIME) != 0) return fail("ISOLATION_RUNTIME_INVALID");
  /* No PATH lookup, Node flags, preload hooks, certificates, proxies, HOME,
     dynamic-loader options, or Abilock settings may come from the caller. */
  return supervise(service_uid, service_gid, entry, operation == OP_CONFIG);
}
