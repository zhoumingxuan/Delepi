#Requires -Version 5.1
<#
.SYNOPSIS
  fix-electron-binary.ps1 - Idempotent electron binary repair script

.DESCRIPTION
  Implements the strict three-stage check from @electron/get install.js:62-72:
    1) dist\version  byte-equality vs electron/package.json version
    2) path.txt      byte-equality vs platformPath
    3) dist\<binary> existence

  If any check fails, repair only that stage (do not delete the directory,
  do not modify package.json, do not touch anything outside dist/).

  All writes use [System.IO.File]::WriteAllBytes with raw UTF-8 bytes (no CRLF).

  Mirror: https://registry.npmmirror.com/-/binary/electron/v42.4.1/electron-v42.4.1-{platform}-{arch}.zip

  Idempotency: running twice produces identical state with no side effects.

.EXIT_CODES
  0 = success / no action needed
  1 = fatal error (download failure, etc.)
  2 = auto-repaired but user attention recommended

.NOTES
  PowerShell 5.1 (Windows PowerShell) compatible.
  Also tested with PowerShell 7.x.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# --- Determine script directory (NOT CWD-dependent) ---
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) {
    # Fallback for PowerShell 2.0 (rare); should not happen on PS 5.1+
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
}

# --- Project root = one level up from scripts/ ---
$ProjectRoot = Split-Path -Parent $ScriptDir

# --- node_modules\electron path ---
$ElectronDir = Join-Path $ProjectRoot 'node_modules\electron'
$ElectronPackageJson = Join-Path $ElectronDir 'package.json'
$DistDir = Join-Path $ElectronDir 'dist'
$PathTxt = Join-Path $ElectronDir 'path.txt'
$DistVersion = Join-Path $DistDir 'version'
$ExpectedElectronVersion = '42.8.0'
$MirrorBase = 'https://registry.npmmirror.com/-/binary/electron'

# --- Platform detection (PS 5.1 compatible) ---
function Get-ScriptPlatform {
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        if ($IsWindows) { return 'win32' }
        elseif ($IsMacOS) { return 'darwin' }
        elseif ($IsLinux) { return 'linux' }
    }
    # PS 5.1 fallback: use environment variables
    if ($env:OS -eq 'Windows_NT') { return 'win32' }
    if ($env:OSTYPE) {
        if ($env:OSTYPE -like 'darwin*') { return 'darwin' }
        if ($env:OSTYPE -like 'linux*') { return 'linux' }
    }
    if ($IsLinux -eq $true) { return 'linux' }   # PS 6 on Linux without OSTYPE
    if ($IsMacOS -eq $true) { return 'darwin' }  # PS 6 on macOS without OSTYPE
    # Last resort: query uname
    if (Test-Path '/usr/bin/uname') {
        $u = (& /usr/bin/uname -s) 2>$null
        if ($u -eq 'Darwin') { return 'darwin' }
        if ($u -eq 'Linux') { return 'linux' }
    }
    throw 'Cannot determine platform: not Windows, macOS, or Linux'
}

# --- Architecture detection (PS 5.1 compatible) ---
function Get-ScriptArch {
    if ($env:PROCESSOR_ARCHITECTURE -eq 'AMD64') { return 'x64' }
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { return 'arm64' }
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        return [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLower()
    }
    # 5.1 fallback: use .NET
    try {
        $procArch = [System.Reflection.Assembly]::GetExecutingAssembly().GetName().ProcessorArchitecture.ToString().ToLower()
        if ($procArch -eq 'amd64') { return 'x64' }
        if ($procArch -eq 'arm64') { return 'arm64' }
    } catch { }
    return 'x64'  # default
}

# --- Platform-specific binary path (relative to dist/) ---
function Get-PlatformBinary {
    param([string]$Platform)
    switch ($Platform) {
        'win32'  { return 'electron.exe' }
        'darwin' { return 'Electron.app/Contents/MacOS/Electron' }
        'linux'  { return 'electron' }
        default   { throw "Unknown platform: $Platform" }
    }
}

# --- Read raw bytes from file ---
function Read-Bytes {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return [System.IO.File]::ReadAllBytes($Path)
}

# --- Write raw UTF-8 bytes to file (NO CRLF, NO BOM) ---
function Write-RawUtf8 {
    param(
        [string]$Path,
        [string]$Content
    )
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Content)
    [System.IO.File]::WriteAllBytes($Path, $bytes)
}

# --- Download with fallback Invoke-WebRequest / curl / wget ---
function Download-ElectronZip {
    param(
        [string]$Url,
        [string]$Destination
    )
    $ok = $false
    $lastError = $null

    if (-not (Get-Command -Name 'Invoke-WebRequest' -ErrorAction SilentlyContinue)) {
        $ok = $false
    } else {
        try {
            Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -TimeoutSec 600
            if ((Test-Path -LiteralPath $Destination) -and (Get-Item -LiteralPath $Destination).Length -gt 0) {
                $ok = $true
            }
        } catch {
            $lastError = $_.Exception.Message
        }
    }

    if (-not $ok) {
        # Try curl fallback
        $curl = Get-Command -Name 'curl.exe' -ErrorAction SilentlyContinue
        if ($curl) {
            try {
                & curl.exe -L -o $Destination --connect-timeout 30 --max-time 600 $Url 2>&1 | Out-Null
                if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $Destination) -and (Get-Item -LiteralPath $Destination).Length -gt 0) {
                    $ok = $true
                } else {
                    $lastError = "curl exit $LASTEXITCODE"
                }
            } catch {
                $lastError = $_.Exception.Message
            }
        }
    }

    if (-not $ok) {
        Write-Host "[fix-electron-binary] FATAL: failed to download $Url"
        if ($lastError) { Write-Host "  Last error: $lastError" }
        return $false
    }
    return $true
}

# --- Main ---
$Platform = Get-ScriptPlatform
$Arch = Get-ScriptArch
$BinaryName = Get-PlatformBinary -Platform $Platform
$DistBinary = Join-Path $DistDir $BinaryName

Write-Host "[fix-electron-binary] Platform=$Platform Arch=$Arch BinaryName=$BinaryName"
Write-Host "[fix-electron-binary] ElectronDir=$ElectronDir"
Write-Host "[fix-electron-binary] DistDir=$DistDir"

# --- Validate environment ---
if (-not (Test-Path -LiteralPath $ElectronPackageJson)) {
    Write-Host "[fix-electron-binary] FATAL: $ElectronPackageJson not found; run npm install first."
    exit 1
}

# Read package.json to get version
try {
    $pkg = Get-Content -Raw -LiteralPath $ElectronPackageJson -Encoding UTF8 | ConvertFrom-Json
} catch {
    Write-Host "[fix-electron-binary] FATAL: failed to parse $ElectronPackageJson : $($_.Exception.Message)"
    exit 1
}
$ElectronVersion = $pkg.version
Write-Host "[fix-electron-binary] Electron version (from package.json): $ElectronVersion"

# --- Ensure dist dir exists ---
if (-not (Test-Path -LiteralPath $DistDir)) {
    New-Item -ItemType Directory -Path $DistDir -Force | Out-Null
    Write-Host "[fix-electron-binary] Created missing dist directory."
}

# --- Three-stage checks (idempotent) ---
$needsRepair = $false
$repaired = @()
$skipReason = @()

# Stage 1: dist\version
$expectedVersionBytes = [System.Text.Encoding]::UTF8.GetBytes($ElectronVersion)
$actualVersionBytes = Read-Bytes -Path $DistVersion
if ($null -eq $actualVersionBytes) {
    Write-Host "[CHECK 1/3] dist\version: MISSING -- needs repair"
    Write-RawUtf8 -Path $DistVersion -Content $ElectronVersion
    Write-Host "  Repaired: wrote '$ElectronVersion' (raw UTF-8, $([System.IO.File]::ReadAllBytes($DistVersion).Length) bytes)"
    $needsRepair = $true
    $repaired += 'dist\version'
} elseif (-not [System.Linq.Enumerable]::SequenceEqual([byte[]]$actualVersionBytes, [byte[]]$expectedVersionBytes)) {
    Write-Host "[CHECK 1/3] dist\version: MISMATCH -- needs repair"
    Write-Host "  Actual:   $([System.Text.Encoding]::UTF8.GetString($actualVersionBytes))"
    Write-Host "  Expected: $ElectronVersion"
    Write-RawUtf8 -Path $DistVersion -Content $ElectronVersion
    Write-Host "  Repaired: wrote '$ElectronVersion'"
    $needsRepair = $true
    $repaired += 'dist\version'
} else {
    Write-Host "[CHECK 1/3] dist\version: OK ($([System.Text.Encoding]::UTF8.GetString($actualVersionBytes)))"
}

# Stage 2: path.txt
$expectedPathBytes = [System.Text.Encoding]::UTF8.GetBytes($BinaryName)
$actualPathBytes = Read-Bytes -Path $PathTxt
if ($null -eq $actualPathBytes) {
    Write-Host "[CHECK 2/3] path.txt: MISSING -- needs repair"
    Write-RawUtf8 -Path $PathTxt -Content $BinaryName
    Write-Host "  Repaired: wrote '$BinaryName' (raw UTF-8, $([System.IO.File]::ReadAllBytes($PathTxt).Length) bytes)"
    $needsRepair = $true
    $repaired += 'path.txt'
} elseif (-not [System.Linq.Enumerable]::SequenceEqual([byte[]]$actualPathBytes, [byte[]]$expectedPathBytes)) {
    Write-Host "[CHECK 2/3] path.txt: MISMATCH -- needs repair"
    Write-Host "  Actual bytes: $($actualPathBytes -join ',')"
    Write-Host "  Expected:     $BinaryName"
    Write-RawUtf8 -Path $PathTxt -Content $BinaryName
    Write-Host "  Repaired: wrote '$BinaryName' (raw UTF-8, $([System.IO.File]::ReadAllBytes($PathTxt).Length) bytes)"
    $needsRepair = $true
    $repaired += 'path.txt'
} else {
    Write-Host "[CHECK 2/3] path.txt: OK ($BinaryName, $($actualPathBytes.Length) bytes)"
}

# Stage 3: dist\<binary>
if (-not (Test-Path -LiteralPath $DistBinary)) {
    Write-Host "[CHECK 3/3] $DistBinary : MISSING -- needs repair"
    # Download from npmmirror
    $zipName = "electron-v$ElectronVersion-$Platform-$Arch.zip"
    $zipUrl = "$MirrorBase/v$ElectronVersion/$zipName"
    $zipPath = Join-Path $env:TEMP $zipName
    if (-not $env:TEMP) { $zipPath = Join-Path $ProjectRoot $zipName }

    Write-Host "  Downloading $zipUrl"
    $dlOk = Download-ElectronZip -Url $zipUrl -Destination $zipPath
    if (-not $dlOk) {
        Write-Host "[fix-electron-binary] FATAL: cannot download $zipUrl"
        if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue }
        exit 1
    }

    Write-Host "  Extracting to $DistDir ..."
    try {
        # Ensure dist dir empty (only if missing binary, we are recovering)
        Expand-Archive -Path $zipPath -DestinationPath $DistDir -Force
        Write-Host "  Extracted."
    } catch {
        Write-Host "[fix-electron-binary] FATAL: Expand-Archive failed: $($_.Exception.Message)"
        if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue }
        exit 1
    }

    # After extraction, electron.d.ts may need to be moved up; install.js does this.
    # The npm install postinstall normally handles that. For idempotent fix, also do it.
    $srcTypeDef = Join-Path $DistDir 'electron.d.ts'
    $targetTypeDef = Join-Path $ElectronDir 'electron.d.ts'
    if ((Test-Path -LiteralPath $srcTypeDef) -and (-not (Test-Path -LiteralPath $targetTypeDef))) {
        Move-Item -LiteralPath $srcTypeDef -Destination $targetTypeDef -Force
        Write-Host "  Moved electron.d.ts to $targetTypeDef"
    }

    # Cleanup zip
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue }

    if (-not (Test-Path -LiteralPath $DistBinary)) {
        Write-Host "[fix-electron-binary] FATAL: post-extraction $DistBinary still missing"
        exit 1
    }
    Write-Host "  Repaired: downloaded and extracted to $DistBinary"
    $needsRepair = $true
    $repaired += $DistBinary
} else {
    $binSize = (Get-Item -LiteralPath $DistBinary).Length
    Write-Host "[CHECK 3/3] $DistBinary : OK ($binSize bytes)"
}

# --- Final summary ---
if (-not $needsRepair) {
    Write-Host "[fix-electron-binary] All checks passed, no action needed"
    exit 0
} else {
    Write-Host "[fix-electron-binary] Repaired: $($repaired -join ', ')"
    Write-Host "[fix-electron-binary] User attention recommended - re-verify if issue persists"
    exit 2
}
