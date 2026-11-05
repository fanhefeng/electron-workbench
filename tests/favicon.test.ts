import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import type { Session } from 'electron';
import { loadFavicon } from '../src/main/favicon.ts';

const signal = () => new AbortController().signal;
const pageSession = (fetch: Session['fetch']) => ({ fetch }) as Session;

test('favicon handles inline SVG and preserves icon formats as image data', async () => {
  const noNetwork = pageSession(async () => {
    throw new Error('Unexpected request');
  });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const data = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  assert.equal(
    await loadFavicon(noNetwork, `data:image/svg+xml,${encodeURIComponent(svg)}`, signal(), false),
    data,
  );
  assert.equal(await loadFavicon(noNetwork, data, signal(), false), data);
  const requests: string[] = [];
  const session = pageSession(async (input, init) => {
    requests.push(typeof input === 'string' ? input : input.url);
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.credentials, 'omit');
    if (requests.length === 1)
      return new Response(null, { status: 302, headers: { location: '/icon.ico' } });
    return new Response('icon bytes', { headers: { 'content-type': 'image/x-icon' } });
  });
  assert.equal(
    await loadFavicon(session, 'https://example.com/favicon', signal(), false),
    `data:image/x-icon;base64,${Buffer.from('icon bytes').toString('base64')}`,
  );
  assert.deepEqual(requests, ['https://example.com/favicon', 'https://example.com/icon.ico']);
});

test('favicon rejects unsafe URLs, redirects and non-image content', async () => {
  let requests = 0;
  const session = pageSession(async () => {
    requests++;
    return new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } });
  });
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://example.com/icon',
    'https://user:password@example.com/icon',
    'data:text/html,hello',
  ]) {
    await assert.rejects(loadFavicon(session, url, signal(), false));
  }
  assert.equal(requests, 0);
  await assert.rejects(
    loadFavicon(session, 'https://example.com/icon', signal(), false),
    /HTTPS required/,
  );
  assert.equal(requests, 1, 'an unsafe redirect must never be fetched');
  const html = pageSession(
    async () => new Response('<html/>', { headers: { 'content-type': 'text/html' } }),
  );
  await assert.rejects(
    loadFavicon(html, 'https://example.com/icon', signal(), false),
    /Invalid favicon response/,
  );
});

test('favicon caps streamed bodies and cancels oversized responses', async () => {
  let cancelled = false;
  const session = pageSession(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(256 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'image/png' } },
      ),
  );
  await assert.rejects(
    loadFavicon(session, 'https://example.com/icon', signal(), false),
    /Favicon too large/,
  );
  assert.ok(cancelled);
  await assert.rejects(
    loadFavicon(session, `data:image/png;base64,${'a'.repeat(400000)}`, signal(), false),
    /Favicon too large/,
  );
});

test('favicon releases its reader and preserves the read error when cancellation fails', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(256 * 1024 + 1));
    },
    cancel() {
      throw new Error('Cancellation failed');
    },
  });
  const session = pageSession(
    async () => new Response(body, { headers: { 'content-type': 'image/png' } }),
  );
  await assert.rejects(
    loadFavicon(session, 'https://example.com/icon', signal(), false),
    /Favicon too large/,
  );
  assert.equal(body.locked, false);
});
