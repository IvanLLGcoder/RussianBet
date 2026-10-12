import { Clapperboard, Cpu, FlaskConical, Landmark, Trophy, UsersRound } from 'lucide-react';
import type { Market } from '../api';
import { avatarColor, gaugeColor } from '../format';

const categoryIcons: Record<string, typeof Landmark> = {
  Politics: Landmark,
  Sports: Trophy,
  Technology: Cpu,
  Culture: Clapperboard,
  Science: FlaskConical,
  Community: UsersRound,
};

// Les marchés n'ont pas d'image : on dessine une vignette à partir de la catégorie.
export function MarketIcon({ market, size = 40 }: { market: Pick<Market, 'category'>; size?: number }) {
  const Icon = categoryIcons[market.category] ?? UsersRound;
  return (
    <span className={`market-icon market-icon-${market.category.toLowerCase()}`} style={{ width: size, height: size }}>
      <Icon size={Math.round(size * 0.5)} strokeWidth={2} />
    </span>
  );
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.42, background: avatarColor(name) }}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

// Jauge demi-cercle des cartes Polymarket.
export function Gauge({ probability, size = 64 }: { probability: number; size?: number }) {
  const radius = 26;
  const length = Math.PI * radius;
  return (
    <div className="gauge" style={{ width: size }}>
      <svg viewBox="0 0 64 36" width={size} height={size * 0.5625} aria-hidden="true">
        <path d="M6 32a26 26 0 0 1 52 0" className="gauge-track" />
        <path
          d="M6 32a26 26 0 0 1 52 0"
          className="gauge-value"
          stroke={gaugeColor(probability)}
          strokeDasharray={`${length * probability} ${length}`}
        />
      </svg>
      <strong>{Math.round(probability * 100)}%</strong>
      <span>chance</span>
    </div>
  );
}
