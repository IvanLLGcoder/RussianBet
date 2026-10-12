export type User = { id: number; username: string; balance: number };
export type Leader = User & { wins: number; volume: number; positions: number; inPlay: number; pnl: number };
export type Invite = { code: string; createdAt: string; expiresAt: string; redeemedCount: number };
export type NotificationPreferences = { newPolls: boolean; participatedResolutions: boolean };
export type NotificationSettings = {
  pushEnabled: boolean;
  publicKey: string | null;
  hasSubscription: boolean;
  preferences: NotificationPreferences;
};
export type OptionStat = { count: number; staked: number; odds: number };
export type Bet = { choiceIndex: number; amount: number; odds: number };
export type Market = {
  id: string;
  title: string;
  description: string;
  category: string;
  options: string[];
  outcomeIndex: number | null;
  status: 'open' | 'resolved';
  cancelledAt: string | null;
  endsAt: string;
  createdAt: string;
  creator: string;
  creatorId: number;
  optionStats: OptionStat[];
  totalStaked: number;
  bettorsCount: number;
  commentsCount?: number;
  myBet: Bet | null;
};
export type HistoryPoint = { t: string; p: number[] };
export type Trade = { id: number; username: string; choiceIndex: number; amount: number; odds: number; createdAt: string };
export type Holder = { username: string; amount: number; odds: number; payout: number };
export type Comment = { id: number; body: string; createdAt: string; username: string; choiceIndex?: number | null };
export type MarketDetail = {
  market: Market;
  history: HistoryPoint[];
  activity: Trade[];
  holders: Holder[][];
  comments: Comment[];
};
export type FeedEntry = Trade & { marketId: string; marketTitle: string; outcome: string };
export type MarketValues = { title: string; description: string; category: string; endsAt: string };

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? 'Une erreur est survenue.');
  return data as T;
}
