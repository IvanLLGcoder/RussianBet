import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webPush from 'web-push';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '..');
const brand = JSON.parse(fs.readFileSync(path.join(root, 'brand.config.json'), 'utf8'));
const dataDirectory = path.join(root, 'data');
fs.mkdirSync(dataDirectory, { recursive: true });

const db = new Database(process.env.DB_PATH || path.join(dataDirectory, 'oddsroom.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 1000 CHECK (balance >= 0),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invite_codes (
    code TEXT PRIMARY KEY,
    created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    redeemed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    redeemed_at TEXT,
    expires_at TEXT
  );
  CREATE TABLE IF NOT EXISTS invite_redemptions (
    invite_code TEXT NOT NULL REFERENCES invite_codes(code) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redeemed_at TEXT NOT NULL,
    PRIMARY KEY (invite_code, user_id)
  );
  CREATE TABLE IF NOT EXISTS markets (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,
    options_json TEXT NOT NULL,
    outcome_index INTEGER,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    ends_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    creator_id INTEGER NOT NULL REFERENCES users(id),
    cancelled_at TEXT
  );
  CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    choice_index INTEGER NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    decimal_odds REAL NOT NULL DEFAULT 2.0,
    created_at TEXT NOT NULL,
    UNIQUE (market_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
  CREATE TABLE IF NOT EXISTS notification_preferences (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    new_polls INTEGER NOT NULL DEFAULT 0 CHECK (new_polls IN (0, 1)),
    participated_resolutions INTEGER NOT NULL DEFAULT 0 CHECK (participated_resolutions IN (0, 1))
  );
  CREATE INDEX IF NOT EXISTS idx_markets_status_ends ON markets(status, ends_at);
  CREATE INDEX IF NOT EXISTS idx_bets_market ON bets(market_id);
`);

// Ajouts de la refonte : uniquement de nouvelles tables et de nouveaux index,
// pour que l'ancienne version puisse toujours tourner sur la même base.
db.exec(`
  CREATE TABLE IF NOT EXISTS market_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_market_comments_market ON market_comments(market_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_bets_created ON bets(created_at);
`);

const marketColumns = db.pragma('table_info(markets)');
if (!marketColumns.some((column) => column.name === 'cancelled_at')) {
  db.exec('ALTER TABLE markets ADD COLUMN cancelled_at TEXT');
}

const inviteColumns = db.pragma('table_info(invite_codes)');
if (!inviteColumns.some((column) => column.name === 'expires_at')) {
  db.exec('ALTER TABLE invite_codes ADD COLUMN expires_at TEXT');
  const legacyInvites = db.prepare('SELECT code, created_at FROM invite_codes').all();
  const setInviteExpiry = db.prepare('UPDATE invite_codes SET expires_at = ? WHERE code = ?');
  const legacyExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  for (const invite of legacyInvites) {
    setInviteExpiry.run(legacyExpiry, invite.code);
  }
}

db.exec(`
  INSERT OR IGNORE INTO invite_redemptions (invite_code, user_id, redeemed_at)
  SELECT code, redeemed_by, redeemed_at FROM invite_codes
  WHERE redeemed_by IS NOT NULL AND redeemed_at IS NOT NULL
`);

const betColumns = db.pragma('table_info(bets)');
if (!betColumns.some((column) => column.name === 'decimal_odds')) {
  db.exec('ALTER TABLE bets ADD COLUMN decimal_odds REAL NOT NULL DEFAULT 2.0');
}

db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
const hasUsers = db.prepare('SELECT 1 FROM users LIMIT 1').get();
const now = new Date().toISOString();
db.prepare(`
  DELETE FROM invite_codes
  WHERE created_by IS NULL AND redeemed_at IS NULL AND expires_at <= ?
`).run(now);
const bootstrapInvite = db.prepare(`
  SELECT code FROM invite_codes WHERE created_by IS NULL AND expires_at > ? LIMIT 1
`).get(now);
if (!hasUsers && !bootstrapInvite) {
  const initialInvite = process.env.INITIAL_INVITE_CODE?.trim().toUpperCase()
    || randomBytes(6).toString('hex').toUpperCase();
  if (!/^[A-Z0-9-]{6,32}$/.test(initialInvite)) {
    throw new Error('INITIAL_INVITE_CODE must be 6–32 letters, numbers, or hyphens.');
  }
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO invite_codes (code, created_at, expires_at) VALUES (?, ?, ?)')
    .run(initialInvite, createdAt, expiresAt);
  console.log(`Bootstrap invite code: ${initialInvite}`);
}

const app = express();
const port = Number(process.env.PORT || 3001);
const categories = new Set(['Culture', 'Sports', 'Technology', 'Politics', 'Community', 'Science']);
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY?.trim() ?? '';
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? '';
const vapidSubject = process.env.VAPID_SUBJECT?.trim() ?? '';
const pushConfiguration = [vapidPublicKey, vapidPrivateKey, vapidSubject];
if (pushConfiguration.some(Boolean) && pushConfiguration.some((value) => !value)) {
  throw new Error('Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT together to enable Web Push.');
}
const pushEnabled = pushConfiguration.every(Boolean);
if (pushEnabled) webPush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
app.use(express.json({ limit: '32kb' }));

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function getCookie(request, name) {
  const cookies = request.headers.cookie?.split(';') ?? [];
  const cookie = cookies.map((entry) => entry.trim()).find((entry) => entry.startsWith(`${name}=`));
  return cookie?.slice(name.length + 1);
}

function getUser(request) {
  const token = getCookie(request, 'sid');
  if (!token) return null;
  return db.prepare(`
    SELECT users.id, users.username, users.balance
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(digest(token), new Date().toISOString()) ?? null;
}

function requireUser(request, response, next) {
  request.user = getUser(request);
  if (!request.user) return response.status(401).json({ error: 'Connectez-vous pour continuer.' });
  next();
}

function setSession(response, userId) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(digest(token), userId, expiresAt);
  response.cookie('sid', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function publicUser(user) {
  return { id: user.id, username: user.username, balance: user.balance };
}

async function sendPushNotifications(subscriptions, payload) {
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webPush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      }, JSON.stringify(payload));
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(subscription.endpoint);
        return;
      }
      console.error('Web Push delivery failed:', error);
    }
  }));
}

function dispatchPushNotifications(subscriptions, payload) {
  void sendPushNotifications(subscriptions, payload)
    .catch((error) => console.error('Could not complete Web Push delivery:', error));
}

function notifyNewPoll(market, creatorId) {
  if (!pushEnabled) return;
  const subscriptions = db.prepare(`
    SELECT push_subscriptions.endpoint, push_subscriptions.p256dh, push_subscriptions.auth
    FROM push_subscriptions
    JOIN notification_preferences ON notification_preferences.user_id = push_subscriptions.user_id
    WHERE notification_preferences.new_polls = 1 AND push_subscriptions.user_id != ?
  `).all(creatorId);
  dispatchPushNotifications(subscriptions, {
    title: 'Nouveau marché',
    body: market.title,
    marketId: market.id,
    type: 'new-poll',
  });
}

function notifyPollResolved(marketId, title) {
  if (!pushEnabled) return;
  const subscriptions = db.prepare(`
    SELECT DISTINCT push_subscriptions.endpoint, push_subscriptions.p256dh, push_subscriptions.auth
    FROM push_subscriptions
    JOIN notification_preferences ON notification_preferences.user_id = push_subscriptions.user_id
    JOIN bets ON bets.user_id = push_subscriptions.user_id
    WHERE notification_preferences.participated_resolutions = 1 AND bets.market_id = ?
  `).all(marketId);
  dispatchPushNotifications(subscriptions, {
    title: 'Un marché où vous avez une position est résolu',
    body: title,
    marketId,
    type: 'poll-resolved',
  });
}

app.get('/api/me', (request, response) => {
  const user = getUser(request);
  response.json({ user: user ? publicUser(user) : null });
});

app.post('/api/auth/register', async (request, response) => {
  const username = typeof request.body.username === 'string' ? request.body.username.trim() : '';
  const email = typeof request.body.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  const password = typeof request.body.password === 'string' ? request.body.password : '';
  const inviteCode = typeof request.body.inviteCode === 'string' ? request.body.inviteCode.trim().toUpperCase() : '';
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return response.status(400).json({ error: 'Le pseudo fait 3 à 20 caractères : lettres, chiffres ou _.' });
  }
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) {
    return response.status(400).json({ error: 'Adresse e-mail invalide.' });
  }
  if (password.length < 8 || password.length > 128) {
    return response.status(400).json({ error: 'Le mot de passe doit faire au moins 8 caractères.' });
  }
  if (!inviteCode) return response.status(400).json({ error: 'Un code d’invitation est requis.' });

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const userId = db.transaction(() => {
      const now = new Date().toISOString();
      const invite = db.prepare(`
        SELECT code FROM invite_codes WHERE code = ? AND expires_at > ?
      `).get(inviteCode, now);
      if (!invite) throw Object.assign(new Error('Ce code d’invitation est invalide ou expiré.'), { status: 400 });

      const result = db.prepare(`
        INSERT INTO users (username, email, password_hash, balance, created_at)
        VALUES (?, ?, ?, 1000, ?)
      `).run(username, email, passwordHash, now);
      db.prepare(`
        INSERT INTO invite_redemptions (invite_code, user_id, redeemed_at) VALUES (?, ?, ?)
      `).run(invite.code, result.lastInsertRowid, now);
      return Number(result.lastInsertRowid);
    })();
    setSession(response, userId);
    response.status(201).json({
      user: publicUser(db.prepare('SELECT id, username, balance FROM users WHERE id = ?').get(userId)),
    });
  } catch (error) {
    if (error.status) return response.status(error.status).json({ error: error.message });
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return response.status(409).json({ error: 'Ce pseudo ou cet e-mail est déjà utilisé.' });
    }
    console.error(error);
    response.status(500).json({ error: 'Impossible de créer votre compte.' });
  }
});

app.post('/api/auth/login', async (request, response) => {
  const identity = typeof request.body.identity === 'string' ? request.body.identity.trim() : '';
  const password = typeof request.body.password === 'string' ? request.body.password : '';
  const user = db.prepare(`
    SELECT id, username, balance, password_hash FROM users
    WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE
  `).get(identity, identity);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return response.status(401).json({ error: 'Identifiants incorrects.' });
  }
  setSession(response, user.id);
  response.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (request, response) => {
  const token = getCookie(request, 'sid');
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(token));
  response.clearCookie('sid', { httpOnly: true, sameSite: 'lax', path: '/' });
  response.json({ ok: true });
});

app.get('/api/invites', requireUser, (request, response) => {
  const invites = db.prepare(`
    SELECT invite_codes.code, invite_codes.created_at AS createdAt,
      invite_codes.expires_at AS expiresAt,
      COUNT(invite_redemptions.user_id) AS redeemedCount
    FROM invite_codes
    LEFT JOIN invite_redemptions ON invite_redemptions.invite_code = invite_codes.code
    WHERE invite_codes.created_by = ?
    GROUP BY invite_codes.code ORDER BY invite_codes.created_at DESC
  `).all(request.user.id);
  response.json({ invites });
});

app.post('/api/invites', requireUser, (request, response) => {
  const validForDays = Number(request.body.validForDays);
  if (![1, 7, 30].includes(validForDays)) {
    return response.status(400).json({ error: 'Choisissez une durée de 1, 7 ou 30 jours.' });
  }
  const code = randomBytes(6).toString('hex').toUpperCase();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + validForDays * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO invite_codes (code, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(code, request.user.id, createdAt, expiresAt);
  response.status(201).json({ invite: { code, createdAt, expiresAt, redeemedCount: 0 } });
});

app.get('/api/notifications/settings', requireUser, (request, response) => {
  const preferences = db.prepare(`
    SELECT new_polls AS newPolls, participated_resolutions AS participatedResolutions
    FROM notification_preferences WHERE user_id = ?
  `).get(request.user.id) ?? { newPolls: 0, participatedResolutions: 0 };
  const subscription = db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ? LIMIT 1')
    .get(request.user.id);
  response.json({
    pushEnabled,
    publicKey: pushEnabled ? vapidPublicKey : null,
    hasSubscription: Boolean(subscription),
    preferences: {
      newPolls: Boolean(preferences.newPolls),
      participatedResolutions: Boolean(preferences.participatedResolutions),
    },
  });
});

app.put('/api/notifications/preferences', requireUser, (request, response) => {
  const { newPolls, participatedResolutions } = request.body;
  if (typeof newPolls !== 'boolean' || typeof participatedResolutions !== 'boolean') {
    return response.status(400).json({ error: 'Les deux préférences doivent valoir true ou false.' });
  }
  db.prepare(`
    INSERT INTO notification_preferences (user_id, new_polls, participated_resolutions)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET new_polls = excluded.new_polls,
      participated_resolutions = excluded.participated_resolutions
  `).run(request.user.id, Number(newPolls), Number(participatedResolutions));
  response.json({ preferences: { newPolls, participatedResolutions } });
});

app.post('/api/notifications/subscriptions', requireUser, (request, response) => {
  if (!pushEnabled) {
    return response.status(503).json({ error: 'Les notifications push ne sont pas configurées sur ce serveur.' });
  }
  const { endpoint, keys } = request.body;
  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    return response.status(400).json({ error: 'Abonnement push invalide.' });
  }
  if (parsedEndpoint.protocol !== 'https:' || typeof keys?.p256dh !== 'string' || !keys.p256dh
    || typeof keys?.auth !== 'string' || !keys.auth) {
    return response.status(400).json({ error: 'Abonnement push invalide.' });
  }
  db.prepare(`
    INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id,
      p256dh = excluded.p256dh, auth = excluded.auth
  `).run(parsedEndpoint.href, request.user.id, keys.p256dh, keys.auth, new Date().toISOString());
  response.status(201).json({ ok: true });
});

app.delete('/api/notifications/subscriptions', requireUser, (request, response) => {
  const { endpoint } = request.body;
  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    return response.status(400).json({ error: 'Abonnement push invalide.' });
  }
  if (parsedEndpoint.protocol !== 'https:') {
    return response.status(400).json({ error: 'Abonnement push invalide.' });
  }
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
    .run(parsedEndpoint.href, request.user.id);
  const hasSubscription = Boolean(db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ? LIMIT 1')
    .get(request.user.id));
  response.json({ ok: true, hasSubscription });
});

function marketOdds(total, selected, optionCount) {
  return Number(((total + optionCount) / (selected + 1)).toFixed(2));
}

function serializeMarkets(rows, userId) {
  if (rows.length === 0) return [];
  const ids = rows.map((market) => market.id);
  const placeholders = ids.map(() => '?').join(', ');
  const totals = db.prepare(`
    SELECT market_id, choice_index, COUNT(*) AS count, SUM(amount) AS staked
    FROM bets WHERE market_id IN (${placeholders}) GROUP BY market_id, choice_index
  `).all(...ids);
  const myBets = db.prepare(`
    SELECT market_id, choice_index, amount, decimal_odds FROM bets
    WHERE user_id = ? AND market_id IN (${placeholders})
  `).all(userId, ...ids);
  const commentCounts = db.prepare(`
    SELECT market_id, COUNT(*) AS count FROM market_comments
    WHERE market_id IN (${placeholders}) GROUP BY market_id
  `).all(...ids);
  const totalsByMarket = new Map();
  for (const row of totals) {
    if (!totalsByMarket.has(row.market_id)) totalsByMarket.set(row.market_id, []);
    totalsByMarket.get(row.market_id).push(row);
  }
  const betsByMarket = new Map(myBets.map((bet) => [bet.market_id, bet]));
  const commentsByMarket = new Map(commentCounts.map((row) => [row.market_id, row.count]));
  return rows.map((market) => {
    const options = JSON.parse(market.options_json);
    const marketBets = totalsByMarket.get(market.id) ?? [];
    const totalPickCount = marketBets.reduce((sum, bet) => sum + bet.count, 0);
    const optionStats = Array.from({ length: options.length }, (_, index) => {
      const summary = marketBets.find((entry) => entry.choice_index === index);
      const count = summary?.count ?? 0;
      return { count, staked: summary?.staked ?? 0, odds: marketOdds(totalPickCount, count, options.length) };
    });
    const myBet = betsByMarket.get(market.id);
    return {
      id: market.id,
      title: market.title,
      description: market.description,
      category: market.category,
      options,
      outcomeIndex: market.outcome_index,
      status: market.status,
      cancelledAt: market.cancelled_at,
      endsAt: market.ends_at,
      createdAt: market.created_at,
      creator: market.creator_name,
      creatorId: market.creator_id,
      optionStats,
      totalStaked: marketBets.reduce((sum, bet) => sum + bet.staked, 0),
      bettorsCount: totalPickCount,
      commentsCount: commentsByMarket.get(market.id) ?? 0,
      myBet: myBet ? {
        choiceIndex: myBet.choice_index,
        amount: myBet.amount,
        odds: myBet.decimal_odds,
      } : null,
    };
  });
}

app.get('/api/markets', requireUser, (request, response) => {
  const markets = db.prepare(`
    SELECT markets.*, users.username AS creator_name
    FROM markets JOIN users ON users.id = markets.creator_id
    ORDER BY CASE
      WHEN markets.status = 'open' AND markets.ends_at > ? THEN 0
      WHEN markets.status = 'open' THEN 1
      ELSE 2
    END, markets.created_at DESC
  `).all(new Date().toISOString());
  response.json({ markets: serializeMarkets(markets, request.user.id) });
});

// Fiche marché : historique des probabilités (rejoué à partir des mises),
// activité, plus gros détenteurs et commentaires. Rien de nouveau n'est stocké
// pour l'historique : tout est recalculé depuis la table bets.
app.get('/api/markets/:id', requireUser, (request, response) => {
  const row = db.prepare(`
    SELECT markets.*, users.username AS creator_name
    FROM markets JOIN users ON users.id = markets.creator_id
    WHERE markets.id = ?
  `).get(request.params.id);
  if (!row) return response.status(404).json({ error: 'Marché introuvable.' });
  const [market] = serializeMarkets([row], request.user.id);
  const optionCount = market.options.length;
  const bets = db.prepare(`
    SELECT bets.id, bets.choice_index, bets.amount, bets.decimal_odds, bets.created_at, users.username
    FROM bets JOIN users ON users.id = bets.user_id
    WHERE bets.market_id = ? ORDER BY bets.created_at ASC, bets.id ASC
  `).all(market.id);

  const counts = new Array(optionCount).fill(0);
  const probabilities = () => {
    const total = counts.reduce((sum, count) => sum + count, 0);
    return counts.map((count) => (count + 1) / (total + optionCount));
  };
  const history = [{ t: market.createdAt, p: probabilities() }];
  for (const bet of bets) {
    if (bet.choice_index >= 0 && bet.choice_index < optionCount) counts[bet.choice_index] += 1;
    history.push({ t: bet.created_at, p: probabilities() });
  }

  const holders = market.options.map((_, index) => bets
    .filter((bet) => bet.choice_index === index)
    .sort((first, second) => second.amount - first.amount)
    .slice(0, 10)
    .map((bet) => ({
      username: bet.username,
      amount: bet.amount,
      odds: bet.decimal_odds,
      payout: Math.floor(bet.amount * bet.decimal_odds),
    })));

  const activity = bets.slice(-50).reverse().map((bet) => ({
    id: bet.id,
    username: bet.username,
    choiceIndex: bet.choice_index,
    amount: bet.amount,
    odds: bet.decimal_odds,
    createdAt: bet.created_at,
  }));

  const comments = db.prepare(`
    SELECT market_comments.id, market_comments.body, market_comments.created_at AS createdAt,
      users.username, bets.choice_index AS choiceIndex
    FROM market_comments
    JOIN users ON users.id = market_comments.user_id
    LEFT JOIN bets ON bets.market_id = market_comments.market_id AND bets.user_id = market_comments.user_id
    WHERE market_comments.market_id = ?
    ORDER BY market_comments.created_at DESC, market_comments.id DESC LIMIT 200
  `).all(market.id);

  response.json({ market, history, activity, holders, comments });
});

app.post('/api/markets/:id/comments', requireUser, (request, response) => {
  const body = typeof request.body.body === 'string' ? request.body.body.trim() : '';
  if (body.length < 1 || body.length > 500) {
    return response.status(400).json({ error: 'Un commentaire fait entre 1 et 500 caractères.' });
  }
  const market = db.prepare('SELECT id FROM markets WHERE id = ?').get(request.params.id);
  if (!market) return response.status(404).json({ error: 'Marché introuvable.' });
  const createdAt = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO market_comments (market_id, user_id, body, created_at) VALUES (?, ?, ?, ?)
  `).run(market.id, request.user.id, body, createdAt);
  response.status(201).json({ comment: { id: Number(result.lastInsertRowid), body, createdAt, username: request.user.username } });
});

// Fil d'activité global (dernières prises, tous marchés confondus).
app.get('/api/activity', requireUser, (request, response) => {
  const activity = db.prepare(`
    SELECT bets.id, bets.market_id AS marketId, bets.choice_index AS choiceIndex, bets.amount,
      bets.decimal_odds AS odds, bets.created_at AS createdAt, users.username,
      markets.title AS marketTitle, markets.options_json
    FROM bets
    JOIN users ON users.id = bets.user_id
    JOIN markets ON markets.id = bets.market_id
    ORDER BY bets.created_at DESC, bets.id DESC LIMIT 30
  `).all();
  response.json({
    activity: activity.map(({ options_json: optionsJson, ...entry }) => ({
      ...entry,
      outcome: JSON.parse(optionsJson)[entry.choiceIndex] ?? '?',
    })),
  });
});

app.get('/api/leaderboard', requireUser, (request, response) => {
  const requestedLimit = Number(request.query.limit ?? 8);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 8;
  // Les champs id, username, balance et wins sont ceux de l'ancienne API ;
  // volume, inPlay, pnl et positions sont des ajouts.
  const leaders = db.prepare(`
    SELECT users.id, users.username, users.balance,
      (SELECT COUNT(*) FROM bets JOIN markets ON markets.id = bets.market_id
       WHERE bets.user_id = users.id AND bets.choice_index = markets.outcome_index
         AND markets.status = 'resolved') AS wins,
      (SELECT COALESCE(SUM(amount), 0) FROM bets WHERE bets.user_id = users.id) AS volume,
      (SELECT COUNT(*) FROM bets WHERE bets.user_id = users.id) AS positions,
      (SELECT COALESCE(SUM(bets.amount), 0) FROM bets JOIN markets ON markets.id = bets.market_id
       WHERE bets.user_id = users.id AND markets.status = 'open') AS inPlay
    FROM users ORDER BY users.balance DESC, users.created_at ASC LIMIT ?
  `).all(limit);
  response.json({
    leaders: leaders.map((leader) => ({ ...leader, pnl: leader.balance + leader.inPlay - 1000 })),
  });
});

app.post('/api/markets', requireUser, (request, response) => {
  const { title, description, category, options, endsAt } = request.body;
  if (typeof title !== 'string' || title.trim().length < 8 || title.trim().length > 100) {
    return response.status(400).json({ error: 'La question fait entre 8 et 100 caractères.' });
  }
  if (typeof description !== 'string' || description.trim().length > 280) {
    return response.status(400).json({ error: 'La description fait 280 caractères maximum.' });
  }
  if (!categories.has(category)) return response.status(400).json({ error: 'Catégorie invalide.' });
  if (!Array.isArray(options) || options.length < 2 || options.length > 6
    || options.some((option) => typeof option !== 'string' || !option.trim() || option.trim().length > 40)) {
    return response.status(400).json({ error: 'Ajoutez entre 2 et 6 issues, de 40 caractères maximum.' });
  }
  const cleanOptions = options.map((option) => option.trim());
  if (new Set(cleanOptions.map((option) => option.toLowerCase())).size !== cleanOptions.length) {
    return response.status(400).json({ error: 'Les issues doivent être toutes différentes.' });
  }
  const expiry = Date.parse(endsAt);
  if (!Number.isFinite(expiry) || expiry < Date.now() + 60_000 || expiry > Date.now() + 90 * 24 * 60 * 60 * 1000) {
    return response.status(400).json({ error: 'La clôture doit être entre 1 minute et 90 jours à partir de maintenant.' });
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO markets (id, title, description, category, options_json, ends_at, created_at, creator_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, title.trim(), description.trim(), category, JSON.stringify(cleanOptions),
    new Date(expiry).toISOString(), new Date().toISOString(), request.user.id,
  );
  notifyNewPoll({ id, title: title.trim() }, request.user.id);
  response.status(201).json({ id });
});

app.patch('/api/markets/:id', requireUser, (request, response) => {
  const market = db.prepare('SELECT id, creator_id, status FROM markets WHERE id = ?').get(request.params.id);
  if (!market) return response.status(404).json({ error: 'Marché introuvable.' });
  if (market.creator_id !== request.user.id) {
    return response.status(403).json({ error: 'Seul le créateur du marché peut le modifier.' });
  }
  if (market.status !== 'open') {
    return response.status(409).json({ error: 'Un marché résolu ne peut plus être modifié.' });
  }

  const { title, description, category, endsAt } = request.body;
  if (typeof title !== 'string' || title.trim().length < 8 || title.trim().length > 100) {
    return response.status(400).json({ error: 'La question fait entre 8 et 100 caractères.' });
  }
  if (typeof description !== 'string' || description.trim().length > 280) {
    return response.status(400).json({ error: 'La description fait 280 caractères maximum.' });
  }
  if (!categories.has(category)) return response.status(400).json({ error: 'Catégorie invalide.' });
  const expiry = Date.parse(endsAt);
  if (!Number.isFinite(expiry) || expiry < Date.now() + 60_000 || expiry > Date.now() + 90 * 24 * 60 * 60 * 1000) {
    return response.status(400).json({ error: 'La clôture doit être entre 1 minute et 90 jours à partir de maintenant.' });
  }

  db.prepare(`
    UPDATE markets SET title = ?, description = ?, category = ?, ends_at = ? WHERE id = ?
  `).run(title.trim(), description.trim(), category, new Date(expiry).toISOString(), market.id);
  response.json({ ok: true });
});

app.post('/api/markets/:id/bets', requireUser, (request, response) => {
  const choiceIndex = Number(request.body.choiceIndex);
  const amount = Number(request.body.amount);
  const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(request.params.id);
  if (!market) return response.status(404).json({ error: 'Marché introuvable.' });
  if (market.status !== 'open' || Date.parse(market.ends_at) <= Date.now()) {
    return response.status(400).json({ error: 'Ce marché n’accepte plus de prises.' });
  }
  const options = JSON.parse(market.options_json);
  if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex >= options.length) {
    return response.status(400).json({ error: 'Choisissez une des issues proposées.' });
  }
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100_000) {
    return response.status(400).json({ error: 'Misez un nombre entier de crédits entre 1 et 100 000.' });
  }

  try {
    db.transaction(() => {
      if (db.prepare('SELECT 1 FROM bets WHERE market_id = ? AND user_id = ?').get(market.id, request.user.id)) {
        throw Object.assign(new Error('Vous avez déjà une position sur ce marché.'), { status: 409 });
      }
      const pickCounts = db.prepare(`
        SELECT COUNT(*) AS total, SUM(CASE WHEN choice_index = ? THEN 1 ELSE 0 END) AS selected
        FROM bets WHERE market_id = ?
      `).get(choiceIndex, market.id);
      const selectedCount = pickCounts.selected ?? 0;
      const decimalOdds = Number(((pickCounts.total + options.length) / (selectedCount + 1)).toFixed(2));
      const debit = db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?')
        .run(amount, request.user.id, amount);
      if (debit.changes !== 1) throw Object.assign(new Error('Solde insuffisant pour cette mise.'), { status: 400 });
      db.prepare(`
        INSERT INTO bets (market_id, user_id, choice_index, amount, decimal_odds, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(market.id, request.user.id, choiceIndex, amount, decimalOdds, new Date().toISOString());
    })();
  } catch (error) {
    if (error.status) return response.status(error.status).json({ error: error.message });
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return response.status(409).json({ error: 'Vous avez déjà une position sur ce marché.' });
    console.error(error);
    return response.status(500).json({ error: 'Impossible de passer l’ordre.' });
  }
  response.json({ user: publicUser(db.prepare('SELECT id, username, balance FROM users WHERE id = ?').get(request.user.id)) });
});

app.post('/api/markets/:id/resolve', requireUser, (request, response) => {
  const outcomeIndex = Number(request.body.outcomeIndex);
  let resolvedTitle;
  try {
    db.transaction(() => {
      const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(request.params.id);
      if (!market) throw Object.assign(new Error('Marché introuvable.'), { status: 404 });
      if (market.status === 'resolved') throw Object.assign(new Error('Ce marché est déjà résolu.'), { status: 409 });
      const options = JSON.parse(market.options_json);
      if (!Number.isInteger(outcomeIndex) || outcomeIndex < 0 || outcomeIndex >= options.length) {
        throw Object.assign(new Error('Choisissez une des issues proposées.'), { status: 400 });
      }
      db.prepare('UPDATE markets SET status = \'resolved\', outcome_index = ? WHERE id = ?')
        .run(outcomeIndex, market.id);
      const winners = db.prepare('SELECT user_id, amount, decimal_odds FROM bets WHERE market_id = ? AND choice_index = ?')
        .all(market.id, outcomeIndex);
      const credit = db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?');
      for (const winner of winners) {
        credit.run(Math.floor(winner.amount * winner.decimal_odds), winner.user_id);
      }
      resolvedTitle = market.title;
    })();
  } catch (error) {
    if (error.status) return response.status(error.status).json({ error: error.message });
    console.error(error);
    return response.status(500).json({ error: 'Impossible de résoudre ce marché.' });
  }
  notifyPollResolved(request.params.id, resolvedTitle);
  response.json({ user: publicUser(db.prepare('SELECT id, username, balance FROM users WHERE id = ?').get(request.user.id)) });
});

app.post('/api/markets/:id/cancel', requireUser, (request, response) => {
  try {
    const result = db.transaction(() => {
      const market = db.prepare('SELECT id, creator_id, status FROM markets WHERE id = ?').get(request.params.id);
      if (!market) throw Object.assign(new Error('Marché introuvable.'), { status: 404 });
      if (market.creator_id !== request.user.id) {
        throw Object.assign(new Error('Seul le créateur du marché peut l’annuler.'), { status: 403 });
      }
      if (market.status !== 'open') {
        throw Object.assign(new Error('Ce marché est déjà clôturé.'), { status: 409 });
      }

      const bets = db.prepare('SELECT user_id, amount FROM bets WHERE market_id = ?').all(market.id);
      const refund = db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?');
      for (const bet of bets) {
        if (refund.run(bet.amount, bet.user_id).changes !== 1) {
          throw new Error(`Could not refund user ${bet.user_id} for market ${market.id}.`);
        }
      }
      const cancelledAt = new Date().toISOString();
      const closed = db.prepare(`
        UPDATE markets SET status = 'resolved', cancelled_at = ? WHERE id = ? AND status = 'open'
      `).run(cancelledAt, market.id);
      if (closed.changes !== 1) throw Object.assign(new Error('Ce marché est déjà clôturé.'), { status: 409 });

      return {
        refundedCredits: bets.reduce((total, bet) => total + bet.amount, 0),
        refundedCallers: bets.length,
      };
    })();
    response.json({
      ...result,
      user: publicUser(db.prepare('SELECT id, username, balance FROM users WHERE id = ?').get(request.user.id)),
    });
  } catch (error) {
    if (error.status) return response.status(error.status).json({ error: error.message });
    console.error(error);
    return response.status(500).json({ error: 'Impossible d’annuler ce marché et de rembourser les mises.' });
  }
});

app.use('/api', (request, response) => response.status(404).json({ error: 'Route API introuvable.' }));

const buildDirectory = path.join(root, 'dist');
if (fs.existsSync(buildDirectory)) {
  app.use(express.static(buildDirectory));
  app.get('*path', (_request, response) => response.sendFile('index.html', { root: buildDirectory }));
}

app.listen(port, () => {
  console.log(`${brand.name} API listening on http://localhost:${port}`);
});