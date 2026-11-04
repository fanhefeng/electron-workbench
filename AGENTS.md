# Workbench development

## Implementation

- Keep this a small Electron template. Add modules for real use cases; avoid speculative DI, plugin systems, worker scaffolds and pass-through abstractions.
- Document current behavior and constraints. Keep migration narratives, completed fix reports and local tool status out of project documentation; remove obsolete code and comments rather than keeping compatibility scaffolds without an active requirement.
- `main` owns native resources and canonical state. `renderer` owns presentation and ephemeral input/focus state. `preload` exposes explicit, typed methods and unsubscribable events.
- Subscribe before fetching the initial snapshot; use its monotonic revision to reject stale results.
- Every WebContentsView has an owner. Respect cancelled unload, retain tab state until destruction, and release webContents on tab/window destruction. Hide embedded views on shell pages and beneath modal UI; guard asynchronous callbacks by view identity.
- Persist through Storage's serialized async writer. Merge validated settings with defaults; do not write synchronously in navigation/settings handlers.
- HTML-in-Canvas is a saved boolean, default off. Apply only CanvasDrawElement to new remote views and on explicit refresh. Preserve tab identity, navigation history, zoom and mute state when recreating a view.

## Security

- Validate IPC sender instance, main frame, exact entry URL, origin and every runtime argument before effects. TypeScript does not replace runtime validation.
- Remote pages receive no preload or Node integration. Keep sandbox, context isolation, webSecurity, HTTPS navigation and default-deny permissions.
- Restrict the shell protocol to its host and renderer directory. Keep production CSP and development-only allowances separate.

## Interface

- Follow DESIGN.md. Use i18n keys, semantic CSS tokens, logical properties, keyboard-accessible controls, visible keyboard focus and reduced-motion support.
- Do not add decorative arrows to buttons, links, navigation, cards or list entries, including hover/focus states and CSS pseudo-elements. Prefer text for back, pagination and expansion; retain only explicitly requested or functionally necessary direction markers. Pass this rule to design skills and generation tools without changing user content or impairing accessibility.
- The embedded-page toolbar uses conventional Back, Forward, Reload, Stop, Copy, Capture, DevTools and Open in browser icons. Use the shared IconButton with localized accessible names, hover titles and consistent interaction states.

## Tooling and verification

- Treat package.json and package-lock.json as the version authority. Read docs/research.md before changing release-sensitive Electron APIs or packaging; use documentation matching the installed versions.
- Keep the scoped minimatch/glob overrides aligned with their consumers and the packaging tests. Remove them when supported upstream dependency ranges make them unnecessary.
- Keep bundled renderer libraries in devDependencies; dependencies contains only packages loaded by the main process at runtime.
- Run `npm run check` and `npm run build` for code changes. Run `npm run test:e2e` for lifecycle, IPC, tabs, storage or native operations; validate packaging for build-tool or packaging changes.
- Use `npm run package` for a local application and `npm run dist` for distribution artifacts. Both use `--publish never`. Formal signing, notarization and real update validation require release infrastructure.
