import { useState, type RefObject } from 'react';
import { Bell, FileText, Folder, Link2 } from 'lucide-react';
import type { Translate } from '../i18n';
import { Button, TextInput } from './Primitives';

const LINKS = [
  { name: 'Electron', url: 'https://www.electronjs.org' },
  { name: 'React', url: 'https://react.dev' },
  { name: 'MDN', url: 'https://developer.mozilla.org' },
  { name: 'GitHub', url: 'https://github.com' },
] as const;

export function Overview({
  t,
  run,
  addressInput,
}: {
  t: Translate;
  run: (task: Promise<unknown>, success?: string) => void;
  addressInput: RefObject<HTMLInputElement | null>;
}) {
  const [url, setURL] = useState('');
  return (
    <div className="page overview">
      <header className="page-header">
        <h1>{t('workspace')}</h1>
        <p>{t('workspaceIntro')}</p>
      </header>
      <form
        className="open-form"
        onSubmit={(event) => {
          event.preventDefault();
          run(window.desktop.openTab(url));
        }}
      >
        <div className="input-with-icon">
          <Link2 size={15} aria-hidden="true" />
          <TextInput
            ref={addressInput}
            aria-label={t('addressPlaceholder')}
            placeholder="https://example.com"
            value={url}
            onChange={(event) => setURL(event.target.value)}
            required
            spellCheck={false}
          />
        </div>
        <Button type="submit" variant="primary">
          {t('open')}
        </Button>
      </form>
      <section className="shortcut-section">
        <h2>{t('library')}</h2>
        <ul className="quick-links">
          {LINKS.map((item) => (
            <li key={item.name}>
              <button
                className="resource-button"
                onClick={() => run(window.desktop.openTab(item.url))}
              >
                <span>
                  <strong>{item.name}</strong>
                  <small>{new URL(item.url).hostname}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="tools-section">
        <h2>{t('native')}</h2>
        <div className="tool-actions">
          <Button onClick={() => run(window.desktop.nativeAction('notify'), t('notificationSent'))}>
            <Bell size={14} aria-hidden="true" />
            {t('notify')}
          </Button>
          <Button onClick={() => run(window.desktop.nativeAction('data'))}>
            <Folder size={14} aria-hidden="true" />
            {t('files')}
          </Button>
          <Button onClick={() => run(window.desktop.nativeAction('logs'))}>
            <FileText size={14} aria-hidden="true" />
            {t('logs')}
          </Button>
        </div>
      </section>
    </div>
  );
}
