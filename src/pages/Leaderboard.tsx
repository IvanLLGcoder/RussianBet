import { useEffect, useState } from 'react';
import { Trophy } from 'lucide-react';
import { request } from '../api';
import type { Leader, User } from '../api';
import { Avatar } from '../components/Bits';
import { credits, signed } from '../format';

type Metric = 'pnl' | 'volume' | 'balance';

export function Leaderboard({ user, version }: { user: User; version: number }) {
  const [leaders, setLeaders] = useState<Leader[] | null>(null);
  const [metric, setMetric] = useState<Metric>('pnl');
  const [error, setError] = useState('');

  useEffect(() => {
    request<{ leaders: Leader[] }>('/api/leaderboard?limit=100')
      .then((result) => setLeaders(result.leaders))
      .catch((problem) => setError(problem instanceof Error ? problem.message : 'Classement indisponible.'));
  }, [version]);

  const sorted = [...(leaders ?? [])].sort((first, second) => second[metric] - first[metric]);
  const labels: Record<Metric, string> = { pnl: 'Gains', volume: 'Volume', balance: 'Solde' };

  return (
    <main className="page leaderboard">
      <div className="board-head">
        <h1><Trophy size={24} /> Classement</h1>
        <div className="segmented segmented-small" role="tablist">
          {(Object.keys(labels) as Metric[]).map((key) => (
            <button key={key} role="tab" aria-selected={metric === key} className={metric === key ? 'active' : ''} onClick={() => setMetric(key)}>{labels[key]}</button>
          ))}
        </div>
      </div>
      {error && <p className="form-error">{error}</p>}
      {leaders === null ? <div className="page-loading" /> : (
        <div className="table-wrap">
          <table className={`table leader-table metric-${metric}`}>
            <thead><tr><th>#</th><th>Membre</th><th className="col-pnl">Gains</th><th className="col-volume">Volume</th><th className="col-wins">Paris gagnés</th><th className="col-balance">Solde</th></tr></thead>
            <tbody>
              {sorted.map((leader, index) => (
                <tr key={leader.id} className={leader.id === user.id ? 'me' : ''}>
                  <td><span className={`rank rank-${index + 1}`}>{index + 1}</span></td>
                  <td><span className="leader-name"><Avatar name={leader.username} size={30} />{leader.username}{leader.id === user.id && <small>vous</small>}</span></td>
                  <td className={`col-pnl ${leader.pnl >= 0 ? 'text-yes' : 'text-no'}`}>{signed(leader.pnl)} jetons</td>
                  <td className="col-volume">{credits(leader.volume)}</td>
                  <td className="col-wins">{leader.wins} / {leader.positions}</td>
                  <td className="col-balance">{credits(leader.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
