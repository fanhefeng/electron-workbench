import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { normalizeURL, parseDeepLink, settingsPatch } from '../src/shared/validation.ts';
import { shellCSP } from '../src/shared/csp.ts';

test('shell CSP restricts production scripts, connections, frames and forms', () => {
  const policy = new Map(
    shellCSP()
      .split('; ')
      .map((rule) => {
        const [name, ...sources] = rule.split(' ');
        return [name, sources];
      }),
  );
  assert.deepEqual(policy.get('script-src'), ["'self'"]);
  assert.deepEqual(policy.get('connect-src'), ["'none'"]);
  for (const name of ['object-src', 'base-uri', 'frame-src', 'form-action'])
    assert.deepEqual(policy.get(name), ["'none'"]);
  assert.ok(!shellCSP().includes('nonce-'));
});

test('development CSP only adds the supplied nonce and local HMR connection', () => {
  const production = shellCSP().split('; ');
  const development = shellCSP('test-nonce').split('; ');
  assert.equal(development.length, production.length);
  assert.ok(development.includes("script-src 'self' 'nonce-test-nonce'"));
  assert.ok(development.includes("connect-src 'self' ws://127.0.0.1:5197"));
  assert.deepEqual(
    development.filter((rule) => !/^(script|connect)-src /.test(rule)),
    production.filter((rule) => !/^(script|connect)-src /.test(rule)),
  );
});

test('navigation accepts HTTPS and rejects privilege-bearing schemes and credentials', () => {
  assert.equal(normalizeURL('example.com/path?q=1'), 'https://example.com/path?q=1');
  for (const value of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,x',
    'http://example.com',
    'https://user:secret@example.com',
    '',
    null,
    'x'.repeat(2 * 1024 * 1024 + 1),
  ]) {
    assert.throws(() => normalizeURL(value));
  }
  assert.throws(() => normalizeURL('http://localhost:9000'));
  assert.equal(normalizeURL('http://127.0.0.1:9000', true), 'http://127.0.0.1:9000/');
  assert.throws(() => normalizeURL('http://localhost.evil.test', true));
});
test('addresses accept ports without reinterpreting unsafe schemes', () => {
  for (const host of [
    'example.com',
    'example.com.',
    'localhost',
    '127.0.0.1',
    '[::1]',
    '例子.测试',
  ]) {
    const value = `${host}:8443/path?q=1#section`;
    assert.equal(normalizeURL(value), new URL(`https://${value}`).href);
  }
  for (const value of [
    'javascript:123',
    'data:123',
    'file:123',
    'http:123',
    'https://example.com:65536',
  ])
    assert.throws(() => normalizeURL(value));
});
test('URL normalization is stable for long and encoded addresses and bounds the result', () => {
  for (const value of [
    `https://example.com/#${'x'.repeat(5000)}`,
    `https://example.com/?q=${'汉'.repeat(500)}`,
  ]) {
    const url = normalizeURL(value);
    assert.equal(normalizeURL(url), url);
  }
  assert.throws(() => normalizeURL(`https://example.com/?q=${'汉'.repeat(240_000)}`));
});
test('deep links cannot cross schemes, actions, or navigate to local files', () => {
  assert.equal(
    parseDeepLink('workbench://open?url=https%3A%2F%2Fexample.com', 'workbench'),
    'https://example.com/',
  );
  assert.equal(parseDeepLink('workbench-dev://open?url=https://example.com', 'workbench'), null);
  assert.equal(parseDeepLink('workbench://quit?url=https://example.com', 'workbench'), null);
  assert.equal(parseDeepLink('workbench://open?url=file:///etc/passwd', 'workbench'), null);
});
test('settings validate exact enums and booleans at runtime', () => {
  assert.deepEqual(settingsPatch({ locale: 'en', restoreTabs: false, htmlInCanvas: true }), {
    locale: 'en',
    restoreTabs: false,
    htmlInCanvas: true,
  });
  for (const input of [
    { closeToTray: 'true' },
    { htmlInCanvas: 'true' },
    { htmlInCanvas: 1 },
    { theme: 'neon' },
    { theme: ['dark'] },
    { accent: ['moss'] },
    { locale: ['en'] },
    { theme: { toString: () => 'dark' } },
    { arbitrary: '/etc' },
    [],
    null,
  ])
    assert.throws(() => settingsPatch(input));
});
