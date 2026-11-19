export function renderInstallNotes(template, version, changelog = '') {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))
    throw new Error('Invalid release version');
  if (!template.includes('Workbench-{{VERSION}}-'))
    throw new Error('Install guide must use version placeholders');
  const notes = template.replaceAll('{{VERSION}}', version);
  if (notes.includes('{{') || /xattr\s+-|spctl\s+--master-disable/.test(notes))
    throw new Error('Invalid install guide placeholder or security bypass');
  const suffixes = new Set([
    'mac-arm64.dmg',
    'mac-arm64.zip',
    'mac-x64.dmg',
    'mac-x64.zip',
    'win-x64.exe',
    'linux-x86_64.AppImage',
  ]);
  const names = notes.match(/Workbench-[A-Za-z0-9._-]+/g) || [];
  for (const name of names) {
    if (
      !name.startsWith(`Workbench-${version}-`) ||
      !suffixes.has(name.slice(`Workbench-${version}-`.length))
    )
      throw new Error(`Unexpected installer filename: ${name}`);
  }
  return notes.trimEnd() + (changelog.trim() ? '\n\n' + changelog.trim() : '') + '\n';
}
