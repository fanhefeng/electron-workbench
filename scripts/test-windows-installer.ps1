param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$Version
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

function Get-WorkbenchRegistration {
    Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayVersion -and $_.DisplayName -eq "Workbench $($_.DisplayVersion)" }
}

function Invoke-Nsis([string]$Path, [string]$Arguments) {
    $options = @{ FilePath = $Path; PassThru = $true }
    if ($Arguments) { $options.ArgumentList = $Arguments }
    $process = Start-Process @options
    if (-not $process.WaitForExit(90000)) {
        $process.Kill()
        throw "Timed out running $Path"
    }
    if ($process.ExitCode -ne 0) { throw "$Path exited with code $($process.ExitCode)" }
}

function Wait-ForResult([scriptblock]$Read, [string]$Failure) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $result = & $Read
        if ($result) { return $result }
        Start-Sleep -Milliseconds 500
    } while ($timer.Elapsed.TotalSeconds -lt 30)
    throw $Failure
}

if (Get-WorkbenchRegistration) { throw 'Use a clean Windows user profile for this test.' }
Invoke-Nsis (Resolve-Path -LiteralPath $Installer).Path

$registration = Get-WorkbenchRegistration
if ($registration.DisplayVersion -ne $Version -or $registration.QuietUninstallString -notmatch '^"([^"]+)" (/currentuser /S)$') {
    throw "Workbench $Version did not register a per-user installation and uninstaller."
}
$uninstaller = $Matches[1]
$uninstallArguments = $Matches[2]
$appPath = Join-Path (Split-Path -Parent $uninstaller) 'Workbench.exe'
if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) { throw "Installed executable missing: $appPath" }
Write-Host "Installed Workbench $Version"

$workspaceName = [Windows.Automation.PropertyCondition]::new(
    [Windows.Automation.AutomationElement]::NameProperty, '工作区'
)
$app = Wait-ForResult {
    $process = Get-Process -Name Workbench -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $appPath -and $_.MainWindowHandle -ne [IntPtr]::Zero } |
        Select-Object -First 1
    if ($process) {
        $window = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
        if ($window.FindFirst([Windows.Automation.TreeScope]::Descendants, $workspaceName)) { $process }
    }
} 'The installed app did not open the Workbench workspace.'
Write-Host 'The installer started Workbench and the workspace rendered.'

# Keep the handle of the installer-started process so its exit code remains readable.
$null = $app.Handle
if (-not $app.CloseMainWindow()) { throw 'Could not close the Workbench window.' }
if (-not $app.WaitForExit(15000)) { throw 'Workbench did not exit after the window was closed.' }
$exitCode = $app.ExitCode
$app.Dispose()
if ($exitCode -ne 0) { throw "Workbench exited with code [$exitCode]." }
Invoke-Nsis $uninstaller $uninstallArguments
$null = Wait-ForResult {
    -not (Test-Path -LiteralPath $appPath) -and -not (Test-Path -LiteralPath $registration.PSPath)
} 'The uninstaller did not remove Workbench and its uninstall registration.'
Write-Host 'Uninstalled Workbench.'
