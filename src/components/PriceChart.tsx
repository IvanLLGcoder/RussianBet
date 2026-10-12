import { useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryPoint, Market } from '../api';
import brand from '../brand';
import { chances, isBinary, marketState, seriesColor } from '../format';

const ranges = [
  { id: '1H', label: '1H', span: 3_600_000 },
  { id: '6H', label: '6H', span: 6 * 3_600_000 },
  { id: '1J', label: '1J', span: 86_400_000 },
  { id: '1S', label: '1S', span: 7 * 86_400_000 },
  { id: '1M', label: '1M', span: 30 * 86_400_000 },
  { id: 'ALL', label: 'Tout', span: Infinity },
] as const;
type RangeId = typeof ranges[number]['id'];

const padding = { top: 14, right: 46, bottom: 26, left: 4 };

function valueAt(history: { t: number; p: number[] }[], time: number) {
  let current = history[0];
  for (const point of history) {
    if (point.t > time) break;
    current = point;
  }
  return current.p;
}

function tickLabel(time: number, span: number) {
  const options: Intl.DateTimeFormatOptions = span <= 2 * 86_400_000
    ? { hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short' };
  return new Intl.DateTimeFormat('fr-FR', options).format(time);
}

export function PriceChart({
  market,
  history,
  now,
  height = 300,
  showRanges = true,
}: {
  market: Market;
  history: HistoryPoint[];
  now: number;
  height?: number;
  showRanges?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [range, setRange] = useState<RangeId>('ALL');
  const [hoverX, setHoverX] = useState<number | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const points = useMemo(() => history.map((point) => ({ t: new Date(point.t).getTime(), p: point.p })), [history]);

  // Marché binaire : une seule courbe (la première issue). Sinon les 4 issues les plus probables.
  const current = chances(market);
  const series = isBinary(market)
    ? [0]
    : current.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value).slice(0, 4).map((entry) => entry.index);

  const state = marketState(market, now);
  const lastTrade = points.length ? points[points.length - 1].t : now;
  const end = state === 'open' ? now : Math.max(lastTrade, Math.min(now, new Date(market.endsAt).getTime()));
  const first = points.length ? points[0].t : now - 3_600_000;
  const span = ranges.find((entry) => entry.id === range)!.span;
  const start = Math.min(end - 60_000, span === Infinity ? first : Math.max(first, end - span));

  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const x = (time: number) => padding.left + ((time - start) / (end - start)) * innerWidth;
  const y = (probability: number) => padding.top + (1 - probability) * innerHeight;

  const visible = points.length
    ? [{ t: start, p: valueAt(points, start) }, ...points.filter((point) => point.t > start && point.t <= end), { t: end, p: valueAt(points, end) }]
    : [{ t: start, p: current }, { t: end, p: current }];

  const paths = series.map((index) => {
    let d = `M${x(visible[0].t).toFixed(1)},${y(visible[0].p[index]).toFixed(1)}`;
    for (const point of visible.slice(1)) {
      d += `H${x(point.t).toFixed(1)}V${y(point.p[index]).toFixed(1)}`;
    }
    return { index, d };
  });

  const ticks = Array.from({ length: 5 }, (_, i) => start + ((end - start) * (i + 0.5)) / 5);
  const hoverTime = hoverX === null ? null : start + ((hoverX - padding.left) / innerWidth) * (end - start);
  const hoverValues = hoverTime === null ? null : (points.length ? valueAt(points, hoverTime) : current);
  const lastValues = visible[visible.length - 1].p;

  function handlePointer(event: React.PointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = event.clientX - bounds.left;
    setHoverX(Math.min(padding.left + innerWidth, Math.max(padding.left, position)));
  }

  return (
    <div className="chart">
      {!isBinary(market) && (
        <div className="chart-legend">
          {series.map((index) => (
            <span key={index}>
              <i style={{ background: seriesColor(market, index) }} />
              {market.options[index]} <b>{Math.round((hoverValues ?? lastValues)[index] * 100)}%</b>
            </span>
          ))}
        </div>
      )}
      <div className="chart-canvas" ref={containerRef}>
        <svg
          width={width}
          height={height}
          onPointerMove={handlePointer}
          onPointerLeave={() => setHoverX(null)}
          role="img"
          aria-label={`Évolution des probabilités : ${market.title}`}
        >
          {[0.25, 0.5, 0.75, 1].map((level) => (
            <g key={level}>
              <line className="chart-grid" x1={padding.left} x2={padding.left + innerWidth} y1={y(level)} y2={y(level)} />
              <text className="chart-axis" x={width - 4} y={y(level) + 4} textAnchor="end">{level * 100}%</text>
            </g>
          ))}
          <line className="chart-baseline" x1={padding.left} x2={padding.left + innerWidth} y1={y(0)} y2={y(0)} />
          {ticks.map((tick) => (
            <text key={tick} className="chart-axis" x={x(tick)} y={height - 6} textAnchor="middle">{tickLabel(tick, end - start)}</text>
          ))}
          <text className="chart-watermark" x={padding.left + 10} y={padding.top + innerHeight - 10}>{brand.wordmark.split(/(\[[^\]]*\])/).filter(Boolean).map((part, index) => (part.startsWith('[') ? <tspan key={index} fontSize="0.55em">{part.slice(1, -1)}</tspan> : <tspan key={index}>{part}</tspan>))}</text>

          {paths.map(({ index, d }) => (
            <path key={index} d={d} className="chart-line" stroke={seriesColor(market, index)} />
          ))}

          {hoverX === null && state === 'open' && series.map((index) => (
            <g key={index}>
              <circle className="chart-pulse" cx={x(end)} cy={y(lastValues[index])} r="7" fill={seriesColor(market, index)} />
              <circle cx={x(end)} cy={y(lastValues[index])} r="3.5" fill={seriesColor(market, index)} />
            </g>
          ))}

          {hoverX !== null && hoverValues && hoverTime !== null && (
            <g>
              <line className="chart-cursor" x1={hoverX} x2={hoverX} y1={padding.top} y2={padding.top + innerHeight} />
              {series.map((index) => (
                <circle key={index} cx={hoverX} cy={y(hoverValues[index])} r="4" fill={seriesColor(market, index)} stroke="var(--surface)" strokeWidth="2" />
              ))}
              <text className="chart-hover-date" x={Math.min(Math.max(hoverX, 60), padding.left + innerWidth - 60)} y={padding.top - 2} textAnchor="middle">
                {new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(hoverTime)}
              </text>
            </g>
          )}
        </svg>
        {isBinary(market) && hoverValues && hoverX !== null && (
          <div className="chart-tooltip" style={{ left: Math.min(hoverX + 10, width - 120), top: y(hoverValues[0]) - 34 }}>
            {market.options[0]} {Math.round(hoverValues[0] * 100)}%
          </div>
        )}
      </div>
      {showRanges && (
        <div className="chart-ranges" role="tablist" aria-label="Période">
          {ranges.map((entry) => (
            <button
              key={entry.id}
              role="tab"
              aria-selected={range === entry.id}
              className={range === entry.id ? 'active' : ''}
              onClick={() => setRange(entry.id)}
            >{entry.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
