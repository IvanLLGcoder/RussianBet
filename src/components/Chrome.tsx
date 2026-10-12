import { useEffect, useRef, useState } from 'react';
import {
  Bell, ChevronDown, Clock3, Flame, House, Info, LogOut, Moon, Plus, Search, Sparkles, Sun, Trophy, UserRoundPlus, WalletMinimal, X,
} from 'lucide-react';
import type { Market, User } from '../api';
import brand from '../brand';
import { categories, categoryLabels, chances, credits, percent } from '../format';
import { linkProps, navigate, type Route } from '../router';
import { Avatar, MarketIcon } from './Bits';
import { Logo, Wordmark } from './Logo';
import { marketPath } from './MarketCard';

export type Feed = 'trending' | 'new' | 'ending' | typeof categories[number];

function SearchBox({
  markets,
  query,
  onQuery,
}: {
  markets: Market[];
  query: string;
  onQuery: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const needle = query.trim().toLowerCase();
  const results = needle
    ? markets.filter((market) => `${market.title} ${market.options.join(' ')}`.toLowerCase().includes(needle)).slice(0, 6)
    : [];

  function open(market: Market) {
    navigate(marketPath(market));
    onQuery('');
    inputRef.current?.blur();
  }

  return (
    <div className="search">
      <Search size={16} className="search-icon" />
      <input
        ref={inputRef}
        value={query}
        placeholder={`Rechercher sur ${brand.name}`}
        aria-label="Rechercher des marchés"
        onChange={(event) => { onQuery(event.target.value); setCursor(0); }}
        onFocus={() => setFocused(true)}
        onBlur={() => window.setTimeout(() => setFocused(false), 120)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setCursor((cursor + 1) % Math.max(1, results.length)); }
          if (event.key === 'ArrowUp') { event.preventDefault(); setCursor((cursor - 1 + results.length) % Math.max(1, results.length)); }
          if (event.key === 'Enter') {
            if (results[cursor]) open(results[cursor]);
            else navigate('/');
          }
          if (event.key === 'Escape') { onQuery(''); inputRef.current?.blur(); }
        }}
      />
      {query ? (
        <button className="search-clear" aria-label="Effacer" onClick={() => onQuery('')}><X size={14} /></button>
      ) : <kbd>/</kbd>}
      {focused && needle && (
        <div className="search-results" role="listbox">
          {results.length === 0 && <div className="search-empty">Aucun marché pour « {query} »</div>}
          {results.map((market, index) => {
            const top = chances(market).reduce((best, value, position, all) => (value > all[best] ? position : best), 0);
            return (
              <button
                key={market.id}
                role="option"
                aria-selected={index === cursor}
                className={index === cursor ? 'active' : ''}
                onMouseDown={(event) => { event.preventDefault(); open(market); }}
              >
                <MarketIcon market={market} size={30} />
                <span className="search-result-title">{market.title}</span>
                <span className="search-result-chance">{percent(chances(market)[top])} <small>{market.options[top]}</small></span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function UserMenu({
  user,
  theme,
  onTheme,
  onInvite,
  onNotifications,
  onHelp,
  onSignOut,
}: {
  user: User;
  theme: 'light' | 'dark';
  onTheme: () => void;
  onInvite: () => void;
  onNotifications: () => void;
  onHelp: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  // Les entrées déjà présentes dans la barre du bas sont masquées sur téléphone.
  const item = (icon: React.ReactNode, label: string, action: () => void, mobileHidden = false) => (
    <button role="menuitem" data-mobile-hidden={mobileHidden || undefined} onClick={() => { setOpen(false); action(); }}>{icon}{label}</button>
  );

  return (
    <div className="user-menu" ref={ref}>
      <button className="user-menu-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Avatar name={user.username} size={30} />
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <Avatar name={user.username} size={36} />
            <div><strong>{user.username}</strong><small>{credits(user.balance)} disponibles</small></div>
          </div>
          {item(<WalletMinimal size={16} />, 'Portefeuille', () => navigate('/portfolio'), true)}
          {item(<Trophy size={16} />, 'Classement', () => navigate('/leaderboard'), true)}
          {item(<UserRoundPlus size={16} />, 'Inviter des amis', onInvite)}
          {item(<Bell size={16} />, 'Notifications', onNotifications)}
          {item(theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />, theme === 'dark' ? 'Mode clair' : 'Mode sombre', onTheme)}
          {item(<Info size={16} />, 'Comment ça marche', onHelp)}
          <div className="menu-divider" />
          {item(<LogOut size={16} />, 'Se déconnecter', onSignOut)}
        </div>
      )}
    </div>
  );
}

export function Header({
  user,
  markets,
  portfolioValue,
  route,
  feed,
  query,
  theme,
  onQuery,
  onFeed,
  onTheme,
  onCreate,
  onAuth,
  onInvite,
  onNotifications,
  onHelp,
  onSignOut,
}: {
  user: User | null;
  markets: Market[];
  portfolioValue: number;
  route: Route;
  feed: Feed;
  query: string;
  theme: 'light' | 'dark';
  onQuery: (value: string) => void;
  onFeed: (feed: Feed) => void;
  onTheme: () => void;
  onCreate: () => void;
  onAuth: (mode: 'login' | 'register') => void;
  onInvite: () => void;
  onNotifications: () => void;
  onHelp: () => void;
  onSignOut: () => void;
}) {
  const feeds: { id: Feed; label: React.ReactNode }[] = [
    { id: 'trending', label: <><Flame size={15} /> Tendances</> },
    { id: 'new', label: <><Sparkles size={15} /> Nouveaux</> },
    { id: 'ending', label: <><Clock3 size={15} /> Bientôt clos</> },
  ];
  const onHome = route.name === 'home';

  return (
    <header className={`topbar${onHome ? '' : ' topbar-inner'}`}>
      <div className="topbar-row">
        <a className="brand" {...linkProps('/')} aria-label={`${brand.name}, accueil`}>
          <Logo size={30} />
          <Wordmark />
        </a>
        {user && <SearchBox markets={markets} query={query} onQuery={onQuery} />}
        <button className="how-link" onClick={onHelp}><Info size={15} /> Comment ça marche</button>
        <div className="topbar-spacer" />
        {user ? (
          <div className="topbar-actions">
            <a className="topbar-stat" {...linkProps('/portfolio')}>
              <small>Portefeuille</small>
              <b>{credits(portfolioValue)}</b>
            </a>
            <a className="topbar-stat" {...linkProps('/portfolio')}>
              <small>Solde</small>
              <b>{credits(user.balance)}</b>
            </a>
            <button className="btn btn-primary btn-create" onClick={onCreate}><Plus size={16} /> <span>Créer</span></button>
            <UserMenu
              user={user}
              theme={theme}
              onTheme={onTheme}
              onInvite={onInvite}
              onNotifications={onNotifications}
              onHelp={onHelp}
              onSignOut={onSignOut}
            />
          </div>
        ) : (
          <div className="topbar-actions">
            <button className="icon-btn theme-toggle" aria-label="Changer de thème" onClick={onTheme}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button>
            <button className="btn btn-text" onClick={() => onAuth('login')}>Connexion</button>
            <button className="btn btn-primary" onClick={() => onAuth('register')}>Inscription</button>
          </div>
        )}
      </div>
      {user && (
        <nav className="catnav" aria-label="Rubriques">
          {feeds.map((entry) => (
            <button
              key={entry.id}
              className={`catnav-item catnav-feed${onHome && feed === entry.id ? ' active' : ''}`}
              onClick={() => { onFeed(entry.id); navigate('/'); }}
            >{entry.label}</button>
          ))}
          <span className="catnav-divider" />
          {categories.map((category) => (
            <button
              key={category}
              className={`catnav-item${onHome && feed === category ? ' active' : ''}`}
              onClick={() => { onFeed(category); navigate('/'); }}
            >{categoryLabels[category]}</button>
          ))}
        </nav>
      )}
    </header>
  );
}

export function MobileTabs({ route, onCreate }: { route: Route; onCreate: () => void }) {
  return (
    <nav className="mobile-tabs" aria-label="Navigation">
      <a className={route.name === 'home' ? 'active' : ''} {...linkProps('/')}><House size={20} />Accueil</a>
      <button onClick={onCreate}><Plus size={20} />Créer</button>
      <a className={route.name === 'portfolio' ? 'active' : ''} {...linkProps('/portfolio')}><WalletMinimal size={20} />Portefeuille</a>
      <a className={route.name === 'leaderboard' ? 'active' : ''} {...linkProps('/leaderboard')}><Trophy size={20} />Classement</a>
    </nav>
  );
}

export type Toast = { id: number; title: string; body?: string; tone?: 'success' | 'error' };

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div className={`toast toast-${toast.tone ?? 'success'}`} key={toast.id}>
          <div><strong>{toast.title}</strong>{toast.body && <p>{toast.body}</p>}</div>
          <button className="icon-btn" aria-label="Fermer" onClick={() => onDismiss(toast.id)}><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}
