"""Non-privileged tests of the root acceptance verifier's public-file helpers."""
import ast
import base64
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "scripts/verify-isolation.py"
specification = importlib.util.spec_from_file_location("isolation_verifier", SOURCE)
module = importlib.util.module_from_spec(specification)
specification.loader.exec_module(module)


class VerifierHelpers(unittest.TestCase):
    def bundle(self, parent):
        directory = parent / "bundle"
        directory.mkdir()
        entries = []
        for name in ["node", "verify-launch", "runtime/bin/abl.mjs",
                     "runtime/dist/src/isolated-worker.js"]:
            file = directory / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("public synthetic fixture " + name)
            entries.append({"path": name, "sha256": module.digest(file), "mode": 420})
        manifest = {"version": 1, "platform": "darwin", "nodeVersion": "synthetic", "files": entries}
        file = directory / "manifest.json"
        file.write_text(json.dumps(manifest))
        return directory, module.digest(file), manifest

    def test_python_39_syntax(self):
        ast.parse(SOURCE.read_text(), feature_version=(3, 9))

    def test_fixed_existing_identity_and_fixture_constants(self):
        self.assertEqual(module.ACCOUNT, "nobody")
        self.assertEqual(module.PARENT, pathlib.Path("/private/var/db"))
        self.assertEqual(module.FIXTURE_NAME, ".abilock-isolation-fixture")

    def test_copy_hashes_exact_verified_bytes(self):
        with tempfile.TemporaryDirectory(prefix="abilock-verifier-public-") as temporary:
            parent = pathlib.Path(temporary)
            bundle, digest, manifest = self.bundle(parent)
            copied = parent / "copied"
            copied.mkdir()
            self.assertEqual(module.freeze_bundle(bundle, digest, copied), manifest)
            for entry in manifest["files"]:
                self.assertEqual(module.digest(copied / entry["path"]), entry["sha256"])

    def test_changed_file_symlink_and_hardlink_are_rejected(self):
        for mode in ["changed", "symlink", "hardlink"]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix="abilock-verifier-public-") as temporary:
                parent = pathlib.Path(temporary)
                bundle, digest, _manifest = self.bundle(parent)
                file = bundle / "node"
                if mode == "changed":
                    file.write_text("public changed fixture")
                elif mode == "symlink":
                    target = parent / "public-target"
                    file.rename(target)
                    file.symlink_to(target)
                else:
                    os.link(file, parent / "second-link")
                copied = parent / "copied"
                copied.mkdir()
                with self.assertRaises((ValueError, OSError)):
                    module.freeze_bundle(bundle, digest, copied)

    def test_manifest_digest_and_traversal_rejected(self):
        with tempfile.TemporaryDirectory(prefix="abilock-verifier-public-") as temporary:
            parent = pathlib.Path(temporary)
            bundle, digest, manifest = self.bundle(parent)
            copied = parent / "copied"
            copied.mkdir()
            with self.assertRaises(ValueError):
                module.freeze_bundle(bundle, "0" * 64, copied)
            manifest["files"][0]["path"] = "../outside"
            (bundle / "manifest.json").write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                module.freeze_bundle(bundle, module.digest(bundle / "manifest.json"), copied)
            self.assertFalse((parent / "outside").exists())

    def test_public_response_decodes_and_rejects_secret_echo(self):
        response = {"result": "synthetic rewrite completed", "echo": "[REDACTED]"}
        frames = [{"type": "headers", "status": 200},
                  {"type": "body", "data": base64.b64encode(json.dumps(response).encode()).decode()},
                  {"type": "done"}]
        wire = b"".join(json.dumps(frame).encode() + b"\n" for frame in frames)
        self.assertEqual(module.parsed_response(wire, "synthetic-secret"), (200, response))
        with self.assertRaises(ValueError):
            module.parsed_response(wire + b"synthetic-secret", "synthetic-secret")
        frames[-1]["failed"] = True
        wire = b"".join(json.dumps(frame).encode() + b"\n" for frame in frames)
        with self.assertRaises(ValueError):
            module.parsed_response(wire, "synthetic-secret")

    def test_frame_carries_only_existing_request_fields(self):
        request = json.loads(module.frame("/v1/call/FIXTURE", "POST", {"method": "POST", "path": "/echo"}))
        self.assertEqual(set(request), {"type", "url", "method", "headers", "body"})
        self.assertEqual(request["headers"], {"content-type": "application/json"})
        self.assertEqual(json.loads(request["body"]), {"method": "POST", "path": "/echo"})

    def test_exact_fixture_patch_does_not_accept_unknown_source(self):
        with tempfile.TemporaryDirectory(prefix="abilock-verifier-public-") as temporary:
            file = pathlib.Path(temporary) / "public.js"
            file.write_text("known source")
            module.patch_once(file, "known source", "fixture source")
            self.assertEqual(file.read_text(), "fixture source")
            with self.assertRaises(ValueError):
                module.patch_once(file, "known source", "another source")

    def test_preexisting_fixture_and_symlink_are_never_adopted(self):
        for mode in ["directory", "dangling-symlink"]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix="abilock-verifier-public-") as temporary:
                parent = pathlib.Path(temporary)
                existing = parent / module.FIXTURE_NAME
                if mode == "directory":
                    existing.mkdir()
                    (existing / "kept").write_text("public existing fixture")
                else:
                    existing.symlink_to(parent / "missing")
                with self.assertRaises(ValueError):
                    module.reserve_fixture(parent, os.getuid())
                if mode == "directory":
                    self.assertEqual((existing / "kept").read_text(), "public existing fixture")
                else:
                    self.assertTrue(existing.is_symlink())

    def test_cleanup_removes_only_created_inode_and_preserves_replacement(self):
        with tempfile.TemporaryDirectory(prefix="abilock-verifier-public-") as temporary:
            parent = pathlib.Path(temporary)
            fixture, identity = module.reserve_fixture(parent, os.getuid())
            original = parent / "original-created-inode"
            fixture.rename(original)
            fixture.mkdir()
            (fixture / "kept").write_text("public replacement fixture")
            with self.assertRaises(ValueError):
                module.remove_created_fixture(fixture, identity, parent, os.getuid())
            self.assertEqual((fixture / "kept").read_text(), "public replacement fixture")
            fixture.rename(parent / "replacement-kept")
            original.rename(fixture)
            module.remove_created_fixture(fixture, identity, parent, os.getuid())
            self.assertFalse(fixture.exists())
            self.assertTrue((parent / "replacement-kept/kept").exists())

    def test_cleanup_refuses_wrong_name_parent_and_symlink(self):
        with tempfile.TemporaryDirectory(prefix="abilock-verifier-public-") as temporary:
            parent = pathlib.Path(temporary)
            fixture, identity = module.reserve_fixture(parent, os.getuid())
            wrong = parent / "unrelated"
            wrong.mkdir()
            with self.assertRaises(ValueError):
                module.remove_created_fixture(wrong, identity, parent, os.getuid())
            with self.assertRaises(ValueError):
                module.remove_created_fixture(fixture, identity, parent / "wrong-parent", os.getuid())
            kept = parent / "kept-created-inode"
            fixture.rename(kept)
            fixture.symlink_to(kept)
            with self.assertRaises(ValueError):
                module.remove_created_fixture(fixture, identity, parent, os.getuid())
            self.assertTrue(kept.exists())
            fixture.unlink()
            kept.rename(fixture)
            module.remove_created_fixture(fixture, identity, parent, os.getuid())

    def crashed_fixture(self, parent, cleanup=False, unpublished=False):
        pid = os.fork()
        if pid == 0:
            fixture, identity = module.reserve_fixture(parent, os.getuid())
            (fixture / 'synthetic-leftover').write_text('fake fixture state')
            if cleanup:
                state = module.fixture_state(parent, os.getuid())
                state['phase'] = 'cleanup'
                module.save_fixture_state(parent, state)
                (fixture / module.FIXTURE_MARKER).unlink()
            if unpublished:
                state = module.fixture_state(parent, os.getuid())
                fixture.rename(parent / state['stage'])
            os._exit(91)
        _, status = os.waitpid(pid, 0)
        self.assertEqual(os.waitstatus_to_exitcode(status), 91)
        return pid

    def test_dead_fixture_is_recovered_before_next_reservation(self):
        with tempfile.TemporaryDirectory(prefix='abilock-verifier-recovery-') as temporary:
            parent = pathlib.Path(temporary)
            self.crashed_fixture(parent)
            fixture, identity = module.reserve_fixture(parent, os.getuid())
            self.assertFalse((fixture / 'synthetic-leftover').exists())
            self.assertEqual(module.fixture_state(parent, os.getuid())['pid'], os.getpid())
            module.remove_created_fixture(fixture, identity, parent, os.getuid())
            self.assertFalse((parent / module.FIXTURE_STATE).exists())

    def test_cleanup_interruption_recovers_even_after_internal_marker_removed(self):
        with tempfile.TemporaryDirectory(prefix='abilock-verifier-recovery-') as temporary:
            parent = pathlib.Path(temporary)
            self.crashed_fixture(parent, cleanup=True)
            fixture, identity = module.reserve_fixture(parent, os.getuid())
            self.assertFalse((fixture / 'synthetic-leftover').exists())
            module.remove_created_fixture(fixture, identity, parent, os.getuid())

    def test_prepublication_interruption_uses_durable_stage_identity(self):
        with tempfile.TemporaryDirectory(prefix='abilock-verifier-recovery-') as temporary:
            parent = pathlib.Path(temporary)
            self.crashed_fixture(parent, unpublished=True)
            previous = module.fixture_state(parent, os.getuid())
            fixture, identity = module.reserve_fixture(parent, os.getuid())
            self.assertFalse((parent / previous['stage']).exists())
            module.remove_created_fixture(fixture, identity, parent, os.getuid())

    def test_live_verifier_cannot_be_adopted_even_if_lease_was_released(self):
        with tempfile.TemporaryDirectory(prefix='abilock-verifier-recovery-') as temporary:
            parent = pathlib.Path(temporary)
            fixture, identity = module.reserve_fixture(parent, os.getuid())
            held = module._FIXTURE_LEASES.pop(str(fixture))
            os.close(held)
            with self.assertRaises(ValueError):
                module.reserve_fixture(parent, os.getuid())
            # Restore this invocation's lease only to clean its own fixture.
            import fcntl
            held = os.open(parent / module.FIXTURE_LOCK, os.O_RDWR)
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            module._FIXTURE_LEASES[str(fixture)] = held
            module.remove_created_fixture(fixture, identity, parent, os.getuid())

    def test_stale_receipt_does_not_remove_replaced_inode(self):
        with tempfile.TemporaryDirectory(prefix='abilock-verifier-recovery-') as temporary:
            parent = pathlib.Path(temporary)
            self.crashed_fixture(parent)
            fixture = parent / module.FIXTURE_NAME
            saved = parent / 'saved-original'
            fixture.rename(saved)
            fixture.mkdir()
            (fixture / 'keep').write_text('unrelated replacement')
            with self.assertRaises(ValueError):
                module.reserve_fixture(parent, os.getuid())
            self.assertEqual((fixture / 'keep').read_text(), 'unrelated replacement')
            self.assertTrue((saved / 'synthetic-leftover').exists())

    def test_stale_fixture_missing_marker_is_not_deleted(self):
        with tempfile.TemporaryDirectory(prefix='abilock-verifier-recovery-') as temporary:
            parent = pathlib.Path(temporary)
            self.crashed_fixture(parent)
            fixture = parent / module.FIXTURE_NAME
            (fixture / module.FIXTURE_MARKER).unlink()
            with self.assertRaises(ValueError):
                module.reserve_fixture(parent, os.getuid())
            self.assertTrue((fixture / 'synthetic-leftover').exists())

    def test_dead_verifier_with_active_fixture_worker_is_not_removed(self):
        with tempfile.TemporaryDirectory(prefix='abilock-verifier-recovery-') as temporary:
            parent = pathlib.Path(temporary)
            self.crashed_fixture(parent)
            fixture = parent / module.FIXTURE_NAME
            worker = subprocess.Popen([sys.executable, '-I', '-c',
                'import sys; print("ready", flush=True); sys.stdin.read()'], cwd=fixture,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            try:
                self.assertEqual(worker.stdout.readline(), b'ready\n')
                with self.assertRaises(ValueError):
                    module.reserve_fixture(parent, os.getuid())
                self.assertTrue((fixture / 'synthetic-leftover').exists())
            finally:
                worker.stdin.close()
                worker.wait(timeout=5)
                worker.stdout.close()
            replacement, identity = module.reserve_fixture(parent, os.getuid())
            module.remove_created_fixture(replacement, identity, parent, os.getuid())

    def test_prepublication_name_collision_is_preserved(self):
        for kind in ['directory', 'symlink']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(prefix='abilock-verifier-reserve-') as temporary:
                parent = pathlib.Path(temporary)
                nonce = 'b' * 32
                candidate = parent / (module.FIXTURE_NAME + '.preparing-' + nonce)
                sentinel = parent / 'unrelated'
                sentinel.mkdir()
                (sentinel / 'keep').write_text('unrelated public data')
                if kind == 'directory':
                    candidate.mkdir()
                    (candidate / 'keep').write_text('existing public fixture')
                else:
                    candidate.symlink_to(sentinel)
                uuid4 = module.uuid.uuid4
                module.uuid.uuid4 = lambda: types.SimpleNamespace(hex=nonce)
                try:
                    with self.assertRaises(FileExistsError):
                        module.reserve_fixture(parent, os.getuid())
                finally:
                    module.uuid.uuid4 = uuid4
                self.assertEqual((sentinel / 'keep').read_text(), 'unrelated public data')
                if kind == 'directory':
                    self.assertEqual((candidate / 'keep').read_text(), 'existing public fixture')
                else:
                    self.assertTrue(candidate.is_symlink())

    def test_unpublished_replacement_is_preserved_on_failure(self):
        for kind in ['directory', 'symlink']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(prefix='abilock-verifier-reserve-') as temporary:
                parent = pathlib.Path(temporary)
                original = parent / 'original-created-inode'
                sentinel = parent / 'unrelated'
                sentinel.mkdir()
                (sentinel / 'keep').write_text('unrelated public data')
                save = module.save_fixture_state
                attempted = []
                def replace_then_fail(parent, state):
                    candidate = parent / state['stage']
                    attempted.append(candidate)
                    candidate.rename(original)
                    if kind == 'directory':
                        candidate.mkdir()
                        (candidate / 'keep').write_text('replacement public data')
                    else:
                        candidate.symlink_to(sentinel)
                    raise OSError('synthetic write interruption')
                module.save_fixture_state = replace_then_fail
                try:
                    with self.assertRaises(OSError):
                        module.reserve_fixture(parent, os.getuid())
                finally:
                    module.save_fixture_state = save
                self.assertTrue((original / module.FIXTURE_MARKER).exists())
                self.assertEqual((sentinel / 'keep').read_text(), 'unrelated public data')
                if kind == 'directory':
                    self.assertEqual((attempted[0] / 'keep').read_text(), 'replacement public data')
                else:
                    self.assertTrue(attempted[0].is_symlink())

    def test_only_created_unpublished_inode_is_cleaned(self):
        with tempfile.TemporaryDirectory(prefix='abilock-verifier-reserve-') as temporary:
            parent = pathlib.Path(temporary)
            save = module.save_fixture_state
            attempted = []
            def fail_before_receipt(parent, state):
                attempted.append(parent / state['stage'])
                raise OSError('synthetic write interruption')
            module.save_fixture_state = fail_before_receipt
            try:
                with self.assertRaises(OSError):
                    module.reserve_fixture(parent, os.getuid())
            finally:
                module.save_fixture_state = save
            self.assertEqual(len(attempted), 1)
            self.assertFalse(attempted[0].exists())

    def test_slow_mock_exceeds_old_deadline_without_polluting_cancel_queue(self):
        delays = []
        event_factory = module.threading.Event
        module.threading.Event = lambda: types.SimpleNamespace(wait=delays.append)
        handler = object.__new__(module.MockHandler)
        handler.path = '/slow'
        handler.headers = {'content-length': '0', 'authorization': 'Bearer synthetic-fake-key'}
        handler.rfile = io.BytesIO()
        handler.wfile = io.BytesIO()
        handler.server = types.SimpleNamespace(key='synthetic-fake-key', correct_auth=0,
                                               pending=[], received=module.queue.Queue())
        statuses = []
        handler.send_response = statuses.append
        handler.send_header = lambda *args: None
        handler.end_headers = lambda: None
        try:
            handler.do_POST()
        finally:
            module.threading.Event = event_factory
        self.assertEqual(delays, [125])
        self.assertEqual(statuses, [200])
        self.assertEqual(handler.server.correct_auth, 1)
        self.assertTrue(handler.server.received.empty())
        self.assertEqual(len(handler.server.pending), 1)
        self.assertEqual(json.loads(handler.wfile.getvalue())['result'], 'synthetic rewrite completed')


if __name__ == "__main__":
    unittest.main()
