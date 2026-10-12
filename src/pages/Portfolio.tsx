import { useState } from 'react';
import { UserRoundPlus, WalletMinimal } from 'lucide-react';
import type { Market, User } from '../api';
import { MarketIcon } from '../components/Bits';
import { marketPath } from '../components/MarketCard';
import { cents, chances, credits, marketState, outcomeColor, payout, signed } from '../format';
import { linkProps } from '../router';

// Valeur « au prix du marché » d'une position : gain si victoire × probabilité actuelle de l'issue.
export function positionValue(market: Market) {
  if (!market.myBet) return 0;
  return Math.round(payout(market.myBet.amount, market.myBet.odds) * chances(market)[market.myBet.choiceIndex]);
}

export function Portfolio({ user, markets, now, onInvite }: { user: User; markets: Market[]; now: number; onInvite: () => void }) {
  const [tab, setTab] = useState<'positions' | 'history'>('positions');
  const mine = markets.filter((market) => market.myBet);
  const open = mine.filter((market) => ['open', 'awaiting'].includes(marketState(market, now)));
  const closed = mine.filter((market) => !['open', 'awaiting'].includes(marketState(market, now)));
  const openValue = open.reduce((sum, market) => sum + positionValue(market), 0);
  const openStakes = open.reduce((sum, market) => sum + (market.myBet?.amount ?? 0), 0);
  const pnl = user.balance + openStakes - 1000;

  return (
    <main className="page portfolio">
      <section className="summary-cards">
        <div className="summary-card summary-main">
          <span><WalletMinimal size={16} /> Portefeuille</span>
          <strong>{credits(user.balance + openValue)}</strong>
          <small className={pnl >= 0 ? 'text-yes' : 'text-no'}>{signed(pnl)} cr depuis l’inscription</small>
        </div>
        <div className="summary-card">
          <span>Solde disponible</span>
          <strong>{credits(user.balance)}</strong>
          <small>{credits(openStakes)} engagés</small>
        </div>
        <div className="summary-card">
          <span>Positions ouvertes</span>
          <strong>{open.length}</strong>
          <small>Valeur actuelle {credits(openValue)}</small>
        </div>
        <button className="summary-card summary-invite" onClick={onInvite}>
          <UserRoundPlus size={20} />
          <strong>Inviter des amis</strong>
          <small>Partagez un lien d’invitation</small>
        </button>
      </section>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'positions'} className={tab === 'positions' ? 'active' : ''} onClick={() => setTab('positions')}>Positions ({open.length})</button>
        <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>Historique ({closed.length})</button>
      </div>

      {tab === 'positions' ? (
        open.length === 0 ? <p className="muted table-empty">Aucune position ouverte. <a {...linkProps('/')}>Parcourir les marchés</a></p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Marché</th><th>Moy. → Actuel</th><th>Mise</th><th>Valeur</th><th>Gain si victoire</th></tr></thead>
              <tbody>
                {open.map((market) => {
                  const bet = market.myBet!;
                  const value = positionValue(market);
                  return (
                    <tr key={market.id}>
                      <td>
                        <a className="table-market" {...linkProps(marketPath(market))}>
                          <MarketIcon market={market} size={36} />
                          <span>{market.title}<small><b style={{ color: outcomeColor(market, bet.choiceIndex) }}>{market.options[bet.choiceIndex]}</b>{marketState(market, now) === 'awaiting' && ' · en attente du résultat'}</small></span>
                        </a>
                      </td>
                      <td>{cents(bet.odds)} → {cents(market.optionStats[bet.choiceIndex].odds)}</td>
                      <td>{credits(bet.amount)}</td>
                      <td>{credits(value)} <small className={value >= bet.amount ? 'text-yes' : 'text-no'}>{signed(value - bet.amount)}</small></td>
                      <td className="text-yes">{credits(payout(bet.amount, bet.odds))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : (
        closed.length === 0 ? <p className="muted table-empty">Aucun marché terminé pour l’instant.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Marché</th><th>Mise</th><th>Résultat</th></tr></thead>
              <tbody>
                {closed.map((market) => {
                  const bet = market.myBet!;
                  const state = marketState(market, now);
                  const won = state === 'resolved' && market.outcomeIndex === bet.choiceIndex;
                  return (
                    <tr key={market.id}>
                      <td>
                        <a className="table-market" {...linkProps(marketPath(market))}>
                          <MarketIcon market={market} size={36} />
                          <span>{market.title}<small><b style={{ color: outcomeColor(market, bet.choiceIndex) }}>{market.options[bet.choiceIndex]}</b> à {cents(bet.odds)}</small></span>
                        </a>
                      </td>
                      <td>{credits(bet.amount)}</td>
                      <td>
                        {state === 'cancelled' ? <span className="muted">Remboursé</span>
                          : won ? <span className="text-yes">Gagné {signed(payout(bet.amount, bet.odds) - bet.amount)} cr</span>
                            : <span className="text-no">Perdu {signed(-bet.amount)} cr</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </main>
  );
}
