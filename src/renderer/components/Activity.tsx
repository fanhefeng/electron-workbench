import type { Snapshot } from '../../shared/model.ts';
import type { Translate } from '../i18n';
import { Button } from './Primitives';

export function Activity({
  state,
  t,
  run,
}: {
  state: Snapshot;
  t: Translate;
  run: (task: Promise<unknown>) => void;
}) {
  return (
    <div className="page activity-page">
      <header className="page-header">
        <h1>{t('activity')}</h1>
        <p>{t('activityHint')}</p>
      </header>
      <section className="settings-section">
        <h2>{t('downloads')}</h2>
        {!state.downloads.length && <p className="empty-line">{t('noDownloads')}</p>}
        {state.downloads.map((item) => (
          <div className="activity-row" key={item.id}>
            <div>
              <strong>{item.name}</strong>
              <small>
                {t(item.state)} · {Math.round(item.received / 1024)} KB
                {item.total > 0 && ` / ${Math.round(item.total / 1024)} KB`}
              </small>
              {item.state === 'progressing' && (
                <progress value={item.received} max={item.total || 1} />
              )}
            </div>
            {item.state === 'completed' && (
              <Button size="small" onClick={() => run(window.desktop.showDownload(item.id))}>
                {t('showFile')}
              </Button>
            )}
          </div>
        ))}
      </section>
      <section className="settings-section">
        <h2>{t('recent')}</h2>
        {!state.activity.length && <p className="empty-line">{t('noActivity')}</p>}
        {state.activity.map((item) => (
          <div className="activity-row" key={item.id}>
            <div>
              <strong>
                {item.kind === 'settings' ? t('settingsChanged') : `${t(item.kind)} ${item.label}`}
              </strong>
            </div>
            <time>
              {new Date(item.time).toLocaleTimeString(
                state.settings.locale === 'zh' ? 'zh-CN' : 'en-US',
                { hour: '2-digit', minute: '2-digit' },
              )}
            </time>
          </div>
        ))}
      </section>
    </div>
  );
}
