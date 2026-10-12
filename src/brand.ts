import brand from '../brand.config.json';

// Le nom du site vit dans brand.config.json (partagé avec le serveur et Vite).
export default brand as { name: string; wordmark: string; tagline: string; description: string };
