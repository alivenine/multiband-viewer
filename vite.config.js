import { defineConfig } from 'vite';

// Production builds get a Content-Security-Policy that forbids any network connection
// except loading the app's own files, so images can't be uploaded anywhere.
const CSP = "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' blob: data:; connect-src 'self' blob: data:; form-action 'none'; base-uri 'none'";

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 600 },
  server: { port: 5173, strictPort: true },
  plugins: [{
    name: 'csp',
    // web builds only: Tauri's tauri:// scheme isn't 'self' for an in-page CSP in WebKit and the app would not start
    apply: (_, { command }) => command === 'build' && !process.env.TAURI_ENV_PLATFORM,
    transformIndexHtml: (html) => html.replace('<head>', `<head>\n  <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  }],
});
