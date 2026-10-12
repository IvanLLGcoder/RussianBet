import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webPush from 'web-push';
import { BanqueIndisponible, creerClientBanque } from './banque.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '..');
const brand = JSON.parse(fs.readFileSync(path.join(root, 'brand.config.json'), 'utf8'));
// On ne crée que le dossier qui contient réellement la base (DB_PATH peut pointer ailleurs, ex. /donnees en Docker).
const databasePath = process.env.DB_PATH || path.join(root, 'data', 'oddsroom.sqlite');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new Database(databasePath);
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

// Économie commune avec le poker (voir MIGRATION.md) : deux tables additives, créées dans tous les
// modes pour que la base reste la même ; elles ne servent qu'en mode banque.
// - comptes_banque : lien entre une ligne locale users et le compte de la banque (poker) ;
// - banque_en_attente : mouvements à envoyer à la banque (gains, remboursements, crédits
//   compensatoires), rejoués jusqu'au succès. essais = -1 : réserve posée avant un débit de mise,
//   qui sert de verrou et ne part que si la mise locale n'a pas abouti.
db.exec(`
  CREATE TABLE IF NOT EXISTS comptes_banque (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    compte_id INTEGER UNIQUE NOT NULL,
    lie_le TEXT
  );
  CREATE TABLE IF NOT EXISTS banque_en_attente (
    cle TEXT PRIMARY KEY,
    compte_id INTEGER NOT NULL,
    montant INTEGER NOT NULL,
    motif TEXT NOT NULL,
    cree_le TEXT NOT NULL,
    essais INTEGER NOT NULL DEFAULT 0,
    derniere_erreur TEXT
  );
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
// Publication sous un sous-chemin (ex. BASE_PATH=/paris derrière poker.dyuka.com/paris/) : on retire
// le préfixe avant le routage, les routes restent « /api/… ». Vide = racine du domaine.
const basePath = (process.env.BASE_PATH ?? '').trim().replace(/\/+$/, '');
if (basePath) {
  app.use((request, response, next) => {
    if (request.url === basePath || request.url.startsWith(`${basePath}?`)) {
      return response.redirect(301, `${basePath}/${request.url.slice(basePath.length)}`);
    }
    if (request.url.startsWith(`${basePath}/`)) request.url = request.url.slice(basePath.length);
    next();
  });
}
app.use(express.json({ limit: '32kb' }));

// Mode banque : actif seulement si BANQUE_URL et BANQUE_SECRET sont définis. Sinon, le site
// fonctionne en autonome, exactement comme avant (crédits locaux).
const banqueUrl = process.env.BANQUE_URL?.trim() ?? '';
const banqueSecret = process.env.BANQUE_SECRET?.trim() ?? '';
const banque = banqueUrl && banqueSecret ? creerClientBanque({ url: banqueUrl, secret: banqueSecret }) : null;
// Constantes du poker (config.py) : solde d'un nouveau compte, et le solde local historique.
const soldeDepartBanque = 10_000;
const soldeDepartLocal = 1000;
const relanceBanqueMs = Math.max(50, Number(process.env.BANQUE_RELANCE_MS) || 30_000);

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
  // En mode banque, seule une ligne liée à un compte de la banque ouvre une session : un ancien
  // compte local encore connecté doit repasser par la connexion (qui le migre vers la banque).
  return db.prepare(`
    SELECT users.id, users.username, users.balance, comptes_banque.compte_id AS compteId
    FROM sessions JOIN users ON users.id = sessions.user_id
    ${banque ? 'JOIN' : 'LEFT JOIN'} comptes_banque ON comptes_banque.user_id = users.id
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
    path: `${basePath}/`,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

const internalEmailDomain = 'sans-email.invalid';

function isInternalEmail(email) {
  return email.toLowerCase().endsWith(`@${internalEmailDomain}`);
}

// Seuls id, pseudo et solde sortent vers le client : jamais l'e-mail (réel ou interne).
function publicUser(user) {
  return { id: user.id, username: user.username, balance: user.balance };
}

// ---------- Économie commune : outils du mode banque ----------

const erreurBanqueInjoignable = 'Le poker (banque des jetons) ne répond pas. Réessayez dans un instant.';
const erreurMiseAnnulee = 'Une mise précédente sur ce marché a été annulée et vous a été rendue : vous ne pouvez plus miser dessus.';

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function soldeMiroir(solde) {
  return Number.isFinite(solde) ? Math.max(0, Math.trunc(solde)) : 0;
}

// users.balance devient le miroir du solde banque : l'ancienne version et les replis le lisent.
function miroir(compteId, solde) {
  if (!Number.isFinite(solde)) return;
  db.prepare('UPDATE users SET balance = ? WHERE id = (SELECT user_id FROM comptes_banque WHERE compte_id = ?)')
    .run(soldeMiroir(solde), compteId);
}

function versesPropres(verse) {
  return Array.isArray(verse)
    ? verse.filter((entry) => entry && typeof entry.motif === 'string' && Number.isFinite(entry.montant))
      .map((entry) => ({ motif: entry.motif, montant: entry.montant }))
    : [];
}

// Pseudo local = nom poker ; en cas de conflit avec un ancien compte local non lié, suffixe « -2 », « -3 »…
function pseudoLibre(nom) {
  const pris = db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE');
  if (!pris.get(nom)) return nom;
  for (let suffixe = 2; ; suffixe += 1) {
    if (!pris.get(`${nom}-${suffixe}`)) return `${nom}-${suffixe}`;
  }
}

function emailInterne(nom) {
  const base = nom.normalize('NFD').replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 20) || 'joueur';
  return `${base}.${randomBytes(4).toString('hex')}@${internalEmailDomain}`;
}

// Ancien compte local, jamais lié, dont le mot de passe local correspond : c'est la même personne.
async function ancienCompteVerifie(identity, password) {
  if (!identity || isInternalEmail(identity)) return null;
  const ancien = db.prepare(`
    SELECT users.id, users.username, users.password_hash FROM users
    LEFT JOIN comptes_banque ON comptes_banque.user_id = users.id
    WHERE comptes_banque.user_id IS NULL AND (users.username = ? COLLATE NOCASE OR users.email = ? COLLATE NOCASE)
  `).get(identity, identity);
  if (!ancien || !(await bcrypt.compare(password, ancien.password_hash))) return null;
  return ancien;
}

// Retrouve la ligne locale liée au compte banque, ou la crée (ou lie l'ancien compte local donné).
// Une ligne créée ici a un mot de passe local aléatoire : la connexion passe toujours par la banque.
async function lierCompte(compte, ancienUserId = null) {
  const lien = db.prepare('SELECT user_id FROM comptes_banque WHERE compte_id = ?');
  const existant = lien.get(compte.id);
  if (existant) {
    miroir(compte.id, compte.solde);
    return existant.user_id;
  }
  const hash = await bcrypt.hash(randomBytes(32).toString('hex'), 10);
  return db.transaction(() => {
    const deja = lien.get(compte.id);
    if (deja) return deja.user_id;
    const now = new Date().toISOString();
    let userId = ancienUserId;
    const ancienEncoreLibre = userId
      && !db.prepare('SELECT 1 FROM comptes_banque WHERE user_id = ?').get(userId);
    if (!ancienEncoreLibre) {
      userId = Number(db.prepare(`
        INSERT INTO users (username, email, password_hash, balance, created_at) VALUES (?, ?, ?, ?, ?)
      `).run(pseudoLibre(compte.nom), emailInterne(compte.nom), hash, soldeMiroir(compte.solde), now).lastInsertRowid);
    }
    db.prepare('INSERT INTO comptes_banque (user_id, compte_id, lie_le) VALUES (?, ?, ?)').run(userId, compte.id, now);
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(soldeMiroir(compte.solde), userId);
    return userId;
  })();
}

function ouvrirSessionBanque(response, userId, compte, status = 200) {
  setSession(response, userId);
  const user = db.prepare('SELECT id, username, balance FROM users WHERE id = ?').get(userId);
  response.status(status).json({ user: publicUser(user), verse: versesPropres(compte.verse) });
}

async function estAdminBanque(user) {
  if (!banque || !user?.compteId) return false;
  try {
    const { status, data } = await banque.comptes([user.compteId]);
    return status === 200 && Boolean(data.comptes?.find((compte) => compte.id === user.compteId)?.admin);
  } catch {
    return false;
  }
}

function mettreEnFile(cle, compteId, montant, motif) {
  db.prepare(`
    INSERT OR IGNORE INTO banque_en_attente (cle, compte_id, montant, motif, cree_le, essais)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(cle, compteId, montant, motif, new Date().toISOString());
}

// Mises dont le débit banque est en cours (verrou en mémoire, par clé d'annulation).
const misesEnCours = new Set();

function noterEchec(cle, message) {
  db.prepare('UPDATE banque_en_attente SET essais = essais + 1, derniere_erreur = ? WHERE cle = ? AND essais >= 0')
    .run(String(message).slice(0, 500), cle);
}

async function viderFileUneFois() {
  const lignes = db.prepare('SELECT * FROM banque_en_attente WHERE essais >= 0 ORDER BY cree_le, cle').all();
  for (const ligne of lignes) {
    try {
      if (ligne.cle.startsWith('paris-annule-mise-')) {
        // Le crédit compensatoire ne part que si le débit a bien eu lieu : on renvoie d'abord le débit
        // (même clé, idempotent). S'il n'avait jamais eu lieu, il a lieu maintenant puis est compensé ;
        // « Solde insuffisant » prouve qu'il n'a jamais eu lieu, il n'y a alors rien à rendre.
        const debit = await banque.mouvement({
          compte: ligne.compte_id,
          montant: -ligne.montant,
          motif: ligne.motif.replace(/^Paris : remboursement — /, 'Paris : mise — '),
          cle: ligne.cle.replace(/^paris-annule-mise-/, 'paris-mise-'),
        });
        if (debit.status === 409 && debit.data.erreur === 'Solde insuffisant') {
          db.prepare('DELETE FROM banque_en_attente WHERE cle = ?').run(ligne.cle);
          continue;
        }
        if (debit.status !== 200) {
          noterEchec(ligne.cle, `débit ${debit.status} : ${debit.data.erreur ?? ''}`);
          continue;
        }
      }
      const { status, data } = await banque.mouvement({
        compte: ligne.compte_id, montant: ligne.montant, motif: ligne.motif, cle: ligne.cle,
      });
      if (status === 200) {
        db.prepare('DELETE FROM banque_en_attente WHERE cle = ?').run(ligne.cle);
        miroir(ligne.compte_id, data.solde);
      } else {
        noterEchec(ligne.cle, `${status} : ${data.erreur ?? ''}`);
        console.error(`Mouvement banque refusé (${ligne.cle}) : ${status} ${data.erreur ?? ''}`);
      }
    } catch (error) {
      noterEchec(ligne.cle, error.message);
      if (error instanceof BanqueIndisponible) break; // inutile d'insister pendant une panne
      console.error(error);
    }
  }
}

let vidageEnCours = null;
let vidageDemande = false;

// Envoie la file à la banque. Les clés sont déterministes : rejouer est sans risque.
function viderFileBanque() {
  if (!banque) return Promise.resolve();
  vidageDemande = true;
  if (!vidageEnCours) {
    vidageEnCours = (async () => {
      try {
        while (vidageDemande) {
          vidageDemande = false;
          await viderFileUneFois();
        }
      } catch (error) {
        console.error('Envoi de la file banque impossible :', error);
      } finally {
        vidageEnCours = null;
      }
    })();
  }
  return vidageEnCours;
}

// Réserves (essais = -1) laissées par une mise interrompue (panne de la banque, arrêt du serveur) :
// si la mise locale existe, la réserve est inutile ; sinon on la transforme en crédit compensatoire.
function activerReservesOrphelines(ageMinimumMs) {
  const limite = new Date(Date.now() - ageMinimumMs).toISOString();
  const reserves = db.prepare('SELECT cle, compte_id FROM banque_en_attente WHERE essais = -1 AND cree_le <= ?').all(limite);
  for (const reserve of reserves) {
    if (misesEnCours.has(reserve.cle)) continue;
    const marketId = /^paris-annule-mise-(.+)-\d+$/.exec(reserve.cle)?.[1];
    const miseLocale = db.prepare(`
      SELECT 1 FROM bets JOIN comptes_banque ON comptes_banque.user_id = bets.user_id
      WHERE bets.market_id = ? AND comptes_banque.compte_id = ?
    `).get(marketId, reserve.compte_id);
    if (miseLocale) db.prepare('DELETE FROM banque_en_attente WHERE cle = ?').run(reserve.cle);
    else db.prepare('UPDATE banque_en_attente SET essais = 0 WHERE cle = ? AND essais = -1').run(reserve.cle);
  }
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

// banque / soldeDepart servent aussi aux visiteurs (feuille d'inscription : « 10 000 jetons offerts »).
// En mode banque, on « touche » le compte (allocation du jour, renflouement) et on renvoie `verse`
// pour que l'interface affiche un toast ; si la banque ne répond pas, on se replie sur le miroir.
app.get('/api/me', async (request, response) => {
  const user = getUser(request);
  const extra = {
    banque: Boolean(banque),
    soldeDepart: banque ? soldeDepartBanque : soldeDepartLocal,
    admin: false,
    verse: [],
  };
  if (!user || !banque) return response.json({ user: user ? publicUser(user) : null, ...extra });
  try {
    const { status, data } = await banque.compte(user.compteId);
    if (status === 200) {
      miroir(user.compteId, data.solde);
      if (data.actif === false) {
        // Compte désactivé au poker : on ferme les sessions locales.
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
        return response.json({ user: null, ...extra });
      }
      return response.json({
        user: publicUser({ ...user, balance: soldeMiroir(data.solde) }),
        ...extra,
        admin: Boolean(data.admin),
        verse: versesPropres(data.verse),
      });
    }
  } catch (error) {
    if (!(error instanceof BanqueIndisponible)) console.error(error);
  }
  response.json({ user: publicUser(user), ...extra });
});

// Inscription en mode banque : le code d'invitation local est validé comme avant, puis le compte
// est créé à la banque (parrain = compte banque de l'invitant s'il est lié) et lié à une ligne locale.
async function inscriptionBanque(request, response) {
  const username = typeof request.body.username === 'string' ? request.body.username.trim() : '';
  const password = typeof request.body.password === 'string' ? request.body.password : '';
  const inviteCode = typeof request.body.inviteCode === 'string' ? request.body.inviteCode.trim().toUpperCase() : '';
  const longueur = [...username].length;
  if (longueur < 2 || longueur > 20) {
    return response.status(400).json({ error: 'Le nom fait 2 à 20 caractères.' });
  }
  if (password.length < 8 || password.length > 128) {
    return response.status(400).json({ error: 'Le mot de passe doit faire au moins 8 caractères.' });
  }
  if (!inviteCode) return response.status(400).json({ error: 'Un code d’invitation est requis.' });
  const invite = db.prepare('SELECT code, created_by FROM invite_codes WHERE code = ? AND expires_at > ?')
    .get(inviteCode, new Date().toISOString());
  if (!invite) return response.status(400).json({ error: 'Ce code d’invitation est invalide ou expiré.' });
  const parrain = invite.created_by
    ? db.prepare('SELECT compte_id FROM comptes_banque WHERE user_id = ?').get(invite.created_by)?.compte_id ?? null
    : null;

  try {
    const { status, data } = await banque.inscription(username, password, parrain);
    if (status !== 201) {
      // 400 (règles du poker) et 409 (« Ce pseudo est déjà pris ») sont affichées telles quelles.
      return response.status([400, 409].includes(status) ? status : 502)
        .json({ error: data.erreur ?? 'La banque a refusé l’inscription.' });
    }
    const userId = await lierCompte(data);
    db.prepare('INSERT OR IGNORE INTO invite_redemptions (invite_code, user_id, redeemed_at) VALUES (?, ?, ?)')
      .run(invite.code, userId, new Date().toISOString());
    ouvrirSessionBanque(response, userId, data, 201);
  } catch (error) {
    if (error instanceof BanqueIndisponible) return response.status(503).json({ error: erreurBanqueInjoignable });
    console.error(error);
    response.status(500).json({ error: 'Impossible de créer votre compte.' });
  }
}

// Connexion en mode banque : nom + mot de passe du poker. Un ancien compte local jamais lié
// (la banque répond 401) est migré : s'il a le bon mot de passe local, on crée son compte à la
// banque avec le même nom et le même mot de passe, puis on le lie.
async function connexionBanque(response, identity, password) {
  if (!identity || !password) return response.status(401).json({ error: 'Identifiants incorrects.' });
  try {
    const connexion = await banque.connexion(identity, password);
    if (connexion.status === 200) {
      const compte = connexion.data;
      const dejaLie = db.prepare('SELECT 1 FROM comptes_banque WHERE compte_id = ?').get(compte.id);
      // Même nom et même mot de passe qu'un ancien compte local non lié : on garde son historique.
      const ancien = dejaLie ? null : await ancienCompteVerifie(compte.nom, password);
      return ouvrirSessionBanque(response, await lierCompte(compte, ancien?.id ?? null), compte);
    }
    if (connexion.status !== 401) {
      return response.status(connexion.status === 403 ? 403 : 502)
        .json({ error: connexion.data.erreur ?? 'Connexion impossible.' });
    }

    const ancien = await ancienCompteVerifie(identity, password);
    if (!ancien) return response.status(401).json({ error: connexion.data.erreur ?? 'Identifiants incorrects.' });
    const inscription = await banque.inscription(ancien.username, password, null);
    if (inscription.status === 201) {
      return ouvrirSessionBanque(response, await lierCompte(inscription.data, ancien.id), inscription.data);
    }
    if (inscription.status === 409) {
      return response.status(409).json({
        error: `Le pseudo « ${ancien.username} » existe déjà au poker : connectez-vous avec le nom et le mot de passe du poker.`,
      });
    }
    return response.status(inscription.status === 400 ? 400 : 502).json({
      error: `Passage au compte commun avec le poker impossible : ${inscription.data.erreur ?? 'refus de la banque.'}`,
    });
  } catch (error) {
    if (error instanceof BanqueIndisponible) return response.status(503).json({ error: erreurBanqueInjoignable });
    console.error(error);
    return response.status(500).json({ error: 'Connexion impossible.' });
  }
}

app.post('/api/auth/register', async (request, response) => {
  if (banque) return inscriptionBanque(request, response);
  const username = typeof request.body.username === 'string' ? request.body.username.trim() : '';
  const providedEmail = typeof request.body.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  const password = typeof request.body.password === 'string' ? request.body.password : '';
  const inviteCode = typeof request.body.inviteCode === 'string' ? request.body.inviteCode.trim().toUpperCase() : '';
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return response.status(400).json({ error: 'Le nom fait 3 à 20 caractères : lettres, chiffres ou _.' });
  }
  // L'e-mail est facultatif. Sans e-mail, on stocke une adresse interne unique et non routable
  // (TLD réservé .invalid) pour respecter la contrainte NOT NULL UNIQUE du schéma ; elle n'est jamais renvoyée.
  if (providedEmail && (!/^\S+@\S+\.\S+$/.test(providedEmail) || providedEmail.length > 254 || isInternalEmail(providedEmail))) {
    return response.status(400).json({ error: 'Adresse e-mail invalide.' });
  }
  if (password.length < 6 || password.length > 128) {
    return response.status(400).json({ error: 'Le mot de passe doit faire au moins 6 caractères.' });
  }
  if (!inviteCode) return response.status(400).json({ error: 'Un code d’invitation est requis.' });

  const email = providedEmail || `${username.toLowerCase()}.${randomBytes(4).toString('hex')}@${internalEmailDomain}`;

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
      return response.status(409).json({ error: providedEmail ? 'Ce pseudo ou cet e-mail est déjà utilisé.' : 'Ce nom est déjà pris, choisissez-en un autre.' });
    }
    console.error(error);
    response.status(500).json({ error: 'Impossible de créer votre compte.' });
  }
});

app.post('/api/auth/login', async (request, response) => {
  const identity = typeof request.body.identity === 'string' ? request.body.identity.trim() : '';
  const password = typeof request.body.password === 'string' ? request.body.password : '';
  if (banque) return connexionBanque(response, identity, password);
  // Les e-mails internes ne servent pas d'identifiant de connexion.
  const user = isInternalEmail(identity) ? undefined : db.prepare(`
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
  response.clearCookie('sid', { httpOnly: true, sameSite: 'lax', path: `${basePath}/` });
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

// Lien d'invitation « rapide » : réutilise le code le plus récent de l'utilisateur encore valable
// plus de 7 jours, sinon en crée un de 30 jours.
app.post('/api/invites/link', requireUser, (request, response) => {
  const day = 24 * 60 * 60 * 1000;
  const select = db.prepare(`
    SELECT invite_codes.code, invite_codes.expires_at AS expiresAt,
      (SELECT COUNT(*) FROM invite_redemptions WHERE invite_redemptions.invite_code = invite_codes.code) AS redeemedCount
    FROM invite_codes
    WHERE invite_codes.created_by = ? AND invite_codes.expires_at > ?
    ORDER BY invite_codes.created_at DESC, invite_codes.rowid DESC LIMIT 1
  `);
  const invite = db.transaction(() => {
    const existing = select.get(request.user.id, new Date(Date.now() + 7 * day).toISOString());
    if (existing) return existing;
    const code = randomBytes(6).toString('hex').toUpperCase();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * day).toISOString();
    db.prepare('INSERT INTO invite_codes (code, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(code, request.user.id, createdAt, expiresAt);
    return { code, expiresAt, redeemedCount: 0 };
  })();
  response.json({ invite });
});

// Public : permet d'afficher « <pseudo> t'invite » avant l'inscription. Ne révèle que le pseudo de l'invitant.
app.get('/api/invites/:code', (request, response) => {
  const code = request.params.code.trim().toUpperCase();
  const invite = db.prepare(`
    SELECT users.username AS inviter FROM invite_codes
    LEFT JOIN users ON users.id = invite_codes.created_by
    WHERE invite_codes.code = ? AND invite_codes.expires_at > ?
  `).get(code, new Date().toISOString());
  response.json({ valid: Boolean(invite), inviter: invite?.inviter ?? null });
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

app.get('/api/leaderboard', requireUser, async (request, response) => {
  const requestedLimit = Number(request.query.limit ?? 8);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 8;
  if (banque) return response.json({ leaders: await classementBanque(limit) });
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

// Classement en mode banque : membres liés seulement, soldes lus en masse à la banque (sans
// « toucher »), repli sur le miroir local si elle ne répond pas.
async function classementBanque(limit) {
  const rows = db.prepare(`
    SELECT users.id, users.username, users.balance, users.created_at AS createdAt, comptes_banque.compte_id AS compteId,
      (SELECT COUNT(*) FROM bets JOIN markets ON markets.id = bets.market_id
       WHERE bets.user_id = users.id AND bets.choice_index = markets.outcome_index
         AND markets.status = 'resolved') AS wins,
      (SELECT COALESCE(SUM(amount), 0) FROM bets WHERE bets.user_id = users.id) AS volume,
      (SELECT COUNT(*) FROM bets WHERE bets.user_id = users.id) AS positions,
      (SELECT COALESCE(SUM(bets.amount), 0) FROM bets JOIN markets ON markets.id = bets.market_id
       WHERE bets.user_id = users.id AND markets.status = 'open') AS inPlay
    FROM users JOIN comptes_banque ON comptes_banque.user_id = users.id
  `).all();
  if (rows.length > 0) {
    try {
      const { status, data } = await banque.comptes(rows.map((row) => row.compteId));
      if (status === 200 && Array.isArray(data.comptes)) {
        const soldes = new Map(data.comptes.map((compte) => [compte.id, compte.solde]));
        for (const row of rows) {
          if (!soldes.has(row.compteId)) continue;
          row.balance = soldeMiroir(soldes.get(row.compteId));
          miroir(row.compteId, row.balance);
        }
      }
    } catch (error) {
      if (!(error instanceof BanqueIndisponible)) console.error(error);
    }
  }
  return rows
    .sort((first, second) => second.balance - first.balance || first.createdAt.localeCompare(second.createdAt))
    .slice(0, limit)
    .map(({ createdAt, compteId, ...leader }) => ({ ...leader, pnl: leader.balance + leader.inPlay - soldeDepartBanque }));
}

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

// Cote verrouillée au moment de l'ordre : (prises totales + nb d'issues) / (prises sur l'issue + 1).
function lockedOdds(marketId, choiceIndex, optionCount) {
  const pickCounts = db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN choice_index = ? THEN 1 ELSE 0 END) AS selected
    FROM bets WHERE market_id = ?
  `).get(choiceIndex, marketId);
  return Number(((pickCounts.total + optionCount) / ((pickCounts.selected ?? 0) + 1)).toFixed(2));
}

// Mise en mode banque : débit à la banque d'abord, puis transaction locale (une prise par marché,
// cote figée). Une réserve (essais = -1) est posée avant le débit : elle sert de verrou et, si la
// transaction locale échoue ou si le serveur s'arrête entre les deux, devient le crédit compensatoire.
async function miserViaBanque(request, response, market, optionCount, choiceIndex, amount) {
  const user = request.user;
  if (db.prepare('SELECT 1 FROM bets WHERE market_id = ? AND user_id = ?').get(market.id, user.id)) {
    return response.status(409).json({ error: 'Vous avez déjà une position sur ce marché.' });
  }
  const cleMise = `paris-mise-${market.id}-${user.compteId}`;
  const cleAnnule = `paris-annule-mise-${market.id}-${user.compteId}`;
  if (misesEnCours.has(cleAnnule)) return response.status(409).json({ error: 'Une mise est déjà en cours sur ce marché.' });
  misesEnCours.add(cleAnnule);
  try {
    const reserve = db.prepare('SELECT montant, essais FROM banque_en_attente WHERE cle = ?').get(cleAnnule);
    if (reserve && reserve.essais >= 0) return response.status(409).json({ error: erreurMiseAnnulee });
    if (reserve && reserve.montant !== amount) {
      return response.status(409).json({
        error: `Une mise de ${reserve.montant} jetons sur ce marché attend la confirmation du poker : réessayez avec ce montant, ou dans quelques minutes.`,
      });
    }
    if (!reserve) {
      db.prepare(`
        INSERT INTO banque_en_attente (cle, compte_id, montant, motif, cree_le, essais) VALUES (?, ?, ?, ?, ?, -1)
      `).run(cleAnnule, user.compteId, amount, `Paris : remboursement — ${market.title}`, new Date().toISOString());
    }
    const supprimerReserve = () => db.prepare('DELETE FROM banque_en_attente WHERE cle = ? AND essais = -1').run(cleAnnule);
    const activerReserve = () => db.prepare('UPDATE banque_en_attente SET essais = 0 WHERE cle = ? AND essais = -1').run(cleAnnule);

    let debit;
    try {
      debit = await banque.mouvement({
        compte: user.compteId, montant: -amount, motif: `Paris : mise — ${market.title}`, cle: cleMise,
      });
    } catch (error) {
      // Débit incertain : la réserve reste en place. Un nouvel essai du même montant réutilise la
      // même clé (sans double débit) ; sinon la réserve sera rendue au bout de quelques minutes.
      if (error instanceof BanqueIndisponible) {
        return response.status(503).json({ error: 'Le poker (banque des jetons) ne répond pas : mise non confirmée. Réessayez dans un instant.' });
      }
      throw error;
    }
    if (debit.status !== 200) {
      supprimerReserve();
      if (debit.status === 409 && debit.data.erreur === 'Solde insuffisant') {
        return response.status(400).json({ error: 'Solde insuffisant pour cette mise.' });
      }
      // « Clé déjà utilisée » : une mise antérieure a été débitée puis annulée.
      if (debit.status === 409) return response.status(409).json({ error: erreurMiseAnnulee });
      return response.status(debit.status === 400 ? 400 : 502).json({ error: debit.data.erreur ?? 'Mise refusée par la banque.' });
    }
    if (debit.data.deja_fait && !reserve) {
      // Débit déjà appliqué par une tentative antérieure qui n'a pas abouti : il est (ou sera) rendu.
      activerReserve();
      await viderFileBanque();
      return response.status(409).json({ error: erreurMiseAnnulee });
    }

    try {
      db.transaction(() => {
        if (db.prepare('SELECT 1 FROM bets WHERE market_id = ? AND user_id = ?').get(market.id, user.id)) {
          throw httpError(409, 'Vous avez déjà une position sur ce marché.');
        }
        db.prepare(`
          INSERT INTO bets (market_id, user_id, choice_index, amount, decimal_odds, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(market.id, user.id, choiceIndex, amount, lockedOdds(market.id, choiceIndex, optionCount), new Date().toISOString());
        supprimerReserve();
        // Pas de débit local : users.balance reflète le solde renvoyé par la banque.
        db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(soldeMiroir(debit.data.solde), user.id);
      })();
    } catch (error) {
      // La banque a débité mais la mise locale a échoué : crédit compensatoire (paris-annule-mise-…).
      activerReserve();
      await viderFileBanque();
      if (error.status) return response.status(error.status).json({ error: error.message });
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return response.status(409).json({ error: 'Vous avez déjà une position sur ce marché.' });
      console.error(error);
      return response.status(500).json({ error: 'Impossible de passer l’ordre.' });
    }
    response.json({ user: publicUser(db.prepare('SELECT id, username, balance FROM users WHERE id = ?').get(user.id)) });
  } finally {
    misesEnCours.delete(cleAnnule);
  }
}

app.post('/api/markets/:id/bets', requireUser, async (request, response) => {
  const choiceIndex = Number(request.body.choiceIndex);
  const amount = Number(request.body.amount);
  const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(request.params.id);
  if (!market) return response.status(404).json({ error: 'Marché introuvable.' });
  if (market.creator_id === request.user.id) {
    return response.status(403).json({ error: 'Vous avez créé ce marché : vous ne pouvez pas miser dessus, c’est vous qui le résolvez.' });
  }
  if (market.status !== 'open' || Date.parse(market.ends_at) <= Date.now()) {
    return response.status(400).json({ error: 'Ce marché n’accepte plus de prises.' });
  }
  const options = JSON.parse(market.options_json);
  if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex >= options.length) {
    return response.status(400).json({ error: 'Choisissez une des issues proposées.' });
  }
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100_000) {
    return response.status(400).json({ error: 'Misez un nombre entier de jetons entre 1 et 100 000.' });
  }
  if (banque) return miserViaBanque(request, response, market, options.length, choiceIndex, amount);

  try {
    db.transaction(() => {
      if (db.prepare('SELECT 1 FROM bets WHERE market_id = ? AND user_id = ?').get(market.id, request.user.id)) {
        throw Object.assign(new Error('Vous avez déjà une position sur ce marché.'), { status: 409 });
      }
      const decimalOdds = lockedOdds(market.id, choiceIndex, options.length);
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

// Paiement d'un gain ou d'un remboursement, appelé dans la transaction locale. En mode banque,
// le mouvement est mis en file (clé déterministe) puis envoyé après la transaction ; un membre
// jamais lié à la banque (mise d'avant le mode banque) est crédité localement, comme avant.
function payer(userId, montant, { cle, motif }) {
  const lien = banque && db.prepare('SELECT compte_id FROM comptes_banque WHERE user_id = ?').get(userId);
  if (lien) {
    mettreEnFile(`${cle}-${lien.compte_id}`, lien.compte_id, montant, motif);
    return true;
  }
  return db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(montant, userId).changes === 1;
}

app.post('/api/markets/:id/resolve', requireUser, async (request, response) => {
  const outcomeIndex = Number(request.body.outcomeIndex);
  const target = db.prepare('SELECT creator_id FROM markets WHERE id = ?').get(request.params.id);
  if (!target) return response.status(404).json({ error: 'Marché introuvable.' });
  // Seul le créateur résout son marché (en mode banque, un admin de la banque aussi).
  if (target.creator_id !== request.user.id && !(await estAdminBanque(request.user))) {
    return response.status(403).json({ error: 'Seul le créateur du marché peut le résoudre.' });
  }
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
      for (const winner of winners) {
        payer(winner.user_id, Math.floor(winner.amount * winner.decimal_odds), {
          cle: `paris-gain-${market.id}`, motif: `Paris : gain — ${market.title}`,
        });
      }
      resolvedTitle = market.title;
    })();
  } catch (error) {
    if (error.status) return response.status(error.status).json({ error: error.message });
    console.error(error);
    return response.status(500).json({ error: 'Impossible de résoudre ce marché.' });
  }
  await viderFileBanque();
  notifyPollResolved(request.params.id, resolvedTitle);
  response.json({ user: publicUser(db.prepare('SELECT id, username, balance FROM users WHERE id = ?').get(request.user.id)) });
});

app.post('/api/markets/:id/cancel', requireUser, async (request, response) => {
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
      const { title } = db.prepare('SELECT title FROM markets WHERE id = ?').get(market.id);
      for (const bet of bets) {
        if (!payer(bet.user_id, bet.amount, { cle: `paris-rembourse-${market.id}`, motif: `Paris : remboursement — ${title}` })) {
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
    await viderFileBanque();
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
  console.log(`${brand.name} API listening on http://localhost:${port}${banque ? ' (mode banque : jetons communs avec le poker)' : ''}`);
});

// File banque : rejouée au démarrage puis toutes les ~30 s jusqu'au succès. Au démarrage, aucune
// mise n'est en cours, donc toutes les réserves restantes sont orphelines.
if (banque) {
  activerReservesOrphelines(0);
  void viderFileBanque();
  setInterval(() => {
    activerReservesOrphelines(5 * 60_000);
    void viderFileBanque();
  }, relanceBanqueMs).unref();
}