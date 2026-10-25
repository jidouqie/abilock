#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

/* Node passes the same open file description as fd 3. No filenames or
   commands are accepted. The parent keeps the lock when this helper exits. */
int main(int argc, char **argv) {
  (void)argv;
  struct stat info;
  if (argc != 1 || getuid() != geteuid() || fstat(3, &info) != 0 ||
      !S_ISREG(info.st_mode) || info.st_uid != geteuid() ||
      info.st_nlink != 1 || (info.st_mode & 077) != 0) return 78;
  if (flock(3, LOCK_EX | LOCK_NB) != 0)
    return errno == EWOULDBLOCK || errno == EAGAIN ? 75 : 78;
  if (write(STDOUT_FILENO, "LOCKED\n", 7) != 7) return 78;
  /* Deliberately do not LOCK_UN: the parent's descriptor owns this lock. */
  return 0;
}
