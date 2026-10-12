import { useEffect, useState } from 'react';
import { Activity, Plus, SearchX } from 'lucide-react';
import { request } from '../api';
import type { FeedEntry, HistoryPoint, Market } from '../api';
import { Avatar, MarketIcon } from '../components/Bits';
import type { Feed } from '../components/Chrome';
import { MarketCard, marketPath } from '../components/MarketCard';
import { PriceChart } from '../components/PriceChart';
import { cents, categoryLabels, chances, compactCredits, credits, isBinary, marketState, outcomeColor, percent, timeAgo, timeLeft } from '../format';
import { linkProps, navigate } from '../router';

type Status = 'active' | 'awaiting' | 'resolved' | 'all';
type Sort = 'volume' | 'new' | 'ending' | 'traders';

const feedTitles: Record<string, string> = {
  trending: 'Tendances',
  new: 'Nouveaux marchés',
  ending: 'Bientôt clos',
};

const sortForFeed = (feed: Feed): Sort => (feed === 'new' ? 'new' : feed === 'ending' ? 'ending' : 'volume');

function Featured({ market, now }: { market: Market; now: number }) {
  const [history, setHistory] = useState<HistoryPoint[] | null>(null);
  useEffect(() => {
    let active = true;
    request<{ history: HistoryPoint[] }>(`/api/markets/${encodeURIComponent(market.id)}`)
      .then((result) => { if (active) setHistory(result.history); })
      .catch(() => { if (active) setHistory([]); });
    return () => { active = false; };
  }, [market.id, market.bettorsCount]);

  const probabilities = chances(market);
  const ranked = market.options.map((option, index) => ({ option, index })).sort((a, b) => probabilities[b.index] - probabilities[a.index]);

  return (
    <article className="featured">
      <div className="featured-main">
        <a className="featured-head" {...linkProps(marketPath(market))}>
          <MarketIcon market={market} size={52} />
          <div>
            <span className="featured-kicker">{categoryLabels[market.category] ?? market.category} · À la une</span>
            <h2>{market.title}</h2>
          </div>
        </a>
        <div className="featured-body">
          <div className="featured-outcomes">
            {ranked.slice(0, 4).map(({ option, index }) => (
              <button key={option} className="featured-outcome" onClick={() => navigate(marketPath(market, index))}>
                <span><i style={{ background: isBinary(market) && index === 0 ? '#1652f0' : outcomeColor(market, index) }} />{option}</span>
                <strong>{percent(probabilities[index])}</strong>
                <span className={`featured-price ${isBinary(market) ? (index === 0 ? 'price-yes' : 'price-no') : ''}`}>{cents(market.optionStats[index].odds)}</span>
              </button>
            ))}
            <div className="featured-meta">
              <span>{credits(market.totalStaked)} Vol.</span>
              <span>Clôture dans {timeLeft(market.endsAt, now)}</span>
            </div>
          </div>
          <div className="featured-chart">
            {history ? <PriceChart market={market} history={history} now={now} height={230} showRanges={false} /> : <div className="chart-skeleton" />}
          </div>
        </div>
      </div>
    </article>
  );
}

export function ActivityFeed({ entries, now, compact = false }: { entries: FeedEntry[]; now: number; compact?: boolean }) {
  if (entries.length === 0) return <p className="muted feed-empty">Aucune prise pour l’instant.</p>;
  return (
    <ul className={`feed${compact ? ' feed-compact' : ''}`}>
      {entries.map((entry) => (
        <li key={entry.id}>
          <a {...linkProps(`/market/${encodeURIComponent(entry.marketId)}`)}>
            <Avatar name={entry.username} size={30} />
            <div>
              <p><b>{entry.username}</b> a acheté <b className="feed-outcome">{entry.outcome}</b> à {cents(entry.odds)} · {compactCredits(entry.amount)}</p>
              <small>{entry.marketTitle}</small>
            </div>
            <time>{timeAgo(entry.createdAt, now)}</time>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function Home({
  markets,
  now,
  feed,
  query,
  onCreate,
}: {
  markets: Market[];
  now: number;
  feed: Feed;
  query: string;
  onCreate: () => void;
}) {
  const [status, setStatus] = useState<Status>('active');
  const [sort, setSort] = useState<Sort>(sortForFeed(feed));
  const [activity, setActivity] = useState<FeedEntry[]>([]);

  useEffect(() => {
    setSort(sortForFeed(feed));
    setStatus('active');
  }, [feed]);

  // La liste des marchés est rafraîchie toutes les 15 s par App : on recharge le fil en même temps.
  useEffect(() => {
    let active = true;
    request<{ activity: FeedEntry[] }>('/api/activity')
      .then((result) => { if (active) setActivity(result.activity); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [markets]);

  const needle = query.trim().toLowerCase();
  const isCategory = !['trending', 'new', 'ending'].includes(feed);
  const visible = markets
    .filter((market) => !isCategory || market.category === feed)
    .filter((market) => {
      const state = marketState(market, now);
      if (feed === 'ending' || status === 'active') return state === 'open';
      if (status === 'awaiting') return state === 'awaiting';
      if (status === 'resolved') return state === 'resolved' || state === 'cancelled';
      return true;
    })
    .filter((market) => !needle || `${market.title} ${market.description} ${market.options.join(' ')} ${market.creator}`.toLowerCase().includes(needle))
    .sort((first, second) => {
      if (sort === 'new') return Date.parse(second.createdAt) - Date.parse(first.createdAt);
      if (sort === 'ending') return Date.parse(first.endsAt) - Date.parse(second.endsAt);
      if (sort === 'traders') return second.bettorsCount - first.bettorsCount;
      return second.totalStaked - first.totalStaked || second.bettorsCount - first.bettorsCount;
    });

  const featured = feed === 'trending' && !needle && status === 'active' ? visible[0] : undefined;
  const awaitingCount = markets.filter((market) => marketState(market, now) === 'awaiting').length;

  return (
    <main className="page">
      {featured && (
        <section className="hero-row">
          <Featured market={featured} now={now} />
          <aside className="hero-side">
            <h3><Activity size={16} /> Activité récente</h3>
            <ActivityFeed entries={activity.slice(0, 6)} now={now} compact />
          </aside>
        </section>
      )}

      <section className="board">
        <div className="board-head">
          <h1>{needle ? `Résultats pour « ${query.trim()} »` : feedTitles[feed] ?? categoryLabels[feed]}</h1>
          <div className="board-filters">
            {feed !== 'ending' && (
              <div className="segmented segmented-small" role="tablist" aria-label="Statut">
                {([
                  ['active', 'Actifs'],
                  ['awaiting', `En attente${awaitingCount ? ` · ${awaitingCount}` : ''}`],
                  ['resolved', 'Résolus'],
                  ['all', 'Tous'],
                ] as [Status, string][]).map(([id, label]) => (
                  <button role="tab" aria-selected={status === id} key={id} className={status === id ? 'active' : ''} onClick={() => setStatus(id)}>{label}</button>
                ))}
              </div>
            )}
            <label className="select">
              <span>Trier par</span>
              <select value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
                <option value="volume">Volume</option>
                <option value="traders">Participants</option>
                <option value="new">Plus récents</option>
                <option value="ending">Clôture proche</option>
              </select>
            </label>
          </div>
        </div>

        {visible.length ? (
          <div className="grid">
            {visible.filter((market) => market !== featured).map((market) => <MarketCard key={market.id} market={market} now={now} />)}
          </div>
        ) : (
          <div className="empty">
            <SearchX size={28} />
            <strong>Aucun marché ici</strong>
            <p>{needle ? 'Essayez une autre recherche.' : 'Lancez le premier marché de cette rubrique.'}</p>
            <button className="btn btn-primary" onClick={onCreate}><Plus size={16} /> Créer un marché</button>
          </div>
        )}
      </section>
    </main>
  );
}
