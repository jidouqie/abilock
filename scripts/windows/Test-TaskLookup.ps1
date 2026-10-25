#requires -Version 5.1
# Read-only scheduler lookups plus in-memory exceptions. No task registration.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Install-Abilock.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'The installer has parsing errors.' }
foreach ($name in @('Test-MissingTaskObject', 'Get-TaskFolderIfPresent', 'Get-TaskIfPresent')) {
    $definitions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $false))
    if ($definitions.Count -ne 1) { throw 'The scheduler lookup function was not found exactly once.' }
    Invoke-Expression $definitions[0].Extent.Text
}
if (-not ('AbilockSyntheticTaskLookup' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
public sealed class AbilockSyntheticTaskLookup {
    public string Mode;
    public object GetFolder(string name) { return Lookup(); }
    public object GetTask(string name) { return Lookup(); }
    private object Lookup() {
        switch (Mode) {
            case "file": throw new FileNotFoundException("Synthetic missing file");
            case "directory": throw new DirectoryNotFoundException("Synthetic missing path");
            case "com-file": throw new COMException("Synthetic missing object", unchecked((int)0x80070002));
            case "com-path": throw new COMException("Synthetic missing path", unchecked((int)0x80070003));
            case "wrapped-file": throw new TargetInvocationException(new FileNotFoundException("Synthetic missing object"));
            case "wrapped-com": throw new TargetInvocationException(new COMException("Synthetic missing object", unchecked((int)0x80070002)));
            case "access": throw new UnauthorizedAccessException("Synthetic access denial");
            case "com-access": throw new COMException("Synthetic access denial", unchecked((int)0x80070005));
            case "rpc": throw new COMException("Synthetic RPC failure", unchecked((int)0x800706ba));
            case "other-facility": throw new COMException("Synthetic non-Win32 failure", unchecked((int)0x80040002));
            case "misleading-inner": throw new UnauthorizedAccessException("Synthetic access denial", new FileNotFoundException("Unrelated inner exception"));
            case "invalid": throw new InvalidOperationException("Synthetic invalid operation");
            default: return this;
        }
    }
}
'@
}
$checks = 0
$fake = New-Object AbilockSyntheticTaskLookup
foreach ($function in @('Get-TaskFolderIfPresent', 'Get-TaskIfPresent')) {
    foreach ($mode in @('file', 'directory', 'com-file', 'com-path', 'wrapped-file', 'wrapped-com')) {
        $fake.Mode = $mode
        if ($null -ne (& $function $fake 'unused')) { throw 'A missing scheduler object was not returned as absent.' }
        $checks++
    }
    foreach ($mode in @('access', 'com-access', 'rpc', 'other-facility', 'misleading-inner', 'invalid')) {
        $fake.Mode = $mode
        $rejected = $false
        try { $null = & $function $fake 'unused' } catch { $rejected = $true }
        if (-not $rejected) { throw 'A scheduler access or transport failure was swallowed as absence.' }
        $checks++
    }
    $fake.Mode = 'present'
    if (-not [Object]::ReferenceEquals((& $function $fake 'unused'), $fake)) { throw 'An existing scheduler object was not retained.' }
    $checks++
}
$scheduler = New-Object -ComObject 'Schedule.Service'
$folder = $null
try {
    $scheduler.Connect()
    $missing = 'Abilock-ReadOnlyLookup-' + [Guid]::NewGuid().ToString('N')
    if ($null -ne (Get-TaskFolderIfPresent $scheduler ('\' + $missing))) { throw 'An unexpected synthetic folder exists.' }
    $checks++
    if ($null -ne (Get-TaskFolderIfPresent $scheduler ('\' + $missing + '\child'))) { throw 'An unexpected synthetic child folder exists.' }
    $checks++
    $folder = Get-TaskFolderIfPresent $scheduler '\'
    if ($null -eq $folder) { throw 'The existing scheduler root was not found.' }
    $checks++
    if ($null -ne (Get-TaskIfPresent $folder $missing)) { throw 'An unexpected synthetic task exists.' }
    $checks++
} finally {
    foreach ($value in @($folder, $scheduler)) {
        if ($null -ne $value -and [Runtime.InteropServices.Marshal]::IsComObject($value)) {
            [Runtime.InteropServices.Marshal]::FinalReleaseComObject($value) | Out-Null
        }
    }
}
Write-Output ('ABILOCK_TASK_LOOKUP_TESTS_OK ' + $checks)
