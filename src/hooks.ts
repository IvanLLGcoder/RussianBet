import { useEffect, useState } from 'react';

// Vrai sur téléphone : sert à alléger certaines vues (graphiques plus bas, pas de « à la une »).
const compactQuery = '(max-width: 600px)';

export function useCompact() {
  const [compact, setCompact] = useState(() => window.matchMedia(compactQuery).matches);
  useEffect(() => {
    const query = window.matchMedia(compactQuery);
    const onChange = () => setCompact(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return compact;
}
