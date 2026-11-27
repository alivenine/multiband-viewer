# Builds the Windows installer. Installs missing tools with winget (built into Windows 10/11).
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User') + ';' +
              (Join-Path $env:USERPROFILE '.cargo\bin')
}
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Install($id, $extra = @()) {
  Write-Host "`n>> Installing $id ..." -ForegroundColor Cyan
  winget install --id $id -e --accept-source-agreements --accept-package-agreements @extra
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) { throw "winget failed to install $id (code $LASTEXITCODE)" }
  Refresh-Path
}

if (-not (Has 'winget')) { throw 'winget not found. Install "App Installer" from the Microsoft Store, then run again.' }
Refresh-Path

# 1. C++ build tools (needed by Rust on Windows)
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasVC = (Test-Path $vswhere) -and (& $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
if (-not $hasVC) {
  Install 'Microsoft.VisualStudio.2022.BuildTools' @('--override', '--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended')
}

# 2. Node.js
if (-not (Has 'node')) { Install 'OpenJS.NodeJS.LTS' }

# 3. Rust
if (-not (Has 'cargo')) {
  Install 'Rustlang.Rustup'
  rustup default stable-msvc
}

Write-Host "`n>> node $(node -v), $(cargo -V)" -ForegroundColor Cyan

# 4. Build (clean reinstall of npm packages, the folder may come from a Mac)
Write-Host "`n>> Installing packages ..." -ForegroundColor Cyan
if (Test-Path node_modules) { Remove-Item -Recurse -Force node_modules }
if (Test-Path src-tauri\target\release\bundle\macos) { Remove-Item -Recurse -Force src-tauri\target }  # Mac build output
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }

Write-Host "`n>> Building app (first build takes a few minutes) ..." -ForegroundColor Cyan
npx tauri build
if ($LASTEXITCODE -ne 0) { throw 'tauri build failed' }

# 5. Collect installers
$out = Join-Path (Get-Location) 'installers'
New-Item -ItemType Directory -Force $out | Out-Null
Get-ChildItem src-tauri\target\release\bundle -Recurse -Include *.exe, *.msi | Copy-Item -Destination $out -Force
Copy-Item src-tauri\target\release\multiband-viewer.exe (Join-Path $out 'MultibandViewer-portable.exe') -Force

Write-Host "`nDone. Installers are in: $out" -ForegroundColor Green
Write-Host '  *-setup.exe  = installer (recommended)'
Write-Host '  *.msi        = installer for IT / group policy'
Write-Host '  MultibandViewer-portable.exe = runs without installing'
Start-Process explorer.exe $out
