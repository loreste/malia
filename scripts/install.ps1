# Malia Installer (Windows PowerShell)
# Installs prebuilt native binaries for Malia and JSE.
# No Rust toolchain or build environment required.

$ErrorActionPreference = "Stop"

$InstallDir = if ($env:MALIA_INSTALL_DIR) { $env:MALIA_INSTALL_DIR } else { "$env:LOCALAPPDATA\malia" }
$BinDir = "$InstallDir\bin"
$Repo = if ($env:MALIA_REPO) { $env:MALIA_REPO } else { "loreste/malia" }
$Version = if ($env:MALIA_VERSION) { $env:MALIA_VERSION } else { "latest" }

# Check Architecture
$Arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
if ($Arch -ne "x64") {
    Write-Error "Malia currently supports 64-bit Windows (x64)."
    exit 1
}

Write-Host "Detected platform: win32-$Arch"

if (-not (Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
}

$LocalMalia = "$PSScriptRoot\..\target\release\malia.exe"
$LocalJse = "$PSScriptRoot\..\target\release\jse.exe"

if (Test-Path $LocalMalia) {
    Write-Host "Installing from local build: $LocalMalia"
    Copy-Item $LocalMalia -Destination "$BinDir\malia.exe" -Force
    if (Test-Path $LocalJse) {
        Copy-Item $LocalJse -Destination "$BinDir\jse.exe" -Force
    } else {
        Copy-Item "$BinDir\malia.exe" -Destination "$BinDir\jse.exe" -Force
    }
} else {
    $DownloadUrl = if ($Version -eq "latest") {
        "https://github.com/$Repo/releases/latest/download/malia-win32-x64.zip"
    } else {
        "https://github.com/$Repo/releases/$Version/download/malia-win32-x64.zip"
    }

    Write-Host "Downloading Malia from: $DownloadUrl"
    $TempZip = [System.IO.Path]::GetTempFileName() + ".zip"

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempZip -UseBasicParsing
        Expand-Archive -Path $TempZip -DestinationPath $BinDir -Force
        if (-not (Test-Path "$BinDir\jse.exe") -and (Test-Path "$BinDir\malia.exe")) {
            Copy-Item "$BinDir\malia.exe" -Destination "$BinDir\jse.exe" -Force
        }
    } finally {
        if (Test-Path $TempZip) {
            Remove-Item $TempZip -Force -ErrorAction SilentlyContinue
        }
    }
}

# Update User PATH if needed
$UserPath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::User)
if ($UserPath -notlike "*$BinDir*") {
    $NewPath = if ($UserPath) { "$UserPath;$BinDir" } else { $BinDir }
    [Environment]::SetEnvironmentVariable("Path", $NewPath, [EnvironmentVariableTarget]::User)
    $env:Path = "$env:Path;$BinDir"
    Write-Host "Added $BinDir to User Environment PATH"
}

Write-Host ""
Write-Host "Malia installed successfully!" -ForegroundColor Green
Write-Host "  Location: $BinDir\malia.exe"
Write-Host "  Alias:    $BinDir\jse.exe"
Write-Host ""
Write-Host "To verify your installation in a new terminal:"
Write-Host "  malia --version"
Write-Host "  jse --version"
