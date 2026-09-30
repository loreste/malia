# Malia installer for Windows.
# Downloads a prebuilt binary from GitHub releases.
# No Rust, no build tools, no dependencies required.
#
# Usage:
#   irm https://raw.githubusercontent.com/loreste/malia/main/scripts/install.ps1 | iex
#
# Options (environment variables):
#   MALIA_VERSION     - release tag (default: latest)
#   MALIA_INSTALL_DIR - install location (default: %LOCALAPPDATA%\malia)

$ErrorActionPreference = "Stop"

$InstallDir = if ($env:MALIA_INSTALL_DIR) { $env:MALIA_INSTALL_DIR } else { "$env:LOCALAPPDATA\malia" }
$BinDir = "$InstallDir\bin"
$Repo = "loreste/malia"
$Version = if ($env:MALIA_VERSION) { $env:MALIA_VERSION } else { "latest" }

if (-not [Environment]::Is64BitOperatingSystem) {
    Write-Error "Malia requires 64-bit Windows."
    exit 1
}

$DownloadUrl = if ($Version -eq "latest") {
    "https://github.com/$Repo/releases/latest/download/malia-win32-x64.zip"
} else {
    "https://github.com/$Repo/releases/download/$Version/malia-win32-x64.zip"
}

Write-Host "Installing malia for win32-x64..."
Write-Host "  from: $DownloadUrl"

if (-not (Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
}

$TempZip = Join-Path ([System.IO.Path]::GetTempPath()) "malia-install.zip"

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    try {
        Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempZip -UseBasicParsing
    } catch {
        Write-Host ""
        Write-Host "Error: download failed." -ForegroundColor Red
        Write-Host "Check available releases at: https://github.com/$Repo/releases"
        Write-Host ""
        Write-Host "To build from source instead:"
        Write-Host "  git clone https://github.com/$Repo.git; cd malia; cargo build --release"
        exit 1
    }

    Expand-Archive -Path $TempZip -DestinationPath $BinDir -Force

    if (-not (Test-Path "$BinDir\jse.exe") -and (Test-Path "$BinDir\malia.exe")) {
        Copy-Item "$BinDir\malia.exe" -Destination "$BinDir\jse.exe" -Force
    }
} finally {
    if (Test-Path $TempZip) {
        Remove-Item $TempZip -Force -ErrorAction SilentlyContinue
    }
}

# Verify the binary runs.
try {
    $ver = & "$BinDir\malia.exe" --version 2>&1
} catch {
    $ver = "unknown"
}

# Add to PATH if needed.
$UserPath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::User)
if ($UserPath -notlike "*$BinDir*") {
    $NewPath = if ($UserPath) { "$UserPath;$BinDir" } else { $BinDir }
    [Environment]::SetEnvironmentVariable("Path", $NewPath, [EnvironmentVariableTarget]::User)
    $env:Path = "$env:Path;$BinDir"
}

Write-Host ""
Write-Host "Installed malia $ver" -ForegroundColor Green
Write-Host "  malia: $BinDir\malia.exe"
Write-Host "  jse:   $BinDir\jse.exe"
Write-Host ""
Write-Host "Open a new terminal and run: malia --help"
