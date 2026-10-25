#requires -Version 5.1
# Pure decisions and temporary synthetic public files. No accounts, tasks,
# installed data, or ACL isolation claims are involved in this test.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Install-Abilock.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'The installer has parsing errors.' }
foreach ($name in @('Get-PendingRepairAction','Get-ContinuationRepairAction','Get-ResumeInstallationPhase','Assert-NoReparse','Assert-PublicBundleManifest','Assert-RepairPublicTree','Assert-OriginalRepairBackup','Assert-RepairCleanupTree','Assert-PendingRepairBackup','Assert-Initialized','Complete-PendingRepairTransition','Get-NativeFailureStage')) {
    $found = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $false))
    if ($found.Count -ne 1) { throw 'A repair function was not found exactly once.' }
    Invoke-Expression $found[0].Extent.Text
}
$OwnerSid = 'S-1-5-21-111-222-333-1001'
$serviceSid = 'S-1-5-21-111-222-333-2001'
$accountName = '_abilock'
$originalHash = 'b' * 64; $manifestHash = 'c' * 64
$checks = 0
function Journal {
    return [pscustomobject]@{ schema=2; existing=$false; nonce=('a'*32); ownerSid=$OwnerSid; serviceSid=$serviceSid; phase='new-active'; bundleHash=$originalHash }
}
function Equal($Actual, $Expected) { if ($Actual -cne $Expected) { throw 'A repair result was incorrect.' }; $script:checks++ }
function Reject([scriptblock]$Action) { $failed=$false; try { & $Action | Out-Null } catch { $failed=$true }; if (-not $failed) { throw 'An unsafe pending repair was accepted.' }; $script:checks++ }
Equal (Get-PendingRepairAction (Journal) $originalHash $manifestHash $true $false $false) 'move-public'
Equal (Get-PendingRepairAction (Journal) $originalHash $manifestHash $false $true $false) 'switch-journal'
Reject { Get-PendingRepairAction (Journal) $originalHash $manifestHash $false $false $false }
Reject { Get-PendingRepairAction (Journal) $originalHash $manifestHash $true $true $false }
Reject { Get-PendingRepairAction (Journal) $originalHash $manifestHash $true $false $true }
Reject { $bad=Journal; $bad.existing=$true; Get-PendingRepairAction $bad $originalHash $manifestHash $true $false $false }
Reject { $bad=Journal; $bad.existing='false'; Get-PendingRepairAction $bad $originalHash $manifestHash $true $false $false }
Reject { $bad=Journal; $bad.ownerSid=$serviceSid; Get-PendingRepairAction $bad $originalHash $manifestHash $true $false $false }
Reject { $bad=Journal; $bad.serviceSid=$OwnerSid; Get-PendingRepairAction $bad $originalHash $manifestHash $true $false $false }
Reject { $bad=Journal; $bad.nonce='../unknown'; Get-PendingRepairAction $bad $originalHash $manifestHash $true $false $false }
Reject { $bad=Journal; $bad.schema=1; Get-PendingRepairAction $bad $originalHash $manifestHash $true $false $false }
Reject { $bad=Journal; $bad.phase='prepared'; Get-PendingRepairAction $bad $originalHash $manifestHash $true $false $false }
Reject { $bad=Journal; $bad.bundleHash='d'*64; Get-PendingRepairAction $bad $originalHash $manifestHash $true $false $false }
Reject { Get-PendingRepairAction (Journal) $originalHash $originalHash $true $false $false }
$repaired=Journal; $repaired.bundleHash=$manifestHash; $repaired.phase='account-created'
$repaired | Add-Member NoteProperty repairSourceBundleHash $originalHash
Equal (Get-PendingRepairAction $repaired $originalHash $manifestHash $false $true $false) 'resume-repaired'
Equal (Get-PendingRepairAction $repaired $originalHash $manifestHash $true $true $false) 'resume-repaired'
Reject { Get-PendingRepairAction $repaired $originalHash $manifestHash $false $false $false }
Reject { $bad=$repaired.PSObject.Copy(); $bad.repairSourceBundleHash='d'*64; Get-PendingRepairAction $bad $originalHash $manifestHash $false $true $false }
$committed=$repaired.PSObject.Copy(); $committed.phase='committed'
Equal (Get-PendingRepairAction $committed $originalHash $manifestHash $true $false $true) 'resume-repaired'
Reject { Get-PendingRepairAction $committed $originalHash $manifestHash $true $false $false }
Reject { Get-PendingRepairAction $committed $originalHash $manifestHash $false $true $true }
Equal (Get-ResumeInstallationPhase $committed $true 'account-created') 'committed'
Equal (Get-ResumeInstallationPhase $committed $true 'new-active') 'committed'
Equal (Get-ResumeInstallationPhase $committed $true 'initialized') 'committed'
$initialized=$repaired.PSObject.Copy(); $initialized.phase='initialized'
Equal (Get-ResumeInstallationPhase $initialized $true 'account-created') 'initialized'
Equal (Get-ResumeInstallationPhase (Journal) $false 'account-created') 'account-created'
foreach ($stage in @(1,3,9,16)) { Equal (Get-NativeFailureStage ('ABILOCK_ISOLATION_FAILED stage='+$stage+' hresult=-2146233087')) $stage }
Equal (Get-NativeFailureStage "ABILOCK_ISOLATION_FAILED stage=7 hresult=0`r`n") 7
foreach ($line in @('ABILOCK_ISOLATION_FAILED stage=17 hresult=0','ABILOCK_ISOLATION_FAILED stage=3 hresult=2147483648','ABILOCK_ISOLATION_FAILED stage=3 hresult=-2147483649','ABILOCK_ISOLATION_FAILED stage=03 hresult=0','ABILOCK_ISOLATION_FAILED stage=3 hresult=0 secret=FAKE',"ABILOCK_ISOLATION_FAILED stage=3 hresult=0`nFAKE",'untrusted text')) { Equal (Get-NativeFailureStage $line) 0 }
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('abilock-pending-repair-tests-'+[Guid]::NewGuid().ToString('N'))
$programParent=Join-Path $temporary 'programs'
$programRoot=Join-Path $programParent 'Abilock'
$backup=Join-Path $programParent ('Abilock.backup-'+('a'*32))
$journalPath=Join-Path $temporary 'journal.json'
$receiptPath=Join-Path $temporary 'initialized.json'
$privateCanary=Join-Path $temporary 'private-canary.txt'
$utf8=New-Object Text.UTF8Encoding($false)
# The production ACL and native atomic-write helper have separate tests.
# These substitutes constrain this suite to its temporary synthetic tree.
function Assert-Protected([string]$Path) {
    if (-not [IO.Path]::GetFullPath($Path).StartsWith($temporary+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Test path escaped its temporary directory.' }
    Assert-NoReparse $Path
}
function Read-PublicJson([string]$Path) { Assert-Protected $Path; return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json) }
$failNextJournal=$false
function Write-Json([string]$Path, $Value) {
    if ($Path -eq $journalPath -and $script:failNextJournal) { $script:failNextJournal=$false; throw 'Synthetic interruption before the atomic journal switch.' }
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 8), $utf8)
}
function Write-RepairSourceManifest([string]$Destination) { [IO.File]::WriteAllText($Destination,$sourceManifestText,$utf8) }
try {
    [IO.Directory]::CreateDirectory($programRoot) | Out-Null
    [IO.File]::WriteAllText((Join-Path $programRoot 'Abilock.Host.exe'),'synthetic public executable',$utf8)
    [IO.File]::WriteAllText($privateCanary,'synthetic private data remains unchanged',$utf8)
    $privateHash=(Get-FileHash -LiteralPath $privateCanary).Hash
    $entry=@{ path='Abilock.Host.exe'; sha256=(Get-FileHash -LiteralPath (Join-Path $programRoot 'Abilock.Host.exe')).Hash.ToLowerInvariant() }
    $repairManifest=[pscustomobject]@{version='2.2.3';files=@($entry)}
    $sourceManifestText=$repairManifest | ConvertTo-Json -Depth 8
    $digest=[Security.Cryptography.SHA256]::Create()
    try { $originalHash=([BitConverter]::ToString($digest.ComputeHash($utf8.GetBytes($sourceManifestText)))).Replace('-','').ToLowerInvariant() } finally { $digest.Dispose() }
    $RepairFromManifestSha256=$originalHash
    $pending=Journal
    Write-Json $journalPath $pending
    Write-Json (Join-Path $programRoot 'windows-installation.json') @{schema=1;version='2.2.3';ownerSid=$OwnerSid;serviceSid=$serviceSid;account=$accountName}
    Write-Json (Join-Path $programRoot '.installation-transaction.json') @{nonce=$pending.nonce}
    [IO.File]::WriteAllText((Join-Path $programRoot 'unknown.txt'),'keep unknown content',$utf8)
    Reject { Complete-PendingRepairTransition $pending 'move-public' $backup }
    Equal (Test-Path -LiteralPath (Join-Path $programRoot 'unknown.txt')) $true
    [IO.File]::Delete((Join-Path $programRoot 'unknown.txt'))
    [IO.Directory]::CreateDirectory((Join-Path $programRoot 'unknown-directory')) | Out-Null
    Reject { Complete-PendingRepairTransition $pending 'move-public' $backup }
    Equal (Test-Path -LiteralPath (Join-Path $programRoot 'unknown-directory')) $true
    [IO.Directory]::Delete((Join-Path $programRoot 'unknown-directory'))
    [IO.File]::WriteAllText((Join-Path $programRoot 'bundle-manifest.json'),'unexpected manifest',$utf8)
    Reject { Complete-PendingRepairTransition $pending 'move-public' $backup }
    Equal (Test-Path -LiteralPath $programRoot) $true
    Equal (Test-Path -LiteralPath $backup) $false
    [IO.File]::Delete((Join-Path $programRoot 'bundle-manifest.json'))
    $failNextJournal=$true
    Reject { Complete-PendingRepairTransition $pending 'move-public' $backup }
    Equal (Test-Path -LiteralPath $programRoot) $false
    Equal (Test-Path -LiteralPath (Join-Path $backup 'Abilock.Host.exe')) $true
    $reloaded=Read-PublicJson $journalPath
    Equal $reloaded.bundleHash $originalHash
    Equal (Get-PendingRepairAction $reloaded $originalHash $manifestHash $false $true $false) 'switch-journal'
    $finished=Complete-PendingRepairTransition $reloaded 'switch-journal' $backup
    Equal $finished.bundleHash $manifestHash
    Equal $finished.phase 'account-created'
    Equal $finished.serviceSid $serviceSid
    Equal $finished.nonce ('a'*32)
    Equal $finished.existing $false
    Equal (Get-FileHash -LiteralPath $privateCanary).Hash $privateHash
    Equal (Get-PendingRepairAction $finished $originalHash $manifestHash $false $true $false) 'resume-repaired'
    [IO.File]::AppendAllText((Join-Path $backup 'Abilock.Host.exe'),'tampered',$utf8)
    Reject { Assert-RepairPublicTree $backup $repairManifest $finished }
    # A committed repair can resume interrupted cleanup even after part or all
    # of the old public backup has been removed. The new active tree and the
    # initialization receipt must still agree with the protected journal.
    [IO.Directory]::CreateDirectory($programRoot) | Out-Null
    [IO.File]::WriteAllText((Join-Path $programRoot 'Abilock.Host.exe'),'synthetic corrected executable',$utf8)
    $manifest=[pscustomobject]@{version='2.2.6';files=@(@{path='Abilock.Host.exe';sha256=(Get-FileHash -LiteralPath (Join-Path $programRoot 'Abilock.Host.exe')).Hash.ToLowerInvariant()})}
    Write-Json (Join-Path $programRoot 'windows-installation.json') @{schema=1;version='2.2.6';ownerSid=$OwnerSid;serviceSid=$serviceSid;account=$accountName}
    Write-Json (Join-Path $programRoot '.installation-transaction.json') @{nonce=$finished.nonce}
    Write-Json $receiptPath @{schema=1;initialized=$true;ownerSid=$OwnerSid;serviceSid=$serviceSid}
    $finished.phase='committed'
    [IO.File]::Delete((Join-Path $backup 'Abilock.Host.exe'))
    [IO.File]::Delete((Join-Path $backup 'bundle-manifest.json'))
    Assert-PendingRepairBackup $finished; $checks++
    Equal (Get-ResumeInstallationPhase $finished $true 'account-created') 'committed'
    Remove-Item -LiteralPath $backup -Recurse -Force
    Assert-PendingRepairBackup $finished; $checks++
    Equal (Get-ResumeInstallationPhase $finished $true 'new-active') 'committed'
    Write-Json $receiptPath @{schema=1;initialized=$true;ownerSid=$serviceSid;serviceSid=$serviceSid}
    Reject { Assert-PendingRepairBackup $finished }
    Equal (Get-FileHash -LiteralPath $privateCanary).Hash $privateHash
    Write-Output ('ABILOCK_PENDING_REPAIR_TESTS_OK '+$checks)
} finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force } }
