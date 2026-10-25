#requires -Version 5.1
# Temporary synthetic scripts only; no installation, UAC, accounts or tasks.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Install-Abilock.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'The installer has parsing errors.' }
$definitions = @()
foreach ($name in @('Get-BootstrapFailureInfo', 'Get-BootstrapFailureIndex', 'New-BootstrapFailure', 'Get-InstallerFailureLine', 'Write-InstallerFailure', 'Stop-InstallerChildFailure')) {
    $found = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $false))
    if ($found.Count -ne 1) { throw 'A diagnostic function was not found exactly once.' }
    $definitions += $found[0].Extent.Text
}
$traps = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.TrapStatementAst] }, $false))
if ($traps.Count -ne 1) { throw 'Expected one non-secret top-level trap.' }
$mainCatch = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CatchClauseAst] -and $node.Body.Extent.Text.Contains('$installationFailure = $_') }, $false))
if ($mainCatch.Count -ne 1) { throw 'The production failure-preserving catch was not found.' }
$prefix = "`$ErrorActionPreference = 'Stop'`nSet-StrictMode -Version 2.0`n" + ($definitions -join "`n") + "`n" + $traps[0].Extent.Text + "`n"
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('abilock-diagnostic-tests-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temporary) | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
$engine = (Get-Process -Id $PID).Path
$checks = 0
$fakeSecret = 'FAKE_SECRET_MUST_NOT_APPEAR_' + [Guid]::NewGuid().ToString('N')
function Quote([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
function Run-Fixture([string]$Name, [string]$Body) {
    $file = Join-Path $temporary ($Name + '.ps1')
    $text = $prefix + $Body + "`n"
    [IO.File]::WriteAllText($file, $text, $utf8)
    $stdout = Join-Path $temporary ($Name + '.stdout')
    $stderr = Join-Path $temporary ($Name + '.stderr')
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $file + '"'
    $process = Start-Process -FilePath $engine -ArgumentList $arguments -RedirectStandardOutput $stdout -RedirectStandardError $stderr -NoNewWindow -PassThru -Wait
    try {
        if (-not $process.WaitForExit(15000)) { try { $process.Kill() } catch { }; throw 'A synthetic diagnostic process timed out.' }
        $out = [IO.File]::ReadAllText($stdout)
        $err = [IO.File]::ReadAllText($stderr)
        if ($out.Contains($fakeSecret) -or $err.Contains($fakeSecret)) { throw 'An exception message escaped into installer diagnostics.' }
        return [pscustomobject]@{ code = $process.ExitCode; stdout = $out; stderr = $err; path = $file; text = $text }
    } finally { $process.Dispose() }
}
function Assert-OriginalLine($Result, [bool]$RollbackFailure) {
    $lines = $Result.text -split "`r?`n"
    $line = [Array]::IndexOf($lines, 'throw $syntheticFailure') + 1
    if ($line -lt 1 -or $Result.code -ne 200000 + $line -or $Result.stderr -notmatch ('ABILOCK_INSTALL_FAILED line=' + $line + ' type=System.IO.IOException hresult=-?[0-9]+')) {
        throw ('The original diagnostic changed: expected line {0}; exit {1}; safe output {2}' -f $line, $Result.code, $Result.stderr)
    }
    if ($RollbackFailure -ne $Result.stderr.Contains('ABILOCK_INSTALL_ROLLBACK_FAILED:')) { throw 'The rollback failure marker was incorrect.' }
    $script:checks++
}
try {
    $failureSetup = '$syntheticFailure = New-Object IO.IOException(' + (Quote $fakeSecret) + ")`n"
    $top = Run-Fixture 'top' ($failureSetup + 'throw $syntheticFailure')
    Assert-OriginalLine $top $false
    $main = Run-Fixture 'main-catch' ('$journal = $null' + "`n" + $failureSetup + "try {`nthrow `$syntheticFailure`n} " + $mainCatch[0].Extent.Text)
    Assert-OriginalLine $main $false
    $rollbackSetup = '$journal = [pscustomobject]@{ existing = $true }; $installedNew = $true' + "`n" + '$backup = ' + (Quote $temporary) + '; $programRoot = ' + (Quote $temporary) + '; $stage = ' + (Quote $temporary) + "`n"
    $rollback = Run-Fixture 'rollback-failure' ($rollbackSetup + $failureSetup + "try {`nthrow `$syntheticFailure`n} " + $mainCatch[0].Extent.Text)
    Assert-OriginalLine $rollback $true
    foreach ($child in @($top, $main, $rollback)) {
        $childOut = Join-Path $temporary ('child-' + [Guid]::NewGuid().ToString('N') + '.stdout')
        $childErr = Join-Path $temporary ('child-' + [Guid]::NewGuid().ToString('N') + '.stderr')
        $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $child.path + '"'
        $body = '$child = Start-Process -FilePath ' + (Quote $engine) + ' -ArgumentList ' + (Quote $arguments) + ' -RedirectStandardOutput ' + (Quote $childOut) + ' -RedirectStandardError ' + (Quote $childErr) + " -NoNewWindow -PassThru -Wait`nStop-InstallerChildFailure `$child.ExitCode"
        $parent = Run-Fixture ('parent-' + $checks) $body
        $originalLine = $child.code - 200000
        if ($parent.code -ne $child.code -or $parent.stderr -notmatch ('Installation stopped at line ' + $originalLine + '\.')) { throw 'The child failure line did not survive the parent process.' }
        if ([IO.File]::ReadAllText($childErr).Contains($fakeSecret)) { throw 'A child exception message was exposed.' }
        $checks++
    }
    foreach ($code in @(1, -1, 200000, 265536, [int]::MaxValue)) {
        $result = Run-Fixture ('unknown-' + $checks) ('Stop-InstallerChildFailure ' + $code)
        if ($result.code -ne 1 -or $result.stderr -match 'line [0-9]+' -or $result.stderr -notmatch 'The installation process did not complete') { throw 'An unknown child code was decoded as a trusted line.' }
        $checks++
    }
    foreach ($code in @(200001, 265535)) {
        $result = Run-Fixture ('boundary-' + $checks) ('Stop-InstallerChildFailure ' + $code)
        if ($result.code -ne $code -or $result.stderr -notmatch ('line ' + ($code - 200000) + '\.')) { throw 'A bounded diagnostic exit code was not preserved.' }
        $checks++
    }
    foreach ($stage in @(1,3,16)) {
        $body = '$failure = New-Object InvalidOperationException(' + (Quote $fakeSecret) + ")`n" + '$failure.Data[''AbilockNativeStage''] = [int]' + $stage + "`nthrow `$failure"
        $result = Run-Fixture ('native-' + $stage) $body
        if ($result.code -ne 300000 + $stage -or $result.stderr -notmatch ('ABILOCK_INSTALL_FAILED native_stage=' + $stage) -or $result.stderr -match 'line=') { throw 'A bounded native stage was not preserved.' }
        $checks++
        $parent = Run-Fixture ('native-parent-' + $stage) ('Stop-InstallerChildFailure ' + $result.code)
        if ($parent.code -ne $result.code -or $parent.stderr -notmatch ('stage ' + $stage + '\.')) { throw 'A native failure stage did not survive the parent process.' }
        $checks++
    }
    foreach ($code in @(300000,300017)) {
        $result = Run-Fixture ('native-unknown-' + $code) ('Stop-InstallerChildFailure ' + $code)
        if ($result.code -ne 1 -or $result.stderr -match 'stage [0-9]+') { throw 'An unrecognized native stage code was trusted.' }
        $checks++
    }
    foreach ($index in @(1,8,9,16,17,24,25,32,33)) {
        $result = Run-Fixture ('bootstrap-' + $index) ('throw (New-BootstrapFailure ' + $index + ')')
        if ($result.code -ne 400000 + $index -or $result.stderr -notmatch 'ABILOCK_BOOTSTRAP_FAILED stage=[a-z]+ code=[A-Z_]+') { throw 'A bounded bootstrap diagnostic was not preserved.' }
        $checks++
        $parent = Run-Fixture ('bootstrap-parent-' + $index) ('Stop-InstallerChildFailure ' + $result.code)
        if ($parent.code -ne $result.code -or $parent.stderr -notmatch 'ABILOCK_BOOTSTRAP_FAILED stage=[a-z]+ code=[A-Z_]+') { throw 'A bootstrap diagnostic did not survive its parent.' }
        $checks++
    }
    foreach ($code in @(400000,400034)) {
        $result = Run-Fixture ('bootstrap-unknown-' + $code) ('Stop-InstallerChildFailure ' + $code)
        if ($result.code -ne 1 -or $result.stderr -match 'ABILOCK_BOOTSTRAP_FAILED') { throw 'An unknown bootstrap code was trusted.' }
        $checks++
    }
    Write-Output ('ABILOCK_INSTALLER_DIAGNOSTICS_TESTS_OK ' + $checks)
} finally { Remove-Item -LiteralPath $temporary -Recurse -Force }
