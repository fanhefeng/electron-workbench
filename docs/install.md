# 下载与安装 / Download and install

本版本没有付费代码签名证书：macOS 使用 ad-hoc 签名，未经 Apple 公证；Windows 安装包未签名。首次运行可能被系统拦截。

This build uses ad-hoc signing on macOS without Apple notarization. Windows installers are unsigned. Your operating system may ask you to approve the app before its first launch.

## 选择安装包 / Choose a download

| 系统 / System                 | 文件名后缀 / Filename suffix            |
| ----------------------------- | --------------------------------------- |
| macOS Apple Silicon（M 系列） | `mac-arm64.dmg` 或 / or `mac-arm64.zip` |
| macOS Intel                   | `mac-x64.dmg` 或 / or `mac-x64.zip`     |
| Windows x64                   | `win-x64.exe`                           |
| Linux x64                     | `linux-x64.AppImage`                    |

下载本 Release 的安装包附件。GitHub 自动生成的 Source code 压缩包包含源码，不能直接安装。

Download an installer attached to this release. GitHub's automatically generated Source code archives contain source files, not an installable app.

## macOS

1. 打开 DMG，将 Workbench 拖入“应用程序”；使用 ZIP 时，解压后将 Workbench.app 移入“应用程序”。
2. 首次尝试打开后，如系统拦截，进入“系统设置”的“隐私与安全性”，找到 Workbench 并点击“仍要打开”，再确认打开。
3. 如果 ad-hoc 应用仍被隔离拦截，确认来源和校验值后，在终端执行下面的命令，再打开 Workbench。命令只移除已安装 Workbench 的下载隔离标记；受组织管理的设备可能禁止用户放行。

Open the DMG and drag Workbench into Applications, or extract the ZIP and move Workbench.app there. After trying to launch it, approve Workbench in System Settings, Privacy & Security, Open Anyway. If quarantine still blocks this ad-hoc build, verify the download and run the following command for this app, then launch it again. Managed devices may prevent these overrides.

```bash
xattr -dr com.apple.quarantine /Applications/Workbench.app
open /Applications/Workbench.app
```

参考 / Reference: [Apple：打开未公证或未知开发者的应用 / Open an app from an unidentified developer](https://support.apple.com/en-us/102445)。

## Windows

运行 `.exe` 安装包。如 SmartScreen 显示未知发布者，在确认来源和校验值后，选择“更多信息”中的“仍要运行”。如果组织策略或安全软件阻止安装，请联系设备管理员。

Run the `.exe` installer. If SmartScreen warns about an unknown publisher, verify the source and checksum, then select More info and Run anyway. Organization policies or security software may require your administrator's approval.

## Linux

在下载目录执行，替换文件名中的版本号：

Run these commands in the download directory, replacing the version in the filename:

```bash
chmod +x Workbench-0.1.0-linux-x64.AppImage
./Workbench-0.1.0-linux-x64.AppImage
```

## 校验下载 / Verify downloads

Release 包含 `SHA256SUMS`。以下命令可计算下载文件的 SHA-256，与清单中对应的值比较：

The release includes `SHA256SUMS`. Calculate your downloaded file's SHA-256 and compare it with the corresponding entry:

```bash
# macOS
shasum -a 256 Workbench-0.1.0-mac-arm64.dmg
# Linux
sha256sum Workbench-0.1.0-linux-x64.AppImage
```

```powershell
# Windows PowerShell
Get-FileHash .\Workbench-0.1.0-win-x64.exe -Algorithm SHA256
```

当前下载版本不启用应用内自动更新；更新时下载新版并重新安装。

In-app automatic updates are not configured for these downloads. Download and install a newer release to update.
