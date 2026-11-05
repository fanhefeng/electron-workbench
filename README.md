# Workbench

基于 Electron、React 和 TypeScript 的桌面工作区模板，提供网页标签、基础原生能力和本地持久化。开发与检查使用 electron-vite 和 Vite+，打包使用 electron-builder。

## 下载

从 [GitHub Releases](https://github.com/fanhefeng/electron-workbench/releases) 下载 macOS Apple Silicon / Intel、Windows x64 或 Linux x64 安装包。当前版本没有 Developer ID、公证或 Windows 代码签名，首次运行的系统放行步骤及 SHA-256 校验方法见 [安装说明](docs/install.md)。

## 开发

需要 Node.js 24.11+（24.x）或 26+，使用 npm 管理依赖。

```bash
npm ci
npm run dev
```

开发与预览命令自动准备 Electron 二进制。开发服务固定在 `127.0.0.1:5197`。

| 命令                 | 用途                                       |
| -------------------- | ------------------------------------------ |
| `npm run check`      | 格式、lint、类型检查和单元测试             |
| `npm run build`      | 类型检查并构建 main、preload 和 renderer   |
| `npm start`          | 运行生产构建，需先执行 build               |
| `npm run test:e2e`   | 真实 Electron 工作流与故障测试，需先 build |
| `npm run test:watch` | 单元测试监听模式                           |
| `npm run format`     | 格式化代码和文档                           |
| `npm run package`    | 生成本机应用目录                           |
| `npm run dist`       | 生成本机分发制品                           |
| `npm audit`          | 审计完整依赖树                             |

具体依赖版本以 `package.json` 和 `package-lock.json` 为准。electron-builder 使用固定的 **27.0.0-alpha.14 预发布版**；构建依赖约束见 [技术依据](docs/research.md#打包与更新)。

## 功能

- 网页：最多 12 个 HTTPS 标签，切换、拖动与键盘排序、导航、站点图标和错误重试。
- 页面操作：复制地址、保存截图、打开独立 DevTools、在系统浏览器打开。
- 桌面：原生菜单、快捷键、托盘、通知、下载、单实例和深链。
- 偏好：中英文、系统 / 浅色 / 深色、强调色、恢复页面、关闭到托盘和登录自启。
- 状态：串行异步保存设置与网页列表，窗口状态由 Electron 保存；活动与下载记录在应用退出后清空。
- 更新：配置 HTTPS 更新源后，可手动检查、下载和安装。

HTML-in-Canvas 是嵌入网页的实验性选项，默认关闭，设置自动保存。新网页直接使用当前值，已打开网页在显式刷新后应用；刷新时保留标签身份、导航历史、缩放和静音状态，并尊重网页的卸载取消。

登录自启仅用于打包后的 macOS / Windows 应用；系统通知受 OS 权限控制。

## 目录与职责

```text
src/
  main/              生命周期、网页容器、原生能力、持久化与更新
  preload/index.ts   具名方法与可退订事件组成的类型化桥接
  renderer/          React 界面、表单与焦点状态、i18n 和样式
  shared/            跨进程类型、默认值与运行时校验
tests/               校验、存储、图标和构建依赖测试
scripts/             Electron 工作流与故障测试
resources/           应用图标与更新源配置
```

主进程保存标签、设置、下载的权威状态，renderer 通过带 revision 的快照订阅。远端网页使用独立 session，不注入 preload、Node 或宿主桥；导航仅接受 HTTPS，权限默认拒绝。生产界面通过受限的 `workbench-app://shell/` 协议与 CSP 加载。

## 快捷键

| 快捷键                          | 动作                     |
| ------------------------------- | ------------------------ |
| Cmd / Ctrl + T                  | 打开页面                 |
| Cmd / Ctrl + W                  | 关闭网页；首页时关闭窗口 |
| Cmd / Ctrl + L                  | 聚焦地址栏               |
| Cmd / Ctrl + R 或 F5            | 刷新网页并应用网页配置   |
| Cmd / Ctrl + ,                  | 设置                     |
| Ctrl + Tab / Ctrl + Shift + Tab | 下一个 / 上一个标签      |
| 标签栏左右方向键 / Home / End   | 切换标签                 |
| 标签栏 Alt + 方向键             | 移动标签                 |
| 标签栏 Delete                   | 关闭网页标签             |
| Escape                          | 关闭新建页面对话框       |

## 打包与更新

制品输出到 `release/`，打包命令均使用 `--publish never`。macOS 默认使用 ad-hoc 签名；正式签名通过 `WORKBENCH_SIGN_IDENTITY` 提供身份，并配置公证。

GitHub Actions 在 `main` 推送、Pull Request 和手动运行时检查并生成安装包，保留为 Actions artifacts。推送 `v*` 标签时，标签必须与 `package.json` 的版本一致；四组构建及 Linux 虚拟桌面 E2E 全部成功后，上传六个安装包和 `SHA256SUMS`，最后发布 Release。预发布版本标签含 `-` 时标记为 prerelease；已发布版本的附件不会被覆盖。

例如，`package.json` 和 `package-lock.json` 的版本均为 `0.1.2` 时：

```bash
git tag -a v0.1.2 -m "Workbench 0.1.2"
git push origin v0.1.2
```

流水线设置 `WORKBENCH_UNSIGNED_RELEASE=1`：macOS 固定 ad-hoc 签名并跳过公证，Windows 不签名，并要求 `resources/update.json` 的更新源保持为空。无需配置证书或发布 PAT；仅发布作业具有 `contents: write` 权限，使用 GitHub 自动提供的 token 上传附件。手动发布同类安装包可执行 `WORKBENCH_UNSIGNED_RELEASE=1 npm run dist`（PowerShell 使用 `$env:WORKBENCH_UNSIGNED_RELEASE='1'`）。

开发应用使用独立名称、数据目录和 `workbench-dev://` 深链。生产深链示例：

```text
workbench://open?url=https%3A%2F%2Fexample.com
```

更新源在 `resources/update.json` 中配置，默认未配置。启用应用内更新需提供真实 HTTPS feed、平台签名、安装制品与更新元数据；通过 builder 发布更新清单时还需要 Ed25519 清单签名密钥。macOS 更新包含 ZIP 制品。GitHub Release 的手动下载安装不启用应用内更新。配置及客户端格式约束见 [打包与更新](docs/research.md#打包与更新)。

## 扩展

- 快捷站点：`src/renderer/components/Overview.tsx` 的 `LINKS`。
- 界面：`src/renderer/components/`、`src/renderer/i18n.ts` 和 `src/renderer/styles.css`，遵循 [界面约定](DESIGN.md)。
- 原生能力：在 `src/shared/model.ts` 定义具名方法，由 preload 暴露，并在主进程完成发送方与参数校验。

开发约束见 [AGENTS.md](AGENTS.md)，设计依据见 [技术依据](docs/research.md)，测试与发布验收见 [验证流程](docs/validation.md)。
