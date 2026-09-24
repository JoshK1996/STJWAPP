import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { buildVersion } from './shared/build-version';

export default defineConfig(({ command }) => {
  const version = command === 'build' ? buildVersion(fileURLToPath(new URL('.', import.meta.url))) : 'development';
  return {
    plugins: [react(), {
      name: 'stjw-release-version',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'app-version.json', source: JSON.stringify({ version }) });
      },
    }],
    define: { __STJW_BUILD_VERSION__: JSON.stringify(version) },
    server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3000' } },
    build: { outDir: 'dist' },
  };
});
