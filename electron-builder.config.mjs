import { readFile } from 'node:fs/promises';
const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const update = JSON.parse(
  await readFile(new URL('./resources/update.json', import.meta.url), 'utf8'),
);
if (update.url) {
  const url = new URL(update.url);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('HTTPS update feed required');
}
export default {
  ...manifest.build,
  mac: {
    ...manifest.build.mac,
    sign: { identity: process.env.WORKBENCH_SIGN_IDENTITY || '-' },
  },
  publish: update.url ? [{ provider: 'generic', url: update.url }] : null,
};
