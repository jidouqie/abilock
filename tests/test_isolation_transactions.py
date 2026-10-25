"""Fault injection exercises actual directory exchange and durable recovery.

All paths, contents and UID attributes are local synthetic fixtures. No real
Abilock directory, administrator authorization, account or key is touched.
"""
import copy
import importlib.util
import json
import os
import pathlib
import shutil
import stat
import tempfile
import types
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'scripts/isolation-install.py'
spec = importlib.util.spec_from_file_location('isolation_installer_transactions', SOURCE)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class Transactions(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='abl-transaction-test-')
        self.root = pathlib.Path(self.temp.name)
        self.owner = os.getuid()
        self.original_chmod = os.chmod
        self.chmod_requests = []
        def trace_chmod(file, mode, *args, **kwargs):
            self.chmod_requests.append((str(file), mode))
            return self.original_chmod(file, mode, *args, **kwargs)
        os.chmod = trace_chmod
        self.original_pwd = installer.pwd.getpwuid
        installer.pwd.getpwuid = lambda uid: types.SimpleNamespace(pw_dir=str(self.root / 'user'))
        installer.INSTALL = self.root / 'program/abilock'
        installer.DATA = self.root / 'private/abilock'
        installer.TRANSACTION = self.root / 'private/transaction'
        installer.TRANSACTION_CLEANUP = self.root / 'private/cleanup'
        for name in ['program', 'private', 'user']:
            (self.root / name).mkdir()
        self.original_root_directory = installer.root_directory
        def trusted_test_directory(directory, created=None):
            info = directory.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != self.owner or info.st_mode & 0o022:
                raise ValueError('Untrusted synthetic parent')
        installer.root_directory = trusted_test_directory
        self.stage = self.root / 'program/.abilock-install-test'
        self.stage.mkdir()
        (self.stage / 'launch').write_text('NEW launch')
        (self.stage / 'runtime').write_text('NEW runtime')
        os.chmod(self.stage / 'launch', 0o555)
        self.original = self.root / 'user/.abilock'

    def tearDown(self):
        os.chmod = self.original_chmod
        installer.pwd.getpwuid = self.original_pwd
        installer.root_directory = self.original_root_directory
        self.temp.cleanup()

    def record(self, mode):
        installer.TRANSACTION.mkdir(mode=0o700)
        return dict(version=1, owner=self.owner, mode=mode, phase='prepared',
                    staging=str(self.stage), stagingIdentity=installer.identity(self.stage),
                    oldIdentity=None, oldLaunchMode=0, dataIdentity=None,
                    original=str(self.original), records=[], backupIdentity=None, backupReady=False,
                    accountCreated=False, uid=None, gid=None, transactionId='a' * 32)

    def upgrade(self):
        installer.INSTALL.mkdir()
        (installer.INSTALL / 'launch').write_text('OLD launch')
        (installer.INSTALL / 'runtime').write_text('OLD runtime')
        os.chmod(installer.INSTALL / 'launch', 0o4755)
        installer.DATA.mkdir(mode=0o700)
        (installer.DATA / 'key').write_bytes(b'FAKE-credential-not-for-output')
        record = self.record('upgrade')
        record.update(oldIdentity=installer.identity(installer.INSTALL), oldLaunchMode=0o4755,
                      dataIdentity=installer.identity(installer.DATA))
        installer.journal_write(record)
        return record

    def migration(self):
        self.original.mkdir(mode=0o700)
        (self.original / 'nested').mkdir(mode=0o700)
        (self.original / 'service.env').write_bytes(b'FAKE-STARTUP-CONTENTS')
        (self.original / 'nested/key').write_bytes(b'FAKE-ORIGINAL-KEY')
        os.chmod(self.original / 'service.env', 0o400)
        os.chmod(self.original / 'nested/key', 0o640)
        record = self.record('install')
        records = installer.validate_private_tree(self.original)
        record.update(records=[{**item, 'acl': item['acl'].hex()} for item in records],
                      dataIdentity=installer.identity(self.original))
        installer.journal_write(record, 'migrate')
        return record, records

    def assert_old_runtime(self):
        self.assertEqual((installer.INSTALL / 'launch').read_text(), 'OLD launch')
        self.assertEqual((installer.INSTALL / 'runtime').read_text(), 'OLD runtime')
        # The ordinary-user sandbox strips setuid; verify the restore request
        # here. Actual root/setuid acceptance runs separately in fake fixtures.
        self.assertEqual(stat.S_IMODE((installer.INSTALL / 'launch').stat().st_mode) & 0o777, 0o755)
        self.assertIn((str(installer.INSTALL / 'launch'), 0o4755), self.chmod_requests)
        self.assertEqual((installer.DATA / 'key').read_bytes(), b'FAKE-credential-not-for-output')
        self.assertFalse(installer.TRANSACTION.exists())
        self.assertFalse(self.stage.exists())
        self.assertFalse(installer.recover_transaction(self.owner))

    def assert_old_private(self):
        self.assertEqual((self.original / 'service.env').read_bytes(), b'FAKE-STARTUP-CONTENTS')
        self.assertEqual((self.original / 'nested/key').read_bytes(), b'FAKE-ORIGINAL-KEY')
        self.assertEqual(stat.S_IMODE((self.original / 'service.env').stat().st_mode), 0o400)
        self.assertEqual(stat.S_IMODE((self.original / 'nested/key').stat().st_mode), 0o640)
        self.assertFalse(installer.DATA.exists())
        self.assertFalse(installer.TRANSACTION.exists())
        self.assertFalse(installer.recover_transaction(self.owner))

    def test_upgrade_before_swap_restores_disabled_launcher(self):
        record = self.upgrade()
        installer.journal_write(record, 'install')
        os.chmod(installer.INSTALL / 'launch', 0)
        self.assertTrue(installer.recover_transaction(self.owner))
        self.assert_old_runtime()

    def test_hard_exit_after_atomic_swap_recovers_from_disk(self):
        record = self.upgrade()
        pid = os.fork()
        if pid == 0:
            installer.journal_write(record, 'install')
            os.chmod(installer.INSTALL / 'launch', 0)
            installer.atomic_swap(installer.INSTALL, self.stage)
            os._exit(97)
        _, status = os.waitpid(pid, 0)
        self.assertEqual(os.waitstatus_to_exitcode(status), 97)
        self.assertEqual((installer.INSTALL / 'runtime').read_text(), 'NEW runtime')
        self.assertTrue(installer.recover_transaction(self.owner))
        self.assert_old_runtime()

    def test_failure_after_enable_still_restores_original(self):
        record = self.upgrade()
        installer.journal_write(record, 'install')
        os.chmod(installer.INSTALL / 'launch', 0)
        installer.atomic_swap(installer.INSTALL, self.stage)
        os.chmod(installer.INSTALL / 'launch', 0o4755)
        installer.recover_transaction(self.owner)
        self.assert_old_runtime()

    def test_commit_is_durable_and_keeps_new_runtime(self):
        record = self.upgrade()
        os.chmod(installer.INSTALL / 'launch', 0)
        installer.atomic_swap(installer.INSTALL, self.stage)
        os.chmod(installer.INSTALL / 'launch', 0o4755)
        installer.journal_write(record, 'commit')
        self.assertTrue(installer.recover_transaction(self.owner))
        self.assertEqual((installer.INSTALL / 'runtime').read_text(), 'NEW runtime')
        self.assertEqual((installer.DATA / 'key').read_bytes(), b'FAKE-credential-not-for-output')
        self.assertFalse(self.stage.exists())
        self.assertFalse(installer.TRANSACTION.exists())

    def test_pending_record_never_overwrites_last_durable_state(self):
        self.upgrade()
        (installer.TRANSACTION / 'state.pending').write_text('{incomplete')
        installer.recover_transaction(self.owner)
        self.assert_old_runtime()

    def test_wrong_owner_and_path_escape_refused_before_mutation(self):
        record = self.upgrade()
        with self.assertRaises(ValueError):
            installer.recover_transaction(self.owner + 1)
        altered = copy.deepcopy(record)
        altered['staging'] = str(self.root)
        installer.journal_write(altered)
        with self.assertRaises(ValueError):
            installer.recover_transaction(self.owner)
        self.assertEqual((installer.INSTALL / 'runtime').read_text(), 'OLD runtime')
        installer.journal_write(record)
        installer.recover_transaction(self.owner)
        self.assert_old_runtime()

    def test_replaced_runtime_inode_retains_transaction(self):
        record = self.upgrade()
        saved = self.root / 'program/moved'
        installer.INSTALL.rename(saved)
        installer.INSTALL.mkdir()
        with self.assertRaises(ValueError):
            installer.recover_transaction(self.owner)
        self.assertTrue(installer.TRANSACTION.exists())
        self.assertEqual((saved / 'runtime').read_text(), 'OLD runtime')
        installer.INSTALL.rmdir()
        saved.rename(installer.INSTALL)
        installer.recover_transaction(self.owner)
        self.assert_old_runtime()

    def test_migration_before_move_is_idempotent(self):
        self.migration()
        installer.recover_transaction(self.owner)
        self.assert_old_private()

    def test_migration_after_rename_restores_permissions(self):
        record, records = self.migration()
        self.original.rename(installer.DATA)
        installer.apply_private_tree(installer.DATA, os.getuid(), os.getgid(), records)
        installer.journal_write(record, 'owner-transfer')
        installer.recover_transaction(self.owner)
        self.assert_old_private()

    def test_incomplete_backup_is_ignored_before_rewrite(self):
        record, records = self.migration()
        self.original.rename(installer.DATA)
        installer.apply_private_tree(installer.DATA, os.getuid(), os.getgid(), records)
        installer.journal_write(record, 'backup')
        backup = installer.TRANSACTION / 'original'
        backup.mkdir(mode=0o700)
        (backup / 'partial').write_bytes(b'FAKE-PARTIAL')
        installer.recover_transaction(self.owner)
        self.assert_old_private()

    def backup_ready(self):
        record, records = self.migration()
        self.original.rename(installer.DATA)
        installer.apply_private_tree(installer.DATA, os.getuid(), os.getgid(), records)
        backup = installer.TRANSACTION / 'original'
        shutil.copytree(installer.DATA, backup)
        record.update(backupReady=True, backupIdentity=installer.identity(backup))
        installer.journal_write(record, 'rewrite')
        os.chmod(installer.DATA / 'service.env', 0o600)
        (installer.DATA / 'service.env').write_bytes(b'FAKE-REWRITTEN-CONTENTS')
        return record, records, backup

    def test_hard_exit_after_private_rewrite_restores_opaque_backup(self):
        self.backup_ready()
        installer.recover_transaction(self.owner)
        self.assert_old_private()

    def test_recovery_after_restored_original_rename_is_idempotent(self):
        record, records, backup = self.backup_ready()
        installer.restore_private_tree(backup, records)
        backup.rename(self.original)
        installer.recover_transaction(self.owner)
        self.assert_old_private()

    def test_recovery_preserves_user_replacement_at_original_location(self):
        self.backup_ready()
        self.original.mkdir(mode=0o700)
        sentinel = self.original / 'unrelated'
        sentinel.write_bytes(b'USER-DATA-MUST-SURVIVE')
        with self.assertRaises(ValueError):
            installer.recover_transaction(self.owner)
        self.assertEqual(sentinel.read_bytes(), b'USER-DATA-MUST-SURVIVE')
        self.assertTrue((installer.TRANSACTION / 'original').exists())

    def test_new_install_precreated_directory_removed_only_by_identity(self):
        record = self.record('install')
        installer.DATA.mkdir(mode=0o700)
        record['dataIdentity'] = installer.identity(installer.DATA)
        (installer.DATA / 'fake-key').write_bytes(b'FAKE-NEW-KEY')
        installer.journal_write(record, 'migrate')
        installer.recover_transaction(self.owner)
        self.assertFalse(installer.DATA.exists())
        self.assertFalse(installer.TRANSACTION.exists())

    def test_partial_cleanup_is_safe_to_finish_without_metadata(self):
        installer.TRANSACTION_CLEANUP.mkdir(mode=0o700)
        (installer.TRANSACTION_CLEANUP / 'partial').write_bytes(b'FAKE-BACKUP-FRAGMENT')
        self.assertFalse(installer.recover_transaction(self.owner))
        self.assertFalse(installer.TRANSACTION_CLEANUP.exists())

    def test_symlink_cleanup_is_rejected(self):
        sentinel = self.root / 'private/unrelated'
        sentinel.mkdir()
        (sentinel / 'keep').write_text('keep')
        installer.TRANSACTION_CLEANUP.symlink_to(sentinel, target_is_directory=True)
        with self.assertRaises(ValueError):
            installer.recover_transaction(self.owner)
        self.assertEqual((sentinel / 'keep').read_text(), 'keep')

    def test_migration_stale_lock_is_held_without_recreating_inode(self):
        self.original.mkdir(mode=0o700)
        (self.original / 'data').mkdir(mode=0o700)
        lock = self.original / 'data/service.lock'
        lock.write_text('2147483647')
        os.chmod(lock, 0o600)
        inode = lock.stat().st_ino
        descriptor = installer.acquire_migration_lock(self.original)
        try:
            self.assertIsNotNone(descriptor)
            self.assertEqual(lock.stat().st_ino, inode)
            second = os.open(lock, os.O_RDWR)
            try:
                with self.assertRaises(BlockingIOError):
                    installer.fcntl.flock(second, installer.fcntl.LOCK_EX | installer.fcntl.LOCK_NB)
            finally:
                os.close(second)
        finally:
            os.close(descriptor)
        self.assertEqual(lock.read_text(), '2147483647')

    def test_migration_live_legacy_pid_is_rejected(self):
        self.original.mkdir(mode=0o700)
        (self.original / 'data').mkdir(mode=0o700)
        lock = self.original / 'data/service.lock'
        lock.write_text(str(os.getpid()))
        os.chmod(lock, 0o600)
        with self.assertRaises(ValueError):
            installer.acquire_migration_lock(self.original)
        self.assertEqual(lock.read_text(), str(os.getpid()))

    def test_migration_live_kernel_lock_is_rejected(self):
        self.original.mkdir(mode=0o700)
        (self.original / 'data').mkdir(mode=0o700)
        lock = self.original / 'data/service.lock'
        lock.write_text('')
        os.chmod(lock, 0o600)
        held = os.open(lock, os.O_RDWR)
        try:
            installer.fcntl.flock(held, installer.fcntl.LOCK_EX | installer.fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                installer.acquire_migration_lock(self.original)
        finally:
            os.close(held)

    def test_migration_missing_lock_does_not_create_a_stale_marker(self):
        self.original.mkdir(mode=0o700)
        (self.original / 'data').mkdir(mode=0o700)
        self.assertIsNone(installer.acquire_migration_lock(self.original))
        self.assertFalse((self.original / 'data/service.lock').exists())

    def test_partial_account_cleanup_only_removes_matching_transaction_tag(self):
        run = installer.subprocess.run
        deleted = []
        def synthetic_dscl(arguments, **kwargs):
            entry = arguments[3]
            if arguments[2] == '-read':
                tag = 'different-install' if entry.startswith('/Users/') else 'a' * 32
                return types.SimpleNamespace(returncode=0, stdout='AbilockInstallTransaction: ' + tag + '\n')
            self.assertEqual(arguments[2], '-delete')
            deleted.append(entry)
            return types.SimpleNamespace(returncode=0, stdout='')
        installer.subprocess.run = synthetic_dscl
        try:
            installer.remove_transaction_account('a' * 32)
        finally:
            installer.subprocess.run = run
        self.assertEqual(deleted, ['/Groups/_abilock'])

    def test_new_public_parent_is_0755_under_private_umask(self):
        public = self.root / 'new-public-parent'
        real_chown = os.chown
        old_umask = os.umask(0o077)
        created = []
        def synthetic_chown(file, uid, gid):
            self.assertEqual(pathlib.Path(file), public)
            self.assertEqual((uid, gid), (0, 0))
        os.chown = synthetic_chown
        try:
            self.original_root_directory(public, created)
        finally:
            os.chown = real_chown
            os.umask(old_umask)
        self.assertEqual(stat.S_IMODE(public.stat().st_mode), 0o755)
        self.assertEqual(created, [(public, public.stat().st_ino)])

    def test_existing_public_parent_permissions_are_not_changed(self):
        public = self.root / 'existing-public-parent'
        public.mkdir(mode=0o700)
        original_lstat = pathlib.Path.lstat
        def root_owned_for_test(file):
            value = original_lstat(file)
            if file == public:
                return types.SimpleNamespace(st_mode=value.st_mode, st_uid=0)
            return value
        pathlib.Path.lstat = root_owned_for_test
        try:
            self.original_root_directory(public)
        finally:
            pathlib.Path.lstat = original_lstat
        self.assertEqual(stat.S_IMODE(public.stat().st_mode), 0o700)
        self.assertNotIn((str(public), 0o755), self.chmod_requests)


if __name__ == '__main__':
    unittest.main()
