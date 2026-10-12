import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import brand from './brand.config.json';

// Le nom du site est défini une seule fois dans brand.config.json :
// ce plugin l'injecte dans index.html et génère le manifeste de l'app installable.
function brandPlugin(): Plugin {
  const manifest = JSON.stringify({
    id: '/',
    name: `${brand.name} — ${brand.tagline}`,
    short_name: brand.name,
    description: brand.description,
    lang: 'fr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#ffffff',
    theme_color: '#1652f0',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 2);

  return {
    name: 'brand',
    transformIndexHtml: (html) => html
      .replaceAll('%BRAND_NAME%', brand.name)
      .replaceAll('%BRAND_TAGLINE%', brand.tagline)
      .replaceAll('%BRAND_DESCRIPTION%', brand.description),
    configureServer(server) {
      server.middlewares.use('/manifest.webmanifest', (_request, response) => {
        response.setHeader('Content-Type', 'application/manifest+json');
        response.end(manifest);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: manifest });
    },
  };
}

export default defineConfig({
  plugins: [react(), brandPlugin()],
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
