import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  CodeXml,
  ExternalLink,
  Copy,
  LockKeyhole,
  RotateCw,
  X,
} from 'lucide-react';
import type { AppInfo } from '../shared/model.ts';
import { translator } from './i18n';
import { useDesktopState } from './store';
import { useAddressForm } from './useAddressForm';
import { Overview } from './components/Overview';
import { Settings } from './components/Settings';
import { Activity } from './components/Activity';
import { TabStrip } from './components/TabStrip';
import { Button, IconButton, TextInput } from './components/Primitives';

export function App() {
  const { state, failure } = useDesktopState();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [dialogKind, setDialogKind] = useState<'new-tab' | 'all-tabs' | null>(null);
  const [tabListError, setTabListError] = useState(false);
  const [switchingTab, setSwitchingTab] = useState<string | null>(null);
  const dialogSession = useRef(0);
  const [toast, setToast] = useState('');
  const [focusAddress, setFocusAddress] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = state?.tabs.find((tab) => tab.id === state.activeTabId);
  const activeId = active?.id;
  const ready = state !== null;
  const dialogOpen = dialogKind !== null;
  const address = useAddressForm((url) => window.desktop.navigateTab(activeId!, url));
  const newAddress = useAddressForm((url) => window.desktop.openTab(url));
  const synchronizeAddress = address.synchronize;
  const resetNewAddress = newAddress.reset;
  const t = translator(state?.settings.locale ?? 'zh');
  const notify = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 4200);
  }, []);
  const run = useCallback(
    (task: Promise<unknown>, success?: string) => {
      void task
        .then(() => {
          if (success) notify(success);
        })
        .catch((error) =>
          notify(
            String(error).replace(
              /^Error: (Error invoking remote method '[^']+': )?(Error: )?/,
              '',
            ),
          ),
        );
    },
    [notify],
  );
  const newTab = useCallback(() => {
    const session = ++dialogSession.current;
    void window.desktop
      .setOverlay(true)
      .then(() => {
        if (dialogSession.current !== session) return;
        resetNewAddress();
        setDialogKind('new-tab');
      })
      .catch((error) => notify(String(error)));
  }, [notify, resetNewAddress]);
  const showAllTabs = useCallback(() => {
    const session = ++dialogSession.current;
    void window.desktop
      .setOverlay(true)
      .then(() => {
        if (dialogSession.current !== session) return;
        setTabListError(false);
        setSwitchingTab(null);
        setDialogKind('all-tabs');
      })
      .catch((error) => notify(String(error)));
  }, [notify]);

  useEffect(() => {
    const root = document.documentElement;
    const navigationKeys = new Set([
      'Tab',
      'Enter',
      ' ',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
    ]);
    const pointer = () => {
      root.dataset.focusInput = 'pointer';
    };
    const keyboard = (event: globalThis.KeyboardEvent) => {
      // Escape restores focus without changing how the user entered the control.
      if (event.isComposing || ['Escape', 'Shift', 'Control', 'Alt', 'Meta'].includes(event.key))
        return;
      if (!navigationKeys.has(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey)
        return;
      root.dataset.focusInput = 'keyboard';
    };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', keyboard, true);
    return () => {
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('keydown', keyboard, true);
      delete root.dataset.focusInput;
    };
  }, []);

  useEffect(() => {
    void window.desktop
      ?.getInfo()
      .then(setInfo)
      .catch((error) => notify(String(error)));
    return () => clearTimeout(toastTimer.current);
  }, [notify]);
  useEffect(() => {
    if (!state) return;
    document.documentElement.dataset.theme = state.dark ? 'dark' : 'light';
    document.documentElement.dataset.accent = state.settings.accent;
    document.documentElement.lang = state.settings.locale === 'zh' ? 'zh-CN' : 'en';
  }, [state]);
  useEffect(() => {
    synchronizeAddress(active?.url ?? '', activeId);
  }, [activeId, active?.url, synchronizeAddress]);
  useEffect(() => {
    if (!ready) return;
    return window.desktop?.onCommand((command) => {
      if (command === 'new-tab') {
        dialogSession.current += 1;
        resetNewAddress();
        setDialogKind('new-tab');
      } else setFocusAddress(true);
    });
  }, [ready, resetNewAddress]);
  useLayoutEffect(() => {
    if (!focusAddress || state?.page !== 'workspace') return;
    addressInput.current?.focus();
    addressInput.current?.select();
    setFocusAddress(false);
  }, [focusAddress, state?.page, activeId]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!info || event.isComposing || event.altKey || event.shiftKey || dialogOpen) return;
      const primary =
        info.platform === 'darwin'
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey;
      if (!primary) return;
      const key = event.key.toLowerCase();
      if (key === 't') {
        event.preventDefault();
        newTab();
      }
      if (key === 'l') {
        event.preventDefault();
        setFocusAddress(true);
      }
      if (key === 'w' && active) {
        event.preventDefault();
        run(window.desktop.closeTab(active.id));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, dialogOpen, info, newTab, run]);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!dialogKind || !element) return;
    if (!element.open) element.showModal();
    const target =
      dialogKind === 'new-tab'
        ? element.querySelector<HTMLElement>('#new-url')
        : (element.querySelector<HTMLElement>('[aria-current="page"]') ??
          element.querySelector<HTMLElement>('.tab-list-choice'));
    target?.focus();
  }, [dialogKind]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !activeId || state?.page !== 'workspace') return;
    const measure = () => {
      const { x, y, width, height } = element.getBoundingClientRect();
      run(window.desktop.setViewport({ x, y, width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [activeId, state?.page, run]);

  if (!state)
    return (
      <main className="startup-error">
        <span>Workbench</span>
        <p>{failure ?? t('loadingApp')}</p>
      </main>
    );

  return (
    <div className={`app ${info?.platform === 'darwin' ? 'mac' : 'other'}`}>
      <main className="main-shell">
        <header className="titlebar">
          <span className="app-name">Workbench</span>
          <nav aria-label="Workbench">
            {(['workspace', 'activity', 'settings'] as const).map((page) => (
              <button
                key={page}
                className="nav-item"
                aria-current={state.page === page ? 'page' : undefined}
                onClick={() => run(window.desktop.setPage(page))}
              >
                {t(page)}
              </button>
            ))}
          </nav>
        </header>
        <TabStrip state={state} t={t} run={run} newTab={newTab} showAllTabs={showAllTabs} />
        <div
          id="workspace-panel"
          className="content"
          role={state.page === 'workspace' ? 'tabpanel' : undefined}
        >
          {state.page === 'workspace' && !active && (
            <Overview t={t} run={run} addressInput={addressInput} />
          )}
          {state.page === 'workspace' && active && (
            <div className="browser">
              <div className="browser-toolbar">
                <IconButton
                  label={t('back')}
                  disabled={!active.canGoBack}
                  onClick={() => run(window.desktop.tabAction(active.id, 'back'))}
                >
                  <ArrowLeft size={16} aria-hidden="true" />
                </IconButton>
                <IconButton
                  label={t('forward')}
                  disabled={!active.canGoForward}
                  onClick={() => run(window.desktop.tabAction(active.id, 'forward'))}
                >
                  <ArrowRight size={16} aria-hidden="true" />
                </IconButton>
                <IconButton
                  label={t(active.loading ? 'stop' : 'reload')}
                  onClick={() =>
                    run(window.desktop.tabAction(active.id, active.loading ? 'stop' : 'reload'))
                  }
                >
                  {active.loading ? (
                    <X size={16} aria-hidden="true" />
                  ) : (
                    <RotateCw size={16} aria-hidden="true" />
                  )}
                </IconButton>
                <form
                  className="address-bar"
                  data-invalid={!!address.error}
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    void address.submit();
                  }}
                >
                  <LockKeyhole size={12} />
                  <TextInput
                    ref={addressInput}
                    aria-label={t('addressPlaceholder')}
                    value={address.value}
                    onChange={(event) => address.change(event.target.value)}
                    onKeyDown={address.onKeyDown}
                    aria-invalid={!!address.error}
                    aria-describedby={address.error ? 'browser-address-error' : undefined}
                    aria-busy={address.pending || undefined}
                    onFocus={(event) => event.target.select()}
                    spellCheck={false}
                  />
                </form>
                <IconButton
                  label={t('copy')}
                  onClick={() => run(window.desktop.tabAction(active.id, 'copy'), t('copied'))}
                >
                  <Copy size={16} aria-hidden="true" />
                </IconButton>
                <IconButton
                  label={t('capture')}
                  onClick={() => run(window.desktop.tabAction(active.id, 'capture'))}
                >
                  <Camera size={16} aria-hidden="true" />
                </IconButton>
                <IconButton
                  label={t('devtools')}
                  onClick={() => run(window.desktop.tabAction(active.id, 'devtools'))}
                >
                  <CodeXml size={16} aria-hidden="true" />
                </IconButton>
                <IconButton
                  label={t('external')}
                  onClick={() => run(window.desktop.tabAction(active.id, 'external'))}
                >
                  <ExternalLink size={16} aria-hidden="true" />
                </IconButton>
              </div>
              {address.error && (
                <p
                  className="address-error browser-address-error"
                  id="browser-address-error"
                  role="alert"
                >
                  {t(address.error)}
                </p>
              )}
              <div ref={viewport} className="web-viewport">
                {active.error && (
                  <div className="page-error">
                    <h2>{t('loadError')}</h2>
                    <p>{new URL(active.url).hostname}</p>
                    <code>{active.error}</code>
                    <Button onClick={() => run(window.desktop.tabAction(active.id, 'reload'))}>
                      {t('retry')}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
          {state.page === 'settings' && <Settings state={state} info={info} t={t} run={run} />}
          {state.page === 'activity' && <Activity state={state} t={t} run={run} />}
        </div>
      </main>
      <dialog
        ref={dialog}
        className={`new-tab-dialog ${dialogKind === 'all-tabs' ? 'all-tabs-dialog' : ''}`}
        data-kind={dialogKind}
        aria-labelledby={dialogKind === 'all-tabs' ? 'all-tabs-title' : 'new-tab-title'}
        onClose={() => {
          if (dialog.current?.open) return;
          dialogSession.current += 1;
          setDialogKind(null);
          resetNewAddress();
          run(window.desktop.setOverlay(false));
          if (dialogKind === 'all-tabs' && document.activeElement === document.body)
            document.getElementById(`tab-${state.activeTabId}`)?.focus();
        }}
      >
        {dialogKind === 'all-tabs' ? (
          <>
            <div className="dialog-heading">
              <h2 id="all-tabs-title">
                {t('allTabs')} ({state.tabs.length})
              </h2>
              <IconButton label={t('close')} onClick={() => dialog.current?.close()}>
                <X size={15} aria-hidden="true" />
              </IconButton>
            </div>
            {tabListError && (
              <p className="address-error" role="alert">
                {t('tabSwitchFailed')}
              </p>
            )}
            <ul className="tab-overflow-list">
              {state.tabs.map((tab) => (
                <li key={tab.id}>
                  <button
                    className="tab-list-choice"
                    disabled={switchingTab !== null}
                    aria-busy={switchingTab === tab.id || undefined}
                    aria-current={
                      state.page === 'workspace' && state.activeTabId === tab.id
                        ? 'page'
                        : undefined
                    }
                    onClick={() => {
                      const session = dialogSession.current;
                      setSwitchingTab(tab.id);
                      setTabListError(false);
                      void window.desktop
                        .activateTab(tab.id)
                        .then(() => {
                          if (
                            dialogSession.current === session &&
                            dialog.current?.open &&
                            dialog.current.dataset.kind === 'all-tabs'
                          )
                            dialog.current.close();
                        })
                        .catch(() => {
                          if (
                            dialogSession.current === session &&
                            dialog.current?.open &&
                            dialog.current.dataset.kind === 'all-tabs'
                          )
                            setTabListError(true);
                        })
                        .finally(() => {
                          if (dialogSession.current === session) setSwitchingTab(null);
                        });
                    }}
                  >
                    <span className="tab-list-copy">
                      <strong>{tab.title}</strong>
                      <small>{new URL(tab.url).host}</small>
                    </span>
                    {state.page === 'workspace' && state.activeTabId === tab.id && (
                      <small className="tab-list-current">{t('currentTab')}</small>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void newAddress.submit().then((opened) => {
                if (opened) dialog.current?.close();
              });
            }}
          >
            <div className="dialog-heading">
              <h2 id="new-tab-title">{t('newPage')}</h2>
              <IconButton label={t('close')} onClick={() => dialog.current?.close()}>
                <X size={15} />
              </IconButton>
            </div>
            <p className="dialog-description">{t('newPageHint')}</p>
            <label className="url-label" htmlFor="new-url">
              {t('source')}
            </label>
            <TextInput
              id="new-url"
              name="url"
              autoFocus
              placeholder="https://example.com"
              autoComplete="off"
              value={newAddress.value}
              onChange={(event) => newAddress.change(event.target.value)}
              onKeyDown={newAddress.onKeyDown}
              required
              aria-invalid={!!newAddress.error}
              aria-describedby="url-error"
            />
            <div className="form-error" id="url-error" role="alert">
              {newAddress.error && t(newAddress.error)}
            </div>
            <footer>
              <Button type="button" onClick={() => dialog.current?.close()}>
                {t('cancel')}
              </Button>
              <Button variant="primary" loading={newAddress.pending} type="submit">
                {t('open')}
              </Button>
            </footer>
          </form>
        )}
      </dialog>
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button aria-label={t('close')} onClick={() => setToast('')}>
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
