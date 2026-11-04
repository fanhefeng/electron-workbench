import { DEFAULT_SETTINGS, type Settings } from './model.ts';

const MAX_URL_LENGTH = 2 * 1024 * 1024;

export function normalizeURL(input: unknown, allowLocal = false): string {
  if (typeof input !== 'string' || !input.trim() || input.length > MAX_URL_LENGTH)
    throw new Error('Invalid URL');
  const value = input.trim();
  const hostWithPort = /^(?:localhost|[^/?#:.]+\.[^/?#:]+):\d+(?:[/?#]|$)/i.test(value);
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value);
  const url = new URL(hasScheme && !hostWithPort ? value : `https://${value}`);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowLocal && local && url.protocol === 'http:'))
    throw new Error('HTTPS required');
  if (url.username || url.password || !url.hostname) throw new Error('Invalid URL');
  if (url.href.length > MAX_URL_LENGTH) throw new Error('Invalid URL');
  return url.href;
}

export function settingsPatch(input: unknown): Partial<Settings> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid settings');
  const value = input as Record<string, unknown>;
  const result: Partial<Settings> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'theme' && typeof item === 'string' && ['system', 'light', 'dark'].includes(item))
      result.theme = item as Settings['theme'];
    else if (
      key === 'accent' &&
      typeof item === 'string' &&
      ['graphite', 'moss', 'clay'].includes(item)
    )
      result.accent = item as Settings['accent'];
    else if (key === 'locale' && typeof item === 'string' && ['zh', 'en'].includes(item))
      result.locale = item as Settings['locale'];
    else if (
      ['restoreTabs', 'closeToTray', 'notifications', 'openAtLogin', 'htmlInCanvas'].includes(
        key,
      ) &&
      typeof item === 'boolean'
    ) {
      Object.assign(result, { [key]: item });
    } else throw new Error(`Invalid setting: ${key}`);
  }
  return result;
}

export function readSettings(input: unknown): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...settingsPatch(input) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function parseDeepLink(value: string, scheme: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== `${scheme}:` || url.hostname !== 'open') return null;
    return normalizeURL(url.searchParams.get('url'));
  } catch {
    return null;
  }
}
