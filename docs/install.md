# 下载与安装 / Download and install

本版本没有付费代码签名证书：macOS 使用 ad-hoc 签名，未经 Apple 公证；Windows 安装包未签名。首次运行可能被系统拦截。

This build uses ad-hoc signing on macOS without Apple notarization. Windows installers are unsigned. Your operating system may ask you to approve the app before its first launch.

## 选择安装包 / Choose a download

| 系统 / System                 | 文件名后缀 / Filename suffix            |
| ----------------------------- | --------------------------------------- |
| macOS Apple Silicon（M 系列） | `mac-arm64.dmg` 或 / or `mac-arm64.zip` |
| macOS Intel                   | `mac-x64.dmg` 或 / or `mac-x64.zip`     |
| Windows x64                   | `win-x64.exe`                           |
| Linux x64                     | `linux-x86_64.AppImage`                 |

下载本 Release 的安装包附件。GitHub 自动生成的 Source code 压缩包包含源码，不能直接安装。

Download an installer attached to this release. GitHub's automatically generated Source code archives contain source files, not an installable app.

## macOS

1. 打开 DMG，将 Workbench 拖入“应用程序”；使用 ZIP 时，解压后将 Workbench.app 移入“应用程序”。
2. 首次尝试打开后，如系统拦截，进入“系统设置”的“隐私与安全性”，找到 Workbench 并点击“仍要打开”，再确认打开。
3. 如果 Workbench 仍被下载隔离拦截，或点击“仍要打开”后 Dock 图标一直跳动且没有窗口，先退出仍在运行的 Workbench，必要时强制退出。确认下载来源和 SHA-256 后，在终端执行下面两条命令，移除这个 Workbench 副本的下载隔离标记并启动应用。受组织管理的设备可能禁止用户放行。

Open the DMG and drag Workbench into Applications, or extract the ZIP and move Workbench.app there. After trying to launch it, approve Workbench in System Settings, Privacy & Security, Open Anyway. If quarantine still blocks the app or the Dock icon keeps bouncing without a window, quit Workbench if it is running. Force quit if it does not respond. Verify the download source and SHA-256, then run the following two commands to clear the quarantine attribute from this copy and launch it. Managed devices may prevent these overrides.

```bash
xattr -dr com.apple.quarantine /Applications/Workbench.app
open /Applications/Workbench.app
```

如果从 `/Applications` 启动仍卡住，从同一个已校验的安装包复制一份新的 `Workbench.app` 到个人“应用程序”目录 `~/Applications`（没有该目录就先创建）。将上述两条命令中的 `/Applications/Workbench.app` 替换为 `"$HOME/Applications/Workbench.app"`。确认新副本能打开后，移走旧副本，避免从 Dock 或 Spotlight 打开旧版。工作区和设置会沿用。

If launching from `/Applications` still stalls, copy a fresh `Workbench.app` from the verified installer into your own Applications folder, `~/Applications`, creating the folder if needed. Replace `/Applications/Workbench.app` in both commands with `"$HOME/Applications/Workbench.app"`. Once the new copy opens, move the old copy aside so Dock or Spotlight does not launch it. The new copy uses your existing workspace and settings.

参考 / Reference: [Apple：打开未公证或未知开发者的应用 / Open an app from an unidentified developer](https://support.apple.com/en-us/102445)。

## Windows

下载 `win-x64.exe`，核对 SHA-256 后双击运行。按安装向导选择仅为当前用户或为所有用户安装，点击“下一步”，选择安装目录后点击“安装”。完成时可选择是否启动 Workbench。以后可从开始菜单启动，在“设置”的“已安装的应用”中卸载。

Download `win-x64.exe`, verify its SHA-256, and double-click it. In the setup wizard, choose whether to install for the current user or all users, click Next, then choose a folder and click Install. On the final page, you can choose whether to open Workbench. Use the Start menu to launch it again, or Settings, Installed apps to uninstall it.

安装包未签名。SmartScreen 提示无法识别应用时，如有“更多信息”和“仍要运行”选项，可在确认来源和校验值后选择。启用了 Smart App Control 或受组织策略管理的设备可能会阻止安装。

The installer is unsigned. If SmartScreen warns about an unrecognized app, confirm the source and checksum before selecting More info and Run anyway, when available. Smart App Control or organization policies may block installation.

参考 / Reference: [Microsoft SmartScreen 与 Smart App Control](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/smartscreen-reputation)。

## Linux

在下载目录执行，替换文件名中的版本号：

Run these commands in the download directory, replacing the version in the filename:

```bash
chmod +x Workbench-0.1.3-linux-x86_64.AppImage
./Workbench-0.1.3-linux-x86_64.AppImage
```

## 校验下载 / Verify downloads

Release 包含 `SHA256SUMS`。以下命令可计算下载文件的 SHA-256，与清单中对应的值比较：

The release includes `SHA256SUMS`. Calculate your downloaded file's SHA-256 and compare it with the corresponding entry:

```bash
# macOS
shasum -a 256 Workbench-0.1.3-mac-arm64.dmg
# Linux
sha256sum Workbench-0.1.3-linux-x86_64.AppImage
```

```powershell
# Windows PowerShell
Get-FileHash .\Workbench-0.1.3-win-x64.exe -Algorithm SHA256
```

当前下载版本不启用应用内自动更新；更新时下载新版并重新安装。

In-app automatic updates are not configured for these downloads. Download and install a newer release to update.
