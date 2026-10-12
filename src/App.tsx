import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from './api';
import type { Market, MarketValues, User } from './api';
import { Header, MobileTabs, Toasts, type Feed, type Toast } from './components/Chrome';
import { AuthModal, HowItWorksModal, InviteModal, MarketFormModal, NotificationsModal, type AuthMode } from './components/Modals';
import { cents, credits, marketState, payout } from './format';
import { Home } from './pages/Home';
import { Landing } from './pages/Landing';
import { Leaderboard } from './pages/Leaderboard';
import { MarketPage } from './pages/MarketPage';
import { Portfolio, positionValue } from './pages/Portfolio';
import { navigate, useRoute } from './router';

type Theme = 'light' | 'dark';

function initialTheme(): Theme {
  const stored = localStorage.getItem('theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export default function App() {
  const route = useRoute();
  const [user, setUser] = useState<User | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);
  const [networkError, setNetworkError] = useState('');
  const [version, setVersion] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [feed, setFeed] = useState<Feed>('trending');
  const [query, setQuery] = useState('');
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const inviteLinkHandled = useRef(false);

  const notify = useCallback((title: string, body?: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current.slice(-3), { id, title, body, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 5000);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#15191e' : '#ffffff');
  }, [theme]);

  const refresh = useCallback(async () => {
    try {
      const me = await request<{ user: User | null }>('/api/me');
      setUser(me.user);
      if (!me.user) {
        setMarkets([]);
        // Ouvre la feuille d'inscription une seule fois : le rafraîchissement périodique ne doit pas la rouvrir.
        if (!inviteLinkHandled.current && new URLSearchParams(window.location.search).get('invite')) setAuthMode('register');
        inviteLinkHandled.current = true;
      } else {
        const result = await request<{ markets: Market[] }>('/api/markets');
        setMarkets(result.markets);
      }
      setNetworkError('');
      setVersion((value) => value + 1);
    } catch {
      setNetworkError('Connexion au serveur impossible. Nouvel essai dans un instant.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 15_000);
    const tick = window.setInterval(() => setNow(Date.now()), 1_000 * 30);
    return () => { window.clearInterval(timer); window.clearInterval(tick); };
  }, [refresh]);

  async function handleAuth(mode: AuthMode, values: Record<string, string>) {
    const payload = mode === 'register' ? values : { identity: values.identity, password: values.password };
    const result = await request<{ user: User }>(mode === 'register' ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (new URLSearchParams(window.location.search).has('invite')) window.history.replaceState(null, '', window.location.pathname);
    setUser(result.user);
    setAuthMode(null);
    notify(mode === 'register' ? `Bienvenue, ${result.user.username} !` : 'Connecté', mode === 'register' ? '1 000 crédits ont été ajoutés à votre solde.' : undefined);
    await refresh();
  }

  async function signOut() {
    await request('/api/auth/logout', { method: 'POST' });
    setUser(null);
    navigate('/');
    await refresh();
  }

  async function trade(market: Market, choiceIndex: number, amount: number) {
    const odds = market.optionStats[choiceIndex].odds;
    const result = await request<{ user: User }>(`/api/markets/${encodeURIComponent(market.id)}/bets`, {
      method: 'POST',
      body: JSON.stringify({ choiceIndex, amount }),
    });
    setUser(result.user);
    notify('Ordre exécuté', `${credits(amount)} sur « ${market.options[choiceIndex]} » à ~${cents(odds)} · gain potentiel ~${credits(payout(amount, odds))}`);
    await refresh();
  }

  async function resolve(market: Market, outcomeIndex: number) {
    const result = await request<{ user: User }>(`/api/markets/${encodeURIComponent(market.id)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcomeIndex }),
    });
    setUser(result.user);
    notify('Marché résolu', `Résultat : ${market.options[outcomeIndex]}`);
    await refresh();
  }

  async function cancel(market: Market) {
    const result = await request<{ user: User; refundedCredits: number; refundedCallers: number }>(
      `/api/markets/${encodeURIComponent(market.id)}/cancel`,
      { method: 'POST' },
    );
    setUser(result.user);
    notify('Marché annulé', `${credits(result.refundedCredits)} remboursés à ${result.refundedCallers} participant(s).`);
    await refresh();
  }

  async function edit(market: Market, values: MarketValues) {
    await request(`/api/markets/${encodeURIComponent(market.id)}`, { method: 'PATCH', body: JSON.stringify(values) });
    notify('Marché modifié');
    await refresh();
  }

  async function create(values: MarketValues & { options: string[] }) {
    const result = await request<{ id: string }>('/api/markets', { method: 'POST', body: JSON.stringify(values) });
    setCreateOpen(false);
    notify('Marché publié', values.title);
    await refresh();
    navigate(`/market/${encodeURIComponent(result.id)}`);
  }

  const openCreate = () => (user ? setCreateOpen(true) : setAuthMode('register'));
  const portfolioValue = (user?.balance ?? 0) + markets
    .filter((market) => market.myBet && ['open', 'awaiting'].includes(marketState(market, now)))
    .reduce((sum, market) => sum + positionValue(market), 0);

  let page: React.ReactNode;
  if (loading) page = <main className="page"><div className="page-loading" /></main>;
  else if (!user) page = <Landing onAuth={setAuthMode} />;
  else if (route.name === 'market') {
    page = (
      <MarketPage
        id={route.id}
        user={user}
        now={now}
        version={version}
        onTrade={trade}
        onResolve={resolve}
        onCancel={cancel}
        onEdit={edit}
        onSignIn={() => setAuthMode('login')}
        notify={notify}
      />
    );
  } else if (route.name === 'portfolio') page = <Portfolio user={user} markets={markets} now={now} />;
  else if (route.name === 'leaderboard') page = <Leaderboard user={user} version={version} />;
  else page = <Home markets={markets} now={now} feed={feed} query={query} onCreate={openCreate} />;

  return (
    <div className="app">
      <Header
        user={user}
        markets={markets}
        portfolioValue={portfolioValue}
        route={route}
        feed={feed}
        query={query}
        theme={theme}
        onQuery={setQuery}
        onFeed={setFeed}
        onTheme={() => setTheme((current) => {
          const next = current === 'dark' ? 'light' : 'dark';
          localStorage.setItem('theme', next);
          return next;
        })}
        onCreate={openCreate}
        onAuth={setAuthMode}
        onInvite={() => setInviteOpen(true)}
        onNotifications={() => setNotificationsOpen(true)}
        onHelp={() => setHelpOpen(true)}
        onSignOut={() => void signOut()}
      />
      {networkError && (
        <div className="network-alert" role="status">{networkError}<button onClick={() => void refresh()}>Réessayer</button></div>
      )}
      {page}
      {user && <MobileTabs route={route} onCreate={openCreate} onInvite={() => setInviteOpen(true)} />}

      {authMode && (
        <AuthModal
          mode={authMode}
          initialInviteCode={new URLSearchParams(window.location.search).get('invite') ?? ''}
          onModeChange={setAuthMode}
          onClose={() => setAuthMode(null)}
          onSubmit={handleAuth}
        />
      )}
      {createOpen && <MarketFormModal onClose={() => setCreateOpen(false)} onCreate={create} />}
      {inviteOpen && <InviteModal onClose={() => setInviteOpen(false)} />}
      {notificationsOpen && <NotificationsModal onClose={() => setNotificationsOpen(false)} />}
      {helpOpen && <HowItWorksModal onClose={() => setHelpOpen(false)} />}
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))} />
    </div>
  );
}
