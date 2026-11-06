param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$Version,
    [switch]$RequireWizard
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

function Get-WorkbenchRegistration {
    Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayVersion -and $_.DisplayName -eq "Workbench $($_.DisplayVersion)" }
}

function Wait-NsisExit([Diagnostics.Process]$Process, [string]$Path) {
    if (-not $process.WaitForExit(90000)) {
        $process.Kill()
        throw "Timed out running $Path"
    }
    if ($process.ExitCode -ne 0) { throw "$Path exited with code $($process.ExitCode)" }
}

function Wait-ForResult([scriptblock]$Read, [string]$Failure, [int]$TimeoutSeconds = 30) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $result = & $Read
        if ($result) { return $result }
        Start-Sleep -Milliseconds 500
    } while ($timer.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    throw $Failure
}

function Get-WizardControl(
    [Diagnostics.Process]$Process,
    [Windows.Automation.AutomationProperty]$Property,
    [object]$Value
) {
    $process.Refresh()
    if ($process.HasExited) { return }
    $handle = $process.MainWindowHandle
    if ($handle -eq [IntPtr]::Zero) { return }
    $window = [Windows.Automation.AutomationElement]::FromHandle($handle)
    $condition = [Windows.Automation.PropertyCondition]::new($Property, $Value)
    $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
}

function Invoke-WizardButton([Diagnostics.Process]$Process) {
    # NSIS uses IDOK (1) for Next, Install and Finish, independent of the display language.
    $button = Wait-ForResult {
        Get-WizardControl $process ([Windows.Automation.AutomationElement]::AutomationIdProperty) '1'
    } 'The setup wizard did not show its confirmation button.'
    $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
}

if (Get-WorkbenchRegistration) { throw 'Use a clean Windows user profile for this test.' }
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$setup = Start-Process -FilePath $installerPath -PassThru
$installDirectory = $null
try {
    $controlType = [Windows.Automation.AutomationElement]::ControlTypeProperty
    $installerMode = Wait-ForResult {
        if ($setup.HasExited) {
            if ($RequireWizard) { throw 'Setup exited without showing the installation wizard.' }
            return 'OneClick'
        }
        if (Get-WizardControl $setup $controlType ([Windows.Automation.ControlType]::RadioButton)) {
            return 'Assisted'
        }
    } 'Setup did not show the installation scope page.' -TimeoutSeconds 90

    if ($installerMode -eq 'Assisted') {
        Invoke-WizardButton $setup
        $directoryInput = Wait-ForResult {
            Get-WizardControl $setup $controlType ([Windows.Automation.ControlType]::Edit)
        } 'Setup did not offer an installation directory.'
        $installDirectory = Join-Path $env:LOCALAPPDATA "Workbench Test $([guid]::NewGuid())"
        $directoryInput.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($installDirectory)
        Invoke-WizardButton $setup

        $null = Wait-ForResult {
            Get-WizardControl $setup $controlType ([Windows.Automation.ControlType]::CheckBox)
        } 'Setup did not show the finish page with its launch option.' -TimeoutSeconds 90
        Invoke-WizardButton $setup
    }
    Wait-NsisExit $setup $installerPath
} finally {
    if (-not $setup.HasExited) { $setup.Kill() }
    $setup.Dispose()
}

$registration = Get-WorkbenchRegistration
if ($registration.DisplayVersion -ne $Version -or $registration.QuietUninstallString -notmatch '^"([^"]+)" (/currentuser /S)$') {
    throw "Workbench $Version did not register a per-user installation and uninstaller."
}
$uninstaller = $Matches[1]
$uninstallArguments = $Matches[2]
$installedDirectory = Split-Path -Parent $uninstaller
if ($installDirectory -and $installedDirectory -ne $installDirectory) {
    throw "Workbench was installed to $installedDirectory instead of $installDirectory."
}
$appPath = Join-Path $installedDirectory 'Workbench.exe'
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
$uninstall = Start-Process -FilePath $uninstaller -ArgumentList $uninstallArguments -PassThru
Wait-NsisExit $uninstall $uninstaller
$uninstall.Dispose()
$null = Wait-ForResult {
    -not (Test-Path -LiteralPath $appPath) -and -not (Test-Path -LiteralPath $registration.PSPath)
} 'The uninstaller did not remove Workbench and its uninstall registration.'
Write-Host 'Uninstalled Workbench.'
