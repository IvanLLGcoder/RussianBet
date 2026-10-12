import { useEffect, useState } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'market'; id: string }
  | { name: 'portfolio' }
  | { name: 'leaderboard' };

function parse(pathname: string): Route {
  const market = pathname.match(/^\/market\/([^/]+)\/?$/);
  if (market) return { name: 'market', id: decodeURIComponent(market[1]) };
  if (pathname.startsWith('/portfolio')) return { name: 'portfolio' };
  if (pathname.startsWith('/leaderboard')) return { name: 'leaderboard' };
  return { name: 'home' };
}

export function navigate(path: string) {
  if (path === window.location.pathname + window.location.search) return;
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo({ top: 0 });
}

export function useRoute() {
  const [route, setRoute] = useState<Route>(() => parse(window.location.pathname));
  useEffect(() => {
    const update = () => setRoute(parse(window.location.pathname));
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return route;
}

// Lien interne : garde le clic-molette / Cmd+clic natifs, navigue sans recharger sinon.
export function linkProps(path: string) {
  return {
    href: path,
    onClick: (event: React.MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      navigate(path);
    },
  };
}
