import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

test("installer checks hashes, completeness and links using public synthetic bundles", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-install-tests-"));
  try {
    const python = `
import hashlib, importlib.util, json, pathlib, os
spec = importlib.util.spec_from_file_location('installer', ${JSON.stringify(path.resolve("scripts/isolation-install.py"))})
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
root = pathlib.Path(${JSON.stringify(directory)})
names = ['launch', 'password', 'node', 'authorize', 'verify-launch', 'file-lock', 'runtime/dist/src/isolated-worker.js', 'runtime/dist/src/local-config.js', 'runtime/dist/src/isolation-bootstrap.js', 'runtime/package.json']
for name in names:
    file = root / name
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes(b'public synthetic file')
def manifest(version='2.0.0'):
    records = [{'path':name,'sha256':installer.file_digest(root/name),'mode':493 if name in ['launch','password','node','Install.command'] else 420} for name in names]
    (root/'manifest.json').write_text(json.dumps({'version':1,'platform':'darwin','arch':'arm64','nodeVersion':'v22.22.0','runtimeVersion':version,'files':records}))
    return installer.file_digest(root/'manifest.json')
digest = manifest()
assert installer.validate_bundle(root, digest)['version'] == 1
def rejected(action):
    try: action()
    except ValueError: return
    raise AssertionError('unsafe bundle accepted')
(root/'node').write_text('tampered')
rejected(lambda: installer.validate_bundle(root, digest))
digest = manifest()
(root/'extra').write_text('undeclared')
rejected(lambda: installer.validate_bundle(root, digest))
(root/'extra').unlink()
os.symlink(root/'node',root/'symlink')
rejected(lambda: installer.validate_bundle(root,digest))
(root/'symlink').unlink()
os.link(root/'node',root/'hardlink')
rejected(lambda: installer.validate_bundle(root,digest))
(root/'hardlink').unlink()
rejected(lambda: installer.validate_bundle(root,'0'*64))
names.extend(['Install.command','runtime/scripts/install-macos.sh','runtime/bin/install-bundle.mjs',
              'runtime/desktop/Abilock.app/Contents/MacOS/Abilock',
              'runtime/desktop/Abilock.app/Contents/Info.plist','runtime/skills/abilock/SKILL.md'])
for name in names:
    file = root/name
    if not file.exists():
        file.parent.mkdir(parents=True,exist_ok=True)
        file.write_bytes(b'public synthetic file')
digest = manifest('2.2.0')
assert installer.validate_bundle(root,digest)['runtimeVersion']=='2.2.0'
(root/'Install.command').write_bytes(b'different installer entry')
digest = manifest('2.2.0')
rejected(lambda: installer.validate_bundle(root,digest))
(root/'Install.command').unlink(); names.remove('Install.command')
digest = manifest('2.2.0')
rejected(lambda: installer.validate_bundle(root,digest))
private = root/'private'
private.mkdir(mode=0o700)
(private/'nested').mkdir(mode=0o700)
(private/'nested/key').write_text('synthetic key only')
os.chmod(private/'nested/key',0o400)
os.symlink(private/'nested/key',private/'late-invalid')
before = (private/'nested/key').stat().st_mode
rejected(lambda: installer.private_tree(private,os.getuid(),os.getgid()))
assert (private/'nested/key').stat().st_mode == before
(private/'late-invalid').unlink()
records = installer.validate_private_tree(private)
installer.apply_private_tree(private,os.getuid(),os.getgid(),records)
assert (private/'nested/key').stat().st_mode & 0o777 == 0o600
installer.restore_private_tree(private,records)
assert (private/'nested/key').stat().st_mode & 0o777 == 0o400
# Replace a matching, prevalidated inode precisely after its root-directory
# check. A symlink/hardlink to an external sentinel must never be chowned,
# chmodded or cleared by the privileged migration or its rollback.
sentinel = root/'external-sentinel'
sentinel.write_text('synthetic external file')
os.chmod(sentinel,0o400)
safe_mode = sentinel.stat().st_mode
safe_owner = sentinel.stat().st_uid
original_acl_set = installer.acl_fd_set
for attack in ['symlink','hardlink','extra-entry','replace-inode']:
    key = private/'nested/key'
    if key.exists() or key.is_symlink(): key.unlink()
    key.write_text('synthetic private file')
    os.chmod(key,0o400)
    records = installer.validate_private_tree(private)
    armed = [True]
    def race(descriptor,text=None):
        original_acl_set(descriptor,text)
        if armed[0]:
            armed[0] = False
            if attack == 'symlink':
                key.unlink(); os.symlink(sentinel,key)
            elif attack == 'hardlink':
                key.unlink(); os.link(sentinel,key)
            elif attack == 'replace-inode':
                replacement = root/'replacement'
                replacement.write_text('synthetic different inode')
                replacement.replace(key)
            else:
                (private/'nested/extra').write_text('synthetic extra')
    installer.acl_fd_set = race
    rejected(lambda: installer.apply_private_tree(private,os.getuid(),os.getgid(),records))
    installer.acl_fd_set = original_acl_set
    installer.restore_private_tree(private,records,expected_identity=True)
    assert sentinel.stat().st_mode == safe_mode and sentinel.stat().st_uid == safe_owner
    if key.exists() or key.is_symlink(): key.unlink()
    if (private/'nested/extra').exists(): (private/'nested/extra').unlink()
    assert sentinel.stat().st_nlink == 1
# Trace the real fd operations on a synthetic executable to ensure ownership
# is transferred before ACL removal, and returned only after ACL restoration.
business = private/'nested/business-file'
business.write_text('synthetic business file')
os.chmod(business,0o700)
privileged = private/'nested/privileged-file'
privileged.write_text('synthetic privileged-bit input')
os.chmod(privileged,0o4700)
records = installer.validate_private_tree(private)
events = []
real_chown = os.fchown
real_chmod = os.fchmod
def traced_chown(descriptor,uid,gid):
    events.append((os.fstat(descriptor).st_ino,'chown'))
    real_chown(descriptor,uid,gid)
def traced_chmod(descriptor,mode):
    events.append((os.fstat(descriptor).st_ino,'chmod'))
    real_chmod(descriptor,mode)
def traced_acl(descriptor,text=None):
    events.append((os.fstat(descriptor).st_ino,'clear' if text is None else 'restore'))
    original_acl_set(descriptor,text)
os.fchown = traced_chown
os.fchmod = traced_chmod
installer.acl_fd_set = traced_acl
installer.apply_private_tree(private,os.getuid(),os.getgid(),records)
for record in records:
    assert [operation for inode,operation in events if inode == record['ino']] == ['chown','clear','chmod']
assert business.stat().st_mode & 0o7777 == 0o700
assert privileged.stat().st_mode & 0o7777 == 0o700
events.clear()
installer.restore_private_tree(private,records,expected_identity=True)
for record in records:
    operations = [operation for inode,operation in events if inode == record['ino']]
    assert operations == (['chown','clear','chmod'] if record['directory'] else []) + ['chmod','restore','chown']
assert business.stat().st_mode & 0o7777 == 0o700
assert privileged.stat().st_mode & 0o7777 == 0o700
os.fchown = real_chown
os.fchmod = real_chmod
installer.acl_fd_set = original_acl_set
print('verified')
`;
    assert.equal(execFileSync("/usr/bin/python3", ["-I", "-c", python], { encoding: "utf8" }).trim(), "verified");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("native password capture requires root and an anonymous pipe", async () => {
  const source = await fs.readFile("native/abilock-password.m", "utf8");
  assert.match(source, /getuid\(\) != 0 \|\| geteuid\(\) != 0/);
  assert.match(source, /S_ISFIFO\(channel.st_mode\)/);
  assert.match(source, /NSSecureTextField/);
  assert.match(source, /write\(3, bytes/);
  assert(!source.includes("printf("));
  assert(!source.includes("NSLog("));
  assert(!source.includes("write(1,"));
});

test("installer accepts the real verifier schema including uppercase EACCES and rejects any deviation", () => {
  const python = `
import importlib.util,json,copy,types,grp
spec=importlib.util.spec_from_file_location('installer',${JSON.stringify(path.resolve("scripts/isolation-install.py"))})
installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)
valid=json.loads('''{"ok":true,"checks":{"protected_bootstrap":true,"kernel_secret_read_EACCES":true,"kernel_runtime_write_EACCES":true,"existing_list_doc_commands":true,"authorized_api_and_echo_redaction":true,"execution_rejects_management":true,"extra_arguments_and_bootstrap_denied":true,"environment_injection_ignored":true,"target_and_auth_override_denied":true,"worker_has_separate_uid":true,"no_execution_listener":true,"eof_cancel_exit_bounded":true,"temporary_config_exits_without_browser":true},"nodeVersion":"v24.21.0","syntheticOnly":true,"fixtureDeviations":["fixed fixture installation/data/client launcher paths","compile-time existing nobody test identity","protected fixture-only ALLOW_LOCAL=1"],"releaseWorkerProxyRedactionUnchanged":true,"fixtureRemoved":true}''')
assert installer.validate_verification_report(valid,'v24.21.0') == valid
def rejected(value):
 try: installer.validate_verification_report(value,'v24.21.0')
 except ValueError: return
 raise AssertionError('invalid report accepted')
for key in valid:
 report=copy.deepcopy(valid);del report[key];rejected(report)
report=copy.deepcopy(valid);report['extra']='untrusted text';rejected(report)
for key in valid['checks']:
 report=copy.deepcopy(valid);del report['checks'][key];rejected(report)
 for wrong in [False,1,'true',None]:
  report=copy.deepcopy(valid);report['checks'][key]=wrong;rejected(report)
report=copy.deepcopy(valid);report['checks']['extra']=True;rejected(report)
report=copy.deepcopy(valid);report['checks']['kernel_secret_read_eacces']=report['checks'].pop('kernel_secret_read_EACCES');rejected(report)
for field in ['ok','syntheticOnly','releaseWorkerProxyRedactionUnchanged','fixtureRemoved']:
 for wrong in [False,1,'true',None]:
  report=copy.deepcopy(valid);report[field]=wrong;rejected(report)
for field,wrong in [('nodeVersion','v24.20.0'),('nodeVersion',None),('checks',[]),('checks',None),('fixtureDeviations','untrusted'),('fixtureDeviations',[])]:
 report=copy.deepcopy(valid);report[field]=wrong;rejected(report)
rejected([]);rejected(None);rejected('untrusted')
account=types.SimpleNamespace(pw_name='_abilock',pw_uid=321,pw_gid=321,pw_dir='/var/empty',pw_shell='/usr/bin/false')
group=types.SimpleNamespace(gr_name='_abilock',gr_gid=321)
installer.pwd.getpwnam=lambda _name:account
installer.pwd.getpwuid=lambda _uid:account
grp.getgrnam=lambda _name:group
grp.getgrgid=lambda _gid:group
assert installer.service_identity_matches(321,321)
account.pw_shell='/bin/zsh';assert not installer.service_identity_matches(321,321)
account.pw_shell='/usr/bin/false';group.gr_gid=322;assert not installer.service_identity_matches(321,321)
for phase in ['initial','prepared','verification','identity','private-snapshot','migrate','owner-transfer','backup','rewrite','install','bootstrap','commit']:
 installer.set_install_phase(phase);assert installer.INSTALL_PHASE==phase
try: installer.set_install_phase('untrusted text')
except ValueError: pass
else: raise AssertionError('unknown phase accepted')
print('verified')
`;
  assert.equal(execFileSync("/usr/bin/python3", ["-I", "-c", python], { encoding: "utf8" }).trim(), "verified");
});

test("installation authorization pins public source and destroys shared rights", async () => {
  const source = await fs.readFile("native/abilock-authorize.c", "utf8");
  assert.match(source, /INSTALL_SCRIPT_SHA256/);
  assert.match(source, /AuthorizationCreate/);
  assert.match(source, /AuthorizationFree\(authorization, kAuthorizationFlagDestroyRights\)/);
  assert.match(source, /const char \*interpreter = "\/usr\/bin\/python3"/);
  assert.match(source, /getuid\(\) < 500/);
  assert(!source.includes("system("));
  assert(!source.includes("osascript"));
  assert(!source.includes("sudo"));
});

test("durable install and upgrade recover after hard exits using only synthetic trees", () => {
  execFileSync("/usr/bin/python3", ["-B", "-I", "tests/test_isolation_transactions.py"], {
    stdio: "pipe", timeout: 30000,
  });
});

test("upgrade backup retains opaque synthetic data and runtime with private metadata and safe receipts", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-upgrade-backup-"));
  try {
    const python = `
import contextlib, importlib.util, io, json, os, pathlib, stat, subprocess, types
spec = importlib.util.spec_from_file_location('installer', ${JSON.stringify(path.resolve("scripts/isolation-install.py"))})
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
root = pathlib.Path(${JSON.stringify(directory)})
installer.DATA = root/'private'
installer.INSTALL = root/'runtime'
installer.BACKUPS = root/'backups'
installer.DATA.mkdir(mode=0o700)
installer.INSTALL.mkdir(mode=0o755)
(installer.DATA/'workspace').mkdir(mode=0o700)
(installer.DATA/'service.env').write_bytes(b'FAKE-STARTUP-SECRET')
(installer.DATA/'workspace/state').write_bytes(b'FAKE-STATE-AND-HISTORY')
os.chmod(installer.DATA/'service.env',0o400)
subprocess.run(['/usr/bin/xattr','-w','com.abilock.synthetic','FAKE-XATTR',str(installer.DATA/'workspace/state')],check=True)
(installer.INSTALL/'launch').write_bytes(b'FAKE-OLD-LAUNCHER')
(installer.INSTALL/'app').mkdir()
(installer.INSTALL/'app/Abilock').write_bytes(b'FAKE-OLD-APP')
(installer.INSTALL/'manifest.json').write_text('{"version":1}')
(installer.INSTALL/'installation.json').write_text('{"version":1}')
os.chmod(installer.INSTALL/'launch',0o755)
def rejected(action):
    try: action()
    except (ValueError,OSError): return
    raise AssertionError('unsafe backup accepted')
# The ordinary process is not an installer and may never request a backup.
rejected(lambda: installer.create_upgrade_backup(os.getuid(),'2.2.11','2.2.11'))
original_root = installer.upgrade_backup_root
original_directory = installer.root_directory
# This tests a fake root without granting root. Ownership calls below must ask
# for root:wheel; the fixture maps only those calls to the test process UID/GID.
uid, gid = os.getuid(), os.getgid()
installer.root_directory = lambda directory: None
installer.BACKUPS.mkdir(mode=0o755)
rejected(original_root)
installer.BACKUPS.rmdir()
installer.BACKUPS.symlink_to(installer.DATA,target_is_directory=True)
rejected(original_root)
installer.BACKUPS.unlink()
installer.root_directory = original_directory
def fake_root():
    installer.BACKUPS.mkdir(mode=0o700,exist_ok=True)
installer.upgrade_backup_root = fake_root
real_chown, real_fchown = os.chown, os.fchown
def mapped_chown(file,owner,group):
    assert (owner,group)==(0,0)
    real_chown(file,uid,gid)
def mapped_fchown(file,owner,group):
    assert (owner,group)==(0,0)
    real_fchown(file,uid,gid)
os.chown, os.fchown = mapped_chown, mapped_fchown
os.getuid = os.geteuid = lambda: 0
before = installer.backup_tree_snapshot(installer.DATA)
state_record=next(item for item in before if item['path']=='workspace/state')
assert state_record['xattrs'][b'com.abilock.synthetic'.hex()]==b'FAKE-XATTR'.hex()
runtime_before = installer.backup_tree_snapshot(installer.INSTALL)
receipt, snapshot = installer.create_upgrade_backup(uid,'2.2.11','2.2.11')
backup = pathlib.Path(receipt['directory'])
assert backup.parent == installer.BACKUPS and len(backup.name)==32
assert snapshot == before and installer.backup_tree_snapshot(installer.DATA)==before
assert installer.backup_tree_snapshot(installer.INSTALL)==runtime_before
assert (backup/'data/service.env').read_bytes()==b'FAKE-STARTUP-SECRET'
assert (backup/'data/workspace/state').read_bytes()==b'FAKE-STATE-AND-HISTORY'
assert (backup/'runtime/app/Abilock').read_bytes()==b'FAKE-OLD-APP'
assert (backup/'runtime/manifest.json').read_bytes()==b'{"version":1}'
for base,directories,files in os.walk(backup):
    assert stat.S_IMODE(os.stat(base).st_mode)==0o700
    for name in files: assert stat.S_IMODE(os.stat(pathlib.Path(base)/name).st_mode)==0o600
manifest=json.loads((backup/'manifest.json').read_text())
assert manifest['complete'] and manifest['data']==before
assert next(item for item in manifest['data'] if item['path']=='workspace/state')['xattrs']==state_record['xattrs']
assert receipt['dataFiles']==2 and receipt['runtimeFiles']==4
# An incomplete backup is retained privately and cannot report completeness.
original_snapshot = installer.backup_tree_snapshot
def fail_copy(source,destination=None,budget=None):
    if destination is not None: raise OSError('synthetic copy failure')
    return original_snapshot(source,budget=budget)
installer.backup_tree_snapshot=fail_copy
rejected(lambda: installer.create_upgrade_backup(uid,'2.2.11','2.2.11'))
installer.backup_tree_snapshot=original_snapshot
assert len(list(installer.BACKUPS.iterdir()))==2
assert sum((item/'manifest.json').exists() for item in installer.BACKUPS.iterdir())==1
assert original_snapshot(installer.DATA)==before
# Receipt contains no private filenames, content, or fingerprints.
installer.verify_upgrade_preservation(receipt,snapshot)
public=(installer.INSTALL/'installation.json').read_text()
assert json.loads(public)['upgradeBackup']['dataPreserved'] is True
for value in ['service.env','workspace','FAKE-','sha256',before[1].get('sha256','missing')]:
    assert value not in public
assert stat.S_IMODE((installer.INSTALL/'installation.json').stat().st_mode)==0o444
# A second same-version upgrade creates a fresh durable backup.
second,_ = installer.create_upgrade_backup(uid,'2.2.11','2.2.11')
assert second['directory']!=receipt['directory'] and backup.exists()
(installer.DATA/'workspace/state').write_bytes(b'FAKE-CHANGED-CONTENTS!')
rejected(lambda: installer.verify_upgrade_preservation(receipt,snapshot))
assert json.loads((installer.INSTALL/'installation.json').read_text())['upgradeBackup']==json.loads(public)['upgradeBackup']
# Links, devices, metadata changes during copy, and size bounds cannot be
# silently omitted, followed, or accepted as a complete backup.
outside=root/'outside'; outside.write_bytes(b'FAKE-OUTSIDE')
for kind in ['symlink','hardlink','fifo']:
    entry=installer.DATA/'unsupported'
    if kind=='symlink': entry.symlink_to(outside)
    elif kind=='hardlink': os.link(outside,entry)
    else: os.mkfifo(entry)
    rejected(lambda: original_snapshot(installer.DATA))
    entry.unlink()
old_limit=installer.MAX_BACKUP_BYTES
installer.MAX_BACKUP_BYTES=1
rejected(lambda: original_snapshot(installer.DATA))
installer.MAX_BACKUP_BYTES=old_limit
original_read=os.read
armed=[True]
def racing_read(descriptor,size):
    result=original_read(descriptor,size)
    if armed[0] and result:
        armed[0]=False
        os.chmod(installer.DATA/'service.env',0o600)
    return result
os.read=racing_read
rejected(lambda: original_snapshot(installer.DATA))
os.read=original_read
original_usage=installer.shutil.disk_usage
installer.shutil.disk_usage=lambda directory: types.SimpleNamespace(free=0)
count=len(list(installer.BACKUPS.iterdir()))
rejected(lambda: installer.create_upgrade_backup(uid,'2.2.11','2.2.11'))
assert len(list(installer.BACKUPS.iterdir()))==count
installer.shutil.disk_usage=original_usage
# Exercise the actual upgrade orchestration, including the same-version case.
# Only product paths/account validation and privileged ownership are fixture
# adapters; the backup, directory swap and preservation check remain real.
installer.pwd.getpwuid=lambda owner: types.SimpleNamespace(pw_dir=str(root/'user'))
installer.root_directory=lambda directory: directory.mkdir(parents=True,exist_ok=True)
installer.public_cli_state=lambda owner: None
installer.register_public_cli=lambda owner,previous: None
installer.check_system_node=lambda node: None
manifest={'runtimeVersion':'2.2.11','arch':'arm64' if os.uname().machine=='arm64' else 'x64'}
installer.validate_bundle=lambda bundle,digest: manifest
installer.validate_existing_installation=lambda owner,version: (300,300,manifest)
installer.assert_idle=lambda owner: None
real_create=installer.create_upgrade_backup
real_swap=installer.atomic_swap
for fail_backup in [True,False]:
    scenario=root/('failure' if fail_backup else 'success')
    scenario.mkdir()
    installer.DATA=scenario/'data'; installer.DATA.mkdir(mode=0o700)
    installer.INSTALL=scenario/'program'; installer.INSTALL.mkdir()
    installer.BACKUPS=scenario/'backups'
    installer.TRANSACTION=scenario/'transaction'
    (installer.DATA/'state').write_bytes(b'FAKE-ORIGINAL-STATE')
    (installer.INSTALL/'launch').write_bytes(b'FAKE-OLD-LAUNCHER')
    (installer.INSTALL/'installation.json').write_text('{"version":1}')
    source_before=original_snapshot(installer.DATA)
    events=[]
    installer.recover_transaction=lambda owner: events.append('recover')
    installer.journal_write=lambda record,phase=None: events.append(phase or 'journal')
    installer.transaction_finish=lambda record: events.append('finish')
    def stage(bundle,digest,manifest,owner,target):
        (target/'launch').write_bytes(b'FAKE-NEW-LAUNCHER')
        (target/'installation.json').write_text('{"version":1}')
    installer.protected_public_stage=stage
    def backup_step(owner,old,new):
        events.append('backup-start')
        if fail_backup: raise OSError('synthetic backup failure')
        result=real_create(owner,old,new)
        events.append('backup-complete')
        return result
    installer.create_upgrade_backup=backup_step
    def swap(first,second):
        events.append('swap')
        assert 'backup-complete' in events
        real_swap(first,second)
    installer.atomic_swap=swap
    with contextlib.redirect_stdout(io.StringIO()):
        action=lambda: installer.install_transaction(root/'public-bundle','f'*64,uid,False)
        if fail_backup: rejected(action)
        else: action()
    assert original_snapshot(installer.DATA)==source_before
    if fail_backup:
        assert 'swap' not in events and 'commit' not in events and events[-1]=='recover'
        assert (installer.INSTALL/'launch').read_bytes()==b'FAKE-OLD-LAUNCHER'
    else:
        assert events.index('backup-complete')<events.index('swap')<events.index('commit')<events.index('finish')
        saved=json.loads((installer.INSTALL/'installation.json').read_text())['upgradeBackup']
        assert saved['dataPreserved'] and pathlib.Path(saved['directory']).exists()
        assert (pathlib.Path(saved['directory'])/'runtime/launch').read_bytes()==b'FAKE-OLD-LAUNCHER'
print('verified synthetic backup only')
`;
    assert.equal(execFileSync("/usr/bin/python3", ["-B", "-I", "-c", python], {
      encoding: "utf8", timeout: 30000,
    }).trim(), "verified synthetic backup only");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("CLI version comparison upgrades old runtimes without downgrading a newer installation", () => {
  const script = `
import assert from 'node:assert/strict';
import { compareRuntimeVersions } from './bin/install-isolation.mjs';
assert.equal(compareRuntimeVersions('2.1.3', '2.1.0'), 1);
assert.equal(compareRuntimeVersions('2.1.3', '2.1.3'), 0);
assert.equal(compareRuntimeVersions('2.1.3', '2.2.0'), -1);
assert.equal(compareRuntimeVersions('2.10.0', '2.9.0'), 1);
for (const invalid of [null, '', 'v2.1.3', '2.1.3-beta', '2.1', '2.1.3/path'])
  assert.throws(() => compareRuntimeVersions('2.1.3', invalid));
`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });
});
