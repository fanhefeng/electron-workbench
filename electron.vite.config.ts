import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { randomBytes } from 'node:crypto';
import { shellCSP } from './src/shared/csp.ts';

export default defineConfig(({ command }) => {
  const development = command === 'serve';
  const nonce = development ? randomBytes(16).toString('base64') : undefined;
  return {
    main: {},
    preload: {
      build: { rolldownOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } },
    },
    renderer: {
      plugins: [
        react(),
        {
          name: 'shell-csp',
          transformIndexHtml: {
            order: 'pre',
            handler: (html) => html.replace('__SHELL_CSP__', shellCSP(nonce)),
          },
        },
      ],
      html: { cspNonce: nonce },
      server: { host: '127.0.0.1', port: 5197, strictPort: true },
      build: { target: 'chrome156', minify: true },
    },
  };
});
