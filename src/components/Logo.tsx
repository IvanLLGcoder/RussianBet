import brand from '../brand';

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="#1652f0" />
      <path d="M13 36h9l7-16 8 26 7-13h7" fill="none" stroke="#fff" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Logo texte : la partie entre crochets de « wordmark » (brand.config.json) est écrite en tout petit.
export function Wordmark({ className = 'wordmark' }: { className?: string }) {
  const parts = brand.wordmark.split(/(\[[^\]]*\])/).filter(Boolean);
  return (
    <span className={className}>
      {parts.map((part, index) => (part.startsWith('[')
        ? <small key={index}>{part.slice(1, -1)}</small>
        : <span key={index}>{part}</span>))}
    </span>
  );
}
