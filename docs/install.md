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

1. 仅从本仓库的发布页下载，核对版本、芯片架构及 SHA256SUMS。摘要一致只确认文件身份，不代表应用安全或开发者可信。
2. 打开 DMG，将 Workbench 拖入“应用程序”；使用 ZIP 时，解压后将 Workbench.app 移入“应用程序”。
3. 此版本只有 ad-hoc 完整性签名，未经 Developer ID 签名或 Apple 公证。对于无法验证开发者的提示，仅在核实来源并自行决定信任后参考 Apple 指引；需要 Apple 验证版本的用户应等待签名、公证版本。
4. 「已损坏／被修改／将损坏电脑」不能当作普通的开发者验证提示。请停止打开，重新下载官方副本；警告持续时联系维护者。不要移除隔离属性或关闭 Gatekeeper 来规避。
5. Dock 图标持续跳动但没有窗口属于尚待诊断的启动问题，不能据此判断是隔离标记造成。请记录系统版本与提示并联系维护者，不要通过修改安全设置处理。受组织管理的设备请联系管理员。

Download only from this repository's releases and verify the version, architecture and SHA256SUMS. A matching hash confirms file identity, not safety or developer trust. Open the DMG and drag Workbench into Applications, or extract the ZIP and move Workbench.app there.

This build has only an ad-hoc integrity signature, not Developer ID signing or Apple notarization. For an unidentified-developer warning, consult Apple's guidance only after verifying the source and deciding to trust the app. Wait for a signed, notarized release if you require Apple verification.

Damage, modification or malware warnings are not ordinary developer-verification warnings. Stop opening the app, obtain a fresh official copy, and contact the maintainer if the warning persists. Do not remove quarantine attributes or disable Gatekeeper to bypass it.

A bouncing Dock icon without a window is an undiagnosed launch problem, not evidence of a quarantine issue. Record your macOS version and any warning and contact the maintainer; do not change security settings to work around it. Contact your administrator on managed devices.

参考 / Reference: [Apple：安全地打开 Mac 上的应用 / Safely open apps on your Mac](https://support.apple.com/en-us/102445)。

## Windows

下载 `win-x64.exe`，核对 SHA-256 后双击运行。按安装向导选择仅为当前用户或为所有用户安装，点击“下一步”，选择安装目录后点击“安装”。完成时可选择是否启动 Workbench。以后可从开始菜单启动，在“设置”的“已安装的应用”中卸载。

Download `win-x64.exe`, verify its SHA-256, and double-click it. In the setup wizard, choose whether to install for the current user or all users, click Next, then choose a folder and click Install. On the final page, you can choose whether to open Workbench. Use the Start menu to launch it again, or Settings, Installed apps to uninstall it.

安装包未签名。SmartScreen 提示无法识别应用时，如有“更多信息”和“仍要运行”选项，可在确认来源和校验值后选择。启用了 Smart App Control 或受组织策略管理的设备可能会阻止安装。

The installer is unsigned. If SmartScreen warns about an unrecognized app, confirm the source and checksum before selecting More info and Run anyway, when available. Smart App Control or organization policies may block installation.

参考 / Reference: [Microsoft SmartScreen 与 Smart App Control](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/smartscreen-reputation)。

## Linux

本文的 {{VERSION}} 表示所下载版本；发布页会自动填入准确版本号。请在下载目录执行：

In this guide, {{VERSION}} means the downloaded version; release notes fill it automatically. Run these commands in the download directory:

```bash
chmod +x Workbench-{{VERSION}}-linux-x86_64.AppImage
./Workbench-{{VERSION}}-linux-x86_64.AppImage
```

## 校验下载 / Verify downloads

Release 包含 `SHA256SUMS`。以下命令可计算下载文件的 SHA-256，与清单中对应的值比较：

The release includes `SHA256SUMS`. Calculate your downloaded file's SHA-256 and compare it with the corresponding entry:

```bash
# macOS
shasum -a 256 Workbench-{{VERSION}}-mac-arm64.dmg
# Linux
sha256sum Workbench-{{VERSION}}-linux-x86_64.AppImage
```

```powershell
# Windows PowerShell
Get-FileHash .\Workbench-{{VERSION}}-win-x64.exe -Algorithm SHA256
```

当前下载版本不启用应用内自动更新；更新时下载新版并重新安装。

In-app automatic updates are not configured for these downloads. Download and install a newer release to update.
