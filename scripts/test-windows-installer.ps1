param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$Version,
    [switch]$RequireWizard
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class NsisWizard {
    private delegate bool VisitWindow(IntPtr window, IntPtr data);

    [DllImport("user32.dll")] private static extern bool EnumWindows(VisitWindow visit, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr window, VisitWindow visit, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr window, int id);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder title, int size);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr command, IntPtr control);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(
        IntPtr window, uint message, IntPtr wParam, string value, uint flags, uint timeout, out IntPtr result);

    private static IntPtr[] VisibleWindows(int processId) {
        var windows = new List<IntPtr>();
        EnumWindows((window, data) => {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner == processId && IsWindowVisible(window)) windows.Add(window);
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }

    public static IntPtr[] FindPage(int processId, string controlClass, int buttonStyle) {
        foreach (IntPtr window in VisibleWindows(processId)) {
            IntPtr next = GetDlgItem(window, 1); // IDOK is Next, Install or Finish.
            if (next == IntPtr.Zero || !IsWindowEnabled(next) || !IsWindowVisible(next)) continue;
            IntPtr match = IntPtr.Zero;
            EnumChildWindows(window, (child, data) => {
                if (!IsWindowVisible(child)) return true;
                var name = new StringBuilder(64);
                GetClassName(child, name, name.Capacity);
                if (!String.Equals(name.ToString(), controlClass, StringComparison.OrdinalIgnoreCase)) return true;
                if (buttonStyle >= 0 && (GetWindowLong(child, -16) & 0x0f) != buttonStyle) return true;
                match = child;
                return false;
            }, IntPtr.Zero);
            if (match != IntPtr.Zero) return new[] { window, match };
        }
        return null;
    }

    public static string WindowTitles(int processId) {
        var titles = new List<string>();
        foreach (IntPtr window in VisibleWindows(processId)) {
            var title = new StringBuilder(256);
            GetWindowText(window, title, title.Capacity);
            titles.Add(title.ToString());
        }
        return titles.Count == 0 ? "no visible windows" : String.Join(", ", titles);
    }

    public static void Advance(IntPtr dialog) {
        // WM_COMMAND with IDOK and BN_CLICKED, the same notification as the enabled button.
        if (!PostMessage(dialog, 0x0111, new IntPtr(1), GetDlgItem(dialog, 1)))
            throw new InvalidOperationException("Could not advance the setup wizard.");
    }

    public static void SetDirectory(IntPtr edit, string path) {
        IntPtr result;
        if (SendMessageTimeout(edit, 0x000c, IntPtr.Zero, path, 2, 5000, out result) == IntPtr.Zero || result == IntPtr.Zero)
            throw new InvalidOperationException("Could not set the installation directory.");
    }
}
'@

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

if (Get-WorkbenchRegistration) { throw 'Use a clean Windows user profile for this test.' }
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$setup = Start-Process -FilePath $installerPath -PassThru
$installDirectory = $null
try {
    $scopePage = Wait-ForResult {
        if ($setup.HasExited) {
            if ($RequireWizard) { throw 'Setup exited without showing the installation wizard.' }
            return 'OneClick'
        }
        [NsisWizard]::FindPage($setup.Id, 'Button', 9) # BS_AUTORADIOBUTTON
    } 'Setup did not show the installation scope page.' -TimeoutSeconds 90

    if ('OneClick' -ne $scopePage) {
        [NsisWizard]::Advance($scopePage[0])
        $directoryPage = Wait-ForResult {
            [NsisWizard]::FindPage($setup.Id, 'Edit', -1)
        } 'Setup did not offer an installation directory.'
        $installDirectory = Join-Path $env:LOCALAPPDATA "Workbench Test $([guid]::NewGuid())"
        [NsisWizard]::SetDirectory($directoryPage[1], $installDirectory)
        [NsisWizard]::Advance($directoryPage[0])

        $finishPage = Wait-ForResult {
            [NsisWizard]::FindPage($setup.Id, 'Button', 3) # BS_AUTOCHECKBOX
        } 'Setup did not show the finish page with its launch option.' -TimeoutSeconds 90
        [NsisWizard]::Advance($finishPage[0])
    }
    Wait-NsisExit $setup $installerPath
} catch {
    Write-Host "Installer windows: $([NsisWizard]::WindowTitles($setup.Id))"
    throw
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
