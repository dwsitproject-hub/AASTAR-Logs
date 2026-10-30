import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Release reported to the DWS Hub SDK so Sentinel reads the code users actually ran:
// VITE_GIT_SHA from CI, else the local git commit, else package version + build date.
function buildRelease(env) {
  if (env.VITE_GIT_SHA) return env.VITE_GIT_SHA;
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    return `${version}+${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
  }
}

// Injects the DWS Hub SDK <script> into <head>, before the app bundle, only when a
// key is configured. Each environment (staging / production Hub) has its own key.
function dwsHubSdk(env, mode) {
  const key = String(env.VITE_HUB_SDK_KEY || '').trim();
  const hubUrl = String(env.VITE_HUB_SDK_URL || 'https://dwshub.kpndomain.com').trim().replace(/\/+$/, '');
  return {
    name: 'dws-hub-sdk',
    transformIndexHtml() {
      if (!key || mode === 'desktop') return [];
      const attrs = {
        src: `${hubUrl}/api/sdk/v1/hub-sdk.js`,
        'data-app-key': key,
        'data-release': buildRelease(env),
        defer: true,
      };
      if (env.VITE_HUB_SDK_DEBUG === 'true') attrs['data-debug'] = 'true';
      // Vite HTML-escapes attribute values when it serializes the tag.
      return [{ tag: 'script', attrs, injectTo: 'head-prepend' }];
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    base: mode === 'desktop' ? './' : '/',
    plugins: [react(), dwsHubSdk(env, mode)],
    build: {
      rolldownOptions: {
        // Readable component/function names in production stack traces (Hub SDK + Sentinel).
        output: { keepNames: true },
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true
        }
      }
    }
  };
});
