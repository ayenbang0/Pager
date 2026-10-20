<#
.SYNOPSIS
  Installs the Pager desktop window for the current user. No administrator rights.

.EXAMPLE
  irm https://raw.githubusercontent.com/ayenbang0/Pager/main/scripts/install.ps1 | iex

.EXAMPLE
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/ayenbang0/Pager/main/scripts/install.ps1))) -Version 1.6.0 -Sha256 <hash>

.DESCRIPTION
  Downloads the release zip, checks its SHA-256 (against -Sha256 or the .sha256 file next to the zip), unpacks it to
  %LOCALAPPDATA%\Programs\Pager and runs Pager.exe --install (Start menu entry, "Open Pager here"). The files are
  not signed: Windows Smart App Control may refuse them, in which case Pager.exe --install falls back to the
  Windows Terminal host.
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$Dir = (Join-Path $env:LOCALAPPDATA 'Programs\Pager'),
  [string]$Sha256,
  # A zip path or URL instead of the GitHub release (offline installs, tests).
  [string]$Source,
  [string]$Repo = 'ayenbang0/Pager',
  [switch]$NoIntegrate,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Stop-Pager([string]$root) {
  Get-Process -Name Pager -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { $_.CloseMainWindow() | Out-Null; if (-not $_.WaitForExit(4000)) { $_.Kill() } }
}

if ($env:OS -ne 'Windows_NT') { throw 'The Pager desktop window is Windows only.' }
$Dir = [IO.Path]::GetFullPath($Dir)
$exe = Join-Path $Dir 'Pager.exe'

if ($Uninstall) {
  if (Test-Path $exe) {
    Stop-Pager $Dir
    $node = Join-Path $Dir 'resources\node\node.exe'
    $cli = Join-Path $Dir 'resources\app\pager\dist\cli.js'
    if ((Test-Path $node) -and (Test-Path $cli)) { & $node $cli desktop uninstall | Out-Host }
  }
  if (Test-Path $Dir) { Remove-Item $Dir -Recurse -Force }
  Write-Host "Removed $Dir (your chats and settings in ~/.pager are untouched)."
  return
}

$work = Join-Path ([IO.Path]::GetTempPath()) ("pager-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $zip = Join-Path $work 'pager.zip'
  $expected = $Sha256
  if ($Source) {
    $url = $Source
  } else {
    if (-not $Version) {
      $Version = (Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'pager-install' }).tag_name.TrimStart('v')
    }
    if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { throw "Not a version: $Version" }
    $url = "https://github.com/$Repo/releases/download/v$Version/Pager-$Version-win-x64.zip"
  }

  Write-Host "Downloading $url"
  if ($url -match '^https?://') { Invoke-WebRequest $url -OutFile $zip -UseBasicParsing } else { Copy-Item -LiteralPath $url -Destination $zip }

  if (-not $expected) {
    $sumFile = Join-Path $work 'pager.zip.sha256'
    if ($url -match '^https?://') { Invoke-WebRequest "$url.sha256" -OutFile $sumFile -UseBasicParsing } elseif (Test-Path "$url.sha256") { Copy-Item "$url.sha256" $sumFile }
    if (Test-Path $sumFile) { $expected = ((Get-Content $sumFile -Raw).Trim() -split '\s+')[0] }
  }
  if (-not $expected) { throw 'No SHA-256 to check the download against. Pass -Sha256 <hash>.' }
  $actual = (Get-FileHash $zip -Algorithm SHA256).Hash
  if ($actual -ne $expected.ToUpperInvariant() -and $actual -ne $expected) { throw "SHA-256 mismatch: expected $expected, got $actual. Nothing was installed." }
  Write-Host "SHA-256 ok ($($actual.Substring(0, 12))...)"

  $stage = Join-Path $work 'stage'
  # tar (built into Windows 10+) unpacks the 400 MB tree in seconds; Expand-Archive takes minutes.
  New-Item -ItemType Directory -Path $stage | Out-Null
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path $tar) { & $tar -xf $zip -C $stage; if ($LASTEXITCODE -ne 0) { throw 'tar could not unpack the download.' } } else { Expand-Archive -LiteralPath $zip -DestinationPath $stage }
  $root = Join-Path $stage 'Pager'
  if (-not (Test-Path (Join-Path $root 'Pager.exe'))) { throw 'The zip does not contain Pager\Pager.exe.' }

  Stop-Pager $Dir
  if (Test-Path $Dir) { Remove-Item $Dir -Recurse -Force }
  New-Item -ItemType Directory -Path (Split-Path $Dir) -Force | Out-Null
  Move-Item -LiteralPath $root -Destination $Dir
  Write-Host "Installed to $Dir"
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

if ($NoIntegrate) { Write-Host "Run $exe to start."; return }
# Pager.exe --install adds the Start menu entry and "Open Pager here", and falls back to the Windows Terminal host when Smart App Control refuses the exe.
Start-Process -FilePath $exe -ArgumentList '--install' -Wait
Write-Host 'Done. Start "Pager" from the Start menu, or right-click a folder > Open Pager here.'
