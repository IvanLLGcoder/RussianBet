import { useEffect, useState } from 'react';
import { CheckCircle2, Clock3, LockKeyhole, Undo2 } from 'lucide-react';
import type { Market, User } from '../api';
import { cents, credits, isBinary, marketState, outcomeColor, payout, signed } from '../format';

export function TradePanel({
  market,
  user,
  now,
  selected,
  onSelect,
  onTrade,
  onSignIn,
}: {
  market: Market;
  user: User | null;
  now: number;
  selected: number;
  onSelect: (index: number) => void;
  onTrade: (choiceIndex: number, amount: number) => Promise<void>;
  onSignIn: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const state = marketState(market, now);

  useEffect(() => {
    setReviewing(false);
    setError('');
  }, [selected, market.id]);

  const stake = Number(amount);
  const validStake = Number.isSafeInteger(stake) && stake >= 1 && stake <= Math.min(100_000, user?.balance ?? 0);
  const odds = market.optionStats[selected]?.odds ?? 1;
  const toWin = validStake ? payout(stake, odds) : 0;

  function bump(value: number | 'max') {
    setReviewing(false);
    const next = value === 'max' ? Math.min(100_000, user?.balance ?? 0) : (Number(amount) || 0) + value;
    setAmount(String(Math.min(next, 100_000)));
  }

  async function submit() {
    if (!reviewing) {
      setReviewing(true);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onTrade(selected, stake);
      setAmount('');
      setReviewing(false);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Ordre refusé.');
      setReviewing(false);
    } finally {
      setBusy(false);
    }
  }

  const outcomeButtons = (
    <div className={`ticket-outcomes${isBinary(market) ? ' ticket-outcomes-binary' : ''}`}>
      {market.options.map((option, index) => {
        const active = selected === index;
        const binaryClass = isBinary(market) ? (index === 0 ? ' ticket-yes' : ' ticket-no') : '';
        return (
          <button
            key={option}
            className={`ticket-outcome${binaryClass}${active ? ' active' : ''}`}
            style={!isBinary(market) && active ? { background: outcomeColor(market, index), borderColor: outcomeColor(market, index) } : undefined}
            onClick={() => onSelect(index)}
            aria-pressed={active}
          >
            <span>{option}</span>
            <b>{cents(market.optionStats[index].odds)}</b>
          </button>
        );
      })}
    </div>
  );

  let body: React.ReactNode;
  if (state === 'cancelled') {
    body = <div className="ticket-closed"><Undo2 size={22} /><strong>Marché annulé</strong><p>Toutes les mises ont été remboursées.</p></div>;
  } else if (state === 'resolved') {
    const winner = market.outcomeIndex ?? 0;
    body = (
      <div className="ticket-closed">
        <CheckCircle2 size={22} className="text-yes" />
        <strong>Résultat : {market.options[winner]}</strong>
        {market.myBet && (
          <p>
            {market.myBet.choiceIndex === winner
              ? <>Vous avez gagné <b className="text-yes">{credits(payout(market.myBet.amount, market.myBet.odds))}</b>.</>
              : <>Votre mise de {credits(market.myBet.amount)} est perdue.</>}
          </p>
        )}
      </div>
    );
  } else if (market.myBet) {
    const bet = market.myBet;
    body = (
      <div className="ticket-position">
        <span className="ticket-label">Votre position</span>
        <div className="position-line">
          <span className="position-pill" style={{ color: outcomeColor(market, bet.choiceIndex) }}>{market.options[bet.choiceIndex]}</span>
          <span>{credits(bet.amount)} à {cents(bet.odds)}</span>
        </div>
        <dl className="ticket-summary">
          <div><dt>Gain si victoire</dt><dd className="text-yes">{credits(payout(bet.amount, bet.odds))}</dd></div>
        </dl>
        <p className="ticket-note">{state === 'awaiting' ? <><Clock3 size={13} /> Prises closes, en attente du résultat.</> : <><LockKeyhole size={13} /> Position définitive jusqu’à la résolution.</>}</p>
      </div>
    );
  } else if (state === 'awaiting') {
    body = <div className="ticket-closed"><Clock3 size={22} /><strong>Prises closes</strong><p>Le marché est terminé et attend son résultat.</p></div>;
  } else if (!user) {
    body = (
      <>
        {outcomeButtons}
        <button className="ticket-submit" onClick={onSignIn}>Se connecter pour trader</button>
      </>
    );
  } else {
    body = (
      <>
        {outcomeButtons}
        <label className="ticket-amount">
          <span className="ticket-amount-head">
            <span>Montant</span>
            <small>Solde {credits(user.balance)}</small>
          </span>
          <span className="ticket-amount-field">
            <input
              inputMode="numeric"
              placeholder="0"
              value={amount}
              onChange={(event) => {
                setReviewing(false);
                setAmount(event.target.value.replace(/\D/g, '').slice(0, 6));
              }}
              aria-label="Montant en crédits"
            />
            <span>cr</span>
          </span>
        </label>
        <div className="ticket-chips">
          {[1, 10, 100].map((value) => <button key={value} onClick={() => bump(value)}>+{value}</button>)}
          <button onClick={() => bump('max')}>Max</button>
        </div>

        {validStake && (
          <dl className="ticket-summary">
            <div className="ticket-win">
              <dt>Gain potentiel</dt>
              <dd>{credits(toWin)} <small>{signed(toWin - stake)} ({Math.round(((toWin - stake) / stake) * 100)} %)</small></dd>
            </div>
          </dl>
        )}

        {stake > (user.balance ?? 0) && <p className="form-error">Solde insuffisant.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}

        {reviewing && validStake && (
          <div className="ticket-review" role="status">
            <b>{credits(stake)}</b> sur <b>{market.options[selected]}</b> : une seule prise par marché, elle ne pourra plus être modifiée.
          </div>
        )}
        <div className="ticket-actions">
          {reviewing && <button className="ticket-back" onClick={() => setReviewing(false)} disabled={busy}>Retour</button>}
          <button className="ticket-submit" disabled={!validStake || busy} onClick={() => void submit()}>
            {busy ? 'Envoi…' : reviewing ? 'Confirmer l’ordre' : `Acheter ${market.options[selected]}`}
          </button>
        </div>
      </>
    );
  }

  return (
    <aside className="ticket" aria-label="Passer un ordre">
      <div className="ticket-body">{body}</div>
    </aside>
  );
}
