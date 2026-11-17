<#
  First-logon setup of the windows-11-arm machine image. autounattend.xml
  runs it once, as the `runner` administrator, from the unattend ISO that
  build.sh makes (-Source is that drive). It:

    1. installs the virtio drivers into the running system (pnputil),
    2. installs winget at a pinned version, then the toolset in
       packages.json (winget, or downloads checked against their sha256),
       and checks every tool runs,
    3. installs the agent to C:\iwci\bin, writes C:\iwci\image, and
       registers the scheduled task that runs `iwci-guest.exe serve-port`
       at every boot as `runner`,
    4. turns off what would otherwise run in every job: Windows Update,
       Defender's real-time scanning (as far as Tamper Protection lets a
       script), sleep and hibernation, indexing, telemetry and maintenance
       tasks,
    5. cleans up, then gives the virtio NIC the runner's static address
       (10.0.2.15/24, gateway and DNS 10.0.2.2, IPv6 unbound), last,
       since the build's own network is QEMU's user-mode one,
    6. shuts the machine down.

  Progress goes to C:\iwci\setup.log and, one line at a time prefixed
  `iwci-setup: `, to the agent's virtio-serial port, which build.sh logs
  during the install. The last line is `iwci-setup: done` or
  `iwci-setup: failed: <why>`; the machine shuts down either way.

  Windows PowerShell 5.1 (what a fresh install has), so no PowerShell 7
  syntax here.
#>
param(
  [Parameter(Mandatory = $true)] [string] $Source
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = 'C:\iwci'
$Downloads = Join-Path $Root 'setup\downloads'
$LogFile = Join-Path $Root 'setup.log'
$PortName = '\\.\Global\org.infrawrench.iwci.agent'
$GuestMac = '52-54-00-12-34-56'

# The agent's port is a device path, which .NET Framework's FileStream
# refuses to open by name, so open it with CreateFileW and wrap the handle.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class IwciPort {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
        IntPtr security, uint disposition, uint flags, IntPtr template);

    public static FileStream Open(string name) {
        // GENERIC_WRITE, no sharing, OPEN_EXISTING
        SafeFileHandle handle = CreateFileW(name, 0x40000000, 0, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (handle.IsInvalid) {
            throw new IOException("cannot open " + name, Marshal.GetHRForLastWin32Error());
        }
        return new FileStream(handle, FileAccess.Write);
    }
}
'@

$script:Port = $null

function Open-Port {
  # The port appears once pnputil has installed vioserial.
  for ($i = 0; $i -lt 60 -and $null -eq $script:Port; $i++) {
    try { $script:Port = [IwciPort]::Open($PortName) } catch { Start-Sleep -Seconds 1 }
  }
}

function Write-Log([string] $Message) {
  $line = '{0} {1}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $Message
  Add-Content -Path $LogFile -Value $line
  Write-Host $line
  if ($null -ne $script:Port) {
    try {
      $bytes = [Text.Encoding]::UTF8.GetBytes("iwci-setup: $Message`n")
      $script:Port.Write($bytes, 0, $bytes.Length)
      $script:Port.Flush()
    } catch {
      $script:Port = $null
    }
  }
}

function Get-Field($Object, [string] $Name) {
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Invoke-Native([string] $File, [string] $Arguments, [int[]] $Ok = @(0)) {
  $process = Start-Process -FilePath $File -ArgumentList $Arguments -Wait -PassThru -NoNewWindow
  if ($Ok -notcontains $process.ExitCode) {
    throw "$File $Arguments exited with $($process.ExitCode)"
  }
}

# Downloads $Url into $Downloads and checks its sha256; returns the path.
function Get-Verified([string] $Url, [string] $Sha256) {
  New-Item -ItemType Directory -Force -Path $Downloads | Out-Null
  $name = [IO.Path]::GetFileName(([Uri] $Url).AbsolutePath)
  $file = Join-Path $Downloads $name
  for ($attempt = 1; ; $attempt++) {
    try {
      Invoke-WebRequest -Uri $Url -OutFile $file -UseBasicParsing
      break
    } catch {
      if ($attempt -ge 3) { throw "downloading $Url failed: $_" }
      Start-Sleep -Seconds (10 * $attempt)
    }
  }
  $got = (Get-FileHash -Algorithm SHA256 -Path $file).Hash
  if ($got -ne $Sha256.ToUpperInvariant()) {
    throw "$Url has sha256 $got, expected $Sha256"
  }
  return $file
}

function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

# Adds each pattern's matches to the machine PATH (a pattern that matches
# nothing is logged; the checks at the end are what fail the build).
function Add-MachinePath([string[]] $Patterns) {
  $entries = @([Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';' | Where-Object { $_ })
  foreach ($pattern in $Patterns) {
    $matched = @(Resolve-Path -Path $pattern -ErrorAction SilentlyContinue | ForEach-Object { $_.ProviderPath })
    if ($matched.Count -eq 0) { Write-Log "PATH: nothing matches $pattern"; continue }
    foreach ($dir in $matched) {
      if ($entries -notcontains $dir) { $entries += $dir }
    }
  }
  [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'Machine')
  Update-SessionPath
}

function Set-MachineEnv([string] $Name, [string] $Pattern) {
  $value = $Pattern
  if ($Pattern.Contains('*')) {
    $value = @(Resolve-Path -Path $Pattern -ErrorAction SilentlyContinue | ForEach-Object { $_.ProviderPath }) | Select-Object -First 1
    if (-not $value) { throw "$Name`: nothing matches $Pattern" }
  }
  [Environment]::SetEnvironmentVariable($Name, $value, 'Machine')
  Set-Item -Path "env:$Name" -Value $value
}

function Set-Reg([string] $Key, [string] $Name, $Value, [string] $Type = 'DWord') {
  if (-not (Test-Path $Key)) { New-Item -Path $Key -Force | Out-Null }
  New-ItemProperty -Path $Key -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null
}

# For the turn-offs: a step Windows refuses (a protected service, Tamper
# Protection) is logged, not fatal.
function Invoke-Optional([string] $What, [scriptblock] $Block) {
  try { & $Block | Out-Null } catch { Write-Log "could not $What`: $($_.Exception.Message)" }
}

function Install-Winget($Spec) {
  Write-Log "winget $($Spec.version)"
  $zip = Get-Verified $Spec.dependencies.url $Spec.dependencies.sha256
  $deps = Join-Path $Downloads 'winget-deps'
  Expand-Archive -Path $zip -DestinationPath $deps -Force
  $folder = $Spec.dependencies.folder
  Get-ChildItem -Path $deps -Recurse -Filter '*.appx' |
    Where-Object { $_.FullName -match "\\$folder\\" } |
    ForEach-Object {
      # A dependency the system already has at a newer version is fine.
      Invoke-Optional "add $($_.Name)" ([scriptblock]::Create("Add-AppxPackage -Path '$($_.FullName)'"))
    }
  $bundle = Get-Verified $Spec.bundle.url $Spec.bundle.sha256
  Add-AppxPackage -Path $bundle -ForceApplicationShutdown
  for ($i = 0; $i -lt 60; $i++) {
    $command = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($command) {
      $version = & $command.Source --version
      if ($LASTEXITCODE -eq 0) {
        Write-Log "winget answers: $version"
        return $command.Source
      }
    }
    Start-Sleep -Seconds 5
  }
  throw 'winget did not become usable after installing App Installer'
}

function Install-Package($Package, [string] $Winget) {
  $name = $Package.name
  switch ($Package.source) {
    'winget' {
      Write-Log "winget: $($Package.id) $($Package.version)"
      $wingetArgs = @(
        'install', '--id', $Package.id, '--version', $Package.version, '--exact',
        '--source', 'winget', '--architecture', 'arm64', '--scope', 'machine',
        '--silent', '--disable-interactivity',
        '--accept-package-agreements', '--accept-source-agreements'
      )
      $type = Get-Field $Package 'installerType'
      if ($type) { $wingetArgs += @('--installer-type', $type) }
      & $Winget @wingetArgs
      # 0x8A150061: already installed (the ISO carried it).
      if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne [int] 0x8A150061) {
        throw "winget install $($Package.id) $($Package.version) exited with $LASTEXITCODE"
      }
    }
    'msi' {
      Write-Log "msi: $name $($Package.version)"
      $msi = Get-Verified $Package.url $Package.sha256
      $extra = Get-Field $Package 'arguments'
      Invoke-Native 'msiexec.exe' "/i `"$msi`" /qn /norestart $extra" @(0, 3010)
    }
    'rustup' {
      Write-Log "rustup $($Package.version), Rust $($Package.toolchain) for $($Package.host)"
      $exe = Get-Verified $Package.url $Package.sha256
      foreach ($entry in (Get-Field $Package 'env').PSObject.Properties) {
        Set-MachineEnv $entry.Name $entry.Value
      }
      $components = (@($Package.components) | ForEach-Object { "--component $_" }) -join ' '
      Invoke-Native $exe "-y --no-modify-path --profile minimal --default-host $($Package.host) --default-toolchain $($Package.toolchain) $components"
    }
    default { throw "packages.json: $name has an unknown source $($Package.source)" }
  }

  $envs = Get-Field $Package 'env'
  if ($envs -and $Package.source -ne 'rustup') {
    foreach ($entry in $envs.PSObject.Properties) { Set-MachineEnv $entry.Name $entry.Value }
  }
  $paths = Get-Field $Package 'path'
  if ($paths) { Add-MachinePath @($paths) }
  $corepack = Get-Field $Package 'corepack'
  if ($corepack) {
    Invoke-Native 'cmd.exe' "/c corepack enable $(@($corepack) -join ' ')"
  }
}

function Disable-TaskFolder([string] $Path) {
  foreach ($task in @(Get-ScheduledTask -TaskPath $Path -ErrorAction SilentlyContinue)) {
    Invoke-Optional "disable task $($task.TaskPath)$($task.TaskName)" ([scriptblock]::Create(
        "Disable-ScheduledTask -TaskPath '$($task.TaskPath)' -TaskName '$($task.TaskName)'"))
  }
}

function Disable-ServiceHard([string] $Name) {
  if (-not (Get-Service -Name $Name -ErrorAction SilentlyContinue)) { return }
  Invoke-Optional "stop $Name" ([scriptblock]::Create("Stop-Service -Name '$Name' -Force"))
  Invoke-Optional "disable $Name" ([scriptblock]::Create("Set-Service -Name '$Name' -StartupType Disabled"))
  # Some (WaaSMedicSvc, UsoSvc) refuse Set-Service; their Start value may
  # still take.
  Invoke-Optional "disable $Name in the registry" ([scriptblock]::Create(
      "Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\$Name' -Name Start -Value 4"))
}

function Disable-Background {
  Write-Log 'turning off Windows Update, Defender scanning, sleep, indexing, telemetry'

  # Windows Update: policy, services and their tasks.
  $wu = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate'
  Set-Reg "$wu\AU" 'NoAutoUpdate' 1
  Set-Reg "$wu\AU" 'AUOptions' 1
  Set-Reg $wu 'ExcludeWUDriversInQualityUpdate' 1
  Set-Reg $wu 'DisableOSUpgrade' 1
  Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\WindowsStore' 'AutoDownload' 2
  Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization' 'DODownloadMode' 0
  foreach ($service in 'wuauserv', 'UsoSvc', 'WaaSMedicSvc', 'DoSvc', 'edgeupdate', 'edgeupdatem') {
    Disable-ServiceHard $service
  }
  foreach ($folder in '\Microsoft\Windows\WindowsUpdate\', '\Microsoft\Windows\UpdateOrchestrator\',
    '\Microsoft\Windows\WaaSMedic\', '\Microsoft\Windows\InstallService\') {
    Disable-TaskFolder $folder
  }
  foreach ($task in @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like 'MicrosoftEdgeUpdate*' })) {
    Invoke-Optional "disable $($task.TaskName)" ([scriptblock]::Create(
        "Disable-ScheduledTask -TaskPath '$($task.TaskPath)' -TaskName '$($task.TaskName)'"))
  }

  # Defender: real-time, behaviour and script scanning off, the system
  # drive excluded, no cloud submissions, no scheduled scans. Tamper
  # Protection (on by default, and only switchable in the Security app or
  # by a management service) may revert the real-time switch; the
  # exclusion is what holds in that case.
  Invoke-Optional 'configure Defender' {
    Set-MpPreference -DisableRealtimeMonitoring $true -DisableBehaviorMonitoring $true `
      -DisableIOAVProtection $true -DisableScriptScanning $true -DisableArchiveScanning $true `
      -MAPSReporting Disabled -SubmitSamplesConsent NeverSend -ScanScheduleDay Never `
      -DisableCatchupFullScan $true -DisableCatchupQuickScan $true
  }
  Invoke-Optional 'exclude C:\ from Defender' { Add-MpPreference -ExclusionPath 'C:\' }
  $defender = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows Defender'
  Set-Reg "$defender\Real-Time Protection" 'DisableRealtimeMonitoring' 1
  Set-Reg "$defender\Spynet" 'SpynetReporting' 0
  Set-Reg "$defender\Spynet" 'SubmitSamplesConsent' 2
  Disable-TaskFolder '\Microsoft\Windows\Windows Defender\'

  # Power: never sleep or hibernate, no hibernation file.
  Invoke-Native 'powercfg.exe' '/hibernate off'
  foreach ($setting in 'standby-timeout-ac', 'hibernate-timeout-ac', 'monitor-timeout-ac', 'disk-timeout-ac') {
    Invoke-Native 'powercfg.exe' "/change $setting 0"
  }

  # Indexing, prefetching and error reporting.
  foreach ($service in 'WSearch', 'SysMain', 'WerSvc', 'DiagTrack', 'dmwappushservice', 'MapsBroker') {
    Disable-ServiceHard $service
  }
  Set-Reg 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting' 'Disabled' 1
  Set-Reg 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting' 'DontShowUI' 1

  # Telemetry (Pro treats 0 as 1, the least it allows) and the scheduled
  # tasks that collect, diagnose, defragment or maintain.
  Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DataCollection' 'AllowTelemetry' 0
  Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent' 'DisableWindowsConsumerFeatures' 1
  Set-Reg 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Schedule\Maintenance' 'MaintenanceDisabled' 1
  foreach ($folder in '\Microsoft\Windows\Application Experience\',
    '\Microsoft\Windows\Customer Experience Improvement Program\',
    '\Microsoft\Windows\Autochk\', '\Microsoft\Windows\DiskDiagnostic\',
    '\Microsoft\Windows\DiskFootprint\', '\Microsoft\Windows\Feedback\Siuf\',
    '\Microsoft\Windows\Windows Error Reporting\', '\Microsoft\Windows\Defrag\',
    '\Microsoft\Windows\Maintenance\', '\Microsoft\Windows\Diagnosis\',
    '\Microsoft\Windows\Flighting\FeatureConfig\', '\Microsoft\Windows\Flighting\OneSettings\',
    '\Microsoft\Windows\Maps\', '\Microsoft\Windows\Power Efficiency Diagnostics\',
    '\Microsoft\Windows\CloudExperienceHost\', '\Microsoft\Windows\Location\',
    '\Microsoft\Windows\Speech\', '\Microsoft\Windows\Chkdsk\') {
    Disable-TaskFolder $folder
  }

  # Small things CI notices: long paths, no last-access writes, no
  # restore points, no new-network prompt, a password that never expires
  # (the scheduled task logs on with it).
  Set-Reg 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' 'LongPathsEnabled' 1
  Invoke-Native 'fsutil.exe' 'behavior set disablelastaccess 1'
  Invoke-Optional 'turn off System Restore' { Disable-ComputerRestore -Drive 'C:\' }
  if (-not (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Network\NewNetworkWindowOff')) {
    New-Item -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Network\NewNetworkWindowOff' -Force | Out-Null
  }
  Invoke-Native 'net.exe' 'accounts /maxpwage:unlimited'
  Set-LocalUser -Name 'runner' -PasswordNeverExpires $true
}

function Install-Agent([string] $Password) {
  Write-Log 'agent'
  New-Item -ItemType Directory -Force -Path (Join-Path $Root 'bin') | Out-Null
  Copy-Item -Path (Join-Path $Source 'iwci\iwci-guest.exe') -Destination (Join-Path $Root 'bin\iwci-guest.exe') -Force
  $image = (Get-Content -Raw -Path (Join-Path $Source 'iwci\image')).Trim()
  [IO.File]::WriteAllText((Join-Path $Root 'image'), $image)

  # The agent exits when a conversation ends badly; the loop starts it
  # again (a scheduled task's own restart setting covers a failure to
  # start, not an exit).
  $serve = @'
@echo off
rem Runs the iwci agent on its virtio-serial port, again whenever it exits.
:loop
"C:\iwci\bin\iwci-guest.exe" serve-port
ping -n 2 127.0.0.1 >nul
goto loop
'@
  [IO.File]::WriteAllText((Join-Path $Root 'bin\serve.cmd'), $serve.Replace("`n", "`r`n"))

  $action = New-ScheduledTaskAction -Execute (Join-Path $Root 'bin\serve.cmd') -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -AtStartup
  # Priority 4 (normal): a task's default, 7, is below normal, and every
  # job would run under it.
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -Priority 4
  Register-ScheduledTask -TaskPath '\iwci\' -TaskName 'iwci-guest' -Action $action -Trigger $trigger `
    -Settings $settings -User 'runner' -Password $Password -RunLevel Highest -Force | Out-Null
}

function Set-StaticNetwork {
  Write-Log 'network: 10.0.2.15/24 via 10.0.2.2, IPv6 unbound'
  $nic = Get-NetAdapter -Physical | Where-Object { $_.MacAddress -eq $GuestMac } | Select-Object -First 1
  if (-not $nic) { throw "no network adapter with MAC $GuestMac" }
  Disable-NetAdapterBinding -Name $nic.Name -ComponentID 'ms_tcpip6'
  Set-NetIPInterface -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -Dhcp Disabled
  Get-NetRoute -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
    Remove-NetRoute -Confirm:$false
  Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Remove-NetIPAddress -Confirm:$false
  New-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -IPAddress '10.0.2.15' `
    -PrefixLength 24 -DefaultGateway '10.0.2.2' | Out-Null
  Set-DnsClientServerAddress -InterfaceIndex $nic.ifIndex -ServerAddresses '10.0.2.2'
  Invoke-Optional 'make the network private' { Set-NetConnectionProfile -InterfaceIndex $nic.ifIndex -NetworkCategory Private }
}

function Test-Toolset($Packages) {
  Write-Log 'checking the toolset'
  Update-SessionPath
  $failed = @()
  foreach ($package in $Packages) {
    foreach ($check in @(Get-Field $package 'check')) {
      if (-not $check) { continue }
      $output = & cmd.exe /d /c "$check 2>&1"
      $code = $LASTEXITCODE
      $first = @($output | Where-Object { $_ }) | Select-Object -First 1
      if ($code -ne 0) {
        $failed += $check
        Write-Log "check failed ($code): $check"
      } else {
        Write-Log "ok: ${check}: $first"
      }
    }
  }
  if ($failed.Count -gt 0) { throw "toolset checks failed: $($failed -join '; ')" }
}

function Clear-Image {
  Write-Log 'cleaning up'
  $wl = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  Set-ItemProperty -Path $wl -Name 'AutoAdminLogon' -Value '0'
  foreach ($name in 'DefaultPassword', 'AutoLogonCount') {
    Remove-ItemProperty -Path $wl -Name $name -ErrorAction SilentlyContinue
  }
  foreach ($path in 'C:\Windows\Panther\unattend.xml', 'C:\Windows\Panther\Unattend', (Join-Path $Root 'setup')) {
    Remove-Item -Path $path -Recurse -Force -ErrorAction SilentlyContinue
  }
  foreach ($dir in $env:TEMP, 'C:\Windows\Temp') {
    Get-ChildItem -Path $dir -Force -ErrorAction SilentlyContinue |
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }
  Invoke-Optional 'clean the component store' {
    Start-Process -FilePath 'dism.exe' -ArgumentList '/Online /Cleanup-Image /StartComponentCleanup /ResetBase' -Wait -NoNewWindow
  }
  Invoke-Optional 'clear event logs' { wevtutil.exe el | ForEach-Object { wevtutil.exe cl "$_" 2>$null } }
  # Hands freed blocks back to the qcow2 (the disk is attached with
  # discard=unmap).
  Invoke-Optional 'retrim C:' { Optimize-Volume -DriveLetter C -ReTrim }
}

# --- main ----------------------------------------------------------------------

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  # autounattend.xml sets ConsentPromptBehaviorAdmin=0, so this does not prompt.
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Source', "`"$Source`"")
  exit
}

New-Item -ItemType Directory -Force -Path $Root | Out-Null
Start-Transcript -Path (Join-Path $Root 'setup-transcript.log') -Append | Out-Null

try {
  Write-Log "setup from $Source"
  Invoke-Native 'pnputil.exe' "/add-driver `"$(Join-Path $Source 'drivers\*.inf')`" /subdirs /install" @(0, 259, 3010)
  Open-Port
  Write-Log 'drivers installed'

  $password = (Get-Content -Raw -Path (Join-Path $Source 'iwci\runner-password')).Trim()
  $spec = Get-Content -Raw -Path (Join-Path $Source 'packages.json') | ConvertFrom-Json

  Write-Log 'waiting for the network'
  for ($i = 0; ; $i++) {
    try { Resolve-DnsName -Name 'github.com' -Type A -ErrorAction Stop | Out-Null; break } catch {
      if ($i -ge 120) { throw 'no network after 10 minutes' }
      Start-Sleep -Seconds 5
    }
  }

  # Windows Update already has NoAutoUpdate from autounattend.xml; the rest
  # is turned off after the installs, because winget can download through
  # Delivery Optimization, one of the services Disable-Background stops.
  $winget = Install-Winget $spec.winget
  Add-MachinePath @('C:\Program Files\WinGet\Links')
  foreach ($package in $spec.packages) { Install-Package $package $winget }
  [Environment]::SetEnvironmentVariable('COREPACK_ENABLE_DOWNLOAD_PROMPT', '0', 'Machine')
  [Environment]::SetEnvironmentVariable('DOTNET_CLI_TELEMETRY_OPTOUT', '1', 'Machine')
  $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  Invoke-Native 'cmd.exe' '/c git config --system core.longpaths true'
  Invoke-Native 'cmd.exe' '/c git lfs install --system --skip-repo'

  # OpenSSH's client ships with Windows 11; make sure.
  $ssh = Get-WindowsCapability -Online -Name 'OpenSSH.Client*' | Select-Object -First 1
  if ($ssh -and $ssh.State -ne 'Installed') { Add-WindowsCapability -Online -Name $ssh.Name | Out-Null }

  Test-Toolset $spec.packages
  Install-Agent $password
  Disable-Background
  Clear-Image
  Set-StaticNetwork
  Write-Log 'done'
} catch {
  Write-Log "failed: $($_.Exception.Message) at $($_.InvocationInfo.PositionMessage -replace '\s+', ' ')"
} finally {
  Stop-Transcript | Out-Null
  Stop-Computer -Force
}
