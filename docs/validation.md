# 验证流程

## 开发检查

```bash
npm ci
npm run check
npm run build
npm run test:e2e
```

`check` 执行格式、类型感知 lint、严格类型检查和单元测试。`test:e2e` 使用生产构建，先验证完整桌面工作流，再运行独立故障测试；需要可运行 Electron 的桌面环境。

测试使用临时数据目录和本地 HTTP 服务，不注册 OS 深链、不修改登录自启、不执行真实更新安装。生产导航仅允许 HTTPS，本地 HTTP 只在隔离测试模式中开放。桌面截图输出到 `test-results/`。

## 自动化覆盖

| 测试入口                  | 覆盖范围                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| `tests/security.test.ts`  | URL、深链、设置校验、编码长度边界和生产 / 开发 CSP                                                  |
| `tests/storage.test.ts`   | 串行写入、并发保存、失败重试、临时文件清理、损坏文件恢复、默认值合并和标签上限                      |
| `tests/favicon.test.ts`   | 图标类型、大小限制、重定向和响应流清理                                                              |
| `tests/packaging.test.ts` | builder 文件过滤、ASAR 内容与 native 文件解包、filelist 匹配、glob 展开预算和 lockfile 安全版本约束 |
| `tests/release.test.ts`   | 标签版本、完整平台与架构集合、非空安装包和 SHA-256 清单                                             |
| `scripts/smoke.mjs`       | preload 与 IPC、远端隔离、导航和标签、原生操作、设置、窗口重建与资源释放                            |
| `scripts/regressions.mjs` | 卸载取消、退出写入失败时的草稿保留、并发关闭的焦点、原生主题、地址栏命令、主壳恢复和更新安装状态    |

桌面工作流覆盖原生拖动、键盘排序、12 个标签的溢出与拖动滚动、下载内容、PNG 捕获、菜单及快捷键、重启恢复。界面覆盖中英文、深浅色、900px 窗口、键盘焦点、select、开关、弹窗及箭头使用约束。

HTML-in-Canvas 测试验证默认关闭、设置持久化、显式刷新应用、真实像素绘制、卸载取消及标签身份 / 导航历史 / 缩放 / 静音状态保留。更新安装测试使用伪更新器，覆盖安装前保存、卸载取消与重试、保存失败时的草稿保留、事件错误、同步异常、重复请求和关闭到托盘行为。

地址表单回归覆盖导航成功或失败后的晚到结果、后续输入保留和弹窗重开；标签排序回归验证异步操作完成后保留用户后来选择的焦点。

安全回归覆盖不同窗口、修改后的壳入口 URL、运行时非法 IPC 参数，以及图标请求不携带其他站点的登录 Cookie。

快捷键测试使用 Electron `sendInputEvent`，发出事件前等待宿主 BrowserWindow 和目标 webContents 聚焦；原生拖动等待 `dragend` 与下一帧后继续输入。

窗口重建测试按 webContents 身份筛选 BrowserWindow，排除 Playwright 同时报告的 WebContentsView 页面；临时 CDP 会话在筛选后释放。

壳崩溃测试在测试 RPC 返回后触发真实崩溃；恢复时先订阅加载完成，再发起重载并独立等待事件，避免控制通道等待被替换的 renderer 上下文。CI 在临时 VM 中关闭外部崩溃转储接管并禁用 core 文件，为整套桌面测试设置 120 秒硬超时。

## 打包与发布验收

以下命令适用于 macOS Apple Silicon；其他平台使用对应构建目标和输出目录。

```bash
npm run package
npm run dist
npm audit
codesign --verify --deep --strict release/mac-arm64/Workbench.app
```

发布制品还需检查：

- DMG 与 ZIP 完整性，包内入口、renderer 资源与额外资源和生产构建一致，开发源码及构建工具未随应用分发。
- ASAR 完整性校验与仅从 ASAR 加载已启用；RunAsNode、Node options 环境变量、CLI inspect 和 file 协议额外权限已关闭。
- blockmap 为 updater 6 支持的 JSON v2 格式。
- 使用隔离数据目录实际启动打包应用，确认可信壳与 preload 正常加载，验证后清理测试进程和数据。打包应用关闭了 inspector，需直接启动验证。

依赖审计覆盖生产与开发依赖。构建工具或 overrides 发生变化时，重新执行兼容测试、E2E 和制品验收。版本与格式约束见 [技术依据](research.md#打包与更新)。

GitHub Actions 在四组 runner 上运行 `check`、`build` 和 `dist`，Linux 使用 Xvfb 和 Openbox 运行真实 Electron E2E，两种 macOS 架构均执行 `codesign --verify --deep --strict`。虚拟显示环境保留 Chromium sandbox，在隔离 CI VM 中允许创建用户命名空间。macOS 特有键盘分支保留在原有桌面测试中，需在 macOS 桌面环境执行。桌面 E2E 在云端失败时最多用全新进程重试两次，每次完整执行所有断言，连续失败会阻止发布。Actions 的 `installers-*` artifacts 仅包含安装包，桌面测试截图独立保存。标签与包版本匹配、全部作业成功且安装包完整非空后，才会生成 SHA-256 清单并公开 Release；失败或取消不会公开草稿。草稿上传失败可重新运行发布作业，已公开 Release 不会被覆盖。

本地检查工作流使用 `actionlint .github/workflows/build.yml`；macOS 无证书分发验证使用 `WORKBENCH_UNSIGNED_RELEASE=1 npm run dist`。下载后按 [安装说明](install.md) 验证 SHA-256 并实际安装；CI 构建通过不能代替各平台的首次安装与系统放行验收。

`package` / `dist` 使用 `--publish never`。本机 ad-hoc 签名与模拟 `app.isPackaged` 的测试不能替代正式 Developer ID、公证或真实更新验收；Windows / Linux 实机、登录自启和跨版本自动更新需在对应环境验证。通知展示需结合系统权限与专注模式检查。
