import type { AppInfo, Settings as SettingsModel, Snapshot } from '../../shared/model.ts';
import type { Translate, MessageKey } from '../i18n';
import { Button, Select, SettingRow, Toggle } from './Primitives';

export function Settings({
  state,
  info,
  t,
  run,
}: {
  state: Snapshot;
  info: AppInfo | null;
  t: Translate;
  run: (task: Promise<unknown>, success?: string) => void;
}) {
  const settings = state.settings;
  const change = (patch: Partial<SettingsModel>) => run(window.desktop.updateSettings(patch));
  const switches: {
    key: 'restoreTabs' | 'closeToTray' | 'notifications' | 'openAtLogin';
    label: MessageKey;
    hint: MessageKey;
  }[] = [
    { key: 'restoreTabs', label: 'restore', hint: 'restoreHint' },
    { key: 'closeToTray', label: 'tray', hint: 'trayHint' },
    { key: 'notifications', label: 'notifications', hint: 'notificationsHint' },
    { key: 'openAtLogin', label: 'login', hint: 'loginHint' },
  ];
  const updateLabel: MessageKey =
    state.update.status === 'unconfigured' ? 'updateUnconfigured' : state.update.status;
  return (
    <div className="page settings-page">
      <header className="page-header">
        <h1>{t('settings')}</h1>
        <p>{t('settingsIntro')}</p>
      </header>
      <section className="settings-section" aria-labelledby="appearance-heading">
        <h2 id="appearance-heading">{t('appearance')}</h2>
        <div className="settings-group">
          <SettingRow id="theme" label={t('theme')} description={t('themeHint')}>
            <Select
              id="theme"
              aria-label={t('theme')}
              aria-describedby="theme-hint"
              value={settings.theme}
              options={(['system', 'light', 'dark'] as const).map((value) => ({
                value,
                label: t(value),
              }))}
              onValueChange={(theme) => change({ theme })}
            />
          </SettingRow>
          <SettingRow id="accent" label={t('accent')} description={t('accentControlHint')}>
            <Select
              id="accent"
              aria-label={t('accent')}
              aria-describedby="accent-hint"
              value={settings.accent}
              options={(['graphite', 'moss', 'clay'] as const).map((value) => ({
                value,
                label: t(value),
              }))}
              onValueChange={(accent) => change({ accent })}
            />
          </SettingRow>
          <SettingRow id="locale" label={t('language')}>
            <Select
              id="locale"
              aria-label={t('language')}
              value={settings.locale}
              options={[
                { value: 'zh', label: '简体中文' },
                { value: 'en', label: 'English' },
              ]}
              onValueChange={(locale) => change({ locale })}
            />
          </SettingRow>
        </div>
      </section>
      <section className="settings-section" aria-labelledby="web-pages-heading">
        <h2 id="web-pages-heading">{t('webPages')}</h2>
        <div className="settings-group">
          <SettingRow
            id="setting-htmlInCanvas"
            label={t('htmlInCanvas')}
            description={t('htmlInCanvasHint')}
          >
            <Toggle
              id="setting-htmlInCanvas"
              label={t('htmlInCanvas')}
              describedBy="setting-htmlInCanvas-hint"
              checked={settings.htmlInCanvas}
              onChange={(htmlInCanvas) => change({ htmlInCanvas })}
            />
          </SettingRow>
        </div>
      </section>
      <section className="settings-section" aria-labelledby="general-heading">
        <h2 id="general-heading">{t('general')}</h2>
        <div className="settings-group">
          {switches.map((item) => (
            <SettingRow
              key={item.key}
              id={`setting-${item.key}`}
              label={t(item.label)}
              description={t(item.hint)}
            >
              <Toggle
                id={`setting-${item.key}`}
                label={t(item.label)}
                describedBy={`setting-${item.key}-hint`}
                checked={settings[item.key]}
                disabled={
                  item.key === 'openAtLogin' && (!info?.packaged || info.platform === 'linux')
                }
                onChange={(value) => change({ [item.key]: value })}
              />
            </SettingRow>
          ))}
        </div>
      </section>
      <section className="settings-section" aria-labelledby="update-heading">
        <h2 id="update-heading">{t('updates')}</h2>
        <div className="settings-group">
          <div className="setting-row">
            <div className="setting-copy">
              <span>Workbench {info?.version}</span>
              <p role="status">
                {t(updateLabel)}
                {state.update.version && ` · ${state.update.version}`}
                {state.update.progress !== undefined && ` · ${Math.round(state.update.progress)}%`}
              </p>
            </div>
            <Button
              size="small"
              loading={['checking', 'installing'].includes(state.update.status)}
              disabled={state.update.status === 'downloading'}
              onClick={() =>
                run(
                  window.desktop.updateAction(
                    state.update.status === 'available'
                      ? 'download'
                      : state.update.status === 'downloaded'
                        ? 'install'
                        : 'check',
                  ),
                )
              }
            >
              {t(
                state.update.status === 'available'
                  ? 'downloadUpdate'
                  : ['downloaded', 'installing'].includes(state.update.status)
                    ? 'installUpdate'
                    : 'checkUpdates',
              )}
            </Button>
          </div>
        </div>
      </section>
      <footer className="about-line">
        <span>
          Electron {info?.electron ?? '—'} · Chromium {info?.chrome.split('.')[0] ?? '—'}
        </span>
        <Button
          variant="ghost"
          size="small"
          onClick={() => run(window.desktop.nativeAction('about'))}
        >
          {t('about')}
        </Button>
      </footer>
    </div>
  );
}
