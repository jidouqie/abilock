#requires -Version 5.1
# Synthetic files and DPAPI round trip only. No accounts, tasks or installation.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0
if ($PSVersionTable.PSEdition -ne 'Desktop') { throw 'Use the system Windows PowerShell 5.1 host for this installer-support test.' }
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\native\windows\InstallerSupport.cs'))
Add-Type -TypeDefinition ([IO.File]::ReadAllText($source)) -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Security
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('abilock-support-tests-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temporary) | Out-Null
$passed = 0
try {
    $sourceFile = Join-Path $temporary 'source.txt'
    [IO.File]::WriteAllText($sourceFile, 'synthetic public bytes')
    $hash = (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash.ToLowerInvariant()
    $destination = Join-Path $temporary 'copied.txt'
    [AbilockInstallerSupport]::CopyVerified($temporary, $sourceFile, $destination, $hash)
    if ([IO.File]::ReadAllText($destination) -cne 'synthetic public bytes') { throw 'The verified copy lost bytes.' }; $passed++
    $failed = $false
    try { [AbilockInstallerSupport]::CopyVerified($temporary, $sourceFile, (Join-Path $temporary 'bad-hash.txt'), ('0' * 64)) } catch { $failed = $true }
    if (-not $failed -or (Test-Path -LiteralPath (Join-Path $temporary 'bad-hash.txt'))) { throw 'A mismatching hash was not rejected before writing.' }; $passed++
    $subdirectory = Join-Path $temporary 'subdirectory'; [IO.Directory]::CreateDirectory($subdirectory) | Out-Null
    $failed = $false
    try { [AbilockInstallerSupport]::CopyVerified($subdirectory, $sourceFile, (Join-Path $subdirectory 'outside.txt'), $hash) } catch { $failed = $true }
    if (-not $failed) { throw 'A source outside the selected bundle was accepted.' }; $passed++
    New-Item -ItemType HardLink -Path (Join-Path $temporary 'hardlink.txt') -Target $sourceFile | Out-Null
    $failed = $false
    try { [AbilockInstallerSupport]::CopyVerified($temporary, $sourceFile, (Join-Path $temporary 'linked-copy.txt'), $hash) } catch { $failed = $true }
    if (-not $failed) { throw 'A multiply linked source file was accepted.' }; $passed++
    $fake = 'Aa1!' + ('A' * 64)
    $protected = [AbilockInstallerSupport]::ProtectSetupPassword($fake)
    if ($protected.Contains($fake) -or [AbilockInstallerSupport]::UnprotectSetupPassword($protected) -cne $fake) { throw 'Synthetic recovery encryption failed.' }; $passed++
    $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $serviceSid = 'S-1-5-21-111-222-333-9999'
    $metadata = Join-Path $temporary 'windows-installation.json'
    function Assert-MetadataAcl([string]$File, [string]$Reader) {
        $acl = Get-Acl -LiteralPath $File
        if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544') { throw 'Public metadata has an unsafe owner or inherited ACL.' }
        $rules = $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
        if ($rules.Count -ne 4) { throw 'Public metadata has unexpected access entries.' }
        foreach ($rule in $rules) {
            $sid = $rule.IdentityReference.Value
            $expected = if ($sid -in @('S-1-5-18','S-1-5-32-544')) { [Security.AccessControl.FileSystemRights]::FullControl } elseif ($sid -in @($ownerSid,$Reader)) { [Security.AccessControl.FileSystemRights]::Read } else { throw 'Public metadata grants an unexpected identity.' }
            $mask = -bnot [int][Security.AccessControl.FileSystemRights]::Synchronize
            if ($rule.AccessControlType -ne 'Allow' -or (([int]$rule.FileSystemRights -band $mask) -ne ([int]$expected -band $mask))) { throw 'A metadata reader received write permissions.' }
        }
        $script:passed++
    }
    [AbilockInstallerSupport]::WriteAtomicFile($metadata, '{"fixture":"legacy"}')
    $legacyAcl = Get-Acl -LiteralPath $metadata
    if (-not $legacyAcl.AreAccessRulesProtected -or $legacyAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]).Count -ne 2) { throw 'The administrator-only writer inherited ordinary-user access.' }; $passed++
    [AbilockInstallerSupport]::WritePublicMetadata($metadata, '{"fixture":"replacement"}', $ownerSid, $serviceSid)
    Assert-MetadataAcl $metadata $serviceSid
    if ([IO.File]::ReadAllText($metadata) -cne '{"fixture":"replacement"}') { throw 'Public metadata replacement lost bytes.' }; $passed++
    $otherServiceSid = 'S-1-5-21-111-222-333-9998'
    [AbilockInstallerSupport]::WritePublicMetadata($metadata, '{"fixture":"second"}', $ownerSid, $otherServiceSid)
    Assert-MetadataAcl $metadata $otherServiceSid
    $failed = $false
    try { [AbilockInstallerSupport]::WritePublicMetadata((Join-Path $temporary 'account.json'), 'fake-secret', $ownerSid, $serviceSid) } catch { $failed = $true }
    if (-not $failed -or (Test-Path -LiteralPath (Join-Path $temporary 'account.json'))) { throw 'The public writer accepted a private metadata name.' }; $passed++
    $failed = $false
    try { [AbilockInstallerSupport]::WritePublicMetadata($metadata, 'fake-secret', $ownerSid, $ownerSid) } catch { $failed = $true }
    if (-not $failed -or [IO.File]::ReadAllText($metadata) -cne '{"fixture":"second"}') { throw 'The public writer accepted overlapping identities or changed an existing record.' }; $passed++
    Write-Output ('ABILOCK_SUPPORT_TESTS_OK ' + $passed)
} finally { Remove-Item -LiteralPath $temporary -Recurse -Force }
