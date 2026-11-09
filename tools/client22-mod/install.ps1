<#
  WarRock client 22 clan mod: installs or removes it in an existing War Rock client (needs administrator rights,
  the game folder is under Program Files). Use install.cmd / uninstall.cmd, or:
    powershell -ExecutionPolicy Bypass -File install.ps1 -Server 1.2.3.4 [-WebPort 8080] [-SetHosts] [-Game <folder>]
    powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall [-Game <folder>]
  Every file is checked by SHA-256 before and after a change; anything unexpected stops the script untouched.
#>
param(
  [string]$Game = "${env:ProgramFiles(x86)}\GamersFirst\War Rock",
  [string]$Server = '127.0.0.1',
  [int]$WebPort = 8080,
  [switch]$SetHosts,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$p = Get-Content -Raw (Join-Path $here 'patches.json') | ConvertFrom-Json

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
function Sha($bytes) {
  $h = [System.Security.Cryptography.SHA256]::Create()
  ([System.BitConverter]::ToString($h.ComputeHash($bytes)) -replace '-', '').ToLower()
}

if (-not (Test-Path (Join-Path $Game 'system\WarRock.exe'))) { Fail "no War Rock client in '$Game' (use -Game <folder>)" }
# Program Files needs administrator rights (install.cmd asks for them); a game folder elsewhere may not.
try { [IO.File]::WriteAllText((Join-Path $Game 'system\.modcheck'), ''); Remove-Item (Join-Path $Game 'system\.modcheck') }
catch { Fail 'cannot write to the game folder: run it as administrator (install.cmd asks for it)' }
$exePath = (Resolve-Path (Join-Path $Game 'system\WarRock.exe')).Path
if (Get-Process WarRock -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exePath }) { Fail 'close the game first' }

# Executable: original <-> patched, a few instruction bytes each way.
function Set-Exe([bool]$patch) {
  $path = Join-Path $Game $p.exe.path
  $data = [IO.File]::ReadAllBytes($path)
  $from, $to = if ($patch) { $p.exe.sha_original, $p.exe.sha_patched } else { $p.exe.sha_patched, $p.exe.sha_original }
  $now = Sha $data
  if ($now -eq $to) { Write-Host "WarRock.exe: already $(if ($patch) {'patched'} else {'original'})"; return }
  if ($now -ne $from) { Fail "WarRock.exe is not the client 22 version this mod knows (sha256 $now)" }
  foreach ($x in $p.exe.patches) {
    $old = [byte[]]($x.original -split '(..)' | Where-Object { $_ } | ForEach-Object { [Convert]::ToByte($_, 16) })
    $new = [byte[]]($x.new -split '(..)' | Where-Object { $_ } | ForEach-Object { [Convert]::ToByte($_, 16) })
    $bytes = if ($patch) { $new } else { $old }
    # unpatching a longer new sequence: the bytes past the original's length came from the original file too
    if (-not $patch -and $new.Length -gt $old.Length) { Fail 'cannot restore this patch' }
    [Array]::Copy($bytes, 0, $data, $x.offset, $bytes.Length)
  }
  if ((Sha $data) -ne $to) { Fail 'WarRock.exe check failed after patching, nothing written' }
  [IO.File]::WriteAllBytes($path, $data)
  Write-Host "WarRock.exe: $(if ($patch) {'patched (HackShield off, CRC checks skipped)'} else {'restored'})"
}

# Menu texture: XOR of the changed blocks, the same operation both ways.
function Set-Menu([bool]$patch) {
  $path = Join-Path $Game $p.menu.path
  $data = [IO.File]::ReadAllBytes($path)
  $from, $to = if ($patch) { $p.menu.sha_original, $p.menu.sha_patched } else { $p.menu.sha_patched, $p.menu.sha_original }
  $now = Sha $data
  if ($now -eq $to) { Write-Host "Menu_eng.dds: already $(if ($patch) {'CLAN'} else {'original'})"; return }
  if ($now -ne $from) { Write-Host "Menu_eng.dds: unknown version, left alone (the button keeps its old label)" -ForegroundColor Yellow; return }
  $xor = [Convert]::FromBase64String($p.menu.xor)
  for ($i = 0; $i -lt $xor.Length; $i++) { $data[$p.menu.offset + $i] = $data[$p.menu.offset + $i] -bxor $xor[$i] }
  if ((Sha $data) -ne $to) { Fail 'Menu_eng.dds check failed, nothing written' }
  [IO.File]::WriteAllBytes($path, $data)
  Write-Host "Menu_eng.dds: $(if ($patch) {'TRAINING button relabelled CLAN'} else {'restored'})"
}

$ourFiles = @('system\dinput8.dll', 'system\dinput8.ini', 'texture\Cland.jpg', 'texture\Avata\DefaultClanMark.jpg')

if ($Uninstall) {
  Set-Exe $false
  Set-Menu $false
  foreach ($f in $ourFiles) { Remove-Item (Join-Path $Game $f) -ErrorAction SilentlyContinue }
  Write-Host 'Clan mod removed.' -ForegroundColor Green
  exit 0
}

Set-Exe $true
Set-Menu $true
Copy-Item (Join-Path $here 'dinput8.dll') (Join-Path $Game 'system\dinput8.dll') -Force
Set-Content -Path (Join-Path $Game 'system\dinput8.ini') -Value "[clan]`r`nurl=http://${Server}:$WebPort/clan" -Encoding ASCII
Copy-Item (Join-Path $here 'Cland.jpg') (Join-Path $Game 'texture\Cland.jpg') -Force
New-Item -ItemType Directory -Force (Join-Path $Game 'texture\Avata') | Out-Null
Copy-Item (Join-Path $here 'DefaultClanMark.jpg') (Join-Path $Game 'texture\Avata\DefaultClanMark.jpg') -Force
Write-Host "Clan page: http://${Server}:$WebPort/clan"

if ($SetHosts) {
  # The client logs in to login.warrock.net: point it at the server (IP addresses only).
  if (-not ($Server -as [ipaddress])) { Fail "-SetHosts needs an IP address, not '$Server'" }
  $hosts = "$env:SystemRoot\System32\drivers\etc\hosts"
  $lines = @(Get-Content $hosts | Where-Object { $_ -notmatch '\slogin\.warrock\.net(\s|$)' })
  Set-Content -Path $hosts -Value ($lines + "$Server login.warrock.net") -Encoding ASCII
  Write-Host "hosts: login.warrock.net -> $Server"
}
Write-Host 'Clan mod installed.' -ForegroundColor Green
