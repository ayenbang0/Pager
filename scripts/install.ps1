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

function Stop-Daemon([string]$node, [string]$cli) {
  $stop = Start-Process -FilePath $node -ArgumentList "`"$cli`" daemon stop" -WindowStyle Hidden -PassThru
  if (-not $stop.WaitForExit(20000)) { $stop.Kill() }
}

function Stop-Pager([string]$root) {
  $prefix = $root.TrimEnd('\') + '\'
  $inRoot = { param($path) $path -and $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) }
  $windows = @(Get-Process -Name Pager -ErrorAction SilentlyContinue | Where-Object { & $inRoot $_.Path })
  $windows | ForEach-Object { $_.CloseMainWindow() | Out-Null }
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  foreach ($w in $windows) { $w.WaitForExit([int][Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)) | Out-Null }
  # The window is only a client. The session daemon (a node.exe inside this folder) outlives it and keeps the files open, so ask it to stop first.
  $node = Join-Path $root 'resources\node\node.exe'
  $cli = Join-Path $root 'resources\app\pager\dist\cli.js'
  if ((Test-Path $node) -and (Test-Path $cli)) { Stop-Daemon $node $cli }
  # Anything still running from this folder (a daemon in another data directory, a helper) would block the replacement.
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $PID -and (& $inRoot $_.ExecutablePath) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($env:OS -ne 'Windows_NT') { throw 'The Pager desktop window is Windows only.' }
$Dir = [IO.Path]::GetFullPath($Dir).TrimEnd('\')
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
  $old = $null
  if (Test-Path $Dir) {
    # Renaming first is all-or-nothing: if something still holds a file open, the old install is left whole instead of half deleted.
    $old = "$Dir.old-" + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    for ($try = 0; ; $try++) {
      try { Rename-Item -LiteralPath $Dir -NewName (Split-Path $old -Leaf); break }
      catch { if ($try -ge 5) { throw "Pager is still running from $Dir. Close it and run the installer again. ($($_.Exception.Message))" }; Start-Sleep -Seconds 1 }
    }
  }
  New-Item -ItemType Directory -Path (Split-Path $Dir) -Force | Out-Null
  try { Move-Item -LiteralPath $root -Destination $Dir }
  catch { if ($old) { Rename-Item -LiteralPath $old -NewName (Split-Path $Dir -Leaf) }; throw }
  Get-ChildItem -LiteralPath (Split-Path $Dir) -Directory -Filter ((Split-Path $Dir -Leaf) + '.old-*') -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Installed to $Dir"
  # A daemon from an older build (a copy running from another folder, say) would be reused by the new window and keep its old behaviour, so it is retired too.
  $node = Join-Path $Dir 'resources\node\node.exe'
  $cli = Join-Path $Dir 'resources\app\pager\dist\cli.js'
  try {
    $newVersion = (Get-Content (Join-Path $Dir 'resources\app\pager\package.json') -Raw | ConvertFrom-Json).version
    $running = (& $node $cli daemon status 2>&1 | Out-String)
    if ($running -match 'running: pid \d+, (\S+?),' -and $Matches[1] -ne $newVersion) {
      Write-Host "Stopping the running Pager daemon ($($Matches[1])) so the window starts $newVersion; its terminal sessions end."
      Stop-Daemon $node $cli
    }
  } catch { Write-Host "Could not check the running daemon: $($_.Exception.Message)" }
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

if ($NoIntegrate) { Write-Host "Run $exe to start."; return }
# Pager.exe --install adds the Start menu entry and "Open Pager here", and falls back to the Windows Terminal host when Smart App Control refuses the exe.
Start-Process -FilePath $exe -ArgumentList '--install' -Wait
Write-Host 'Done. Start "Pager" from the Start menu, or right-click a folder > Open Pager here.'
