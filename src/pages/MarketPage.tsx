import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, CalendarClock, Check, Link2, Pencil, TrendingDown, TrendingUp, Undo2, UsersRound } from 'lucide-react';
import { request } from '../api';
import type { Comment, Market, MarketDetail, MarketValues, User } from '../api';
import { Avatar, MarketIcon } from '../components/Bits';
import { StateBadge } from '../components/MarketCard';
import { MarketFormModal } from '../components/Modals';
import { PriceChart } from '../components/PriceChart';
import { TradePanel } from '../components/TradePanel';
import {
  cents, categoryLabels, chances, compactCredits, credits, dateTime, isBinary, marketState, outcomeColor, payout, percent, seriesColor, shortDate, timeAgo, timeLeft,
} from '../format';
import { linkProps } from '../router';

type Tab = 'comments' | 'holders' | 'activity';

function initialSelection(market: Market) {
  const requested = Number(new URLSearchParams(window.location.search).get('o'));
  if (Number.isInteger(requested) && requested >= 0 && requested < market.options.length && new URLSearchParams(window.location.search).has('o')) {
    return requested;
  }
  if (isBinary(market)) return 0;
  const probabilities = chances(market);
  return probabilities.indexOf(Math.max(...probabilities));
}

function OutcomeTag({ market, index }: { market: Market; index: number }) {
  return <span className="outcome-tag" style={{ color: outcomeColor(market, index) }}>{market.options[index]}</span>;
}

export function MarketPage({
  id,
  user,
  admin,
  now,
  version,
  onTrade,
  onResolve,
  onCancel,
  onEdit,
  onSignIn,
  notify,
}: {
  id: string;
  user: User | null;
  admin: boolean;
  now: number;
  version: number;
  onTrade: (market: Market, choiceIndex: number, amount: number) => Promise<void>;
  onResolve: (market: Market, outcomeIndex: number) => Promise<void>;
  onCancel: (market: Market) => Promise<void>;
  onEdit: (market: Market, values: MarketValues) => Promise<void>;
  onSignIn: () => void;
  notify: (title: string, body?: string, tone?: 'success' | 'error') => void;
}) {
  const [detail, setDetail] = useState<MarketDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('comments');
  const [editing, setEditing] = useState(false);
  const [reload, setReload] = useState(0);
  const ticketRef = useRef<HTMLDivElement>(null);
  const [ticketVisible, setTicketVisible] = useState(false);

  // Barre d'achat collée en bas sur téléphone, masquée quand le ticket est déjà à l'écran.
  useEffect(() => {
    const element = ticketRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setTicketVisible(entry.isIntersecting), { threshold: 0.2 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [detail !== null]);

  // Arrivée depuis un bouton « Oui / Non » d'une carte (?o=) sur téléphone : on va droit au ticket.
  useEffect(() => {
    if (!detail || !new URLSearchParams(window.location.search).has('o')) return;
    if (!window.matchMedia('(max-width: 1080px)').matches) return;
    window.setTimeout(() => ticketRef.current?.scrollIntoView({ block: 'start' }), 50);
  }, [detail !== null, id]);

  useEffect(() => {
    let active = true;
    request<MarketDetail>(`/api/markets/${encodeURIComponent(id)}`)
      .then((result) => {
        if (!active) return;
        setDetail(result);
        setMissing(false);
        setSelected((current) => current ?? initialSelection(result.market));
      })
      .catch(() => { if (active) setMissing(true); });
    return () => { active = false; };
  }, [id, version, reload]);

  useEffect(() => {
    setSelected(null);
    setDetail(null);
    setTab('comments');
  }, [id]);

  if (missing) {
    return (
      <main className="page">
        <div className="empty">
          <strong>Marché introuvable</strong>
          <a className="btn btn-primary" {...linkProps('/')}><ArrowLeft size={16} /> Retour aux marchés</a>
        </div>
      </main>
    );
  }
  if (!detail || selected === null) return <main className="page"><div className="page-loading" /></main>;

  const { market, history, activity, holders, comments } = detail;
  const state = marketState(market, now);
  const probabilities = chances(market);
  const binary = isBinary(market);
  const dayAgo = history.filter((point) => Date.parse(point.t) <= now - 86_400_000).pop() ?? history[0];
  const change = binary && dayAgo ? probabilities[0] - dayAgo.p[0] : 0;
  const ranked = market.options.map((option, index) => ({ option, index })).sort((a, b) => probabilities[b.index] - probabilities[a.index]);
  const isCreator = user?.id === market.creatorId;
  const canResolve = isCreator || admin;
  const refresh = () => setReload((value) => value + 1);

  function openTicket(index: number) {
    setSelected(index);
    ticketRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => ticketRef.current?.querySelector('input')?.focus({ preventScroll: true }), 350);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.origin + window.location.pathname);
      notify('Lien copié');
    } catch {
      notify('Copie impossible', undefined, 'error');
    }
  }

  return (
    <main className="page market-page">
      <div className="market-layout">
        <div className="market-main">
          <header className="market-header">
            <MarketIcon market={market} size={64} />
            <div className="market-header-text">
              <div className="market-crumbs">
                <a {...linkProps('/')}>Marchés</a> · <span>{categoryLabels[market.category] ?? market.category}</span>
                <StateBadge market={market} now={now} />
              </div>
              <h1>{market.title}</h1>
              <div className="market-meta">
                <span><b>{credits(market.totalStaked)}</b> Vol.</span>
                <span><UsersRound size={14} /> {market.bettorsCount} participant{market.bettorsCount > 1 ? 's' : ''}</span>
                <span><CalendarClock size={14} /> {state === 'open' ? `Clôture dans ${timeLeft(market.endsAt, now)}` : shortDate(market.endsAt)}</span>
                <span className="meta-actions">
                  <button className="icon-btn" title="Copier le lien" aria-label="Copier le lien" onClick={() => void copyLink()}><Link2 size={16} /></button>
                  {isCreator && state !== 'resolved' && state !== 'cancelled' && (
                    <button className="icon-btn" title="Modifier" aria-label="Modifier le marché" onClick={() => setEditing(true)}><Pencil size={15} /></button>
                  )}
                </span>
              </div>
            </div>
          </header>

          {binary ? (
            <div className="chance-line">
              <strong style={{ color: '#1652f0' }}>{percent(probabilities[0])} chance</strong>
              <span className="chance-of">pour « {market.options[0]} »</span>
              {Math.abs(change) >= 0.01 && (
                <span className={change > 0 ? 'delta-up' : 'delta-down'}>
                  {change > 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />} {Math.round(Math.abs(change) * 100)}% sur 24 h
                </span>
              )}
            </div>
          ) : null}

          <PriceChart market={market} history={history} now={now} />

          {!binary && (
            <section className="outcome-table">
              <div className="outcome-table-head">
                <span>Issue</span><span>Chance</span><span />
              </div>
              {ranked.map(({ option, index }) => {
                const won = state === 'resolved' && market.outcomeIndex === index;
                return (
                  <div className={`outcome-table-row${selected === index ? ' selected' : ''}${won ? ' won' : ''}`} key={option} onClick={() => setSelected(index)}>
                    <span className="outcome-name">
                      <i style={{ background: seriesColor(market, index) }} />
                      <span>{option}<small>{compactCredits(market.optionStats[index].staked)} Vol. · {market.optionStats[index].count} prise{market.optionStats[index].count > 1 ? 's' : ''}</small></span>
                    </span>
                    <strong>{won ? <Check size={18} /> : percent(probabilities[index])}</strong>
                    {state === 'open' && !market.myBet ? (
                      <button className={`buy-pill${selected === index ? ' active' : ''}`} onClick={(event) => { event.stopPropagation(); setSelected(index); }}>
                        Acheter {cents(market.optionStats[index].odds)}
                      </button>
                    ) : <span />}
                  </div>
                );
              })}
            </section>
          )}

          <div className="mobile-ticket" ref={ticketRef}>
            <TradePanel
              market={market}
              user={user}
              now={now}
              selected={selected}
              onSelect={setSelected}
              onTrade={async (choice, amount) => { await onTrade(market, choice, amount); refresh(); }}
              onSignIn={onSignIn}
            />
          </div>

          {state === 'open' && !market.myBet && !ticketVisible && (
            <div className="mobile-buy-bar">
              {binary ? market.options.map((option, index) => (
                <button key={option} className={`btn ${index === 0 ? 'btn-yes' : 'btn-no'}`} onClick={() => openTicket(index)}>
                  {option} {cents(market.optionStats[index].odds)}
                </button>
              )) : (
                <button className="btn btn-primary" onClick={() => openTicket(selected)}>
                  Acheter « {market.options[selected]} » {cents(market.optionStats[selected].odds)}
                </button>
              )}
            </div>
          )}

          {(state === 'open' || state === 'awaiting') && canResolve && (
            <ResolutionBox
              market={market}
              open={state === 'awaiting'}
              isCreator={isCreator}
              onResolve={async (index) => { await onResolve(market, index); refresh(); }}
              onCancel={async () => { await onCancel(market); refresh(); }}
            />
          )}

          <section className="rules">
            <h2>Règles</h2>
            <p>{market.description || `Ce marché se résout selon l’issue réelle de la question « ${market.title} ».`}</p>
            <p className="rules-meta">Clôture le {dateTime(market.endsAt)} · créé par @{market.creator} le {shortDate(market.createdAt)} · résolu par son créateur</p>
          </section>

          <section className="tabs-section">
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'comments'} className={tab === 'comments' ? 'active' : ''} onClick={() => setTab('comments')}>Commentaires ({comments.length})</button>
              <button role="tab" aria-selected={tab === 'holders'} className={tab === 'holders' ? 'active' : ''} onClick={() => setTab('holders')}>Principaux détenteurs</button>
              <button role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>Activité</button>
            </div>
            {tab === 'comments' && <Comments market={market} comments={comments} now={now} canPost={Boolean(user)} onPosted={refresh} />}
            {tab === 'holders' && (
              <div className={`holders${binary ? ' holders-binary' : ''}`}>
                {market.options.map((option, index) => (
                  <div className="holders-column" key={option}>
                    <h3><OutcomeTag market={market} index={index} /> <small>{holders[index]?.length ?? 0} détenteur{(holders[index]?.length ?? 0) > 1 ? 's' : ''}</small></h3>
                    {(holders[index] ?? []).length === 0 ? <p className="muted">Personne pour l’instant.</p> : (
                      <ul>
                        {holders[index].map((holder) => (
                          <li key={holder.username}>
                            <Avatar name={holder.username} size={26} />
                            <span>{holder.username}</span>
                            <b>{compactCredits(holder.amount)}</b>
                            <small title="Gain si victoire">→ {compactCredits(holder.payout)}</small>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
            {tab === 'activity' && (
              activity.length === 0 ? <p className="muted">Aucune prise pour l’instant.</p> : (
                <ul className="trades">
                  {activity.map((trade) => (
                    <li key={trade.id}>
                      <Avatar name={trade.username} size={28} />
                      <span><b>{trade.username}</b> a acheté <OutcomeTag market={market} index={trade.choiceIndex} /> à {cents(trade.odds)}</span>
                      <b>{credits(trade.amount)}</b>
                      <time>{timeAgo(trade.createdAt, now)}</time>
                    </li>
                  ))}
                </ul>
              )
            )}
          </section>
        </div>

        <div className="market-side">
          <TradePanel
            market={market}
            user={user}
            now={now}
            selected={selected}
            onSelect={setSelected}
            onTrade={async (choice, amount) => { await onTrade(market, choice, amount); refresh(); }}
            onSignIn={onSignIn}
          />
          {market.myBet && state !== 'cancelled' && (
            <div className="side-note">
              Gain si <OutcomeTag market={market} index={market.myBet.choiceIndex} /> : <b>{credits(payout(market.myBet.amount, market.myBet.odds))}</b>
            </div>
          )}
        </div>
      </div>

      {editing && (
        <MarketFormModal
          market={market}
          onClose={() => setEditing(false)}
          onEdit={async (values) => { await onEdit(market, values); setEditing(false); refresh(); }}
        />
      )}
    </main>
  );
}

function ResolutionBox({
  market,
  open,
  isCreator,
  onResolve,
  onCancel,
}: {
  market: Market;
  open: boolean;
  isCreator: boolean;
  onResolve: (index: number) => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const [choice, setChoice] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<'resolve' | 'cancel' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
      setConfirming(null);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Action impossible.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="resolution" open={open}>
      <summary><h2>Résoudre le marché</h2>{open && <span className="resolution-hint">Prises closes : quel est le résultat ?</span>}</summary>
      <p className="muted">Les gagnants sont payés aussitôt ; la décision est définitive.</p>
      <div className="chip-row">
        {market.options.map((option, index) => (
          <button key={option} className={`chip${choice === index ? ' active' : ''}`} onClick={() => { setChoice(index); setConfirming(null); }}>{option}</button>
        ))}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="resolution-actions">
        {confirming === 'resolve' && choice !== null ? (
          <>
            <span>Confirmer « {market.options[choice]} » ?</span>
            <button className="btn btn-ghost" onClick={() => setConfirming(null)} disabled={busy}>Retour</button>
            <button className="btn btn-primary" onClick={() => void run(() => onResolve(choice))} disabled={busy}>Confirmer la résolution</button>
          </>
        ) : confirming === 'cancel' ? (
          <>
            <span>Annuler le marché et rembourser toutes les mises ?</span>
            <button className="btn btn-ghost" onClick={() => setConfirming(null)} disabled={busy}>Retour</button>
            <button className="btn btn-danger" onClick={() => void run(onCancel)} disabled={busy}>Annuler et rembourser</button>
          </>
        ) : (
          <>
            <button className="btn btn-primary" disabled={choice === null} onClick={() => setConfirming('resolve')}>Résoudre</button>
            {isCreator && <button className="btn btn-ghost" onClick={() => setConfirming('cancel')}><Undo2 size={15} /> Annuler le marché</button>}
          </>
        )}
      </div>
    </details>
  );
}

function Comments({
  market,
  comments,
  now,
  canPost,
  onPosted,
}: {
  market: Market;
  comments: Comment[];
  now: number;
  canPost: boolean;
  onPosted: () => void;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await request(`/api/markets/${encodeURIComponent(market.id)}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
      setBody('');
      onPosted();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Envoi impossible.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="comments">
      {canPost && (
        <form className="comment-form" onSubmit={(event) => void submit(event)}>
          <input value={body} onChange={(event) => setBody(event.target.value)} maxLength={500} placeholder="Ajouter un commentaire" aria-label="Commentaire" />
          <button className="btn btn-primary" disabled={busy || !body.trim()}>Publier</button>
        </form>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {comments.length === 0 ? <p className="muted">Soyez le premier à commenter.</p> : (
        <ul>
          {comments.map((comment) => (
            <li key={comment.id}>
              <Avatar name={comment.username} size={32} />
              <div>
                <div className="comment-head">
                  <b>{comment.username}</b>
                  {comment.choiceIndex !== null && comment.choiceIndex !== undefined && (
                    <span className="comment-position" style={{ color: outcomeColor(market, comment.choiceIndex), borderColor: 'currentColor' }}>
                      {market.options[comment.choiceIndex]}
                    </span>
                  )}
                  <time>{timeAgo(comment.createdAt, now)}</time>
                </div>
                <p>{comment.body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
