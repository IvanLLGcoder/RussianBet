import type { Market } from './api';

export const categories = ['Politics', 'Sports', 'Technology', 'Culture', 'Science', 'Community'] as const;

// Les catégories restent stockées en anglais dans la base (compatibilité avec l'ancienne version).
export const categoryLabels: Record<string, string> = {
  Politics: 'Politique',
  Sports: 'Sports',
  Technology: 'Tech',
  Culture: 'Culture',
  Science: 'Science',
  Community: 'Communauté',
};

const numberFormat = new Intl.NumberFormat('fr-FR');
const compactFormat = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });

export function credits(value: number) {
  return `${numberFormat.format(value)} cr`;
}

export function compactCredits(value: number) {
  return value >= 10_000 ? `${compactFormat.format(value)} cr` : credits(value);
}

export function signed(value: number) {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${numberFormat.format(Math.abs(value))}`;
}

// Probabilité implicite de chaque issue : (prises sur l'issue + 1) / (prises totales + nb d'issues).
// C'est exactement 1 / cote non arrondie, donc les probabilités d'un marché somment à 100 %.
export function chances(market: Market) {
  const total = market.optionStats.reduce((sum, option) => sum + option.count, 0);
  return market.optionStats.map((option) => (option.count + 1) / (total + market.options.length));
}

export function percent(probability: number) {
  if (probability < 0.01) return '<1%';
  if (probability > 0.99) return '>99%';
  return `${Math.round(probability * 100)}%`;
}

// Prix « à la Polymarket » : une part paie 1 crédit si l'issue gagne, et coûte 1 / cote.
export function cents(odds: number) {
  return `${Math.min(99, Math.max(1, Math.round(100 / odds)))}¢`;
}

export function payout(amount: number, odds: number) {
  return Math.floor(amount * odds);
}

export type MarketState = 'open' | 'awaiting' | 'resolved' | 'cancelled';

export function marketState(market: Market, now: number): MarketState {
  if (market.cancelledAt) return 'cancelled';
  if (market.status === 'resolved') return 'resolved';
  return new Date(market.endsAt).getTime() <= now ? 'awaiting' : 'open';
}

export function isBinary(market: Market) {
  return market.options.length === 2;
}

export function shortDate(value: string | number) {
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value));
}

export function dateTime(value: string | number) {
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

export function timeLeft(value: string, now: number) {
  const difference = new Date(value).getTime() - now;
  if (difference <= 0) return 'Clôturé';
  const minutes = Math.floor(difference / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days} j ${hours % 24} h`;
  if (hours > 0) return `${hours} h ${minutes % 60} min`;
  return `${Math.max(1, minutes)} min`;
}

export function timeAgo(value: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'à l’instant';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `il y a ${days} j`;
  return shortDate(value);
}

export function localDateTime(value: Date) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

// Couleurs des issues : vert / rouge pour un marché binaire, palette distincte sinon.
const palette = ['#1652f0', '#f2780c', '#8b5cf6', '#14a3a3', '#e5489b', '#c49a00'];

export function outcomeColor(market: Market, index: number) {
  if (isBinary(market)) return index === 0 ? 'var(--yes)' : 'var(--no)';
  return palette[index % palette.length];
}

export function seriesColor(market: Market, index: number) {
  if (isBinary(market)) return '#1652f0';
  return palette[index % palette.length];
}

// Couleur de la jauge : rouge à 0 %, vert à 100 %.
export function gaugeColor(probability: number) {
  return `hsl(${Math.round(probability * 135)} 62% 46%)`;
}

export function avatarColor(name: string) {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 70% 55%)`;
}
