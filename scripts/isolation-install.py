#!/usr/bin/env python3
"""Install a reviewed, complete macOS bundle; never exposes user credentials.

The root caller supplies a public bundle digest and installation owner. Existing
credential migration is a separate trusted operation, never an argument here.
No launchd job, listener, sudoers permission, or background service is installed.
"""
from __future__ import annotations

import argparse
import ctypes
import fcntl
import hashlib
import json
import os
import re
import pathlib
import pwd
import shutil
import stat
import subprocess
import sys
import tempfile
import time

INSTALL = pathlib.Path("/usr/local/libexec/abilock")
DATA = pathlib.Path("/private/var/db/abilock")
BACKUPS = pathlib.Path('/private/var/db/abilock-backups')
BACKUP_MARKER = b'Abilock trusted installer backup directory v1\n'
MAX_BACKUP_BYTES = 64 * 1024 * 1024 * 1024
MAX_BACKUP_ENTRIES = 200000
MAX_BACKUP_METADATA_BYTES = 64 * 1024 * 1024
ACCOUNT = "_abilock"
PUBLIC_CLI = pathlib.Path('/usr/local/bin/abl')
CLI_WRAPPER = b'#!/bin/sh\nexec /usr/local/libexec/abilock/node /usr/local/libexec/abilock/runtime/bin/abl.mjs "$@"\n'
MAX_BUNDLE_BYTES = 1024 * 1024 * 1024
INSTALL_LOCK = pathlib.Path("/private/var/db/.abilock-install.lock")
INSTALL_PHASE = "initial"
INSTALL_PHASES = {"initial", "prepared", "verification", "identity", "private-snapshot", "migrate",
                 "owner-transfer", "backup", "rewrite", "install", "bootstrap", "commit"}
VERIFICATION_CHECKS = {"protected_bootstrap", "kernel_secret_read_EACCES", "kernel_runtime_write_EACCES",
                       "existing_list_doc_commands", "authorized_api_and_echo_redaction", "execution_rejects_management",
                       "extra_arguments_and_bootstrap_denied", "environment_injection_ignored",
                       "target_and_auth_override_denied", "worker_has_separate_uid", "no_execution_listener",
                       "eof_cancel_exit_bounded", "temporary_config_exits_without_browser"}
VERIFICATION_KEYS = {"ok", "checks", "nodeVersion", "syntheticOnly", "fixtureDeviations",
                     "releaseWorkerProxyRedactionUnchanged", "fixtureRemoved"}
VERIFICATION_DEVIATIONS = ["fixed fixture installation/data/client launcher paths",
                          "compile-time existing nobody test identity", "protected fixture-only ALLOW_LOCAL=1"]
libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True) if sys.platform == "darwin" else None
if libc is not None:
    libc.acl_get_file.argtypes = [ctypes.c_char_p, ctypes.c_int]
    libc.acl_get_file.restype = ctypes.c_void_p
    libc.acl_to_text.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ssize_t)]
    libc.acl_to_text.restype = ctypes.c_void_p
    libc.acl_from_text.argtypes = [ctypes.c_char_p]
    libc.acl_from_text.restype = ctypes.c_void_p
    libc.acl_set_file.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p]
    libc.acl_free.argtypes = [ctypes.c_void_p]
    libc.acl_get_fd_np.argtypes = [ctypes.c_int, ctypes.c_int]
    libc.acl_get_fd_np.restype = ctypes.c_void_p
    libc.acl_set_fd_np.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
    libc.acl_init.argtypes = [ctypes.c_int]
    libc.acl_init.restype = ctypes.c_void_p


def acl_fd_text(descriptor: int) -> bytes:
    if libc is None:
        return b""
    ctypes.set_errno(0)
    permissions = libc.acl_get_fd_np(descriptor, 0x100)
    if not permissions:
        if ctypes.get_errno() == 2:
            return b"!#acl 1\n"
        refuse("File permissions could not be verified")
    text = None
    try:
        length = ctypes.c_ssize_t()
        text = libc.acl_to_text(permissions, ctypes.byref(length))
        if not text:
            refuse("File permissions could not be verified")
        return ctypes.string_at(text, length.value).rstrip(b"\0")
    finally:
        if text:
            libc.acl_free(text)
        libc.acl_free(permissions)


def acl_fd_set(descriptor: int, text: bytes | None = None) -> None:
    if libc is None:
        return
    permissions = libc.acl_init(0) if text is None else libc.acl_from_text(text)
    if not permissions:
        refuse("File permissions could not be updated")
    try:
        if libc.acl_set_fd_np(descriptor, permissions, 0x100) != 0:
            refuse("File permissions could not be updated")
    finally:
        libc.acl_free(permissions)


def acl_fd_empty(descriptor: int) -> bool:
    return not any(line.strip() and not line.startswith(b"!#acl")
                   for line in acl_fd_text(descriptor).splitlines())


def acl_text(file: pathlib.Path) -> bytes:
    if libc is None:
        return b""
    permissions = libc.acl_get_file(os.fsencode(file), 0x100)
    if not permissions:
        if ctypes.get_errno() == 2 and file.exists():
            return b"!#acl 1\n"
        refuse("File permissions could not be verified")
    text = None
    try:
        length = ctypes.c_ssize_t()
        text = libc.acl_to_text(permissions, ctypes.byref(length))
        if not text:
            refuse("File permissions could not be verified")
        return ctypes.string_at(text, length.value).rstrip(b"\0")
    finally:
        if text:
            libc.acl_free(text)
        libc.acl_free(permissions)


def acl_restore(file: pathlib.Path, text: bytes) -> None:
    if libc is None:
        return
    permissions = libc.acl_from_text(text)
    if not permissions:
        refuse("Original file permissions could not be restored")
    try:
        if libc.acl_set_file(os.fsencode(file), 0x100, permissions) != 0:
            refuse("Original file permissions could not be restored")
    finally:
        libc.acl_free(permissions)


def clear_acl(file: pathlib.Path, recursive: bool = False) -> None:
    if sys.platform == "darwin":
        subprocess.run(["/bin/chmod", "-RN" if recursive else "-N", str(file)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def refuse(message: str) -> None:
    raise ValueError(message)


def set_install_phase(phase: str) -> None:
    global INSTALL_PHASE
    if phase not in INSTALL_PHASES:
        refuse("Invalid installation phase")
    INSTALL_PHASE = phase


def validate_verification_report(result: object, node_version: str) -> dict:
    """Accept exactly the reviewed verifier contract, never arbitrary fields."""
    if type(result) is not dict or set(result) != VERIFICATION_KEYS or \
            any(result.get(name) is not True for name in ("ok", "syntheticOnly",
                                                         "releaseWorkerProxyRedactionUnchanged", "fixtureRemoved")) or \
            type(result.get("nodeVersion")) is not str or type(node_version) is not str or \
            result["nodeVersion"] != node_version or type(result.get("checks")) is not dict or \
            set(result["checks"]) != VERIFICATION_CHECKS or any(value is not True for value in result["checks"].values()) or \
            type(result.get("fixtureDeviations")) is not list or result["fixtureDeviations"] != VERIFICATION_DEVIATIONS:
        refuse("Synthetic isolation verification report is invalid")
    return result


def file_digest(file: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with file.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def validate_bundle(bundle: pathlib.Path, expected: str) -> dict:
    bundle = bundle.resolve(strict=True)
    if not bundle.is_dir() or bundle.is_symlink():
        refuse("Invalid installation bundle")
    manifest_file = bundle / "manifest.json"
    if manifest_file.is_symlink() or file_digest(manifest_file) != expected:
        refuse("Installation manifest changed")
    manifest = json.loads(manifest_file.read_text("utf-8"))
    if set(manifest) != {"version", "platform", "arch", "nodeVersion", "runtimeVersion", "files"} or manifest["version"] != 1:
        refuse("Invalid installation manifest")
    if manifest["platform"] != "darwin" or manifest["arch"] not in {"arm64", "x64"}:
        refuse("Unsupported installation platform")
    if not isinstance(manifest["files"], list) or not manifest["files"]:
        refuse("Installation manifest has no files")
    required = {"launch", "password", "node", "authorize", "verify-launch", "file-lock", "runtime/dist/src/isolated-worker.js",
                "runtime/dist/src/local-config.js", "runtime/dist/src/isolation-bootstrap.js",
                "runtime/package.json"}
    if version_tuple(manifest['runtimeVersion']) >= (2, 2, 0):
        required.update({'Install.command', 'runtime/scripts/install-macos.sh', 'runtime/bin/install-bundle.mjs',
                         'runtime/desktop/Abilock.app/Contents/MacOS/Abilock',
                         'runtime/desktop/Abilock.app/Contents/Info.plist',
                         'runtime/skills/abilock/SKILL.md'})
    declared = {}
    for item in manifest["files"]:
        if not isinstance(item, dict) or set(item) != {"path", "sha256", "mode"} or \
                not isinstance(item["path"], str) or not isinstance(item["sha256"], str) or \
                item["mode"] not in {420, 493} or item["path"] in declared:
            refuse("Invalid installation file record")
        name = pathlib.PurePosixPath(item["path"])
        if name.is_absolute() or ".." in name.parts or str(name) != item["path"]:
            refuse("Invalid installation file path")
        declared[item["path"]] = item["sha256"]
    if not required.issubset(declared):
        refuse("Installation bundle is incomplete")
    actual = {}
    total = 0
    for root, directories, files in os.walk(bundle, followlinks=False):
        for name in directories + files:
            file = pathlib.Path(root) / name
            relative = file.relative_to(bundle).as_posix()
            info = file.lstat()
            if info.st_mode & (stat.S_ISUID | stat.S_ISGID):
                refuse("Bundle contains a privileged file")
            if file.is_symlink():
                # Even an internal symlink unnecessarily expands the privileged
                # install contract; preparation must copy its ordinary target.
                refuse("Bundle contains a symbolic link")
            if file.is_dir():
                continue
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                refuse("Bundle contains a non-regular file or hard link")
            if relative == "manifest.json":
                continue
            if relative.startswith("/") or ".." in pathlib.PurePosixPath(relative).parts:
                refuse("Invalid manifest path")
            total += info.st_size
            if total > MAX_BUNDLE_BYTES:
                refuse("Installation bundle is too large")
            actual[relative] = file_digest(file)
    if actual != declared:
        refuse("Installation bundle changed")
    for relative in actual:
        if relative not in {"launch", "password", "node", "authorize", "verify-launch", "file-lock", "Install.command"} and not relative.startswith("runtime/"):
            refuse("Unexpected installation file")
    if version_tuple(manifest['runtimeVersion']) >= (2, 2, 0):
        entry = bundle / 'Install.command'
        if file_digest(entry) != file_digest(bundle / 'runtime/scripts/install-macos.sh') or \
                next(item['mode'] for item in manifest['files'] if item['path'] == 'Install.command') != 0o755:
            refuse('The installation entry is inconsistent')
        if any(value > 127 for value in entry.read_bytes()):
            refuse('The installation entry must be ASCII English')
    return manifest


def check_system_node(node: pathlib.Path) -> None:
    """A copied Homebrew Node still loads user-writable dylibs. Reject it."""
    result = subprocess.run(["/usr/bin/otool", "-L", str(node)], check=True,
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    for line in result.stdout.splitlines()[1:]:
        dependency = line.strip().split(" (", 1)[0]
        if dependency and not (dependency.startswith("/usr/lib/") or
                               dependency.startswith("/System/Library/")):
            refuse("Node requires an unprotected dynamic library")


def copy_checked_bundle(bundle: pathlib.Path, staging: pathlib.Path, manifest: dict) -> None:
    """Use no-follow descriptors, not a root copytree over mutable user paths."""
    directory = os.open(bundle, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for item in manifest["files"]:
            parts = pathlib.PurePosixPath(item["path"]).parts
            current = os.dup(directory)
            try:
                for component in parts[:-1]:
                    nested = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                     dir_fd=current)
                    os.close(current)
                    current = nested
                source = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                                 dir_fd=current)
                try:
                    info = os.fstat(source)
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                        refuse("Installation source changed")
                    destination = staging / item["path"]
                    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    digest = hashlib.sha256()
                    with destination.open("xb") as output:
                        count = 0
                        while chunk := os.read(source, 1024 * 1024):
                            count += len(chunk)
                            if count > info.st_size or count > MAX_BUNDLE_BYTES:
                                refuse("Installation source changed")
                            digest.update(chunk)
                            output.write(chunk)
                    if count != info.st_size or digest.hexdigest() != item["sha256"]:
                        refuse("Installation source changed")
                finally:
                    os.close(source)
            finally:
                os.close(current)
        # Serialize the already verified public metadata, never recopy an
        # attacker-controlled manifest between validation and commit.
        shutil.copyfile(bundle / "manifest.json", staging / "manifest.json", follow_symlinks=False)
    finally:
        os.close(directory)


def validate_private_tree(directory: pathlib.Path) -> list:
    """Check the whole tree and retain exact metadata before any mutation."""
    records = []
    def visit(descriptor: int, relative: str) -> None:
        info = os.fstat(descriptor)
        if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)) or \
                (stat.S_ISREG(info.st_mode) and info.st_nlink != 1):
            refuse("Private configuration contains an unsupported file")
        records.append({"path": relative, "uid": info.st_uid, "gid": info.st_gid,
                        "mode": stat.S_IMODE(info.st_mode), "directory": stat.S_ISDIR(info.st_mode),
                        "dev": info.st_dev, "ino": info.st_ino, "acl": acl_fd_text(descriptor)})
        if stat.S_ISDIR(info.st_mode):
            for name in sorted(os.listdir(descriptor)):
                child = None
                try:
                    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                                    dir_fd=descriptor)
                    visit(child, name if relative == "." else relative + "/" + name)
                except OSError:
                    refuse("Private configuration contains an unsupported file")
                finally:
                    if child is not None:
                        os.close(child)
    root = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        visit(root, ".")
    finally:
        os.close(root)
    return records


def apply_private_tree(directory: pathlib.Path, uid: int, gid: int, records: list) -> None:
    by_path = {record["path"]: record for record in records}
    directories = sorted((record for record in records if record["directory"]),
                         key=lambda record: len(pathlib.PurePosixPath(record["path"]).parts))
    expected_children = {record["path"]: set() for record in directories}
    for record in records:
        if record["path"] != ".":
            relative = pathlib.PurePosixPath(record["path"])
            expected_children[str(relative.parent)].add(relative.name)
    opened = {}
    def verify(descriptor: int, record: dict) -> None:
        info = os.fstat(descriptor)
        correct_type = stat.S_ISDIR(info.st_mode) if record["directory"] else stat.S_ISREG(info.st_mode)
        if not correct_type or info.st_dev != record["dev"] or info.st_ino != record["ino"] or \
                (not record["directory"] and info.st_nlink != 1):
            refuse("Private configuration changed before migration")
    try:
        # Freeze parent namespaces before opening their children. An inherited
        # old-user directory descriptor cannot bypass the directory's new DAC.
        for record in directories:
            relative = pathlib.PurePosixPath(record["path"])
            if record["path"] == ".":
                descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            else:
                descriptor = os.open(relative.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                     dir_fd=opened[str(relative.parent)])
            opened[record["path"]] = descriptor
            verify(descriptor, record)
            os.fchown(descriptor, uid, gid)
            acl_fd_set(descriptor)
            os.fchmod(descriptor, 0o700)
            if not acl_fd_empty(descriptor):
                refuse("Private directory permissions changed during migration")
            if set(os.listdir(descriptor)) != expected_children[record["path"]]:
                refuse("Private configuration children changed before migration")
        # Every directory is now frozen. Never chmod/chown a pathname from the
        # user's former tree, and never follow a late symlink or hard link.
        for record in records:
            if record["directory"]:
                continue
            relative = pathlib.PurePosixPath(record["path"])
            descriptor = os.open(relative.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                                 dir_fd=opened[str(relative.parent)])
            try:
                verify(descriptor, record)
                os.fchown(descriptor, uid, gid)
                acl_fd_set(descriptor)
                os.fchmod(descriptor, 0o600 | (record["mode"] & 0o100))
                if not acl_fd_empty(descriptor):
                    refuse("Private file permissions changed during migration")
                verify(descriptor, record)
                linked = os.stat(relative.name, dir_fd=opened[str(relative.parent)], follow_symlinks=False)
                if linked.st_dev != record["dev"] or linked.st_ino != record["ino"] or \
                        not stat.S_ISREG(linked.st_mode) or linked.st_nlink != 1:
                    refuse("Private configuration file changed during migration")
            finally:
                os.close(descriptor)
        for relative, descriptor in opened.items():
            verify(descriptor, by_path[relative])
            if set(os.listdir(descriptor)) != expected_children[relative]:
                refuse("Private configuration children changed during migration")
            if relative != ".":
                component = pathlib.PurePosixPath(relative)
                info = os.stat(component.name, dir_fd=opened[str(component.parent)], follow_symlinks=False)
                if info.st_dev != by_path[relative]["dev"] or info.st_ino != by_path[relative]["ino"]:
                    refuse("Private configuration directory changed during migration")
    except OSError:
        refuse("Private configuration changed before migration")
    finally:
        for descriptor in opened.values():
            os.close(descriptor)


def restore_private_tree(directory: pathlib.Path, records: list, expected_identity: bool = False) -> None:
    # Use the prevalidated snapshot rather than repeating a validator that may
    # be the very cause of rollback. The protected backup has ordinary files.
    opened = {}
    def same(descriptor: int, record: dict) -> bool:
        info = os.fstat(descriptor)
        return (stat.S_ISDIR(info.st_mode) if record["directory"] else stat.S_ISREG(info.st_mode)) and \
            (record["directory"] or info.st_nlink == 1) and \
            (not expected_identity or (info.st_dev == record["dev"] and info.st_ino == record["ino"]))
    try:
        for record in sorted((value for value in records if value["directory"]),
                             key=lambda value: len(pathlib.PurePosixPath(value["path"]).parts)):
            relative = pathlib.PurePosixPath(record["path"])
            try:
                descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC) \
                    if record["path"] == "." else os.open(relative.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                                          dir_fd=opened[str(relative.parent)])
            except (OSError, KeyError):
                if expected_identity:
                    continue
                raise
            if not same(descriptor, record):
                os.close(descriptor)
                if expected_identity:
                    continue
                refuse("Protected rollback directory changed")
            opened[record["path"]] = descriptor
            # Re-freeze even untouched siblings before opening their children.
            # The former owner must lose ACL ownership before its removal.
            os.fchown(descriptor, os.geteuid(), os.getegid())
            acl_fd_set(descriptor)
            os.fchmod(descriptor, 0o700)
            if not acl_fd_empty(descriptor):
                refuse("Rollback directory permissions changed")
        for record in records:
            if record["directory"]:
                continue
            relative = pathlib.PurePosixPath(record["path"])
            try:
                descriptor = os.open(relative.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                                     dir_fd=opened[str(relative.parent)])
            except (OSError, KeyError):
                if expected_identity:
                    continue
                raise
            try:
                if not same(descriptor, record):
                    if expected_identity:
                        continue
                    refuse("Protected rollback file changed")
                os.fchmod(descriptor, record["mode"] & ~0o6000)
                acl_fd_set(descriptor, record["acl"])
                os.fchown(descriptor, record["uid"], record["gid"])
            finally:
                os.close(descriptor)
        for record in sorted((value for value in records if value["directory"]),
                             key=lambda value: len(pathlib.PurePosixPath(value["path"]).parts), reverse=True):
            descriptor = opened.get(record["path"])
            if descriptor is not None:
                os.fchmod(descriptor, record["mode"] & ~0o6000)
                acl_fd_set(descriptor, record["acl"])
                os.fchown(descriptor, record["uid"], record["gid"])
    finally:
        for descriptor in opened.values():
            os.close(descriptor)


def private_tree(directory: pathlib.Path, uid: int, gid: int) -> None:
    records = validate_private_tree(directory)
    apply_private_tree(directory, uid, gid, records)


def rewrite_data_directory(directory: pathlib.Path, destination: pathlib.Path) -> None:
    file = directory / "service.env"
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 8192:
        refuse("Private startup configuration is invalid")
    # This operation occurs only inside the trusted root installer. The text
    # never enters CLI output, logs, a public artifact, or a model tool result.
    contents = file.read_text("utf-8")
    pattern = r"(?m)^ABILOCK_DATA_DIR=.*$"
    if len(re.findall(pattern, contents)) != 1:
        refuse("Private startup configuration is invalid")
    new_contents = re.sub(pattern, "ABILOCK_DATA_DIR=" + json.dumps(str(destination / "data")), contents)
    temporary = directory / ".service.env.install"
    with temporary.open("x", encoding="utf-8") as output:
        output.write(new_contents)
        output.flush()
        os.fsync(output.fileno())
    os.chmod(temporary, 0o600)
    os.chown(temporary, info.st_uid, info.st_gid)
    temporary.replace(file)


def bootstrap_management(uid: int, gid: int) -> None:
    if (DATA / "data/admin-auth.json").exists() and (DATA / "data/admin-auth.v2").exists():
        return
    read_pipe, write_pipe = os.pipe()
    password_pid = None
    bootstrap_process = None
    try:
        password_pid = os.fork()
        if password_pid == 0:
            try:
                os.dup2(write_pipe, 3)
                os.set_inheritable(3, True)
                os.closerange(4, 65536)
                os.execve(str(INSTALL / "password"), [str(INSTALL / "password")],
                          {"PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"})
            finally:
                os._exit(78)
        os.close(write_pipe)
        write_pipe = -1
        bootstrap_process = subprocess.Popen([str(INSTALL / "launch"), "bootstrap-admin"],
                                              stdin=read_pipe, stdout=subprocess.DEVNULL,
                                              stderr=subprocess.DEVNULL)
        os.close(read_pipe)
        read_pipe = -1
        _, password_status = os.waitpid(password_pid, 0)
        password_pid = None
        if os.waitstatus_to_exitcode(password_status) != 0 or bootstrap_process.wait() != 0:
            refuse("Management password setup was cancelled or failed")
        private_tree(DATA, uid, gid)
        if not (DATA / "data/admin-auth.json").is_file() or not (DATA / "data/admin-auth.v2").is_file():
            refuse("Management password setup did not complete")
    finally:
        for descriptor in (read_pipe, write_pipe):
            if descriptor >= 0:
                os.close(descriptor)
        if password_pid is not None:
            try:
                os.kill(password_pid, 15)
                os.waitpid(password_pid, 0)
            except ProcessLookupError:
                pass
        for process in (bootstrap_process,):
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=6)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def root_directory(path: pathlib.Path, created: list | None = None) -> None:
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            refuse("Untrusted system installation directory")
        if any(line.strip() and not line.startswith(b"!#acl") for line in acl_text(path).splitlines()):
            refuse("Shared system directory has additional permissions")
    else:
        root_directory(path.parent, created)
        path.mkdir(mode=0o755)
        os.chown(path, 0, 0)
        clear_acl(path)
        # The installer uses umask 077 for private files. Public parents must
        # still be traversable; never change permissions of existing parents.
        os.chmod(path, 0o755)
        if created is not None:
            created.append((path, path.stat().st_ino))


def ensure_account(transaction: dict | None = None) -> tuple[int, int, bool]:
    import grp
    try:
        account = pwd.getpwnam(ACCOUNT)
    except KeyError:
        account = None
    if account is not None:
        if account.pw_uid == 0 or account.pw_uid >= 500 or account.pw_gid == 0 or \
                account.pw_dir != "/var/empty" or account.pw_shell != "/usr/bin/false":
            refuse("Existing Abilock system identity is incompatible")
        try:
            group = grp.getgrgid(account.pw_gid)
        except KeyError:
            refuse("Existing Abilock system group is missing")
        if group.gr_name != ACCOUNT:
            refuse("Existing Abilock system group is incompatible")
        return account.pw_uid, account.pw_gid, False
    try:
        grp.getgrnam(ACCOUNT)
        refuse("An unrelated group already uses the Abilock identity name")
    except KeyError:
        pass
    used_users = {entry.pw_uid for entry in pwd.getpwall()}
    used_groups = {entry.gr_gid for entry in grp.getgrall()}
    identifier = next((number for number in range(300, 500)
                       if number not in used_users and number not in used_groups), None)
    if identifier is None:
        refuse("No unused system identity is available")
    # Persist a tag before account mutation; each initial dscl create writes
    # the tag atomically, making partial identity recovery attributable.
    transaction_id = transaction['transactionId'] if transaction is not None else ''
    if transaction is not None:
        transaction.update(accountCreated=True, uid=identifier, gid=identifier)
        journal_write(transaction)
    steps = [
        ["-create", f"/Groups/{ACCOUNT}", "AbilockInstallTransaction", transaction_id],
        ["-create", f"/Groups/{ACCOUNT}", "PrimaryGroupID", str(identifier)],
        ["-create", f"/Groups/{ACCOUNT}", "Password", "*"],
        ["-create", f"/Users/{ACCOUNT}", "AbilockInstallTransaction", transaction_id],
        ["-create", f"/Users/{ACCOUNT}", "UniqueID", str(identifier)],
        ["-create", f"/Users/{ACCOUNT}", "PrimaryGroupID", str(identifier)],
        ["-create", f"/Users/{ACCOUNT}", "UserShell", "/usr/bin/false"],
        ["-create", f"/Users/{ACCOUNT}", "NFSHomeDirectory", "/var/empty"],
        ["-create", f"/Users/{ACCOUNT}", "RealName", "Abilock"],
        ["-create", f"/Users/{ACCOUNT}", "Password", "*"],
        ["-create", f"/Users/{ACCOUNT}", "IsHidden", "1"],
    ]
    try:
        for arguments in steps:
            subprocess.run(["/usr/bin/dscl", ".", *arguments], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for attempt in range(8):
            if service_identity_matches(identifier, identifier):
                break
            if attempt == 7:
                refuse("New system identity could not be verified")
            time.sleep(0.125)
    except BaseException:
        if transaction is not None:
            remove_transaction_account(transaction_id)
        raise
    return identifier, identifier, True


def service_identity_matches(uid: int, gid: int) -> bool:
    import grp
    try:
        account = pwd.getpwnam(ACCOUNT)
        account_by_id = pwd.getpwuid(uid)
        group = grp.getgrnam(ACCOUNT)
        group_by_id = grp.getgrgid(gid)
        return account.pw_name == ACCOUNT and account_by_id.pw_name == ACCOUNT and \
            account.pw_uid == uid and account_by_id.pw_uid == uid and account.pw_gid == gid and \
            account.pw_dir == "/var/empty" and account.pw_shell == "/usr/bin/false" and \
            account_by_id.pw_gid == gid and account_by_id.pw_dir == "/var/empty" and \
            account_by_id.pw_shell == "/usr/bin/false" and \
            group.gr_name == ACCOUNT and group.gr_gid == gid and group_by_id.gr_name == ACCOUNT and \
            group_by_id.gr_gid == gid
    except KeyError:
        return False


# Durable transaction records contain paths, hashes and permission metadata only.
# Any opaque private backup remains inside this root-only directory.
TRANSACTION = pathlib.Path('/private/var/db/.abilock-install-transaction')
TRANSACTION_CLEANUP = pathlib.Path('/private/var/db/.abilock-install-cleanup')
RUNTIME_LOCK = pathlib.Path('/private/var/db/.abilock-runtime.lock')
EXECUTABLES = {'launch', 'password', 'node', 'authorize', 'verify-launch', 'file-lock'}
DESKTOP_EXECUTABLE = 'runtime/desktop/Abilock.app/Contents/MacOS/Abilock'


def public_executable(relative: str) -> bool:
    return relative in EXECUTABLES or relative in {'Install.command', DESKTOP_EXECUTABLE}


def public_cli_state(owner: int) -> tuple | None:
    """Check a fixed public filename, never follow a caller-selected target."""
    current = PUBLIC_CLI.parent
    while True:
        try:
            info = current.lstat()
        except FileNotFoundError:
            current = current.parent
            continue
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or \
                any(line.strip() and not line.startswith(b'!#acl') for line in acl_text(current).splitlines()):
            refuse('The public command directory is not protected')
        if current == current.parent:
            break
        current = current.parent
    try:
        info = PUBLIC_CLI.lstat()
    except FileNotFoundError:
        return None
    if info.st_uid not in {0, owner}:
        refuse('An unrelated public abl command already exists')
    if stat.S_ISLNK(info.st_mode):
        target = pathlib.Path(os.path.abspath(PUBLIC_CLI.parent / os.readlink(PUBLIC_CLI)))
        expected = pathlib.Path('/usr/local/lib/node_modules/abilock/bin/abl.mjs')
        if target != expected:
            refuse('An unrelated public abl link already exists')
        package_file = expected.parent.parent / 'package.json'
        package_info = package_file.lstat()
        if not stat.S_ISREG(package_info.st_mode) or package_info.st_size > 65536:
            refuse('The existing public CLI package is invalid')
        package = json.loads(package_file.read_text('utf-8'))
        if package.get('name') != 'abilock' or package.get('bin', {}).get('abl') != 'bin/abl.mjs':
            refuse('An unrelated public CLI package already exists')
        return (info.st_dev, info.st_ino, 'link', str(target))
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != len(CLI_WRAPPER):
        refuse('An unrelated public abl command already exists')
    descriptor = os.open(PUBLIC_CLI, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino) or os.read(descriptor, 4096) != CLI_WRAPPER:
            refuse('An unrelated public abl command already exists')
    finally:
        os.close(descriptor)
    return (info.st_dev, info.st_ino, 'wrapper')


def register_public_cli(owner: int, expected: tuple | None) -> None:
    """Publish only the constant wrapper after the protected runtime commits."""
    import uuid
    root_directory(PUBLIC_CLI.parent)
    if public_cli_state(owner) != expected:
        refuse('The public CLI entry changed during installation')
    parent = os.open(PUBLIC_CLI.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = '.abilock-cli-' + uuid.uuid4().hex
    descriptor = None
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        os.fchown(descriptor, 0, 0)
        acl_fd_set(descriptor)
        with os.fdopen(os.dup(descriptor), 'wb') as output:
            output.write(CLI_WRAPPER)
            output.flush()
        os.fchmod(descriptor, 0o555)
        os.fsync(descriptor)
        if public_cli_state(owner) != expected:
            refuse('The public CLI entry changed during installation')
        if expected is None:
            # A late conflicting entry must not be overwritten.
            os.link(temporary, PUBLIC_CLI.name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            os.unlink(temporary, dir_fd=parent)
        else:
            os.replace(temporary, PUBLIC_CLI.name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass
        os.close(parent)


JOURNAL_KEYS = {'version', 'owner', 'mode', 'phase', 'staging', 'stagingIdentity', 'oldIdentity',
                'oldLaunchMode', 'dataIdentity', 'original', 'records', 'backupIdentity',
                'backupReady', 'accountCreated', 'uid', 'gid', 'transactionId'}


def identity(path: pathlib.Path) -> list[int] | None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        refuse('Transaction path is not a directory')
    return [info.st_dev, info.st_ino]


def sync_directory(directory: pathlib.Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def sync_tree(directory: pathlib.Path) -> None:
    for root, directories, files in os.walk(directory, followlinks=False):
        for name in files:
            descriptor = os.open(pathlib.Path(root) / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                    refuse('Transaction file is not regular')
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        sync_directory(pathlib.Path(root))


def backup_fd_xattrs(descriptor: int) -> dict[str, str]:
    # Apple's system Python may not expose os.*xattr. Read via the already
    # opened fd so unsupported metadata can never be silently discarded.
    if libc is not None:
        listing = libc.flistxattr
        listing.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
        listing.restype = ctypes.c_ssize_t
        reading = libc.fgetxattr
        reading.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_void_p,
                            ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]
        reading.restype = ctypes.c_ssize_t
        length = listing(descriptor, None, 0, 0)
        if length < 0 or length > MAX_BACKUP_METADATA_BYTES:
            refuse('Backup extended attributes could not be verified')
        if length == 0:
            return {}
        names_buffer = ctypes.create_string_buffer(length)
        if listing(descriptor, names_buffer, length, 0) != length:
            refuse('Backup extended attributes changed while being read')
        names = names_buffer.raw.split(b'\0')
        if names[-1] != b'' or any(not name for name in names[:-1]):
            refuse('Backup extended attributes are invalid')
        values = {}
        total = length * 2
        for name in sorted(names[:-1]):
            size = reading(descriptor, name, None, 0, 0, 0)
            total += size * 2
            if size < 0 or total > MAX_BACKUP_METADATA_BYTES:
                refuse('Backup extended attributes are too large')
            buffer = ctypes.create_string_buffer(max(size, 1))
            if reading(descriptor, name, buffer, size, 0, 0) != size:
                refuse('Backup extended attributes changed while being read')
            values[name.hex()] = buffer.raw[:size].hex()
        return values
    if not hasattr(os, 'listxattr') or not hasattr(os, 'getxattr'):
        refuse('Backup extended attribute verification is unsupported')
    values = {}
    total = 0
    for name in sorted(os.listxattr(descriptor)):
        value = os.getxattr(descriptor, name)
        total += (len(os.fsencode(name)) + len(value)) * 2
        if total > MAX_BACKUP_METADATA_BYTES:
            refuse('Backup extended attributes are too large')
        values[os.fsencode(name).hex()] = value.hex()
    return values


def backup_tree_snapshot(source: pathlib.Path, destination: pathlib.Path | None = None,
                         budget: dict | None = None) -> list[dict]:
    """Opaque, bounded fd traversal; never follow links or modify the source.

    Backup files deliberately remain root-only and non-executable. Original
    ownership, permissions, ACLs and extended attributes are recovery metadata
    in the root-only manifest, not applied to the backup's protection boundary.
    """
    if budget is None:
        budget = {'bytes': 0, 'entries': 0, 'metadata': 0}
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    root = os.open(source, flags | os.O_DIRECTORY)
    records = []
    device = os.fstat(root).st_dev

    def attributes(descriptor: int) -> dict:
        info = os.fstat(descriptor)
        directory = stat.S_ISDIR(info.st_mode)
        if info.st_dev != device or not (directory or stat.S_ISREG(info.st_mode)) or \
                (not directory and info.st_nlink != 1):
            refuse('Backup source contains an unsupported entry')
        xattrs = backup_fd_xattrs(descriptor)
        return {'dev': info.st_dev, 'ino': info.st_ino, 'uid': info.st_uid,
                'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode),
                'directory': directory, 'size': info.st_size,
                'mtimeNs': info.st_mtime_ns, 'ctimeNs': info.st_ctime_ns,
                'flags': getattr(info, 'st_flags', 0), 'acl': acl_fd_text(descriptor).hex(),
                'xattrs': xattrs}

    def walk(descriptor: int, relative: str, target: pathlib.Path | None, depth: int) -> None:
        if depth > 128:
            refuse('Backup source is too deep')
        before = attributes(descriptor)
        budget['entries'] += 1
        budget['metadata'] += len(json.dumps(before)) + len(relative.encode('utf-8'))
        if budget['entries'] > MAX_BACKUP_ENTRIES or budget['metadata'] > MAX_BACKUP_METADATA_BYTES:
            refuse('Backup source is too large')
        record = {'path': relative, **before}
        records.append(record)
        if before['directory']:
            names = sorted(os.listdir(descriptor))
            if budget['entries'] + len(names) > MAX_BACKUP_ENTRIES:
                refuse('Backup source is too large')
            if target is not None:
                target.mkdir(mode=0o700)
                os.chown(target, 0, 0)
                clear_acl(target)
                os.chmod(target, 0o700)
            for name in names:
                child = os.open(name, flags, dir_fd=descriptor)
                try:
                    walk(child, relative + '/' + name if relative else name,
                         target / name if target is not None else None, depth + 1)
                finally:
                    os.close(child)
            if sorted(os.listdir(descriptor)) != names:
                refuse('Backup source changed while being read')
            if target is not None:
                sync_directory(target)
        else:
            budget['bytes'] += before['size']
            if budget['bytes'] > MAX_BACKUP_BYTES:
                refuse('Backup source is too large')
            output = None
            digest = hashlib.sha256()
            consumed = 0
            try:
                if target is not None:
                    output = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    os.fchown(output, 0, 0)
                    acl_fd_set(output)
                    os.fchmod(output, 0o600)
                while True:
                    block = os.read(descriptor, 1024 * 1024)
                    if not block:
                        break
                    consumed += len(block)
                    if consumed > before['size']:
                        refuse('Backup source changed while being read')
                    digest.update(block)
                    if output is not None:
                        view = memoryview(block)
                        while view:
                            written = os.write(output, view)
                            if written == 0:
                                refuse('Backup copy did not complete')
                            view = view[written:]
                if consumed != before['size']:
                    refuse('Backup source changed while being read')
                if output is not None:
                    os.fsync(output)
            finally:
                if output is not None:
                    os.close(output)
            record['sha256'] = digest.hexdigest()
            budget['metadata'] += 80
            if budget['metadata'] > MAX_BACKUP_METADATA_BYTES:
                refuse('Backup metadata is too large')
            if target is not None and file_digest(target) != record['sha256']:
                refuse('Backup copy verification failed')
        if attributes(descriptor) != before:
            refuse('Backup source changed while being read')

    try:
        walk(root, '', destination, 0)
    finally:
        os.close(root)
    return records


def upgrade_backup_root() -> None:
    # Do not repair ownership/ACLs of existing or unknown directories.
    for parent in reversed(BACKUPS.parents):
        root_directory(parent)
    created = not BACKUPS.exists() and not BACKUPS.is_symlink()
    if created:
        BACKUPS.mkdir(mode=0o700)
        os.chown(BACKUPS, 0, 0)
        clear_acl(BACKUPS)
        os.chmod(BACKUPS, 0o700)
        sync_directory(BACKUPS.parent)
    descriptor = os.open(BACKUPS, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o700 or \
                not acl_fd_empty(descriptor):
            refuse('Untrusted upgrade backup directory')
        if created:
            marker = os.open('.abilock-backups-v1', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=descriptor)
            try:
                os.fchown(marker, 0, 0)
                acl_fd_set(marker)
                os.fchmod(marker, 0o600)
                if os.write(marker, BACKUP_MARKER) != len(BACKUP_MARKER):
                    refuse('Backup directory marker could not be saved')
                os.fsync(marker)
            finally:
                os.close(marker)
            os.fsync(descriptor)
        marker = os.open('.abilock-backups-v1', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                         dir_fd=descriptor)
        try:
            item = os.fstat(marker)
            if not stat.S_ISREG(item.st_mode) or item.st_uid != 0 or item.st_gid != 0 or \
                    item.st_nlink != 1 or stat.S_IMODE(item.st_mode) != 0o600 or \
                    not acl_fd_empty(marker) or item.st_size != len(BACKUP_MARKER) or \
                    os.read(marker, len(BACKUP_MARKER) + 1) != BACKUP_MARKER:
                refuse('Unrecognized upgrade backup directory')
        finally:
            os.close(marker)
    finally:
        os.close(descriptor)


def create_upgrade_backup(owner: int, old_version: str, new_version: str) -> tuple[dict, list[dict]]:
    """Called only by the trusted installer while both exclusive gates are held."""
    import uuid
    if os.getuid() != 0 or os.geteuid() != 0:
        refuse('Administrator authorization is required')
    upgrade_backup_root()
    budget = {'bytes': 0, 'entries': 0, 'metadata': 0}
    private = backup_tree_snapshot(DATA, budget=budget)
    runtime = backup_tree_snapshot(INSTALL, budget=budget)
    if shutil.disk_usage(BACKUPS).free < budget['bytes'] + budget['metadata'] * 2 + 16 * 1024 * 1024:
        refuse('Insufficient space for a complete upgrade backup')
    backup = BACKUPS / uuid.uuid4().hex
    backup.mkdir(mode=0o700)
    os.chown(backup, 0, 0)
    clear_acl(backup)
    os.chmod(backup, 0o700)
    sync_directory(BACKUPS)
    # A failed/incomplete root-only backup is retained for a trusted human;
    # it is never mistaken for complete and never automatically restored.
    copied_private = backup_tree_snapshot(DATA, backup / 'data')
    copied_runtime = backup_tree_snapshot(INSTALL, backup / 'runtime')
    if copied_private != private or copied_runtime != runtime or \
            backup_tree_snapshot(DATA) != private or backup_tree_snapshot(INSTALL) != runtime:
        refuse('Upgrade source changed while being backed up')
    receipt = {'version': 1, 'directory': str(backup), 'oldRuntimeVersion': old_version,
               'newRuntimeVersion': new_version,
               'dataFiles': sum(not item['directory'] for item in private),
               'runtimeFiles': sum(not item['directory'] for item in runtime)}
    metadata = {'version': 1, 'complete': True, 'owner': owner, 'receipt': receipt,
                'data': private, 'runtime': runtime}
    descriptor = os.open(backup / 'manifest.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fchown(descriptor, 0, 0)
        acl_fd_set(descriptor)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(os.dup(descriptor), 'w', encoding='utf-8') as output:
            json.dump(metadata, output, separators=(',', ':'))
            output.write('\n')
            output.flush()
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    sync_directory(backup)
    return receipt, private


def verify_upgrade_preservation(receipt: dict, private: list[dict]) -> None:
    if backup_tree_snapshot(DATA) != private:
        refuse('Private data changed during the upgrade')
    metadata = INSTALL / 'installation.json'
    value = json.loads(metadata.read_text(encoding='utf-8'))
    value['upgradeBackup'] = {**receipt, 'dataPreserved': True}
    temporary = INSTALL / '.installation.pending'
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fchown(descriptor, 0, 0)
        acl_fd_set(descriptor)
        with os.fdopen(os.dup(descriptor), 'w', encoding='utf-8') as output:
            json.dump(value, output, separators=(',', ':'))
            output.write('\n')
            output.flush()
        os.fchmod(descriptor, 0o444)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    temporary.replace(metadata)
    sync_directory(INSTALL)


def journal_write(record: dict, phase: str | None = None) -> None:
    if phase is not None:
        record['phase'] = phase
    payload = json.dumps(record, separators=(',', ':')).encode('utf-8')
    if len(payload) > 64 * 1024 * 1024:
        refuse('Transaction metadata is too large')
    temporary = TRANSACTION / 'state.pending'
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
            refuse('Untrusted transaction journal')
        with os.fdopen(os.dup(descriptor), 'wb') as output:
            output.write(payload)
            output.flush()
        os.fchmod(descriptor, 0o600)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    temporary.replace(TRANSACTION / 'state.json')
    sync_directory(TRANSACTION)


def validate_journal(record: object, owner: int) -> dict:
    if type(record) is not dict or set(record) != JOURNAL_KEYS or record['version'] != 1 or \
            record['owner'] != owner or record['mode'] not in {'install', 'upgrade'} or \
            record['phase'] not in {'prepared', 'identity', 'migrate', 'owner-transfer', 'backup',
                                   'rewrite', 'install', 'bootstrap', 'commit', 'rollback'} or \
            not isinstance(record['transactionId'], str) or not re.fullmatch('[a-f0-9]{32}', record['transactionId']):
        refuse('Invalid transaction journal')
    staging = pathlib.Path(record['staging'])
    if staging.parent != INSTALL.parent or not re.fullmatch(r'\.abilock-install-[a-zA-Z0-9_-]+', staging.name):
        refuse('Invalid transaction staging path')
    original = pathlib.Path(pwd.getpwuid(owner).pw_dir) / '.abilock'
    if record['original'] != str(original):
        refuse('Invalid original private path')
    for key in ('stagingIdentity', 'oldIdentity', 'dataIdentity', 'backupIdentity'):
        value = record[key]
        if value is not None and (not isinstance(value, list) or len(value) != 2 or
                                  any(type(number) is not int or number < 0 for number in value)):
            refuse('Invalid transaction directory identity')
    if record['stagingIdentity'] is None or type(record['oldLaunchMode']) is not int or \
            record['oldLaunchMode'] not in {0, 0o4755} or \
            any(type(record[key]) is not bool for key in ('backupReady', 'accountCreated')):
        refuse('Invalid transaction metadata')
    if any(record[key] is not None and (type(record[key]) is not int or not 0 < record[key] < 500)
           for key in ('uid', 'gid')):
        refuse('Invalid transaction identity')
    if not isinstance(record['records'], list):
        refuse('Invalid permission snapshot')
    seen = set()
    for item in record['records']:
        if type(item) is not dict or set(item) != {'path', 'uid', 'gid', 'mode', 'directory', 'dev', 'ino', 'acl'}:
            refuse('Invalid permission record')
        name = pathlib.PurePosixPath(item['path'])
        if name.is_absolute() or '..' in name.parts or str(name) != item['path'] or item['path'] in seen:
            refuse('Invalid permission path')
        seen.add(item['path'])
        if any(type(item[key]) is not int or item[key] < 0 for key in ('uid', 'gid', 'mode', 'dev', 'ino')) or \
                type(item['directory']) is not bool or type(item['acl']) is not str:
            refuse('Invalid permission attributes')
        try:
            bytes.fromhex(item['acl'])
        except ValueError:
            refuse('Invalid permission ACL')
    if record['records'] and ('.' not in seen or not record['records'][0]['directory']):
        refuse('Missing private root record')
    return record


def read_journal(owner: int) -> dict | None:
    if not TRANSACTION.exists() and not TRANSACTION.is_symlink():
        return None
    root_directory(TRANSACTION)
    if TRANSACTION.stat().st_mode & 0o777 != 0o700:
        refuse('Untrusted transaction directory permissions')
    file = TRANSACTION / 'state.json'
    try:
        descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        # Only an empty reservation or an unfinished first state write is ours.
        names = set(os.listdir(TRANSACTION))
        if names not in (set(), {'state.pending'}):
            refuse('Incomplete transaction metadata requires manual recovery')
        if names:
            info = (TRANSACTION / 'state.pending').lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
                refuse('Untrusted pending transaction')
            (TRANSACTION / 'state.pending').unlink()
        TRANSACTION.rmdir()
        sync_directory(TRANSACTION.parent)
        return None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or \
                info.st_mode & 0o077 or info.st_size > 64 * 1024 * 1024 or not acl_fd_empty(descriptor):
            refuse('Untrusted transaction record')
        with os.fdopen(os.dup(descriptor), 'r', encoding='utf-8') as source:
            record = json.load(source)
    finally:
        os.close(descriptor)
    return validate_journal(record, owner)


def atomic_swap(first: pathlib.Path, second: pathlib.Path) -> None:
    # Both directories have the same root-owned parent. RENAME_SWAP is atomic
    # on APFS: a power failure leaves one complete runtime at the fixed path.
    if libc is None:
        refuse('Atomic installation exchange is unsupported')
    function = libc.renamex_np
    function.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(os.fsencode(first), os.fsencode(second), 2) != 0:
        raise OSError(ctypes.get_errno(), 'Atomic runtime exchange failed')
    sync_directory(first.parent)


def remove_known_tree(directory: pathlib.Path, expected: list[int] | None) -> None:
    actual = identity(directory)
    if actual is None:
        return
    if expected is None or actual != expected:
        refuse('Transaction directory identity changed; recovery retained')
    shutil.rmtree(directory)
    sync_directory(directory.parent)


def transaction_finish(record: dict) -> None:
    # A committed upgrade keeps the new runtime. An uncommitted transaction
    # rolls back before this cleanup routine is reached.
    stage = pathlib.Path(record['staging'])
    expected = record['oldIdentity'] if record['mode'] == 'upgrade' and record['phase'] == 'commit' \
        else record['stagingIdentity']
    remove_known_tree(stage, expected)
    # The journal parent has always been root-only, so its opaque backup has
    # never been available through the ordinary client identity.
    if TRANSACTION_CLEANUP.exists() or TRANSACTION_CLEANUP.is_symlink():
        refuse('Previous transaction cleanup has not completed')
    TRANSACTION.rename(TRANSACTION_CLEANUP)
    sync_directory(TRANSACTION.parent)
    cleanup_finished_transaction()


def cleanup_finished_transaction() -> None:
    if not TRANSACTION_CLEANUP.exists() and not TRANSACTION_CLEANUP.is_symlink():
        return
    root_directory(TRANSACTION_CLEANUP)
    if stat.S_IMODE(TRANSACTION_CLEANUP.stat().st_mode) != 0o700:
        refuse('Untrusted completed transaction')
    # This name is reached only after rollback/commit is durable. Cleanup can
    # itself be interrupted at any file, including the metadata file.
    shutil.rmtree(TRANSACTION_CLEANUP)
    sync_directory(TRANSACTION_CLEANUP.parent)


def recover_transaction(owner: int) -> bool:
    cleanup_finished_transaction()
    record = read_journal(owner)
    if record is None:
        return False
    if record['phase'] == 'commit':
        if identity(INSTALL) != record['stagingIdentity']:
            refuse('Committed runtime identity changed')
        transaction_finish(record)
        return True
    original = pathlib.Path(record['original'])
    stage = pathlib.Path(record['staging'])
    install_identity = identity(INSTALL)
    stage_identity = identity(stage)
    if record['mode'] == 'upgrade':
        if install_identity == record['stagingIdentity'] and stage_identity == record['oldIdentity']:
            atomic_swap(INSTALL, stage)
        elif install_identity != record['oldIdentity'] or stage_identity not in (record['stagingIdentity'], None):
            refuse('Interrupted upgrade directories changed; recovery retained')
        # This is the original, validated root-owned runtime and exact inode.
        os.chmod(INSTALL / 'launch', record['oldLaunchMode'])
        sync_tree(INSTALL)
    else:
        if install_identity is not None:
            if install_identity != record['stagingIdentity']:
                refuse('Interrupted installation runtime changed')
            # Disable the entry before touching private data during recovery.
            os.chmod(INSTALL / 'launch', 0)
            remove_known_tree(INSTALL, record['stagingIdentity'])
        records = [{**item, 'acl': bytes.fromhex(item['acl'])} for item in record['records']]
        current_data = identity(DATA)
        original_identity = identity(original)
        expected_original = None if not records else [records[0]['dev'], records[0]['ino']]
        backup = TRANSACTION / 'original'
        if records:
            if record['backupReady']:
                # Recognize recovery interrupted after the final original-path
                # rename. Never restore/chmod a user-visible path twice.
                if original_identity == record['backupIdentity']:
                    remove_known_tree(DATA, record['dataIdentity'])
                else:
                    if original_identity is not None or identity(backup) != record['backupIdentity']:
                        refuse('Original location changed; protected recovery retained')
                    restore_private_tree(backup, records)
                    sync_tree(backup)
                    backup.rename(original)
                    sync_directory(original.parent)
                    remove_known_tree(DATA, record['dataIdentity'])
            elif current_data == expected_original and original_identity is None:
                restore_private_tree(DATA, records, expected_identity=True)
                sync_tree(DATA)
                DATA.rename(original)
                sync_directory(DATA.parent)
                sync_directory(original.parent)
            elif not (original_identity == expected_original and current_data is None):
                refuse('Private migration directories changed; recovery retained')
        elif current_data is not None:
            remove_known_tree(DATA, record['dataIdentity'])
        # Dedicated identity may safely remain with no data if the machine
        # lost power mid-create. Only transaction-tagged records are removed.
        if record['accountCreated']:
            remove_transaction_account(record['transactionId'])
    journal_write(record, 'rollback')
    transaction_finish(record)
    return True


def remove_transaction_account(transaction_id: str) -> None:
    for entry in (f'/Users/{ACCOUNT}', f'/Groups/{ACCOUNT}'):
        probe = subprocess.run(['/usr/bin/dscl', '.', '-read', entry, 'AbilockInstallTransaction'],
                               text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        if probe.returncode == 0 and probe.stdout.strip() == 'AbilockInstallTransaction: ' + transaction_id:
            subprocess.run(['/usr/bin/dscl', '.', '-delete', entry], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def version_tuple(value: object) -> tuple[int, int, int]:
    if not isinstance(value, str) or not re.fullmatch(r'\d+\.\d+\.\d+', value):
        refuse('Unsupported runtime version')
    return tuple(int(part) for part in value.split('.'))


def validate_existing_installation(owner: int, new_version: str) -> tuple[int, int, dict]:
    for directory in [*reversed(INSTALL.parents), INSTALL]:
        root_directory(directory)
    if INSTALL.stat().st_mode & 0o777 != 0o755:
        refuse('Existing installation permissions are incompatible')
    expected_owner = f'{owner}\n'.encode('ascii')
    def read_public(file: pathlib.Path, limit: int) -> bytes:
        descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or \
                    info.st_mode & 0o022 or info.st_size > limit or not acl_fd_empty(descriptor):
                refuse('Existing installation metadata is untrusted')
            return os.read(descriptor, limit + 1)
        finally:
            os.close(descriptor)
    if read_public(INSTALL / 'owner', 32) != expected_owner:
        refuse('This installation belongs to another user')
    manifest = json.loads(read_public(INSTALL / 'manifest.json', 16 * 1024 * 1024))
    if not isinstance(manifest, dict) or manifest.get('version') != 1 or \
            manifest.get('platform') != 'darwin' or not isinstance(manifest.get('files'), list) or \
            version_tuple(manifest.get('runtimeVersion')) < (2, 1, 0) or \
            version_tuple(new_version) < version_tuple(manifest['runtimeVersion']):
        refuse('Existing runtime cannot be upgraded with this package')
    declared = {}
    for item in manifest['files']:
        name = pathlib.PurePosixPath(item['path'])
        if name.is_absolute() or '..' in name.parts or str(name) != item['path'] or item['path'] in declared:
            refuse('Existing installation manifest is invalid')
        declared[item['path']] = item['sha256']
    actual = set()
    for root, directories, files in os.walk(INSTALL, followlinks=False):
        for name in directories:
            root_directory(pathlib.Path(root) / name)
        for name in files:
            file = pathlib.Path(root) / name
            relative = file.relative_to(INSTALL).as_posix()
            info = file.lstat()
            mode = 0o4755 if relative == 'launch' else 0o555 if public_executable(relative) else 0o444
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or \
                    stat.S_IMODE(info.st_mode) != mode or \
                    any(line.strip() and not line.startswith(b'!#acl') for line in acl_text(file).splitlines()):
                refuse('Existing runtime permissions changed')
            if relative in {'owner', 'manifest.json', 'verification.json', 'installation.json'}:
                continue
            actual.add(relative)
            if relative not in declared or file_digest(file) != declared[relative]:
                refuse('Existing runtime changed')
    if actual != set(declared):
        refuse('Existing runtime is incomplete')
    account = pwd.getpwnam(ACCOUNT)
    if not 0 < account.pw_uid < 500 or not 0 < account.pw_gid < 500 or account.pw_uid == owner or \
            not service_identity_matches(account.pw_uid, account.pw_gid):
        refuse('Existing system identity changed')
    info = DATA.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != account.pw_uid or info.st_gid != account.pw_gid or \
            stat.S_IMODE(info.st_mode) != 0o700 or \
            any(line.strip() and not line.startswith(b'!#acl') for line in acl_text(DATA).splitlines()):
        refuse('Existing private directory is incompatible')
    return account.pw_uid, account.pw_gid, manifest


def assert_idle(uid: int) -> None:
    # Do not inspect argv or environments. This also detects legacy 2.1.0
    # supervisors that predate the shared runtime lock.
    result = subprocess.run(['/bin/ps', '-ww', '-axo', 'pid=,uid=,comm='], check=True,
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 2)
        if len(fields) != 3 or not fields[0].isdigit() or not fields[1].isdigit():
            continue
        if int(fields[1]) == uid or fields[2] in {str(INSTALL / 'launch'), str(INSTALL / 'node')}:
            refuse('Close Abilock calls and configuration before upgrading')


def acquire_migration_lock(directory: pathlib.Path) -> int | None:
    """Hold an existing flock while checking legacy PID-only writers.

    Do not create a legacy wx lock: freezing the validated directory namespace
    detects a lock newly created after the snapshot, without leaving a stale
    marker if the installer itself is killed.
    """
    root = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    data = None
    descriptor = None
    try:
        try:
            data = os.open('data', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
            descriptor = os.open('service.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=data)
        except FileNotFoundError:
            return None
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 32 or info.st_mode & 0o077:
            refuse('Invalid migration lock')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        value = os.read(descriptor, 33).strip()
        if value:
            if not re.fullmatch(rb'[1-9][0-9]{0,9}', value) or int(value) > 2147483647:
                refuse('Invalid legacy migration lock')
            try:
                os.kill(int(value), 0)
            except ProcessLookupError:
                pass
            else:
                refuse('Close the original configuration session before migration')
        # An old wx writer can have opened its file before writing the PID.
        # lsof checks this inode without exposing arguments or environments.
        opened = subprocess.run(['/usr/sbin/lsof', '-t', '--', str(directory / 'data/service.lock')],
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
        if opened.returncode not in (0, 1) or any(not pid.isdigit() or int(pid) != os.getpid()
                                                 for pid in opened.stdout.split()):
            refuse('Close the original configuration session before migration')
        retained = descriptor
        descriptor = None
        return retained
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if data is not None:
            os.close(data)
        os.close(root)


def protected_public_stage(bundle: pathlib.Path, expected: str, manifest: dict, owner: int,
                           staging: pathlib.Path) -> pathlib.Path:
    try:
        copy_checked_bundle(bundle, staging, manifest)
        validate_bundle(staging, expected)
        check_system_node(staging / 'node')
        clear_acl(staging, True)
        for root, directories, files in os.walk(staging):
            directory = pathlib.Path(root)
            os.chown(directory, 0, 0)
            os.chmod(directory, 0o755)
            for name in files:
                file = directory / name
                os.chown(file, 0, 0)
                os.chmod(file, 0o555 if public_executable(file.relative_to(staging).as_posix()) else 0o444)
        for name, value in [('owner', f'{owner}\n'), ('installation.json', json.dumps({
                'version': 1, 'runtimeVersion': manifest['runtimeVersion'], 'dataSchema': 1,
                'runtimeGate': 1, 'daemon': False}, separators=(',', ':')) + '\n')]:
            file = staging / name
            file.write_text(value, encoding='utf-8')
            os.chown(file, 0, 0)
            os.chmod(file, 0o444)
        for name in EXECUTABLES - {'node'}:
            subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(staging / name)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if (staging / DESKTOP_EXECUTABLE).exists():
            subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(staging / 'runtime/desktop/Abilock.app')],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        sync_tree(staging)
        return staging
    except BaseException:
        shutil.rmtree(staging)
        raise


def verify_stage(staging: pathlib.Path, expected: str, manifest: dict, owner: int) -> None:
    set_install_phase('verification')
    verification = staging / 'runtime/scripts/verify-isolation.py'
    if not verification.is_file():
        refuse('Reviewed isolation verification is missing')
    verified = subprocess.run(['/usr/bin/python3', '-I', str(verification), '--bundle', str(staging),
                               '--digest', expected, '--owner', str(owner)],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        result = json.loads(verified.stdout)
    except (ValueError, UnicodeDecodeError):
        result = {}
    if not isinstance(result, dict):
        result = {}
    if verified.returncode != 0:
        stage = result.get('stage', 'unknown')
        stages = {'prerequisites', 'freeze-public-bundle', 'compile-native-fixture', 'prepare-native-fixture',
                  'protected-bootstrap', 'synthetic-credential-setup', 'kernel-read-write-denial',
                  'existing-cli-list', 'existing-cli-doc', 'authorized-api-and-redaction',
                  'execution-management-denial', 'argument-and-bootstrap-denial', 'environment-injection',
                  'target-auth-override-denial', 'worker-identity-and-eof', 'worker-identity-and-cancel',
                  'temporary-configuration', 'complete', 'cleanup', 'unknown'}
        if not isinstance(stage, str) or stage not in stages:
            stage = 'unknown'
        print('ISOLATION_VERIFICATION_FAILED:' + stage, flush=True)
        refuse('Synthetic isolation verification failed')
    result = validate_verification_report(result, manifest['nodeVersion'])
    report = staging / 'verification.json'
    report.write_text(json.dumps(result, separators=(',', ':')) + '\n', encoding='utf-8')
    os.chown(report, 0, 0)
    os.chmod(report, 0o444)
    clear_acl(report)
    sync_tree(staging)
    print('ISOLATION_VERIFICATION_OK', flush=True)


def install_transaction(bundle: pathlib.Path, expected: str, owner: int, verify_first: bool) -> None:
    import uuid
    set_install_phase('prepared')
    if sys.platform != 'darwin' or os.getuid() != 0 or os.geteuid() != 0:
        refuse('Run the reviewed installer with administrator authorization')
    if owner < 500 or owner >= 2**32 - 1:
        refuse('Invalid installation owner')
    pwd.getpwuid(owner)
    manifest = validate_bundle(bundle, expected)
    if manifest['arch'] != ('arm64' if os.uname().machine == 'arm64' else 'x64'):
        refuse('Installation bundle does not match this Mac')
    version_tuple(manifest['runtimeVersion'])
    command_before = public_cli_state(owner) if version_tuple(manifest['runtimeVersion']) >= (2, 2, 0) else None
    check_system_node(bundle / 'node')
    root_directory(INSTALL.parent)
    root_directory(DATA.parent)
    recover_transaction(owner)
    upgrade = INSTALL.exists() or INSTALL.is_symlink()
    if upgrade:
        uid, gid, _old_manifest = validate_existing_installation(owner, manifest['runtimeVersion'])
        assert_idle(uid)
    elif DATA.exists() or DATA.is_symlink():
        refuse('Private data without a known installation will not be reset')
    staging = pathlib.Path(tempfile.mkdtemp(prefix='.abilock-install-', dir=INSTALL.parent))
    original = pathlib.Path(pwd.getpwuid(owner).pw_dir) / '.abilock'
    record = {'version': 1, 'owner': owner, 'mode': 'upgrade' if upgrade else 'install',
              'phase': 'prepared', 'staging': str(staging), 'stagingIdentity': identity(staging),
              'oldIdentity': identity(INSTALL) if upgrade else None, 'oldLaunchMode': 0o4755 if upgrade else 0,
              'dataIdentity': identity(DATA) if upgrade else None, 'original': str(original),
              'records': [], 'backupIdentity': None, 'backupReady': False, 'accountCreated': False,
              'uid': uid if upgrade else None, 'gid': gid if upgrade else None,
              'transactionId': uuid.uuid4().hex}
    TRANSACTION.mkdir(mode=0o700)
    clear_acl(TRANSACTION)
    sync_directory(TRANSACTION.parent)
    journal_write(record)
    migration_lock = None
    try:
        protected_public_stage(bundle, expected, manifest, owner, staging)
        if verify_first:
            verify_stage(staging, expected, manifest, owner)
        if upgrade:
            set_install_phase('backup')
            journal_write(record, 'backup')
            assert_idle(uid)
            backup_receipt, private_snapshot = create_upgrade_backup(
                owner, _old_manifest['runtimeVersion'], manifest['runtimeVersion'])
            set_install_phase('install')
            journal_write(record, 'install')
            os.chmod(INSTALL / 'launch', 0)
            sync_directory(INSTALL)
            assert_idle(uid)
            atomic_swap(INSTALL, staging)
            os.chmod(INSTALL / 'launch', 0o4755)
            sync_tree(INSTALL)
        else:
            set_install_phase('identity')
            journal_write(record, 'identity')
            uid, gid, created_account = ensure_account(record)
            record.update(uid=uid, gid=gid, accountCreated=created_account)
            journal_write(record)
            assert_idle(uid)
            if original.exists() or original.is_symlink():
                set_install_phase('private-snapshot')
                info = original.lstat()
                if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner or info.st_mode & 0o077:
                    refuse('Close the original configuration session before migration')
                migration_lock = acquire_migration_lock(original)
                records = validate_private_tree(original)
                record['records'] = [{**item, 'acl': item['acl'].hex()} for item in records]
                record['dataIdentity'] = identity(original)
                journal_write(record, 'migrate')
                set_install_phase('migrate')
                original.rename(DATA)
                sync_directory(original.parent)
                sync_directory(DATA.parent)
                set_install_phase('owner-transfer')
                journal_write(record, 'owner-transfer')
                apply_private_tree(DATA, uid, gid, records)
                set_install_phase('backup')
                journal_write(record, 'backup')
                backup = TRANSACTION / 'original'
                shutil.copytree(DATA, backup, copy_function=shutil.copy2)
                clear_acl(backup, True)
                sync_tree(backup)
                record.update(backupIdentity=identity(backup), backupReady=True)
                journal_write(record)
                set_install_phase('rewrite')
                journal_write(record, 'rewrite')
                rewrite_data_directory(DATA, DATA)
            else:
                fresh = TRANSACTION / 'new-private'
                fresh.mkdir(mode=0o700)
                os.chown(fresh, uid, gid)
                clear_acl(fresh)
                record['dataIdentity'] = identity(fresh)
                journal_write(record, 'migrate')
                set_install_phase('migrate')
                fresh.rename(DATA)
                sync_directory(DATA.parent)
            temporary = DATA / 'tmp'
            temporary.mkdir(mode=0o700, exist_ok=True)
            os.chown(temporary, uid, gid)
            clear_acl(temporary)
            sync_tree(DATA)
            set_install_phase('install')
            journal_write(record, 'install')
            staging.rename(INSTALL)
            sync_directory(INSTALL.parent)
            os.chmod(INSTALL / 'launch', 0o4755)
            set_install_phase('bootstrap')
            journal_write(record, 'bootstrap')
            # The source is now protected and the global runtime gate blocks
            # ordinary calls. Let only the trusted bootstrap take Store's lock.
            if migration_lock is not None:
                os.close(migration_lock)
                migration_lock = None
            bootstrap_management(uid, gid)
            sync_tree(DATA)
            sync_tree(INSTALL)
        _uid, _gid, installed = validate_existing_installation(owner, manifest['runtimeVersion'])
        if (_uid, _gid) != (uid, gid) or installed['runtimeVersion'] != manifest['runtimeVersion']:
            refuse('Installed runtime verification failed')
        if upgrade:
            set_install_phase('backup')
            verify_upgrade_preservation(backup_receipt, private_snapshot)
        set_install_phase('commit')
        journal_write(record, 'commit')
        transaction_finish(record)
        if version_tuple(manifest['runtimeVersion']) >= (2, 2, 0):
            register_public_cli(owner, command_before)
        print('Abilock isolated runtime installed.')
    except BaseException:
        # Normal exceptions use the exact same durable path as the next run
        # after SIGKILL/power loss. No in-memory booleans decide data ownership.
        recover_transaction(owner)
        raise
    finally:
        if migration_lock is not None:
            os.close(migration_lock)

def install(bundle: pathlib.Path, expected: str, owner: int, verify_first: bool = False) -> None:
    if sys.platform != "darwin" or os.getuid() != 0 or os.geteuid() != 0:
        refuse("Administrator authorization is required")
    os.umask(0o077)
    root_directory(INSTALL_LOCK.parent)
    lock = os.open(INSTALL_LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    gate = None
    try:
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o077:
            refuse("Untrusted installation lock")
        if not acl_fd_empty(lock):
            refuse("Installation lock has extra permissions")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            gate = os.open(RUNTIME_LOCK, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.fchown(gate, 0, 0)
            acl_fd_set(gate)
            os.fchmod(gate, 0o600)
            os.fsync(gate)
            sync_directory(RUNTIME_LOCK.parent)
        except FileExistsError:
            gate = os.open(RUNTIME_LOCK, os.O_RDWR | os.O_NOFOLLOW)
        info = os.fstat(gate)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_size != 0 or \
                stat.S_IMODE(info.st_mode) != 0o600 or not acl_fd_empty(gate):
            refuse("Untrusted runtime lock")
        fcntl.flock(gate, fcntl.LOCK_EX | fcntl.LOCK_NB)
        install_transaction(bundle, expected, owner, verify_first)
    finally:
        if gate is not None:
            os.close(gate)
        os.close(lock)


def check_installation(bundle: pathlib.Path, expected: str, owner: int) -> None:
    """All public validation happens before the administrator prompt."""
    manifest = validate_bundle(bundle, expected)
    if version_tuple(manifest['runtimeVersion']) >= (2, 2, 0):
        public_cli_state(owner)
    if sys.platform != 'darwin' or manifest['arch'] != ('arm64' if os.uname().machine == 'arm64' else 'x64'):
        refuse('Installation bundle does not match this Mac')
    check_system_node(bundle / 'node')
    for name in EXECUTABLES - {'node'}:
        subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(bundle / name)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # A previous interruption is resolved by the same root-only journal path;
    # ordinary preflight cannot read that protected metadata or opaque backup.
    if TRANSACTION.exists() or TRANSACTION.is_symlink():
        info = TRANSACTION.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
            refuse('Untrusted recovery directory')
        return
    if INSTALL.exists() or INSTALL.is_symlink():
        uid, _gid, _manifest = validate_existing_installation(owner, manifest['runtimeVersion'])
        assert_idle(uid)
    elif DATA.exists() or DATA.is_symlink():
        refuse('Private data without a known installation will not be reset')


def main() -> int:
    parser = argparse.ArgumentParser(description="Install the reviewed Abilock isolation bundle")
    parser.add_argument("--bundle", type=pathlib.Path, required=True)
    parser.add_argument("--digest", required=True)
    parser.add_argument("--owner", type=int)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--verify-first", action="store_true")
    arguments = parser.parse_args()
    if len(arguments.digest) != 64 or any(c not in "0123456789abcdef" for c in arguments.digest):
        refuse("Invalid public bundle digest")
    if arguments.check:
        check_installation(arguments.bundle, arguments.digest, os.getuid())
        print("Abilock isolation bundle verified.")
    elif arguments.owner is None:
        refuse("Installation owner is required")
    else:
        install(arguments.bundle.resolve(), arguments.digest, arguments.owner, arguments.verify_first)
    return 0


if __name__ == "__main__":
    try:
        if os.geteuid() == 0 and os.getuid() != 0:
            os.setuid(0)
        raise SystemExit(main())
    except (ValueError, KeyError, OSError, subprocess.SubprocessError):
        # Avoid displaying native exception text or paths from private data.
        print("ISOLATION_INSTALL_FAILED:" + INSTALL_PHASE, flush=True)
        print("Abilock isolation installation failed; existing data was not reset.", file=sys.stderr)
        raise SystemExit(78)
