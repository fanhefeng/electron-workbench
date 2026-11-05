import { readFile } from 'node:fs/promises';
const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const update = JSON.parse(
  await readFile(new URL('./resources/update.json', import.meta.url), 'utf8'),
);
const unsignedRelease = process.env.WORKBENCH_UNSIGNED_RELEASE === '1';
if (unsignedRelease && update.url)
  throw new Error('Unsigned releases require resources/update.json url to be null');
if (update.url) {
  const url = new URL(update.url);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('HTTPS update feed required');
}
export default {
  ...manifest.build,
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  mac: {
    ...manifest.build.mac,
    sign: { identity: unsignedRelease ? '-' : process.env.WORKBENCH_SIGN_IDENTITY || '-' },
    ...(unsignedRelease ? { notarize: false } : {}),
  },
  win: {
    ...manifest.build.win,
    ...(unsignedRelease ? { sign: false } : {}),
  },
  publish: !unsignedRelease && update.url ? [{ provider: 'generic', url: update.url }] : null,
};
