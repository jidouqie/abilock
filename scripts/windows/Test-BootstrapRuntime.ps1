#requires -Version 5.1
# Windows integration test only. Uses fake passwords, fresh temp ACL fixtures,
# a same-user native helper, and one temporary ordinary InteractiveToken task.
# It never reads or changes a real Abilock installation or private directory.
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$RuntimeDirectory,
 [Parameter(Mandatory=$true)][string]$NodePath,
 [string]$FixtureParent=([IO.Path]::GetTempPath())
)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
Set-StrictMode -Version 2.0
$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$sid=$identity.User.Value
if(-not (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Synthetic ACL setup requires the authorized same-owner administrative test session.'}
if($sid -notmatch '^S-1-5-21-[0-9-]+$'){throw 'Use an ordinary desktop account that has an interactive logon session.'}
$runtime=[IO.Path]::GetFullPath($RuntimeDirectory);$node=[IO.Path]::GetFullPath($NodePath);$parent=[IO.Path]::GetFullPath($FixtureParent)
function Assert-NoReparse([string]$Path){
 $current=[IO.Path]::GetFullPath($Path)
 while($current){if(([IO.File]::GetAttributes($current)-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'Synthetic test inputs must not use reparse points.'};$current=[IO.Path]::GetDirectoryName($current)}
}
$userTemp=[IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp')).TrimEnd('\')
if($parent.TrimEnd('\') -ine $userTemp -and -not $parent.StartsWith($userTemp+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'FixtureParent must be inside this users known LocalApplicationData Temp directory.'}
foreach($protected in @((Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Abilock'),(Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Abilock'))){
 foreach($inputPath in @($parent,$runtime,$node)){if($inputPath -ieq $protected -or $inputPath.StartsWith($protected+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Real Abilock installation paths are not accepted by this synthetic fixture.'}}
}
foreach($inputPath in @($parent,$runtime,$node)){Assert-NoReparse $inputPath}
$nonce=[Guid]::NewGuid().ToString('N');$root=Join-Path $parent ('abilock-bootstrap-runtime-'+$nonce)
$cases=Join-Path $root 'cases';$tools=Join-Path $root 'tools';$results=Join-Path $root 'results'
$report=Join-Path $parent ('abilock-bootstrap-runtime-report-'+$nonce+'.json')
$taskFolder='Abilock-BootstrapTest-'+$nonce
$utf8=New-Object Text.UTF8Encoding($false)
$fixtureSource=Join-Path $PSScriptRoot 'bootstrap-fixture'
function Set-CaseAcl([string]$Path,[string]$Rights,[switch]$Wide){
 if($Path -ine $root -and -not $Path.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'The synthetic ACL target escaped its fresh directory.'}
 $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false)
 $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
 foreach($who in @('S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($who)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}
 $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),$Rights,'ContainerInherit,ObjectInherit','None','Allow')))
 if($Wide){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')))}
 Set-Acl -LiteralPath $Path -AclObject $acl
}
function New-Directory([string]$Path){[IO.Directory]::CreateDirectory($Path)|Out-Null}
function Write-PublicJson([string]$Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 10),$utf8)}
function Missing-TaskObject([Exception]$ErrorValue){
 while($ErrorValue -is [Management.Automation.MethodInvocationException] -or $ErrorValue -is [Reflection.TargetInvocationException]){if(-not $ErrorValue.InnerException){return $false};$ErrorValue=$ErrorValue.InnerException}
 return $ErrorValue.HResult -eq -2147024894 -or $ErrorValue.HResult -eq -2147024893
}
if((Test-Path -LiteralPath $root)-or -not(Test-Path -LiteralPath $runtime -PathType Container)-or -not(Test-Path -LiteralPath $node -PathType Leaf)){throw 'The integration fixture inputs are invalid.'}
$coreHashes=@()
foreach($name in @('local-state.js','isolation-bootstrap.js','store.js','process-lock.js','platform-files.js')){
 $file=Join-Path $runtime ('dist\src\'+$name);Assert-NoReparse $file
 $coreHashes += [ordered]@{path=$file;sha256=(Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()}
}
$held=@();$scheduler=$null;$folder=$null;$parentFolder=$null;$task=$null;$instance=$null
$createdFolder=$false;$taskRemoved=$false;$folderRemoved=$false;$fixtureRemoved=$false;$processesExited=$false;$remainingProcesses=@();$check=$null;$failure=$null
try{
 New-Directory $root;Set-CaseAcl $root 'ReadAndExecute'
 [IO.File]::WriteAllText((Join-Path $root 'fixture.marker'),'Abilock synthetic bootstrap runtime',$utf8)
 foreach($name in @('cases','tools','results','tmp','helper-profile')){New-Directory (Join-Path $root $name);Set-CaseAcl (Join-Path $root $name) $(if($name -in @('cases','tools')){'ReadAndExecute'}else{'FullControl'})}
 foreach($name in @('baseline','appdata','appdata-file','appdata-wide','existing-data','dirty-tmp','concurrent','lock-check')){
  $case=Join-Path $cases $name;New-Directory $case;Set-CaseAcl $case 'FullControl';New-Directory (Join-Path $case 'tmp')
 }
 foreach($name in @('appdata','appdata-wide','concurrent')){New-Directory (Join-Path $cases ($name+'\AppData\Local'))}
 [IO.File]::WriteAllText((Join-Path $cases 'appdata\AppData\Local\profile-sentinel.txt'),'public profile fixture',$utf8)
 [IO.File]::WriteAllText((Join-Path $cases 'appdata-file\AppData'),'public file fixture',$utf8)
 [IO.File]::WriteAllText((Join-Path $cases 'appdata-wide\AppData\Local\profile-sentinel.txt'),'public wide profile fixture',$utf8)
 Set-CaseAcl (Join-Path $cases 'appdata-wide\AppData') 'FullControl' -Wide
 New-Directory (Join-Path $cases 'existing-data\data')
 [IO.File]::WriteAllText((Join-Path $cases 'existing-data\data\sentinel.txt'),'public existing data fixture',$utf8)
 [IO.File]::WriteAllText((Join-Path $cases 'dirty-tmp\tmp\sentinel.txt'),'public nonempty tmp fixture',$utf8)
 foreach($name in @('BootstrapRuntime.mjs','register.mjs','loader.mjs','windows-paths.mjs')){[IO.File]::Copy((Join-Path $fixtureSource $name),(Join-Path $tools $name),$false)}
 $source=[IO.File]::ReadAllText((Join-Path $fixtureSource 'FixtureHost.cs')).Replace('__FIXTURE_ROOT__',$root.Replace('"','""')).Replace('__FIXTURE_SID__',$sid)
 $sourcePath=Join-Path $tools 'FixtureHost.cs';[IO.File]::WriteAllText($sourcePath,$source,$utf8)
 $helper=Join-Path $tools 'FixtureHost.exe'
 $compiler=Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
 & $compiler /nologo /target:exe /platform:anycpu /optimize+ /warnaserror+ "/out:$helper" $sourcePath
 if($LASTEXITCODE-ne 0){throw 'The fixed synthetic native helper did not compile.'}
 $map=[ordered]@{root=$root;cases=$cases;helper=$helper;node=$node;runtime=$runtime;windowsPathsModule=(Join-Path $runtime 'dist\src\windows-paths.js');windows=[Environment]::GetFolderPath('Windows');programFiles=[Environment]::GetFolderPath('ProgramFiles');programData=[Environment]::GetFolderPath('CommonApplicationData');temporary=(Join-Path $root 'tmp');profile=(Join-Path $root 'helper-profile');coreHashes=$coreHashes;sentinels=@{'appdata-file'='AppData';'appdata-wide'='AppData/Local/profile-sentinel.txt';'existing-data'='data/sentinel.txt';'dirty-tmp'='tmp/sentinel.txt'}}
 Write-PublicJson (Join-Path $tools 'fixture-map.json') $map
 $childPath=Join-Path $tools 'Run.ps1'
 $child=@'
#requires -Version 5.1
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$map=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'fixture-map.json'))|ConvertFrom-Json
trap {
 try{[IO.File]::WriteAllText((Join-Path $map.root 'results\result.json'),([ordered]@{ok=$false;stage='powershell-fixture-runner';failureLine=$_.InvocationInfo.ScriptLineNumber;failureHResult=$_.Exception.HResult;syntheticOnly=$true;passwordValuesPrinted=$false}|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))}catch{}
 exit 1
}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if((New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'This fixture must run with the ordinary token.'}
$start=New-Object Diagnostics.ProcessStartInfo
$start.FileName=$map.node;$start.Arguments='--import "'+([Uri](Join-Path $PSScriptRoot 'register.mjs')).AbsoluteUri+'" "'+(Join-Path $PSScriptRoot 'BootstrapRuntime.mjs')+'"'
$start.WorkingDirectory=$PSScriptRoot;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
$start.EnvironmentVariables.Clear()
$start.EnvironmentVariables['SystemRoot']=$map.windows;$start.EnvironmentVariables['WINDIR']=$map.windows;$start.EnvironmentVariables['SystemDrive']=[IO.Path]::GetPathRoot($map.windows).TrimEnd('\')
$start.EnvironmentVariables['PATH']=Join-Path $map.windows 'System32';$start.EnvironmentVariables['ProgramFiles']=$map.programFiles;$start.EnvironmentVariables['ProgramData']=$map.programData
$start.EnvironmentVariables['HOME']=$map.profile;$start.EnvironmentVariables['USERPROFILE']=$map.profile;$start.EnvironmentVariables['TEMP']=$map.temporary;$start.EnvironmentVariables['TMP']=$map.temporary
$node=[Diagnostics.Process]::Start($start)
try{
 $output=$node.StandardOutput.ReadToEndAsync();$errors=$node.StandardError.ReadToEndAsync()
 if(-not $node.WaitForExit(300000)){$node.Kill();$null=$node.WaitForExit(5000);throw 'The synthetic bootstrap test timed out.'}
 if(-not $output.Wait(5000)-or -not $errors.Wait(5000)-or $output.Result.Length-gt 65536){throw 'The synthetic bootstrap output did not finish.'}
 # Output is a closed synthetic result; never publish stderr or fixture secrets.
 $value=$output.Result|ConvertFrom-Json
 if(-not $value){$errorCode='UNCLASSIFIED';if($errors.Result-match "code: '([A-Z0-9_]{1,80})'"){$errorCode=$Matches[1]};$value=[pscustomobject]@{ok=$false;stage='node-before-fixture';code=$errorCode;syntheticOnly=$true;passwordValuesPrinted=$false}}
 $value|Add-Member NoteProperty nodeExitCode $node.ExitCode
 $value|Add-Member NoteProperty nodeProcessId $node.Id
 $value|Add-Member NoteProperty ordinaryOwnerToken $true
 [IO.File]::WriteAllText((Join-Path $map.root 'results\result.json'),($value|ConvertTo-Json -Depth 10),(New-Object Text.UTF8Encoding($false)))
 if($node.ExitCode-ne 0-or -not $value.ok){exit 1}
}finally{$node.Dispose()}
'@
 [IO.File]::WriteAllText($childPath,$child,$utf8)
 foreach($file in @(Get-ChildItem -LiteralPath $tools -File)+@((Get-Item -LiteralPath $node))){$held+=New-Object IO.FileStream($file.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)}
 foreach($item in $coreHashes){$held+=New-Object IO.FileStream($item.path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)}
 $scheduler=New-Object -ComObject 'Schedule.Service';$scheduler.Connect();$parentFolder=$scheduler.GetFolder('\')
 $sddl='O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;'+$sid+')'
 $folder=$parentFolder.CreateFolder($taskFolder,$sddl);$createdFolder=$true
 $definition=$scheduler.NewTask(0);$definition.RegistrationInfo.Description='Abilock synthetic bootstrap '+$nonce
 $definition.Principal.UserId=$sid;$definition.Principal.LogonType=3;$definition.Principal.RunLevel=0
 $definition.Settings.ExecutionTimeLimit='PT6M';$definition.Settings.DisallowStartIfOnBatteries=$false;$definition.Settings.StopIfGoingOnBatteries=$false;$definition.Settings.AllowDemandStart=$true
 $action=$definition.Actions.Create(0);$action.Path=Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\WindowsPowerShell\v1.0\powershell.exe';$action.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$childPath+'"';$action.WorkingDirectory=$tools
 $task=$folder.RegisterTaskDefinition('Check',$definition,18,$sid,$null,3,$sddl);$instance=$task.Run($null)
 $deadline=[DateTime]::UtcNow.AddSeconds(365)
 do{Start-Sleep -Milliseconds 200;if([DateTime]::UtcNow-ge $deadline){throw 'The temporary bootstrap task timed out.'}}while($task.GetInstances(0).Count-ne 0-or $task.LastTaskResult-eq 267011)
 $resultPath=Join-Path $results 'result.json'
 if(-not(Test-Path -LiteralPath $resultPath)){throw 'The synthetic bootstrap result is missing.'}
 $check=[IO.File]::ReadAllText($resultPath)|ConvertFrom-Json
 if($task.LastTaskResult-ne 0-or -not $check.ok){throw 'The Windows synthetic bootstrap transaction failed.'}
 foreach($item in $coreHashes){if((Get-FileHash -LiteralPath $item.path).Hash.ToLowerInvariant()-cne $item.sha256){throw 'A core module changed during the synthetic regression.'}}
}catch{$failure=[ordered]@{line=$_.InvocationInfo.ScriptLineNumber;hresult=$_.Exception.HResult}}
finally{
 if($createdFolder){
  try{
   if($task){if($task.GetInstances(0).Count-ne 0){$task.Stop(0)};$stop=[DateTime]::UtcNow.AddSeconds(10);while($task.GetInstances(0).Count-ne 0-and [DateTime]::UtcNow-lt $stop){Start-Sleep -Milliseconds 100};if($task.GetInstances(0).Count-ne 0){throw 'The owned test is still running.'};$folder.DeleteTask('Check',0)}
   if($folder.GetTasks(1).Count-ne 0-or $folder.GetFolders(0).Count-ne 0){throw 'Unexpected synthetic task folder contents.'}
   $taskRemoved=$true;$parentFolder.DeleteFolder($taskFolder,0);$folderRemoved=$true
  }catch{if(-not $failure){$failure=[ordered]@{line=$_.InvocationInfo.ScriptLineNumber;hresult=$_.Exception.HResult}}}
 }
 foreach($file in $held){$file.Dispose()}
 foreach($item in @($instance,$task,$folder,$parentFolder,$scheduler)){if($item-and[Runtime.InteropServices.Marshal]::IsComObject($item)){[Runtime.InteropServices.Marshal]::FinalReleaseComObject($item)|Out-Null}}
 try{
  # The server-side GUID filter selects only this run's Node/helper command
  # paths. No unrelated command lines are returned, and nothing is killed here.
  $exitDeadline=[DateTime]::UtcNow.AddSeconds(10)
  do{
   $remainingProcesses=@(Get-CimInstance Win32_Process -Filter ("(Name='node.exe' OR Name='FixtureHost.exe') AND CommandLine LIKE '%"+$nonce+"%'") -Property ProcessId,CreationDate,ExecutablePath)
   if($remainingProcesses.Count-eq 0){break};Start-Sleep -Milliseconds 100
  }while([DateTime]::UtcNow-lt $exitDeadline)
  $processesExited=$remainingProcesses.Count-eq 0
  if(-not $processesExited){throw 'An owned synthetic process remains; retain the fixture for review.'}
  if(Test-Path -LiteralPath $root){
   if([IO.File]::ReadAllText((Join-Path $root 'fixture.marker'))-cne 'Abilock synthetic bootstrap runtime'){throw 'Fixture ownership marker changed.'}
   $scan=New-Object 'Collections.Generic.Stack[string]';$scan.Push($root)
   while($scan.Count-gt 0){$dir=$scan.Pop();Assert-NoReparse $dir;foreach($entry in Get-ChildItem -LiteralPath $dir -Force){Assert-NoReparse $entry.FullName;if($entry.PSIsContainer){$scan.Push($entry.FullName)}}}
   Remove-Item -LiteralPath $root -Recurse -Force
  };$fixtureRemoved=$true
 }catch{if(-not $failure){$failure=[ordered]@{line=$_.InvocationInfo.ScriptLineNumber;hresult=$_.Exception.HResult}}}
}
$summary=[ordered]@{ok=([bool]$check-and $check.ok-and -not $failure-and $taskRemoved-and $folderRemoved-and $fixtureRemoved-and $processesExited);syntheticOnly=$true;fixtureRoot=$root;taskFolder=$taskFolder;taskRemoved=$taskRemoved;folderRemoved=$folderRemoved;fixtureRemoved=$fixtureRemoved;processesExited=$processesExited;remainingOwnedProcesses=@($remainingProcesses|Select-Object ProcessId,CreationDate);failure=$failure;result=$check;deviations=@('Same ordinary user SID used by fixture helper; not the production dedicated SID','Only windows-paths dependency redirected to a fixed test-only native helper','Production installer password window and bootstrap named-pipe handshake not exercised');privateInstallationDataAccessed=$false;completedUtc=[DateTime]::UtcNow.ToString('o')}
Write-PublicJson $report $summary
$summary|ConvertTo-Json -Depth 14 -Compress
if(-not $summary.ok){exit 1}
