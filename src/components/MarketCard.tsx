import { CheckCircle2, Clock3, MessageCircle, Undo2 } from 'lucide-react';
import type { Market } from '../api';
import { linkProps, navigate } from '../router';
import { cents, chances, compactCredits, isBinary, marketState, outcomeColor, percent, timeLeft } from '../format';
import { Gauge, MarketIcon } from './Bits';

export function marketPath(market: Market, outcome?: number) {
  return `/market/${encodeURIComponent(market.id)}${outcome === undefined ? '' : `?o=${outcome}`}`;
}

export function StateBadge({ market, now }: { market: Market; now: number }) {
  const state = marketState(market, now);
  if (state === 'cancelled') return <span className="badge badge-muted"><Undo2 size={12} /> Annulé · remboursé</span>;
  if (state === 'resolved') {
    return (
      <span className="badge badge-resolved">
        <CheckCircle2 size={12} /> Résultat : {market.options[market.outcomeIndex ?? 0]}
      </span>
    );
  }
  if (state === 'awaiting') return <span className="badge badge-awaiting"><Clock3 size={12} /> En attente du résultat</span>;
  return null;
}

export function MarketCard({ market, now }: { market: Market; now: number }) {
  const probabilities = chances(market);
  const state = marketState(market, now);
  const tradable = state === 'open' && !market.myBet;
  const ranked = market.options
    .map((option, index) => ({ option, index, probability: probabilities[index] }))
    .sort((first, second) => second.probability - first.probability);

  return (
    <article className="market-card">
      <a className="market-card-head" {...linkProps(marketPath(market))}>
        <MarketIcon market={market} />
        <h3>{market.title}</h3>
        {isBinary(market) && state !== 'resolved' && state !== 'cancelled' && <Gauge probability={probabilities[0]} />}
      </a>

      {isBinary(market) ? (
        <div className="market-card-binary">
          {market.options.map((option, index) => {
            const won = state === 'resolved' && market.outcomeIndex === index;
            return (
              <button
                key={option}
                className={`outcome-button ${index === 0 ? 'outcome-yes' : 'outcome-no'}${won ? ' outcome-won' : ''}`}
                disabled={state === 'cancelled' || (state === 'resolved' && !won)}
                onClick={() => navigate(marketPath(market, tradable ? index : undefined))}
              >
                <span className="outcome-button-label">{option}</span>
                <span className="outcome-button-price">{won ? <CheckCircle2 size={15} /> : cents(market.optionStats[index].odds)}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="market-card-rows">
          {ranked.map(({ option, index, probability }) => {
            const won = state === 'resolved' && market.outcomeIndex === index;
            return (
              <div className={`card-row${won ? ' card-row-won' : ''}`} key={option}>
                <span className="card-row-name"><i style={{ background: outcomeColor(market, index) }} />{option}</span>
                <strong>{won ? <CheckCircle2 size={15} /> : percent(probability)}</strong>
                {tradable && (
                  <button className="mini-buy" onClick={() => navigate(marketPath(market, index))}>
                    Acheter
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <footer className="market-card-foot">
        <span>{compactCredits(market.totalStaked)} Vol.</span>
        {state === 'open' && <span className="foot-time"><Clock3 size={12} />{timeLeft(market.endsAt, now)}</span>}
        <span className="foot-comments"><MessageCircle size={12} />{market.commentsCount ?? 0}</span>
        <span className="foot-spacer" />
        {market.myBet && state !== 'cancelled' && (
          <span className="badge badge-position" title="Votre position">
            {market.options[market.myBet.choiceIndex]} · {compactCredits(market.myBet.amount)}
          </span>
        )}
        {!market.myBet && <StateBadge market={market} now={now} />}
      </footer>
    </article>
  );
}
