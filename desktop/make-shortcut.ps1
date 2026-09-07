<#
  make-shortcut.ps1 - one-time Desktop shortcut creator.
  --------------------------------------------------------------------------
  Creates "Questlog.lnk" on the current user's Desktop pointing at launch.mjs.
  Current user only - no admin, no registry writes beyond the shortcut file
  itself (which WScript.Shell writes for us).

  The shortcut launches node.exe on desktop\launch.mjs minimised, so
  double-clicking it goes straight to the Overworld. A console exists for the
  second the launcher runs and then closes - the trade for one launcher that is
  the same file on Windows, macOS and Linux instead of a PowerShell script.

  If desktop\questlog.ico is missing and Node is available, it is generated
  first via make-ico.mjs; otherwise the shortcut falls back to a stock Windows
  icon (imageres.dll,187) and this is reported.
#>
[CmdletBinding()]
param(
  [switch]$Force   # overwrite an existing Questlog.lnk without complaint
)

$ErrorActionPreference = "Stop"

$ScriptDir = $PSScriptRoot                      # ...\questlog\desktop
$AppRoot   = Split-Path -Parent $ScriptDir      # ...\questlog
$Launcher  = Join-Path $ScriptDir "launch.mjs"
$IcoPath   = Join-Path $ScriptDir "questlog.ico"

if (-not (Test-Path $Launcher)) { throw "launch.mjs not found next to this script ($Launcher)." }

# Generate the .ico if absent (best-effort; non-fatal).
if (-not (Test-Path $IcoPath)) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  $maker = Join-Path $ScriptDir "make-ico.mjs"
  if ($node -and (Test-Path $maker)) {
    try {
      Write-Host "Generating icon (questlog.ico)..."
      & $node.Source $maker $IcoPath | Write-Host
    } catch {
      Write-Warning "Icon generation failed: $($_.Exception.Message)"
    }
  }
}

# Resolve icon: our .ico if present, else a stock Windows glyph.
if (Test-Path $IcoPath) {
  $iconLocation = "$IcoPath,0"
  $iconNote = "using questlog.ico"
} else {
  $iconLocation = "$env:SystemRoot\System32\imageres.dll,187"
  $iconNote = "questlog.ico not found; using stock icon imageres.dll,187"
}

# Full path to node.exe (avoid PATH surprises inside the .lnk - Explorer
# resolves a shortcut, not a shell that inherited the founder's PATH).
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js is required and was not found on PATH. Install it from https://nodejs.org/ and re-run." }
$nodeExe = $node.Source

$desktop = [Environment]::GetFolderPath("Desktop")
$lnkPath = Join-Path $desktop "Questlog.lnk"

if ((Test-Path $lnkPath) -and -not $Force) {
  Write-Host "Questlog.lnk already exists on the Desktop. Re-run with -Force to overwrite."
}

$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($lnkPath)
$sc.TargetPath       = $nodeExe
$sc.Arguments        = '"{0}"' -f $Launcher
$sc.WorkingDirectory = $AppRoot
$sc.IconLocation     = $iconLocation
$sc.Description       = "Questlog - open the Overworld"
$sc.WindowStyle      = 7   # minimized (the launcher exits fast; nothing lingers)
$sc.Save()

Write-Host "Created shortcut: $lnkPath"
Write-Host "  Target : $nodeExe"
Write-Host "  Args   : $($sc.Arguments)"
Write-Host "  Icon   : $iconNote"
