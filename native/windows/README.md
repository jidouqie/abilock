# Windows runtime

The Windows runtime uses a dedicated local account and fixed Task Scheduler
actions. There are no automatic triggers and no Abilock Windows service. Each
CLI invocation starts a separate task, worker, and contained Node process. All
of these exit when the call ends. The operating system's existing Task Scheduler
service is not an Abilock background process.

The protected program is `%ProgramFiles%\Abilock`; private data is
`%ProgramData%\Abilock\private`. The ordinary owner can read and execute the
program but cannot change it, read private data, alter scheduled tasks, or obtain
the dedicated account password. The installer generates the account password
internally and gives it directly to Task Scheduler. Interrupted initial setup
can resume using a temporary machine-DPAPI-encrypted recovery record in an
administrator/System-only directory; that record is deleted at commit. The
password is never a CLI option, environment variable, or log entry. The task uses password
logon because S4U does not provide the network access required by API calls.

`Abilock.Host.exe client execute` and `client config` use the same public JSON
frames as the macOS launcher. Each client creates a random named pipe whose DACL
allows only the owner, dedicated account, and SYSTEM. The task arguments contain
only a closed operation name and a 64-character nonce. The worker checks the
pipe object's kernel owner and ACL. Before forwarding any request, the client
queries the pipe peer's kernel token and requires the dedicated SID. The worker
connects at **Identification** level, so
the caller cannot impersonate the worker account. No arbitrary path, Node flag,
environment, executable, or command line can be supplied to the scheduled task.

The fixed Node child is created suspended, assigned to a kill-on-close Job
Object, and only then resumed. EOF closes the child's input. A bounded shutdown
terminates that job if necessary. The worker drains output before closing the
pipe, including the final response. Concurrent calls have separate pipes and
jobs; Task Scheduler uses parallel instances.

Since 2.2.8, each incoming pipe chunk is flushed to the Node child's buffered
stdin immediately. A caller can keep stdin open while awaiting its response;
small requests no longer wait for EOF. The native self-test sends a fixed small
frame through a real Windows named pipe and child stdin, and requires an answer
before closing the sender. A separate synthetic probe with only the flush
removed fails this check with exit code 24; the corrected host exits with 0.
Both tests use a dedicated temporary profile and no real credentials.

Git is included using the SHA-pinned official MinGit distribution for the
selected x64 or ARM64 architecture. The program uses only the protected
`git/cmd/git.exe`, fixed executable search directories, and fixed Git exec path;
the user's Git installation, PATH, global configuration, credential helpers,
SSH configuration and hooks are not used. HTTPS credentials stay in the Node
broker. SSH uses the fixed `Abilock.GitSsh.exe` byte-stream bridge, which receives
no upstream credential; a private, per-operation capability authorizes only the
selected Git upload-pack or receive-pack service over a random loopback port.
Each Git call closes its temporary bridge and removes the capability file.
The MinGit archive retains its upstream license notices and bundled dependencies.
The pinned release and its corresponding sources are linked in
`scripts/windows/git-runtime.json`.

`check-private PATH` and `file-lock PATH` are internal helpers. Both require the
dedicated SID and fixed installation. Paths are restricted to the private tree;
reparse points, alternate streams and multiply linked files are rejected. A
Windows lock helper holds a `FileShare.None` handle until stdin closes. It exists
only for the owning operation and exits on owner failure. File-lock contention
returns exit code 75; success writes exactly `LOCKED\n`. ACL validation writes
exactly `OK\n` and never reads file contents.
`check-public PATH` similarly verifies fixed program-tree paths and their
ancestor ACLs before Windows Git starts; it cannot inspect a private path or
execute a supplied file.

Initial setup creates a temporary administrator-only Bootstrap task. An English
password window collects the configuration password and passes it through stdin
and an administrator/System/dedicated-SID pipe. This also supports a standard
user authorizing installation with another administrator account; daily calls
remain bound to the original user's SID. The Bootstrap task is removed after success. Upgrades
disable new task starts, refuse active calls, swap only public program files,
and preserve the account SID and all private data. A protected journal records
the public swap so an interrupted upgrade can restore the previous program.
Unknown or incomplete private state is retained and requires recovery; it is
never silently reinitialized.

Version 2.2.4 passes explicit `SecurityIdentifier` objects into named-pipe ACL rules. SID text must not use the account-name overload. Native self-tests construct the actual ACL and create temporary pipes. Failure diagnostics contain only a closed stage number and numeric HRESULT.

The optional pending-setup repair accepts a verified interrupted 2.2.3 or 2.2.6 setup and a verified 2.2.7 replacement. `-RepairFromBundle` and `-RepairFromManifestSha256` accompany the new bundle/hash. Under the existing installation lock, the installer checks the original identity, journal, public files and idle tasks, retains a protected public backup, and continues the same dedicated account and private data. It is not a password reset or an unknown-installation adoption path. Continuing an interrupted 2.2.6 repair additionally verifies and retains the original protected 2.2.3 backup. The current 2.2.6 public tree moves to a separate nonce-bound intermediate backup; its source hash is added to the same atomic journal without changing the original source hash, nonce, owner or service SID. Interrupted directory moves, source-manifest writes and journal switches resume only after both public trees are verified. After the replacement initializes and validates, commit cleanup can resume even if deletion of either verified public backup was interrupted.

The scripts use ASCII text and PowerShell 5.1 syntax, with no profile dependency,
PowerShell 7-only operators, localized account names, plaintext credential
arguments, or vendor keys. The mutation phase always uses the in-box Windows
PowerShell 5.1 host, including when launched from PowerShell 7.6 or later; an
already elevated process does not trigger a second UAC prompt. Test both Windows PowerShell 5.1 and PowerShell 7.6.
Newer PowerShell versions are a compatibility target, not a claim of testing
unknown future releases. The fixed native host and desktop use the system .NET
Framework: x64 requires 4.8 or later on Windows 10+, and ARM64 requires 4.8.1 or
later on Windows 11+. Preflight checks the native OS architecture and installed
framework release before UAC. It does not install a framework or change system
policy. The desktop also requires Microsoft Edge WebView2 Runtime.

After installation, the original caller registers the bundled skill in its own
Codex and Claude directories. An elevated original caller first impersonates its
linked limited token; lack of an ordinary token fails closed. Another account
used only for UAC cannot receive the user's skills. Existing unrelated skills
and reparse points are rejected. Identical content is left alone; older Abilock
skills are retained outside discovery directories under each tool's
`abilock-skill-backups` directory.

Build order:

1. Build the public runtime and install its production dependencies on Windows.
2. Run `scripts/windows/Build-Windows.ps1`.
3. Build the desktop app in `native/desktop/windows`.
4. Run `scripts/windows/Prepare-Windows.ps1` with those two input directories.
5. Run `Install-Abilock.ps1 -BundlePath BUNDLE -Check`, then install that same
   verified bundle. Installation requests UAC once when necessary.
6. Run the Windows tests under both supported PowerShell families. On a test
   machine also verify fake-key isolation, API completion, simultaneous calls,
   cancellation, child cleanup, and interrupted-upgrade recovery.

Source and static checks on macOS do not prove Windows kernel enforcement.
The installer and its reviewed bundle are trusted. Bundle hashes detect changed
files; they do not provide publisher authentication. Administrator rights,
authorized configuration-page control, and a malicious trusted upstream are
outside the credential-isolation boundary.

Primary references:

- [Task registration and password/S4U logon](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskfolder-registertaskdefinition)
- [Task security hardening](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-security-hardening)
- [Task parameters](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/nf-taskschd-iregisteredtask-run)
- [Named pipe impersonation controls](https://learn.microsoft.com/en-us/windows/win32/ipc/impersonating-a-named-pipe-client)

Windows 2.2.5 creates public installation metadata with administrator/System full access and explicit owner/service SID read access. Private setup records keep administrator-only ACLs. An ordinary paired repair may defer only an inaccessible legacy metadata record until the elevated validation; bundle, architecture and parent checks still run before UAC.

The clean client, desktop and worker environments include SystemDrive derived from the known Windows directory, never the caller's SystemDrive value. Windows known-folder expansion requires it. Native child tests verify known folders before declaring readiness.

Bootstrap failures use only four fixed stages and eight fixed public error codes. The installer accepts exactly the bounded failure schema, maps it to reserved numeric child exit codes, and reconstructs a fixed diagnostic in the original user process. Empty, malformed or unrecognized responses become `response/BOOTSTRAP_RESPONSE`; no error message, response body, password, path or stack is printed.

`scripts/windows/Test-BootstrapRuntime.ps1` runs the complete initial password
transaction against a temporary public runtime copy, using fake passwords and
the desktop owner's ordinary token. Its reusable fixture instructions are in
`scripts/windows/bootstrap-fixture/README.md`. On Windows 11 ARM64, the 2.2.7
runtime passed all nine checks: empty and protected-AppData initialization,
reopening state, unsafe/incomplete directory rejection, repeated initialization,
real Windows lock contention, and two-process initialization without resetting
the password or master key. The test task, fixture and child processes exited
and were removed. Its report is
`artifacts/windows-20261022/bootstrap-runtime-2.2.7-result.json`.

These tests keep the transaction modules unchanged and redirect only their
Windows-path helper dependency to a native helper restricted to the temporary
fixture. They exercise real Windows ACLs and locks with a same-user SID; they do
not replace installed dedicated-SID isolation, UAC, the password window, or
production bootstrap pipe acceptance.
