import { createWriteStream, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function createLogger(directory: string) {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'main.log');
  try {
    if (statSync(file).size > 2_000_000) renameSync(file, `${file}.old`);
  } catch {
    /* First launch. */
  }
  const stream = createWriteStream(file, { flags: 'a', mode: 0o600 });
  stream.on('error', (error) => console.error('Log write failed', error));
  return (action: string, detail = '') => {
    const line = `${new Date().toISOString()} ${action} ${detail}\n`;
    stream.write(line);
    if (!process.env.WORKBENCH_QUIET) console.info(line.trim());
  };
}
