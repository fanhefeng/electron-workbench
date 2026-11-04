import type { Session } from 'electron';
import { normalizeURL } from '../shared/validation.ts';

const MAX_BYTES = 256 * 1024;
const IMAGE_TYPE = /^image\/(?:png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon|svg\+xml)$/i;

/** Keep remote image requests in the page session; the shell only receives bounded image data. */
export async function loadFavicon(
  session: Session,
  input: string,
  signal: AbortSignal,
  allowLocal: boolean,
): Promise<string> {
  if (input.startsWith('data:')) {
    if (input.length > MAX_BYTES * 1.5) throw new Error('Favicon too large');
    const match = /^data:([^;,]+)(;base64)?,(.*)$/is.exec(input);
    if (!match || !IMAGE_TYPE.test(match[1])) throw new Error('Invalid favicon type');
    const bytes = match[2]
      ? Buffer.from(match[3], 'base64')
      : Buffer.from(decodeURIComponent(match[3]));
    if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('Invalid favicon size');
    return `data:${match[1]};base64,${bytes.toString('base64')}`;
  }

  let url = input;
  for (let redirects = 0; redirects <= 3; redirects++) {
    url = normalizeURL(url, allowLocal);
    const response = await session.fetch(url, {
      signal,
      redirect: 'manual',
      credentials: 'include',
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('Invalid favicon redirect');
      url = new URL(location, url).href;
      continue;
    }
    const type = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
    if (
      !response.ok ||
      !IMAGE_TYPE.test(type) ||
      Number(response.headers.get('content-length')) > MAX_BYTES ||
      !response.body
    ) {
      await response.body?.cancel();
      throw new Error('Invalid favicon response');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) throw new Error('Favicon too large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!size) throw new Error('Empty favicon');
    return `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`;
  }
  throw new Error('Too many favicon redirects');
}
