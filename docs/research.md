# 架构与技术依据

本文记录当前工程的架构、运行时约束和维护依据。依赖版本以 package.json 和 package-lock.json 为准，接口资料使用对应版本的官方文档。

## 版本基线

项目固定 **Electron 45.2.2**，内含 Chromium 156.0.8078.80、Node.js 24.22.2、V8 15.6.75.27；固定具体 Electron 版本并提交 lockfile，升级时重新跑桌面端验证。[版本页](https://releases.electronjs.org/release/v45.2.2)

| 运行时约束                                                                                            | 实现                                                                |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| sandbox preload 不提供 `Buffer`、`setImmediate`、`clearImmediate` 及 `events` / `timers` / `url` 垫片 | preload 只使用 `electron`、类型和 Web API，打包为单个 CommonJS 文件 |
| 屏幕捕获权限使用 `display-capture`；`media` 用于摄像头、麦克风                                        | 默认拒绝屏幕捕获、摄像头与麦克风权限                                |

运行时约束参考 [Electron 45 发布说明](https://www.electronjs.org/blog/electron-45-0)。

剪贴板使用异步 `clipboard.writeText(...)`。窗口设置固定 `name` 和 `windowStatePersistence`，由 Electron 保存位置、大小和显示模式。[剪贴板 API](https://www.electronjs.org/docs/latest/api/clipboard)、[窗口状态保存](https://www.electronjs.org/docs/latest/tutorial/window-state-persistence)

## 产品范围

一个窗口提供工作区、活动和设置。主要流程是打开 HTTPS 网页、管理标签、复制地址、截图、下载以及恢复工作区。设备授权、特殊 OAuth、多窗口和远端 JSAPI 只在有实际业务需求时单独设计。

## 进程与模块

Electron 主进程负责窗口、生命周期和原生能力，renderer 使用 Web 技术展示界面，preload 负责隔离世界之间的受控桥接；耗 CPU 的工作才适合拆到 utility process。[官方进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)

本模板采用以下分工：

```text
React 界面
  │ 少量明确的方法 + 只读状态快照
preload / contextBridge
  │ IPC，主进程校验发送方和参数
主进程编排
  ├─ tabs：tab 与 WebContentsView 的唯一所有者
  ├─ storage：校验、串行写入、恢复
  ├─ native：菜单、托盘、通知、剪贴板、截图
  └─ updates：检查、下载、安装状态
```

主进程保存 tab、设置和下载的权威状态，renderer 不重复维护第二份业务状态。每个快照带单调递增的 revision，先订阅再获取初始快照，忽略过期快照。React 使用 `useSyncExternalStore` 订阅稳定、缓存过的快照，订阅必须返回退订函数。[React 官方接口契约](https://react.dev/reference/react/useSyncExternalStore)

## 网页容器

官方给出 iframe、`<webview>` 和 `WebContentsView` 三类选择：iframe 受目标站点 CSP 限制；官方不推荐 `<webview>`，原因是其架构变化可能影响稳定性。`WebContentsView` 适用于需要主进程控制的网页容器。[Web Embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds)

网页容器使用 **WebContentsView**。它由主进程创建，网页没有 preload 和宿主 JSAPI。页面加载不需要绕过 `X-Frame-Options`，也不修改站点 CSP。前进与后退使用 `webContents.navigationHistory`。[WebContentsView API](https://www.electronjs.org/docs/latest/api/web-contents-view)、[NavigationHistory API](https://www.electronjs.org/docs/latest/api/navigation-history)

容器位置由 renderer 实际布局测量后上报，主进程按主壳的 `getZoomFactor()` 换算为原生坐标，再限制在窗口范围内；设置、主页和模态框显示时隐藏原生网页 View，因为它不是 DOM 元素，普通 CSS `z-index` 不能成为可靠的遮挡方案。用户关闭标签、正常关闭窗口和退出应用会等待 `webContents.close({ waitForBeforeUnload: true })` 的销毁或取消结果；取消时不删除标签描述、不切换选中项、不保存关闭状态。关闭与 Canvas 重建共用关闭等待及监听清理；实际销毁后才移除 View。宿主窗口被销毁或 View 创建失败时强制回收资源。官方特别说明，关闭承载窗口不会替应用销毁附加的 WebContentsView 内容。[缩放接口](https://www.electronjs.org/docs/latest/api/web-contents#contentsgetzoomfactor)、[BaseWindow 资源管理](https://www.electronjs.org/docs/latest/api/base-window#resource-management)

恢复时只读取 tab 描述；首次激活才创建网页进程，限制 tab 数量、活动记录和下载历史的内存上限。保留已打开 tab 的页面状态，避免每次切换都重新加载。性能优化以实际运行测量为依据。[Electron 性能指南](https://www.electronjs.org/docs/latest/tutorial/performance)

### 页签图标

主进程监听网页的 `page-favicon-updated` 事件，通过远端 session 的 `fetch` 获取图标，支持常见图像格式与内联 data 图标。请求使用 `credentials: 'omit'`，不向网页指定的 URL 附带登录 Cookie；需要身份认证的图标使用默认图标。网络 URL 与每次重定向都按现有 HTTPS 规则校验；请求限制为 5 秒、最多 3 次重定向和 256 KiB 图像数据。主壳只接收 data 图像，维持现有 `img-src 'self' data:` CSP；不向远端增加 preload 或 Node 能力。跨文档导航和 WebContents 销毁时取消旧请求，晚到结果不能覆盖新文档的图标；图标不写入持久化描述，重新加载后由网页更新。[Electron favicon 事件](https://www.electronjs.org/docs/latest/api/web-contents#event-page-favicon-updated)、[Session fetch](https://www.electronjs.org/docs/latest/api/session#sesfetchinput-init)

## IPC 和可信内容

preload 对外只暴露 `openTab`、`updateSettings` 等具体方法，renderer 不获得 `ipcRenderer`、任意 channel 的 `invoke` 或 Electron event 对象；事件回调只转交需要的业务数据并提供取消订阅。[Context Isolation 安全说明](https://www.electronjs.org/docs/latest/tutorial/context-isolation)

IPC 的 TypeScript 类型不能代替运行时检查。本模板的校验策略：

1. `event.sender` 必须为当前主壳的 `webContents`。
2. `event.senderFrame` 必须存在、等于当前主壳 `mainFrame`，入口 URL 与可信壳完全一致，且 `origin` 等于可信壳 origin。
3. 在任何 `await` 前读取并校验发送方；URL、枚举、长度、布尔值和 View bounds 都在主进程验证。
4. 标识符只索引主进程拥有的 tab / download，拒绝 renderer 提供任意文件路径。

官方要求验证所有 IPC 的发送方，且提醒 `about:blank` / `blob:` URL 不能可靠识别控制方，应检查 origin；这里额外加入主壳实例与主 frame 身份约束，是模板的最小权限设计。[Security：验证发送方](https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages)、[ipcMain API](https://www.electronjs.org/docs/latest/api/ipc-main)

## 远程页面隔离和导航

主壳与远程页面均启用 sandbox、context isolation，关闭 Node integration，保持 `webSecurity`，禁止不安全混合内容。远程网页使用与主壳分离的 session，不注入原生桥。主壳禁止跳转到远端；远程网页导航只允许 HTTPS，拒绝 `file:`、`javascript:` 和任意外部协议。`window.open` 不直接放行，由主进程转换成受同样约束的新 tab。只有用户主动点“在浏览器打开”才调用经过 URL 校验的 `shell.openExternal`。[Electron 安全清单](https://www.electronjs.org/docs/latest/tutorial/security)

对远程 session 同时设置 `setPermissionRequestHandler` 和 `setPermissionCheckHandler`，默认拒绝摄像头、麦克风、屏幕、地理位置、剪贴板读取和网页通知；check 回调的 `webContents` 可能为 `null`，不能直接解引用。未来开放某项权限应按 origin、frame、用户手势和可撤销的用户选择实现，不通过一个总开关放行所有权限。[Session 权限接口](https://www.electronjs.org/docs/latest/api/session#sessetpermissionrequesthandlerhandler)

这仍然是应用内网页容器，不宣称完整浏览器级的安全产品。外部站点自己的 OAuth、多窗口或设备功能可能需要后续有针对性的接入。

URL 输入与规范化结果均限制在 2 MiB 内，与 Chromium 的进程间 URL 长度上限对齐，避免中文编码后无法恢复；省略协议的域名端口地址补全 HTTPS。网页导航与重定向必须已经是合法的绝对地址，不接受通过协议补全替换目标。导航、历史恢复、持久化和浏览器打开复用同一校验，后退、刷新、停止、截图与 DevTools 不依赖当前 URL 校验。[Chromium URL 上限](https://raw.githubusercontent.com/chromium/chromium/main/url/url_constants.h)

## 主壳协议和 CSP

生产主壳通过 `workbench-app://shell/` 自定义标准安全协议加载。通过 `protocol.handle` 只服务打包后的 renderer 目录：解析 URL、解码路径、检查固定 host 与目录包含关系，防止编码路径与目录穿越。不要让该协议成为“读取任意本地文件”的通用接口。自定义 session 的协议需要注册在对应 session 上。[protocol API](https://www.electronjs.org/docs/latest/api/protocol)

生产 CSP 限制脚本为本地资源，禁止 `eval`、对象和远程 frame。策略由 `src/shared/csp.ts` 定义，构建产物与协议响应共用；开发入口通过 nonce 开放 HMR 所需的脚本和本地 WebSocket。安全标志不代替输入校验，也不能把整个应用切成 `webSecurity: false` 来修嵌入问题。[Security：CSP 与自定义协议](https://www.electronjs.org/docs/latest/tutorial/security)

## 持久化与错误恢复

数据文件只放在 `app.getPath('userData')`，开发和生产使用不同 app name、数据目录和深链 scheme；设置按字段校验并合并默认值，无效字段或已移除字段不影响其他有效偏好；设置 IPC 仍严格拒绝非法字段。tab URL 在恢复时重新校验。恢复前验证工作区根结构，语法或根结构错误的文件先备份再采用默认值；备份失败时停止加载，避免覆盖唯一副本。

写入使用单条异步队列，写同目录临时文件成功后再 rename，避免快速设置修改发生交叉写入。正常关闭窗口和退出应用时，先等待待保存状态写入，再开始网页卸载；预先保存失败时保留网页及草稿，退出前再次等待关闭期间的最终写入。日志也避免同步文件写入阻塞主进程。Node 官方说明：没有等待上次完成就对同一文件重复调用 `writeFile` 不安全。临时文件加 rename 是本模板采用的文件替换策略，不代表跨平台、断电情况下的数据库事务或绝对持久保证。[Node.js 文件系统文档](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromiseswritefilefile-data-options)

## 原生交互与生命周期

使用原生应用菜单与常用快捷键，使网页拥有焦点时也能新建、切换、关闭 tab 或聚焦地址栏；避免依赖仅存在于壳 renderer 的键盘监听。托盘只在开启相关设置时创建，退出标志必须绕过“关闭到托盘”的拦截。主壳加载期间和 renderer 崩溃后隐藏所有原生网页，崩溃时重新载入固定可信入口，恢复前缓冲壳命令；恢复不重建网页 View。通知由宿主根据设置发送，网页通知不继承宿主权限。[菜单](https://www.electronjs.org/docs/latest/api/menu)、[快捷键](https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts)、[Tray](https://www.electronjs.org/docs/latest/api/tray)

深链是外部输入：只接受固定 scheme、host、动作和 HTTPS URL，冷启动先排队，主窗口就绪后执行；macOS 处理 `open-url`，Windows / Linux 处理 `second-instance` 与启动参数，单实例锁让同一环境复用窗口。开发和生产 scheme 分离。[官方 Deep Links 指南](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app)

下载使用 Electron 的保存对话框和 `DownloadItem` 事件，主进程拥有文件路径，renderer 只能按下载 ID 请求“显示文件”。下载状态与失败要明确，不能把磁盘写入失败显示成完成。[DownloadItem API](https://www.electronjs.org/docs/latest/api/download-item)

## 打包与更新

本项目固定 **electron-builder 27.0.0-alpha.14（预发布）**，使用对应 v27 schema。`fileOptions` 管理应用文件及额外资源，`mac.sign.identity` 接收签名身份；本地默认 ad-hoc，正式签名通过 `WORKBENCH_SIGN_IDENTITY` 提供。[v27 配置](https://www.electron.build/docs/migration/v27-config-changes/)

安全依赖基线通过限定调用方的 overrides 维护：`app-builder-lib`、`@electron/asar`、`filelist` 使用 minimatch 11.0.4，ASAR 同时使用 glob 14.0.3。glob 与 minimatch 的匹配接口需成组验证。[minimatch 安全公告](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249)、[minimatch 接口](https://github.com/isaacs/minimatch/blob/v11.0.4/changelog.md)、[glob 接口](https://github.com/isaacs/node-glob/blob/v14.0.3/changelog.md)

`tests/packaging.test.ts` 验证实际 builder 文件过滤、父目录匹配、隐藏与中文资源、ASAR 内容和 native 文件解包、filelist 的 include/exclude，以及恶意 glob 的展开数量上限。lockfile 回归拒绝公告范围内的 minimatch；`npm audit` 检查全部开发与生产依赖。上游直接支持安全版本后，应删除对应 override 并重新验证。

更新采用 `electron-updater` 6 的状态机，检查、下载、安装分开；`installing` 阻止重复安装。安装前先保存工作区、等待网页卸载并保存最终状态；取消卸载时回到待安装状态，保存失败时保留网页及草稿。卸载完成后禁止创建新网页，安装失败时恢复工作区。只有 Electron 的实际更新退出事件才绕过托盘。没有发布配置时保持未配置。builder 显式声明 `electronUpdaterCompatibility: ">=6.8.3"`，输出客户端支持的 JSON v2 blockmap。[blockmap 兼容范围](https://www.electron.build/docs/migration/v27-build-changes/#block-map-format-follows-electronupdatercompatibility)

`package` / `dist` 显式使用 `--publish never`。受系统信任的分发使用 Developer ID、公证或对应平台签名；应用内更新还需要真实 HTTPS feed、安装制品及更新元数据。v27 发布更新清单默认要求 Ed25519 签名，密钥由发布基础设施提供，不存入客户端或仓库。updater 6 不提供 Ed25519 清单签名校验；启用客户端清单验签需要支持该协议的客户端及完整发布验收。[清单签名要求](https://www.electron.build/docs/migration/v27-build-changes/#signed-update-manifests-are-required)、[客户端运行时变化](https://www.electron.build/docs/migration/v27-runtime-changes/)

GitHub Actions 使用独立平台 runner 构建 macOS arm64 / x64、Windows x64 和 Linux x64。`WORKBENCH_UNSIGNED_RELEASE=1` 固定 macOS ad-hoc 签名、显式跳过公证并关闭 Windows 签名；更新源非空时拒绝构建。builder 只构建文件；GitHub CLI 在所有作业成功后创建草稿、上传完整安装包和 SHA-256 清单，再公开 Release。该分发方式不发布自动更新元数据，不需要更新清单签名密钥。安装与系统放行步骤见 [安装说明](install.md)。

CI 桌面测试使用 Linux 的 Xvfb 和 Openbox 提供独立显示及窗口管理，独立 D-Bus 会话中的 Dunst 提供通知服务；允许隔离 VM 创建用户命名空间，应用继续启用 Chromium sandbox，不使用 `--no-sandbox`。macOS 两种架构仍在原生 runner 打包并验证代码签名。[Electron 无显示器测试](https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci)

流程默认只有仓库读取权限，仅标签发布作业具有内容写入权限；Action 依赖固定完整提交 SHA，checkout 不保留凭据。标签必须等于 `v` 加包版本，制品名称包含平台和架构，发布前验证六个非空文件的完整集合。普通推送、PR 和手动运行只上传临时 artifacts。[GitHub runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[Actions 安全实践](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)、[ad-hoc 签名](https://www.electron.build/docs/features/code-signing/code-signing-mac/)

打包启用 ASAR 完整性校验与仅从 ASAR 加载，关闭 RunAsNode、Node options 环境变量、CLI inspect 和 file 协议额外权限。macOS 构建嵌入 ASAR 完整性摘要，再修改 fuses 和签名；ad-hoc 与正式签名均使用上游对应的默认 entitlements。[ASAR 摘要](https://www.electron.build/docs/migration/v27-runtime-changes/#macos-the-asar-integrity-digest-is-embedded)、[Electron Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)

## 验证范围

测试分层、覆盖范围与发布制品验收见 [验证流程](validation.md)。

## 控件与表单

控件保留原生语义：按钮、输入框、checkbox switch 和 select。选择器使用 `appearance: base-select` 与 `::picker(select)` 定制菜单、选中标记和箭头；MDN BCD 确认 Chrome 135 起支持，实际目标 Chromium 156 已在 Electron 内验证。选项数据仍是原生 option，由浏览器处理键盘、Escape、焦点归还和菜单定位；没有额外的 listbox 状态机或外部 UI 库。样式置于 `@supports` 中，其他浏览器仍能使用原生 select。[MDN 可定制 select](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Forms/Customizable_select)、[appearance 与兼容数据](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/appearance)、[picker 与兼容数据](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/::picker)

## HTML-in-Canvas 配置

Electron 提供 `enableBlinkFeatures` / `disableBlinkFeatures`，用于按名称控制 Blink 功能。本模板只映射固定的 `CanvasDrawElement`，不开放任意 flags，不启用整个 `experimentalFeatures` 集合。[Electron WebPreferences](https://www.electronjs.org/docs/latest/api/structures/web-preferences)

Electron 45.2.2 / Chromium 156.0.8078.80 默认不暴露 `drawElementImage`。启用后，通过带 `layoutsubtree` 的 canvas 绘制 HTML；Electron E2E 验证实际像素。API 写法须与内核版本匹配，升级时重新验证。[HTML-in-Canvas API 依据](https://developer.chrome.com/blog/html-in-canvas-origin-trial)

`htmlInCanvas` 作为严格布尔设置，默认 false，通过主进程设置 IPC 与 Storage 串行写入，与其他设置共用默认值合并和校验。每次创建网页 View 时读取当前配置，并按 View 记录已应用值。切换设置不立即重载页面；显式刷新时比较配置，仅在值不同时重建容器。通过 navigationHistory.getAllEntries / restore 恢复历史与当前索引，保留同一 tab 描述、排序、缩放和静音状态；替换前先关闭当前容器，异步事件校验 View 身份；网页取消 beforeunload 时保留当前容器。普通刷新、强制刷新、Cmd / Ctrl + R 和 F5 均经同一控制入口。Electron 的 restore 对表单和滚动位置属于尽力恢复，不承诺完整复制网页运行状态。[NavigationHistory restore](https://www.electronjs.org/docs/latest/api/navigation-history#navigationhistoryrestoreoptions)、[WebContents close](https://www.electronjs.org/docs/latest/api/web-contents#contentscloseopts)

此功能仅作用于远端网页，主壳使用普通 HTML / React；网页仍没有 Node、preload 或宿主桥。

## 开发工具链

项目使用 npm 和 lockfile，开发 Node.js 要求为 24.11+（24.x）或 26+。固定版本 Vite+ 1.5.0 提供 Vite、Rolldown、Oxc、Vitest、格式化、lint 与 TypeScript Go 类型检查。`vite` alias 与 npm override 让 electron-vite、React 插件及 Vitest 使用同一份 Vite+ core。[Vite+ 依赖规则](https://viteplus.dev/guide/migrate-rules#dependency-rules)

`electron.vite.config.ts` 编排 main、单文件 CJS preload 和 renderer 构建；`vite.config.ts` 配置格式、lint 和单元测试。完整应用使用 `npm run dev` / `npm run build`，不使用只面向普通网页的 `vp dev` / `vp build`。[electron-vite](https://electron-vite.org/guide/)、[Vite+ 任务](https://viteplus.dev/guide/run)

React、React DOM 和 Lucide 随 renderer bundle 分发，列入 devDependencies；dependencies 仅包含主进程运行时加载的 electron-updater，避免重复打包浏览器依赖。

`vp check` 同时执行格式、类型感知 lint 和严格类型检查；`typecheck` 只执行类型检查。`tsconfig.json` 显式开启 `noEmit`、严格检查、未使用变量/参数和 switch fallthrough 检查。测试分为 Node 单元测试、完整 Electron 工作流和独立故障回归。[Vite+ 检查](https://viteplus.dev/guide/check)、[Oxlint 类型检查](https://oxc.rs/docs/guide/usage/linter/type-aware#type-checking-diagnostics)

Electron 使用延迟二进制下载，electron-vite 的启动检查需要 `path.txt`。`dev` 与 `start` 先运行官方 `install-electron`，已安装时复用二进制。[Electron 安装](https://www.electronjs.org/docs/latest/tutorial/installation#binary-download-step)
