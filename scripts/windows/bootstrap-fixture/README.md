# Windows bootstrap transaction regression

Run `Test-BootstrapRuntime.ps1` from an authorized administrative session of the
desktop owner, while that owner is signed in interactively. The test itself runs
with the owner's ordinary token in a temporary, triggerless task.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Test-BootstrapRuntime.ps1 -RuntimeDirectory "C:\Users\example\AppData\Local\Temp\abilock-test-runtime" -NodePath "C:\Users\example\AppData\Local\Temp\abilock-test-node\node.exe"
```

Prepare a public runtime copy containing the built `dist` tree (including
`dist/request-limits.json`), package metadata, and installed dependencies. Use a
public copy of the supported Node executable. Real Abilock installation paths
are rejected. The optional `FixtureParent` must be within the current owner's
known `LocalApplicationData\Temp` directory; its ancestors must not be reparse
points.

The test creates fresh ACL fixtures and uses fake passwords only. It exercises
the unmodified `local-state`, `isolation-bootstrap`, `store`, `process-lock`, and
`platform-files` modules. A loader redirects only `windows-paths` to a fixed,
test-only native helper compiled for the new fixture directory. Generated maps,
binaries, and fixture data stay in that temporary directory.

Checks cover initial password setup, protected preexisting `AppData`, reopening
state, rejection of an `AppData` file or broad ACL, incomplete existing data,
nonempty temporary directories, repeat initialization, real Windows file-lock
contention, and concurrent initialization without changing the existing password
or master key. Passwords and key material are never included in the report.

The script removes only its own task, task folder, and verified temporary tree.
If a test process remains, it preserves the tree and fails instead of reporting
successful cleanup. A JSON report remains beside the temporary tree.

This is a same-user SID fixture with real Windows ACL and file-lock behavior.
It does not prove production service-SID isolation, the installer password
window, or the production bootstrap named-pipe exchange. Those require separate
installed-system acceptance.
