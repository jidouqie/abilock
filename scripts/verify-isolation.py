#!/usr/bin/env python3
"""Root-only macOS kernel acceptance using an entirely synthetic installation.

Never invoke this from an unreviewed/root-unprotected script. The installer runs
the reviewed protected copy under its single administrator authorization. No
real Abilock data, account creation, daemon, or browser is used here.
"""
from __future__ import annotations

import argparse
import base64
import ctypes
import hashlib
import http.server
import json
import os
import pathlib
import pwd
import queue
import selectors
import shutil
import socket
import stat
import subprocess
import sys
import threading
import time
import uuid

PARENT = pathlib.Path("/private/var/db")
FIXTURE_NAME = ".abilock-isolation-fixture"
ACCOUNT = "nobody"
SAFE_STAGE = "prerequisites"
SLOW_RESPONSE_SECONDS = 125


def require(condition: bool) -> None:
    if not condition:
        raise ValueError("Synthetic isolation verification failed")


def digest(file: pathlib.Path) -> str:
    value = hashlib.sha256()
    with file.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def root_chain(path: pathlib.Path) -> None:
    for component in [*reversed(path.parents), path]:
        info = component.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
                not info.st_mode & 0o022)


def freeze_bundle(bundle: pathlib.Path, expected: str, destination: pathlib.Path) -> dict:
    """Read each reviewed file through no-follow descriptors and verify its hash."""
    require(not bundle.is_symlink())
    manifest_fd = os.open(bundle / "manifest.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(manifest_fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 16 * 1024 * 1024)
        chunks = []
        size = 0
        while True:
            chunk = os.read(manifest_fd, 1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            require(size <= info.st_size)
            chunks.append(chunk)
        contents = b"".join(chunks)
        require(size == info.st_size and hashlib.sha256(contents).hexdigest() == expected)
        manifest = json.loads(contents)
    finally:
        os.close(manifest_fd)
    require(manifest.get("version") == 1 and manifest.get("platform") == "darwin")
    entries = manifest.get("files")
    require(isinstance(entries, list) and bool(entries))
    seen = set()
    total = 0
    root = os.open(bundle, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for entry in entries:
            require(isinstance(entry, dict) and set(entry) == {"path", "sha256", "mode"})
            relative = pathlib.PurePosixPath(entry["path"])
            require(not relative.is_absolute() and ".." not in relative.parts and
                    str(relative) == entry["path"] and str(relative) not in seen)
            seen.add(str(relative))
            current = os.dup(root)
            source = None
            try:
                for part in relative.parts[:-1]:
                    nested = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                     dir_fd=current)
                    os.close(current)
                    current = nested
                source = os.open(relative.parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                                 dir_fd=current)
                info = os.fstat(source)
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
                total += info.st_size
                require(total <= 1024 * 1024 * 1024)
                target = destination.joinpath(*relative.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                value = hashlib.sha256()
                count = 0
                with target.open("xb") as output:
                    while True:
                        chunk = os.read(source, 1024 * 1024)
                        if not chunk:
                            break
                        count += len(chunk)
                        require(count <= info.st_size)
                        value.update(chunk)
                        output.write(chunk)
                require(count == info.st_size and value.hexdigest() == entry["sha256"])
            finally:
                if source is not None:
                    os.close(source)
                os.close(current)
    finally:
        os.close(root)
    require({"node", "verify-launch", "runtime/bin/abl.mjs",
             "runtime/dist/src/isolated-worker.js"}.issubset(seen))
    return manifest


FIXTURE_STATE = FIXTURE_NAME + '.state.json'
FIXTURE_LOCK = FIXTURE_NAME + '.lock'
FIXTURE_MARKER = '.abilock-fixture.json'
_FIXTURE_LEASES = {}


def sync_directory(directory: pathlib.Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fixture_state(parent: pathlib.Path, owner: int) -> dict | None:
    file = parent / FIXTURE_STATE
    try:
        descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == owner and info.st_nlink == 1 and
                stat.S_IMODE(info.st_mode) == 0o600 and info.st_size < 4096)
        state = json.loads(os.read(descriptor, 4096))
    finally:
        os.close(descriptor)
    require(type(state) is dict and set(state) == {'version', 'pid', 'owner', 'dev', 'ino', 'stage', 'nonce', 'phase'} and
            state['version'] == 1 and state['owner'] == owner and
            all(type(state[key]) is int and state[key] > 0 for key in ('pid', 'dev', 'ino')) and
            state['pid'] <= 2147483647 and type(state['nonce']) is str and
            len(state['nonce']) == 32 and all(value in '0123456789abcdef' for value in state['nonce']) and
            state['stage'] == FIXTURE_NAME + '.preparing-' + state['nonce'] and
            state['phase'] in {'active', 'cleanup'})
    return state


def save_fixture_state(parent: pathlib.Path, state: dict) -> None:
    temporary = parent / (FIXTURE_STATE + '.pending')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == state['owner'] and info.st_nlink == 1)
        payload = json.dumps(state, separators=(',', ':')).encode()
        with os.fdopen(os.dup(descriptor), 'wb') as output:
            output.write(payload)
            output.flush()
        os.fchmod(descriptor, 0o600)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    temporary.replace(parent / FIXTURE_STATE)
    sync_directory(parent)


def fixture_matches(directory: pathlib.Path, state: dict, marker_required: bool = True) -> bool:
    try:
        info = directory.lstat()
    except FileNotFoundError:
        return False
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == state['owner'] and not info.st_mode & 0o022 and
            (info.st_dev, info.st_ino) == (state['dev'], state['ino']))
    try:
        descriptor = os.open(directory / FIXTURE_MARKER, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        require(not marker_required)
        return True
    try:
        marker = os.fstat(descriptor)
        require(stat.S_ISREG(marker.st_mode) and marker.st_uid == state['owner'] and marker.st_nlink == 1 and
                stat.S_IMODE(marker.st_mode) == 0o600 and marker.st_size < 4096)
        value = json.loads(os.read(descriptor, 4096))
        require(value == {key: item for key, item in state.items() if key != 'phase'})
    finally:
        os.close(descriptor)
    return True


def fixture_is_idle(directory: pathlib.Path) -> None:
    # Original verifier may have died while a worker was closing its pipes.
    # Inspect only references under this exact fixture, never argv/env. Do not
    # kill or adopt any process. The next attempt can proceed after it exits.
    result = subprocess.run(['/usr/sbin/lsof', '-t', '+D', str(directory)], text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
    require(result.returncode in (0, 1) and all(pid.isdigit() and int(pid) == os.getpid()
                                                for pid in result.stdout.split()))


def clean_fixture_state(parent: pathlib.Path, state: dict, stale: bool) -> None:
    fixture, staging = parent / FIXTURE_NAME, parent / state['stage']
    if stale:
        try:
            os.kill(state['pid'], 0)
        except ProcessLookupError:
            pass
        else:
            require(False)
    # A directory can be at only one of these names after atomic publication.
    candidates = []
    for directory in (fixture, staging):
        if fixture_matches(directory, state, state['phase'] != 'cleanup'):
            candidates.append(directory)
    require(len(candidates) <= 1)
    for directory in candidates:
        fixture_is_idle(directory)
        # Keep the recovery receipt outside the tree being removed. A power
        # failure during rmtree is recoverable even after its marker is gone.
        state = {**state, 'phase': 'cleanup'}
        save_fixture_state(parent, state)
        require(fixture_matches(directory, state, marker_required=False))
        shutil.rmtree(directory)
        sync_directory(parent)
    (parent / FIXTURE_STATE).unlink()
    sync_directory(parent)


def reserve_fixture(parent: pathlib.Path, owner: int = 0) -> tuple[pathlib.Path, tuple[int, int]]:
    """Recover only our dead, inode-matched synthetic fixture under a lease."""
    import fcntl
    fixture = parent / FIXTURE_NAME
    descriptor = os.open(parent / FIXTURE_LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    retained = False
    staging = None
    staging_identity = None
    staging_nonce = None
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == owner and info.st_nlink == 1 and
                stat.S_IMODE(info.st_mode) == 0o600 and info.st_size == 0)
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = fixture_state(parent, owner)
        if state is not None:
            clean_fixture_state(parent, state, stale=True)
        try:
            fixture.lstat()
        except FileNotFoundError:
            pass
        else:
            require(False)
        nonce = uuid.uuid4().hex
        candidate = parent / (FIXTURE_NAME + '.preparing-' + nonce)
        candidate.mkdir(mode=0o700)
        info = candidate.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == owner)
        # Claim cleanup ownership only after this invocation created and
        # inspected the directory. A name collision grants no delete rights.
        staging = candidate
        staging_identity = (info.st_dev, info.st_ino)
        staging_nonce = nonce
        state = {'version': 1, 'pid': os.getpid(), 'owner': owner, 'dev': info.st_dev, 'ino': info.st_ino,
                 'stage': staging.name, 'nonce': nonce, 'phase': 'active'}
        marker = staging / FIXTURE_MARKER
        with marker.open('x', encoding='utf-8') as output:
            os.fchmod(output.fileno(), 0o600)
            json.dump({key: value for key, value in state.items() if key != 'phase'}, output, separators=(',', ':'))
            output.flush()
            os.fsync(output.fileno())
        os.chmod(marker, 0o600)
        os.chmod(staging, 0o755)
        sync_directory(staging)
        # Receipt and marker are durable before the fixed name is visible.
        save_fixture_state(parent, state)
        staging.rename(fixture)
        staging = None
        sync_directory(parent)
        _FIXTURE_LEASES[str(fixture)] = descriptor
        retained = True
        return fixture, (info.st_dev, info.st_ino)
    finally:
        if not retained:
            try:
                # Only discard this invocation's unpublished inode. Collisions,
                # replacements and durable receipts are retained for inspection.
                if staging is not None and staging_identity is not None and fixture_state(parent, owner) is None:
                    try:
                        current = staging.lstat()
                    except FileNotFoundError:
                        current = None
                    if current is not None and staging.parent == parent and \
                            staging.name == FIXTURE_NAME + '.preparing-' + staging_nonce and \
                            stat.S_ISDIR(current.st_mode) and current.st_uid == owner and \
                            (current.st_dev, current.st_ino) == staging_identity:
                        shutil.rmtree(staging)
            finally:
                os.close(descriptor)


def remove_created_fixture(fixture: pathlib.Path, identity: tuple[int, int],
                           parent: pathlib.Path, owner: int = 0) -> None:
    require(fixture.parent == parent and fixture.name == FIXTURE_NAME)
    descriptor = _FIXTURE_LEASES.get(str(fixture))
    require(descriptor is not None)
    state = fixture_state(parent, owner)
    require(state is not None and state['pid'] == os.getpid() and
            (state['dev'], state['ino']) == identity and fixture_matches(fixture, state))
    clean_fixture_state(parent, state, stale=False)
    _FIXTURE_LEASES.pop(str(fixture))
    os.close(descriptor)

def demote(uid: int, gid: int):
    def apply() -> None:
        os.setgroups([])
        os.setgid(gid)
        os.setuid(uid)
    return apply


def protected_tree(directory: pathlib.Path) -> None:
    for root, directories, files in os.walk(directory, followlinks=False):
        os.chown(root, 0, 0)
        os.chmod(root, 0o755)
        for name in directories:
            require(not (pathlib.Path(root) / name).is_symlink())
        for name in files:
            file = pathlib.Path(root) / name
            info = file.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
            os.chown(file, 0, 0)
            os.chmod(file, 0o444)


def patch_once(file: pathlib.Path, before: str, after: str) -> None:
    contents = file.read_text("utf-8")
    require(contents.count(before) == 1)
    file.write_text(contents.replace(before, after), encoding="utf-8")


class MockServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, key: str):
        self.key = key
        self.correct_auth = 0
        self.received = queue.Queue()
        self.pending = []
        super().__init__(("127.0.0.1", 0), MockHandler)

    def handle_error(self, _request, _address) -> None:
        # Server-side assertions are represented by the safe counters/report.
        # Never write handler exception stacks into the administrator output.
        pass


class MockHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args) -> None:
        pass

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        require(0 <= length <= 1024 * 1024)
        self.rfile.read(length)
        correct = self.headers.get("authorization") == "Bearer " + self.server.key
        if correct:
            self.server.correct_auth += 1
        if self.path == "/hang":
            event = threading.Event()
            self.server.pending.append(event)
            self.server.received.put(event)
            event.wait(15)
        elif self.path == "/slow":
            event = threading.Event()
            self.server.pending.append(event)
            event.wait(SLOW_RESPONSE_SECONDS)
        body = json.dumps({"result": "synthetic rewrite completed", "echo": self.server.key}).encode()
        self.send_response(200 if correct else 401)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


def parsed_response(wire: bytes, secret: str) -> tuple[int, object]:
    require(secret.encode() not in wire)
    messages = [json.loads(line) for line in wire.splitlines()]
    require(bool(messages) and messages[0].get("type") == "headers" and
            messages[-1].get("type") == "done" and not messages[-1].get("failed"))
    chunks = []
    for message in messages[1:-1]:
        require(message.get("type") == "body")
        chunks.append(base64.b64decode(message["data"], validate=True))
    return messages[0]["status"], json.loads(b"".join(chunks))


def frame(route: str, method: str = "GET", body: object = None) -> bytes:
    result = {"type": "request", "url": route, "method": method, "headers": {}}
    if body is not None:
        result["headers"]["content-type"] = "application/json"
        result["body"] = json.dumps(body)
    return (json.dumps(result) + "\n").encode()


def children_of(pid: int) -> list[int]:
    library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    function = library.proc_listchildpids
    function.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
    function.restype = ctypes.c_int
    buffer = (ctypes.c_int * 16)()
    require(function(pid, buffer, ctypes.sizeof(buffer)) > 0)
    return [int(child) for child in buffer if child > 0]


def worker_identity(pid: int, owner: int, service: int) -> int:
    children = children_of(pid)
    require(len(children) == 1)
    child = children[0]
    result = subprocess.run(["/bin/ps", "-p", str(child), "-o", "uid=,ppid="],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True,
                            timeout=5, text=True)
    values = result.stdout.split()
    require(len(values) == 2 and int(values[0]) & 0xffffffff == service and int(values[1]) == pid and
            service != owner)
    listeners = subprocess.run(["/usr/sbin/lsof", "-nP", "-a", "-p", f"{pid},{child}",
                                "-iTCP", "-sTCP:LISTEN"], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, timeout=5)
    require(listeners.returncode == 1 and not listeners.stdout)
    return child


def wait_ready(process: subprocess.Popen, secret: str) -> str:
    selected = selectors.DefaultSelector()
    try:
        selected.register(process.stdout, selectors.EVENT_READ)
        require(bool(selected.select(8)))
        line = process.stdout.readline(4096)
        require(secret.encode() not in line)
        data = json.loads(line)
        require(set(data) == {"type", "url"} and data["type"] == "configuration-ready")
        from urllib.parse import urlsplit
        url = urlsplit(data["url"])
        require(url.scheme == "http" and url.hostname == "127.0.0.1" and
                url.path in {"", "/"} and not url.username and not url.query and not url.fragment)
        return data["url"]
    finally:
        selected.close()


def verify(bundle: pathlib.Path, expected: str, owner: int) -> dict:
    global SAFE_STAGE
    require(sys.platform == "darwin" and os.getuid() == 0 and os.geteuid() == 0)
    require(owner >= 500 and owner != 2**32 - 1)
    human = pwd.getpwuid(owner)
    service = pwd.getpwnam(ACCOUNT)
    require(service.pw_uid not in {0, owner} and service.pw_gid != 0 and
            service.pw_dir == "/var/empty" and service.pw_shell in {"/usr/bin/false", "/sbin/nologin"})
    root_chain(PARENT)
    fixture, fixture_identity = reserve_fixture(PARENT)
    install, data = fixture / "install", fixture / "private"
    children = []
    server = None
    thread = None
    checks = {}
    key = "synthetic-isolation-" + uuid.uuid4().hex
    try:
        SAFE_STAGE = "freeze-public-bundle"
        install.mkdir()
        metadata = freeze_bundle(bundle, expected, install)
        runtime = install / "runtime"
        patch_once(runtime / "dist/src/isolated-environment.js", '"/usr/local/libexec/abilock"', json.dumps(str(install)))
        patch_once(runtime / "dist/src/isolated-environment.js", '"/private/var/db/abilock"', json.dumps(str(data)))
        # This is solely the protected synthetic fixture. Never enable local
        # mock permission via inherited environment or any release entry.
        patch_once(runtime / "dist/src/environment.js", "export function setting(name) {",
                   'export function setting(name) {\n    if (name === "ALLOW_LOCAL") return "1";')
        patch_once(runtime / "bin/isolated-transport.mjs", '"/usr/local/libexec/abilock/launch"',
                   json.dumps(str(install / "launch")))
        launch = install / "launch"
        launch.unlink()
        SAFE_STAGE = "prepare-native-fixture"
        (install / "verify-launch").replace(launch)
        (install / "owner").write_text(str(owner) + "\n", encoding="ascii")
        protected_tree(install)
        for name in ["node", "password", "file-lock"]:
            os.chmod(install / name, 0o555)
        gate = install / "runtime.lock"
        with gate.open("x"):
            pass
        os.chown(gate, 0, 0)
        os.chmod(gate, 0o600)
        os.chmod(launch, 0o4755)
        data.mkdir(mode=0o700)
        os.chown(data, service.pw_uid, service.pw_gid)
        temporary = data / "tmp"
        temporary.mkdir(mode=0o700)
        os.chown(temporary, service.pw_uid, service.pw_gid)
        admin_password = "synthetic-management-" + uuid.uuid4().hex
        SAFE_STAGE = "protected-bootstrap"
        bootstrap = subprocess.Popen([str(launch), "bootstrap-admin"], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        children.append(bootstrap)
        bootstrap_out, bootstrap_error = bootstrap.communicate(
            input=json.dumps({"password": admin_password}).encode(), timeout=15)
        require(bootstrap.returncode == 0 and key.encode() not in bootstrap_out + bootstrap_error and
                admin_password.encode() not in bootstrap_out + bootstrap_error)
        checks["protected_bootstrap"] = True
        server = MockServer(key)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        port = server.server_address[1]
        # Trusted synthetic setup uses the real Store and AES envelope; its key
        # is passed only on stdin to this protected fixture process.
        setup = runtime / "fixture-setup.mjs"
        setup.write_text('''import fs from "node:fs";
import {loadLocalRuntime} from "./dist/src/local-state.js";
import {platformSchema,requestSchema} from "./dist/src/schema.js";
if(requestSchema.parse({method:"POST",path:"/echo"}).timeoutMs!==420000 ||
 !requestSchema.safeParse({method:"POST",path:"/echo",timeoutMs:420000}).success ||
 requestSchema.safeParse({method:"POST",path:"/echo",timeoutMs:420001}).success)
 throw new Error("Synthetic request timeout contract failed");
const input=JSON.parse(fs.readFileSync(0,"utf8"));
const runtime=await loadLocalRuntime({dir:input.dir,requireExisting:true});
try {
 await runtime.store.save(platformSchema.parse({alias:"FIXTURE",name:"Synthetic API",baseUrl:input.baseUrl,
 auth:{type:"bearer"},allowInsecureLocal:true,rules:[{method:"POST",path:"/echo"},{method:"POST",path:"/hang"},{method:"POST",path:"/slow"}]}),{value:input.key},false,0);
 await runtime.store.saveDoc("FIXTURE",{title:"Synthetic usage",sourceUrl:"https://docs.example.test/api",markdown:"POST /echo returns synthetic copy. The configured key stays inside the worker."},"manual");
} finally {await runtime.store.close();}
''', encoding="utf-8")
        os.chmod(setup, 0o444)
        safe_env = {"PATH": "/usr/bin:/bin", "HOME": str(data), "TMPDIR": str(temporary) + "/",
                    "USER": ACCOUNT, "LOGNAME": ACCOUNT, "LANG": "en_US.UTF-8"}
        SAFE_STAGE = "synthetic-credential-setup"
        initialized = subprocess.run([str(install / "node"), str(setup)], cwd=runtime,
                                     env=safe_env, preexec_fn=demote(service.pw_uid, service.pw_gid),
                                     input=json.dumps({"dir": str(data), "baseUrl": f"http://127.0.0.1:{port}", "key": key}).encode(),
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
        require(initialized.returncode == 0 and key.encode() not in initialized.stdout + initialized.stderr)
        caller = fixture / "caller"
        caller.mkdir(mode=0o755)
        os.chown(caller, owner, human.pw_gid)
        canary = data / "injection-ran"
        preload = caller / "evil.mjs"
        preload.write_text('import fs from "node:fs";fs.writeFileSync(' + json.dumps(str(canary)) + ',"canary");', encoding="utf-8")
        os.chown(preload, owner, human.pw_gid)
        os.chmod(preload, 0o644)
        request_file = caller / "request.json"
        request_file.write_text(json.dumps({"method": "POST", "path": "/echo", "timeoutMs": 420000,
                                            "body": {"text": "synthetic copy"}}))
        os.chown(request_file, owner, human.pw_gid)
        os.chmod(request_file, 0o644)
        slow_request = caller / "slow-request.json"
        slow_request.write_text(json.dumps({"method": "POST", "path": "/slow",
                                           "body": {"text": "synthetic delayed copy"}}))
        os.chown(slow_request, owner, human.pw_gid)
        os.chmod(slow_request, 0o644)
        caller_env = {"PATH": "/usr/bin:/bin", "HOME": str(caller), "LANG": "en_US.UTF-8"}

        def run_call(arguments: list[str], payload: bytes = None, environment: dict = None,
                     cli: bool = False, timeout_seconds: int = 12):
            command = [str(install / "node"), str(runtime / "bin/abl.mjs")] if cli else [str(launch)]
            if payload is None:
                result = subprocess.run(command + arguments, cwd=caller, env=environment or caller_env,
                                        preexec_fn=demote(owner, human.pw_gid), stdin=subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout_seconds)
            else:
                # Keep the request pipe open until the one-shot worker finishes;
                # subprocess.communicate() would send EOF and cancel the request.
                process = subprocess.Popen(command + arguments, cwd=caller, env=environment or caller_env,
                                           preexec_fn=demote(owner, human.pw_gid), stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                children.append(process)
                captured = [b"", b""]
                def read_output(index: int, pipe) -> None:
                    captured[index] = pipe.read()
                readers = [threading.Thread(target=read_output, args=(0, process.stdout), daemon=True),
                           threading.Thread(target=read_output, args=(1, process.stderr), daemon=True)]
                for reader in readers:
                    reader.start()
                process.stdin.write(payload)
                process.stdin.flush()
                process.wait(timeout=timeout_seconds)
                try:
                    process.stdin.close()
                except BrokenPipeError:
                    pass
                process.stdin = None
                for reader in readers:
                    reader.join(timeout=2)
                    require(not reader.is_alive())
                result = subprocess.CompletedProcess(command + arguments, process.returncode, *captured)
            require(key.encode() not in result.stdout + result.stderr and
                    admin_password.encode() not in result.stdout + result.stderr)
            return result

        permission_source = '''import errno,json,os,sys
result={}
for name in json.loads(sys.argv[1]):
 try:
  fd=os.open(name,os.O_RDONLY);os.close(fd);result[name]=False
 except OSError as error:result[name]=error.errno==errno.EACCES
for name in json.loads(sys.argv[2]):
 try:
  fd=os.open(name,os.O_WRONLY);os.close(fd);result[name]=False
 except OSError as error:result[name]=error.errno==errno.EACCES
print(json.dumps({"denied":all(result.values()),"checks":len(result)}))
'''
        SAFE_STAGE = "kernel-read-write-denial"
        permission = subprocess.run([sys.executable, "-I", "-c", permission_source,
                                     json.dumps([str(data / "service.env"), str(data / "data/state.json"), str(data / "data/admin-auth.json")]),
                                     json.dumps([str(install / "node"), str(runtime / "dist/src/isolated-worker.js"), str(launch)])],
                                    preexec_fn=demote(owner, human.pw_gid), stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, timeout=8)
        require(permission.returncode == 0 and json.loads(permission.stdout) == {"denied": True, "checks": 6})
        checks["kernel_secret_read_EACCES"] = True
        checks["kernel_runtime_write_EACCES"] = True
        for arguments in [["list", "--json"], ["doc", "FIXTURE", "--json"]]:
            SAFE_STAGE = "existing-cli-" + arguments[0]
            result = run_call(arguments, cli=True)
            require(result.returncode == 0 and json.loads(result.stdout)["ok"] is True)
        checks["existing_list_doc_commands"] = True
        SAFE_STAGE = "authorized-api-and-redaction"
        result = run_call(["api", "FIXTURE", "--file", str(request_file), "--json"], cli=True)
        require(result.returncode == 0 and json.loads(result.stdout)["ok"] is True and
                b"synthetic rewrite completed" in result.stdout and b"[REDACTED]" in result.stdout and
                server.correct_auth == 1)
        # The protected release schema must accept seven minutes; this real
        # one-shot CLI call also crosses the previous two-minute deadline.
        started = time.monotonic()
        delayed = run_call(["api", "FIXTURE", "--file", str(slow_request), "--json"],
                           cli=True, timeout_seconds=160)
        elapsed = time.monotonic() - started
        require(delayed.returncode == 0 and json.loads(delayed.stdout)["ok"] is True and
                SLOW_RESPONSE_SECONDS <= elapsed < 160 and
                b"synthetic rewrite completed" in delayed.stdout and b"[REDACTED]" in delayed.stdout and
                server.correct_auth == 2)
        checks["authorized_api_and_echo_redaction"] = True
        SAFE_STAGE = "execution-management-denial"
        denial = run_call(["execute"], frame("/admin/platforms"))
        status, _body = parsed_response(denial.stdout, key)
        require(denial.returncode == 0 and status == 404)
        checks["execution_rejects_management"] = True
        SAFE_STAGE = "argument-and-bootstrap-denial"
        for arguments in [["execute", "extra"], ["config", "extra"], ["bootstrap-admin"]]:
            require(run_call(arguments).returncode != 0)
        checks["extra_arguments_and_bootstrap_denied"] = True
        SAFE_STAGE = "environment-injection"
        injected_env = {**caller_env, "NODE_OPTIONS": "--import=" + str(preload), "NODE_PATH": str(caller),
                        "DYLD_INSERT_LIBRARIES": str(preload), "LD_PRELOAD": str(preload),
                        "ABILOCK_DATA_DIR": str(caller), "ABILOCK_MASTER_KEY": "0" * 64,
                        "ABILOCK_ENDPOINT": "http://127.0.0.1:1", "ABILOCK_EXEC_TOKEN": "caller-token"}
        injected = run_call(["execute"], frame("/v1/platforms"), injected_env)
        status, body = parsed_response(injected.stdout, key)
        require(injected.returncode == 0 and status == 200 and isinstance(body, dict) and not canary.exists())
        checks["environment_injection_ignored"] = True
        SAFE_STAGE = "target-auth-override-denial"
        for call in [
            {"method": "POST", "path": "/echo", "headers": {"authorization": "caller-override"}},
            {"method": "POST", "path": "/echo", "baseUrl": "https://caller-override.example"},
        ]:
            denied = run_call(["execute"], frame("/v1/call/FIXTURE", "POST", call))
            status, _body = parsed_response(denied.stdout, key)
            require(denied.returncode == 0 and status in {400, 403} and server.correct_auth == 2)
        checks["target_and_auth_override_denied"] = True
        for cancellation in ["eof", "cancel"]:
            SAFE_STAGE = "worker-identity-and-" + cancellation
            process = subprocess.Popen([str(launch), "execute"], cwd=caller, env=caller_env,
                                       preexec_fn=demote(owner, human.pw_gid), stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            children.append(process)
            process.stdin.write(frame("/v1/call/FIXTURE", "POST", {"method": "POST", "path": "/hang", "timeoutMs": 10000}))
            process.stdin.flush()
            release = server.received.get(timeout=8)
            child = worker_identity(process.pid, owner, service.pw_uid)
            if cancellation == "cancel":
                process.stdin.write(b'{"type":"cancel"}\n')
                process.stdin.flush()
            process.stdin.close()
            process.stdin = None
            started = time.monotonic()
            out, error = process.communicate(timeout=8)
            require(time.monotonic() - started < 8 and key.encode() not in out + error)
            release.set()
            try:
                os.kill(child, 0)
                require(False)
            except ProcessLookupError:
                pass
        checks["worker_has_separate_uid"] = True
        checks["no_execution_listener"] = True
        checks["eof_cancel_exit_bounded"] = True
        SAFE_STAGE = "temporary-configuration"
        # Configuration starts a temporary management listener without opening
        # any browser. Closing its pipe must remove that owned listener.
        reserve = socket.socket()
        reserve.bind(("127.0.0.1", 0))
        management_port = reserve.getsockname()[1]
        reserve.close()
        env_file = data / "service.env"
        contents = env_file.read_text("utf-8")
        require("ABILOCK_ADMIN_PORT=4317" in contents)
        env_file.write_text(contents.replace("ABILOCK_ADMIN_PORT=4317", "ABILOCK_ADMIN_PORT=" + str(management_port)))
        os.chown(env_file, service.pw_uid, service.pw_gid)
        os.chmod(env_file, 0o600)
        configuration = subprocess.Popen([str(launch), "config"], cwd=caller, env=caller_env,
                                         preexec_fn=demote(owner, human.pw_gid), stdin=subprocess.PIPE,
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        children.append(configuration)
        address = wait_ready(configuration, key)
        require(address == "http://127.0.0.1:" + str(management_port))
        configuration.stdin.close()
        configuration.stdin = None
        out, error = configuration.communicate(timeout=8)
        require(configuration.returncode == 0 and key.encode() not in out + error)
        probe = socket.socket()
        probe.settimeout(1)
        require(probe.connect_ex(("127.0.0.1", management_port)) != 0)
        probe.close()
        checks["temporary_config_exits_without_browser"] = True
        SAFE_STAGE = "complete"
        return {"ok": True, "checks": checks, "nodeVersion": metadata["nodeVersion"],
                "syntheticOnly": True, "fixtureDeviations": ["fixed fixture installation/data/client launcher paths",
                "compile-time existing nobody test identity", "protected fixture-only ALLOW_LOCAL=1"],
                "releaseWorkerProxyRedactionUnchanged": True}
    finally:
        prior_stage = SAFE_STAGE
        SAFE_STAGE = "cleanup"
        for process in children:
            if process.poll() is None:
                if process.stdin is not None:
                    try:
                        process.stdin.close()
                    except OSError:
                        pass
                process.terminate()
                try:
                    process.wait(timeout=7)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
        if server is not None:
            for pending in server.pending:
                pending.set()
            server.shutdown()
            server.server_close()
        if thread is not None:
            thread.join(timeout=3)
        # Remove only this invocation's marker- and inode-matched fixture.
        # Dead prior fixtures are recovered by reserve_fixture under its lease;
        # unknown/replaced directories and live processes are never adopted.
        # No installed runtime, real private directory or account is touched.
        remove_created_fixture(fixture, fixture_identity, PARENT)
        SAFE_STAGE = prior_stage


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify reviewed Abilock isolation with fake credentials")
    parser.add_argument("--bundle", type=pathlib.Path, required=True)
    parser.add_argument("--digest", required=True)
    parser.add_argument("--owner", type=int, required=True)
    arguments = parser.parse_args()
    require(len(arguments.digest) == 64 and all(char in "0123456789abcdef" for char in arguments.digest))
    result = verify(arguments.bundle, arguments.digest, arguments.owner)
    result["fixtureRemoved"] = True
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        # Native errors, arguments, stdout and passwords never enter a report.
        print(json.dumps({"ok": False, "syntheticOnly": True, "error": "ISOLATION_VERIFICATION_FAILED", "stage": SAFE_STAGE}))
        raise SystemExit(78)
