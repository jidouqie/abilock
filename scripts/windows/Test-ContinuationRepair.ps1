#requires -Version 5.1
# Synthetic public-file interruptions only. No installed files, tasks or accounts.
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Install-Abilock.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Installer parsing failed.'}
foreach($name in @('Get-ContinuationRepairAction','Assert-NoReparse','Assert-PublicBundleManifest','Assert-RepairPublicTree','Assert-OriginalRepairBackup','Assert-RepairCleanupTree','Assert-PendingRepairBackup','Assert-Initialized','Complete-ContinuationRepairTransition','Get-BootstrapFailureInfo','Get-BootstrapFailureIndex')) {
 $found=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$false))
 if($found.Count -ne 1){throw 'A continuation function is missing.'}
 Invoke-Expression $found[0].Extent.Text
}
$OwnerSid='S-1-5-21-111-222-333-1001';$serviceSid='S-1-5-21-111-222-333-2001';$accountName='_abilock'
$nonce='a'*32;$originHash='b'*64;$previousHash='c'*64;$manifestHash='d'*64;$checks=0
function Equal($Actual,$Expected){if($Actual -cne $Expected){throw 'Unexpected continuation result.'};$script:checks++}
function Reject([scriptblock]$Action){$failed=$false;try{& $Action | Out-Null}catch{$failed=$true};if(-not $failed){throw 'An unsafe continuation was accepted.'};$script:checks++}
function Journal {return [pscustomobject]@{schema=2;existing=$false;nonce=$nonce;ownerSid=$OwnerSid;serviceSid=$serviceSid;phase='new-active';bundleHash=$previousHash;repairSourceBundleHash=$originHash}}
Equal (Get-ContinuationRepairAction (Journal) $previousHash $manifestHash $true $true $false $false) 'move-public'
Equal (Get-ContinuationRepairAction (Journal) $previousHash $manifestHash $false $true $true $false) 'switch-journal'
foreach($state in @(@($false,$true,$false,$false),@($true,$true,$true,$false),@($true,$false,$false,$false),@($true,$true,$false,$true))){Reject {Get-ContinuationRepairAction (Journal) $previousHash $manifestHash $state[0] $state[1] $state[2] $state[3]}}
foreach($field in @('ownerSid','serviceSid','nonce','bundleHash','phase','repairSourceBundleHash')) {
 Reject {$j=Journal;$j.$field='unknown';Get-ContinuationRepairAction $j $previousHash $manifestHash $true $true $false $false}
}
Reject {$j=Journal;$j.existing=$true;Get-ContinuationRepairAction $j $previousHash $manifestHash $true $true $false $false}
Reject {$j=Journal;$j.existing='false';Get-ContinuationRepairAction $j $previousHash $manifestHash $true $true $false $false}
Reject {$j=Journal;$j|Add-Member NoteProperty repairPreviousBundleHash $previousHash;Get-ContinuationRepairAction $j $previousHash $manifestHash $true $true $false $false}
$continued=Journal;$continued.bundleHash=$manifestHash;$continued.phase='account-created';$continued|Add-Member NoteProperty repairPreviousBundleHash $previousHash
Equal (Get-ContinuationRepairAction $continued $previousHash $manifestHash $false $true $true $false) 'resume-repaired'
Equal (Get-ContinuationRepairAction $continued $previousHash $manifestHash $true $true $true $false) 'resume-repaired'
Reject {Get-ContinuationRepairAction $continued $previousHash $manifestHash $false $true $false $false}
Reject {Get-ContinuationRepairAction $continued $previousHash $manifestHash $false $false $true $false}
$continued.phase='new-active';Reject {Get-ContinuationRepairAction $continued $previousHash $manifestHash $false $true $true $false}
$continued.phase='committed';Equal (Get-ContinuationRepairAction $continued $previousHash $manifestHash $true $false $false $true) 'resume-repaired'
Reject {Get-ContinuationRepairAction $continued $previousHash $manifestHash $true $false $false $false}
# Every accepted worker failure maps to constants, including through exit codes.
for($index=1;$index -le 32;$index++) {
 $info=Get-BootstrapFailureInfo $index
 $json=@{ok=$false;event='bootstrap-failed';stage=$info.stage;code=$info.code}|ConvertTo-Json -Compress
 Equal (Get-BootstrapFailureIndex $json) $index
}
foreach($text in @('{"ok":false,"event":["bootstrap-failed"],"stage":"input","code":"BOOTSTRAP_FAILED"}', '', '{}','null','[]','[{"ok":false,"event":"bootstrap-failed","stage":"input","code":"BOOTSTRAP_FAILED"}]','{"ok":false,"event":"bootstrap-failed","stage":"input","code":"UNKNOWN"}','{"ok":false,"event":"bootstrap-failed","stage":"unknown","code":"BOOTSTRAP_FAILED"}','{"ok":false,"event":"bootstrap-failed","stage":"input","code":"BOOTSTRAP_FAILED","secret":"FAKE_SECRET"}','{"ok":false,"ok":false,"event":"bootstrap-failed","stage":"input","code":"BOOTSTRAP_FAILED"}',('x'*4097))) {
 Equal (Get-BootstrapFailureIndex $text) 0
}
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('abilock-continuation-'+[Guid]::NewGuid().ToString('N'))
$programParent=Join-Path $temporary 'programs';$programRoot=Join-Path $programParent 'Abilock'
$backup=Join-Path $programParent ('Abilock.backup-'+$nonce);$intermediate=Join-Path $programParent ('Abilock.repair-'+$nonce)
$journalPath=Join-Path $temporary 'journal.json';$receiptPath=Join-Path $temporary 'initialized.json';$privateCanary=Join-Path $temporary 'private-canary.txt'
$utf8=New-Object Text.UTF8Encoding($false);$failManifest=$false;$failJournal=$false
function Assert-Protected([string]$Path){if(-not [IO.Path]::GetFullPath($Path).StartsWith($temporary+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Test path escaped.'};Assert-NoReparse $Path}
function Read-PublicJson([string]$Path){Assert-Protected $Path;return ([IO.File]::ReadAllText($Path)|ConvertFrom-Json)}
function Write-Json([string]$Path,$Value){if($Path -eq $journalPath -and $script:failJournal){$script:failJournal=$false;throw 'Synthetic journal interruption.'};[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 8),$utf8)}
function Get-BundleManifest([string]$Root,[string]$ExpectedHash,[switch]$SourceOnly){Assert-Protected $Root;$file=Join-Path $Root 'bundle-manifest.json';Assert-Protected $file;if((Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant() -cne $ExpectedHash){throw 'Fixture manifest hash mismatch.'};$value=Read-PublicJson $file;Assert-PublicBundleManifest $Root $value;return $value}
function Write-RepairSourceManifest([string]$Destination){if($script:failManifest){$script:failManifest=$false;throw 'Synthetic source manifest interruption.'};[IO.File]::WriteAllText($Destination,$sourceManifestText,$utf8)}
function New-Tree([string]$Root,[string]$Version) {
 [IO.Directory]::CreateDirectory($Root)|Out-Null
 [IO.File]::WriteAllText((Join-Path $Root 'Abilock.Host.exe'),('synthetic '+$Version),$utf8)
 $value=[pscustomobject]@{version=$Version;architecture='arm64';files=@(@{path='Abilock.Host.exe';sha256=(Get-FileHash -LiteralPath (Join-Path $Root 'Abilock.Host.exe')).Hash.ToLowerInvariant()})}
 Write-Json (Join-Path $Root 'bundle-manifest.json') $value
 Write-Json (Join-Path $Root 'windows-installation.json') @{schema=1;version=$Version;ownerSid=$OwnerSid;serviceSid=$serviceSid;account=$accountName}
 Write-Json (Join-Path $Root '.installation-transaction.json') @{nonce=$nonce}
 return $value
}
try {
 $null=New-Tree $backup '2.2.3';$originHash=(Get-FileHash -LiteralPath (Join-Path $backup 'bundle-manifest.json')).Hash.ToLowerInvariant()
 $originalFileHash=(Get-FileHash -LiteralPath (Join-Path $backup 'Abilock.Host.exe')).Hash
 $repairManifest=New-Tree $programRoot '2.2.6';$sourceManifestText=[IO.File]::ReadAllText((Join-Path $programRoot 'bundle-manifest.json'))
 $previousHash=(Get-FileHash -LiteralPath (Join-Path $programRoot 'bundle-manifest.json')).Hash.ToLowerInvariant();$RepairFromManifestSha256=$previousHash
 [IO.File]::Delete((Join-Path $programRoot 'bundle-manifest.json'))
 $manifest=[pscustomobject]@{version='2.2.7';architecture='arm64';files=@()}
 [IO.File]::WriteAllText($privateCanary,'synthetic private data; do not alter',$utf8);$privateHash=(Get-FileHash -LiteralPath $privateCanary).Hash
 $j=Journal;Write-Json $journalPath $j
 [IO.File]::WriteAllText((Join-Path $programRoot 'unknown.txt'),'preserve unknown content',$utf8)
 Reject {Complete-ContinuationRepairTransition $j 'move-public' $intermediate};Equal (Test-Path -LiteralPath $intermediate) $false
 [IO.File]::Delete((Join-Path $programRoot 'unknown.txt'))
 $failManifest=$true;Reject {Complete-ContinuationRepairTransition $j 'move-public' $intermediate}
 Equal (Test-Path -LiteralPath $programRoot) $false;Equal (Test-Path -LiteralPath (Join-Path $intermediate 'bundle-manifest.json')) $false
 $j=Read-PublicJson $journalPath;Equal $j.bundleHash $previousHash
 Equal (Get-ContinuationRepairAction $j $previousHash $manifestHash $false $true $true $false) 'switch-journal'
 $failJournal=$true;Reject {Complete-ContinuationRepairTransition $j 'switch-journal' $intermediate}
 Equal (Test-Path -LiteralPath (Join-Path $intermediate 'bundle-manifest.json')) $true
 $j=Read-PublicJson $journalPath;Equal $j.bundleHash $previousHash
 $j=Complete-ContinuationRepairTransition $j 'switch-journal' $intermediate
 Equal $j.bundleHash $manifestHash;Equal $j.repairSourceBundleHash $originHash;Equal $j.repairPreviousBundleHash $previousHash
 Equal $j.serviceSid $serviceSid;Equal $j.nonce $nonce;Equal $j.existing $false
 Assert-PendingRepairBackup $j;$checks++
 Equal (Get-FileHash -LiteralPath (Join-Path $backup 'Abilock.Host.exe')).Hash $originalFileHash
 Equal (Get-FileHash -LiteralPath $privateCanary).Hash $privateHash
 [IO.File]::AppendAllText((Join-Path $intermediate 'Abilock.Host.exe'),'tamper',$utf8)
 Reject {Assert-PendingRepairBackup $j}
 [IO.File]::WriteAllText((Join-Path $intermediate 'Abilock.Host.exe'),'synthetic 2.2.6',$utf8)
 $manifest=New-Tree $programRoot '2.2.7'
 $j.phase='committed';Write-Json $receiptPath @{schema=1;initialized=$true;ownerSid=$OwnerSid;serviceSid=$serviceSid}
 Assert-PendingRepairBackup $j;$checks++
 [IO.File]::Delete((Join-Path $intermediate 'Abilock.Host.exe'));Assert-PendingRepairBackup $j;$checks++
 Remove-Item -LiteralPath $intermediate -Recurse -Force;Assert-PendingRepairBackup $j;$checks++
 Remove-Item -LiteralPath $backup -Recurse -Force;Assert-PendingRepairBackup $j;$checks++
 Write-Json $receiptPath @{schema=1;initialized=$true;ownerSid=$serviceSid;serviceSid=$serviceSid};Reject {Assert-PendingRepairBackup $j}
 Equal (Get-FileHash -LiteralPath $privateCanary).Hash $privateHash
 Write-Output ('ABILOCK_CONTINUATION_REPAIR_TESTS_OK '+$checks)
} finally {if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Recurse -Force}}
