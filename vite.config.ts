import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import brand from './brand.config.json';

// Le nom du site est défini une seule fois dans brand.config.json :
// ce plugin l'injecte dans index.html et génère le manifeste de l'app installable.
// BASE_PATH (ex. « /paris ») publie le site sous un sous-chemin ; vide = racine du domaine.
const base = `${(process.env.BASE_PATH ?? '').replace(/\/+$/, '')}/`;

function brandPlugin(): Plugin {
  const manifest = JSON.stringify({
    id: base,
    name: `${brand.name} — ${brand.tagline}`,
    short_name: brand.name,
    description: brand.description,
    lang: 'fr',
    start_url: base,
    scope: base,
    display: 'standalone',
    orientation: 'any',
    background_color: '#ffffff',
    theme_color: '#1652f0',
    icons: [
      { src: `${base}icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${base}icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `${base}maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
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
  base,
  plugins: [react(), brandPlugin()],
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
