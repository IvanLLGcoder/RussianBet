// Mode banque (économie commune avec le poker) : le serveur paris tourne dans un processus enfant,
// branché sur une fausse banque en mémoire (test/aides/fausse-banque.js) qui suit le contrat.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import test, { after, before } from 'node:test';
import { demarrerFausseBanque } from './aides/fausse-banque.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'duyka-banque-test-'));
const databasePath = path.join(temporaryDirectory, 'test.sqlite');
const inviteCode = 'BANQUE01';
let serverProcess;
let baseUrl;
let serverOutput = '';
let banque;

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function call(endpoint, { body, cookie, method } = {}) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  const token = response.headers.get('set-cookie')?.match(/sid=([^;]+)/)?.[1];
  return { status: response.status, data, cookie: token ? `sid=${token}` : cookie };
}

function base() {
  return new Database(databasePath);
}

function lire(requete, ...parametres) {
  const db = base();
  try {
    return db.prepare(requete).all(...parametres);
  } finally {
    db.close();
  }
}

function ecrire(requete, ...parametres) {
  const db = base();
  try {
    return db.prepare(requete).run(...parametres);
  } finally {
    db.close();
  }
}

function compteDe(username) {
  return lire(`
    SELECT comptes_banque.compte_id AS id FROM comptes_banque JOIN users ON users.id = comptes_banque.user_id
    WHERE users.username = ?
  `, username)[0]?.id;
}

// Ancien compte local (d'avant le mode banque), créé directement en base.
function ancienCompte(username, password, balance = 1000) {
  return Number(ecrire(`
    INSERT INTO users (username, email, password_hash, balance, created_at) VALUES (?, ?, ?, ?, ?)
  `, username, `${username}@example.test`, bcrypt.hashSync(password, 4), balance, new Date().toISOString()).lastInsertRowid);
}

async function attendre(condition, message) {
  for (let essai = 0; essai < 100; essai += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

async function creerMarche(cookie, title) {
  const result = await call('/api/markets', {
    cookie,
    body: {
      title, description: '', category: 'Community', options: ['Oui', 'Non'],
      endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data.id;
}

const state = {};

before(async () => {
  banque = await demarrerFausseBanque();
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: databasePath,
      INITIAL_INVITE_CODE: inviteCode,
      BANQUE_URL: banque.url,
      BANQUE_SECRET: banque.secret,
      BANQUE_RELANCE_MS: '150',
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: '',
      VAPID_SUBJECT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (chunk) => { serverOutput += chunk; });
  serverProcess.stderr.on('data', (chunk) => { serverOutput += chunk; });

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (serverProcess.exitCode !== null) break;
    try {
      if ((await fetch(`${baseUrl}/api/me`)).ok) {
        ready = true;
        break;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(ready, true, `Le serveur n'a pas démarré. ${serverOutput}`);
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    const exited = once(serverProcess, 'exit');
    serverProcess.kill();
    await exited;
  }
  await banque?.fermer();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('visiteur : /api/me annonce le mode banque et le solde de départ', async () => {
  const moi = await call('/api/me');
  assert.equal(moi.status, 200);
  assert.deepEqual(moi.data, { user: null, banque: true, connexionPoker: false, soldeDepart: 10_000, admin: false, verse: [] });
});

test('inscription par lien : compte créé à la banque, parrain transmis, ligne locale liée', async () => {
  const cesar = await call('/api/auth/register', { body: { username: 'César D.', password: 'motdepasse1', inviteCode } });
  assert.equal(cesar.status, 201, JSON.stringify(cesar.data));
  assert.equal(cesar.data.user.username, 'César D.');
  assert.equal(cesar.data.user.balance, 10_000);
  state.cesar = cesar.cookie;
  const compteCesar = banque.parNom('César D.');
  assert.equal(compteCesar.parrain, null);
  assert.equal(compteDe('César D.'), compteCesar.id);

  // E-mail interne, et le mot de passe local ne permet pas de contourner la banque.
  const [ligne] = lire('SELECT email, password_hash FROM users WHERE username = ?', 'César D.');
  assert.match(ligne.email, /@sans-email\.invalid$/);
  assert.equal(bcrypt.compareSync('motdepasse1', ligne.password_hash), false);

  // L'invité de César a César pour parrain à la banque.
  const lien = await call('/api/invites/link', { cookie: state.cesar, method: 'POST' });
  const zoe = await call('/api/auth/register', { body: { username: 'Zoé', password: 'motdepasse2', inviteCode: lien.data.invite.code } });
  assert.equal(zoe.status, 201, JSON.stringify(zoe.data));
  state.zoe = zoe.cookie;
  assert.equal(banque.parNom('Zoé').parrain, compteCesar.id);
  assert.equal(lire('SELECT COUNT(*) AS n FROM invite_redemptions WHERE invite_code = ?', lien.data.invite.code)[0].n, 1);

  // Règles et erreurs de la banque, affichées telles quelles.
  const pris = await call('/api/auth/register', { body: { username: 'césar d.', password: 'motdepasse3', inviteCode } });
  assert.equal(pris.status, 409);
  assert.equal(pris.data.error, 'Ce pseudo est déjà pris');
  const court = await call('/api/auth/register', { body: { username: 'Nina', password: 'court12', inviteCode } });
  assert.equal(court.status, 400);
  assert.match(court.data.error, /8 caractères/);
  const sansCode = await call('/api/auth/register', { body: { username: 'Nina', password: 'motdepasse4', inviteCode: 'INCONNU1' } });
  assert.equal(sansCode.status, 400);
  assert.equal(banque.parNom('Nina'), undefined);
});

test('connexion : compte poker existant → ligne locale créée puis retrouvée', async () => {
  const compte = banque.creer('Éloïse.B', 'pokerpoker');
  const premiere = await call('/api/auth/login', { body: { identity: 'Éloïse.B', password: 'pokerpoker' } });
  assert.equal(premiere.status, 200, JSON.stringify(premiere.data));
  assert.equal(premiere.data.user.username, 'Éloïse.B');
  assert.equal(premiere.data.user.balance, 10_000);
  const seconde = await call('/api/auth/login', { body: { identity: 'éloïse.b', password: 'pokerpoker' } });
  assert.equal(seconde.data.user.id, premiere.data.user.id);
  assert.equal(compteDe('Éloïse.B'), compte.id);
  state.eloise = seconde.cookie;

  const mauvais = await call('/api/auth/login', { body: { identity: 'Éloïse.B', password: 'mauvais-mdp' } });
  assert.equal(mauvais.status, 401);
});

test('connexion : un ancien compte local non lié de même nom → suffixe pour le compte poker', async () => {
  const ancienId = ancienCompte('marc', 'ancienmdp1');
  banque.creer('Marc', 'pokermarc1');
  const connexion = await call('/api/auth/login', { body: { identity: 'Marc', password: 'pokermarc1' } });
  assert.equal(connexion.status, 200, JSON.stringify(connexion.data));
  assert.equal(connexion.data.user.username, 'Marc-2');
  assert.notEqual(connexion.data.user.id, ancienId);
  assert.equal(lire('SELECT 1 FROM comptes_banque WHERE user_id = ?', ancienId).length, 0);

  // L'ancien « marc » essaie de migrer : le nom est déjà pris au poker → erreur claire.
  const migration = await call('/api/auth/login', { body: { identity: 'marc', password: 'ancienmdp1' } });
  assert.equal(migration.status, 409);
  assert.match(migration.data.error, /existe déjà au poker/);

  // Une session locale d'avant le mode banque (compte non lié) ne suffit plus.
  const token = randomBytes(32).toString('hex');
  ecrire('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    createHash('sha256').update(token).digest('hex'), ancienId, new Date(Date.now() + 60_000).toISOString());
  assert.equal((await call('/api/me', { cookie: `sid=${token}` })).data.user, null);
});

test('migration d\'un ancien compte local : création à la banque avec le même nom et mot de passe', async () => {
  const ancienId = ancienCompte('paul', 'ancienmdp2', 1234);
  const connexion = await call('/api/auth/login', { body: { identity: 'paul@example.test', password: 'ancienmdp2' } });
  assert.equal(connexion.status, 200, JSON.stringify(connexion.data));
  assert.equal(connexion.data.user.id, ancienId, 'la ligne locale (et son historique) est conservée');
  assert.equal(connexion.data.user.balance, 10_000);
  const compte = banque.parNom('paul');
  assert.equal(compte.mdp, 'ancienmdp2');
  assert.equal(compteDe('paul'), compte.id);

  // Ensuite, la connexion passe directement par la banque.
  const ensuite = await call('/api/auth/login', { body: { identity: 'paul', password: 'ancienmdp2' } });
  assert.equal(ensuite.status, 200);
  assert.equal(ensuite.data.user.id, ancienId);
  assert.equal(lire('SELECT COUNT(*) AS n FROM users WHERE username LIKE ?', 'paul%')[0].n, 1);
});

test('/api/me : touche le compte, transmet `verse` et met à jour le miroir', async () => {
  const id = compteDe('César D.');
  banque.programmerVersement(id, 'Allocation du jour', 250);
  const moi = await call('/api/me', { cookie: state.cesar });
  assert.equal(moi.status, 200);
  assert.deepEqual(moi.data.verse, [{ motif: 'Allocation du jour', montant: 250 }]);
  assert.equal(moi.data.user.balance, 10_250);
  assert.equal(moi.data.banque, true);
  assert.equal(lire('SELECT balance FROM users WHERE username = ?', 'César D.')[0].balance, 10_250);
  const encore = await call('/api/me', { cookie: state.cesar });
  assert.deepEqual(encore.data.verse, []);
});

test('mise : débit à la banque puis mise locale', async () => {
  state.marche = await creerMarche(state.zoe, 'Zoé finit-elle le marathon ?');
  const cle = `paris-mise-${state.marche}-${compteDe('César D.')}`;

  const mise = await call(`/api/markets/${state.marche}/bets`, { cookie: state.cesar, body: { choiceIndex: 0, amount: 300 } });
  assert.equal(mise.status, 200, JSON.stringify(mise.data));
  assert.equal(mise.data.user.balance, 9950);
  assert.deepEqual(banque.mouvements.get(cle), { compte: compteDe('César D.'), montant: -300, motif: 'Paris : mise — Zoé finit-elle le marathon ?' });
  assert.equal(banque.comptes.get(compteDe('César D.')).solde, 9950);
  assert.equal(lire('SELECT balance FROM users WHERE username = ?', 'César D.')[0].balance, 9950, 'pas de double débit local');
  assert.equal(lire('SELECT COUNT(*) AS n FROM banque_en_attente')[0].n, 0);

  const doublon = await call(`/api/markets/${state.marche}/bets`, { cookie: state.cesar, body: { choiceIndex: 1, amount: 10 } });
  assert.equal(doublon.status, 409);
});

test('mise : solde insuffisant à la banque', async () => {
  const refus = await call(`/api/markets/${state.marche}/bets`, { cookie: state.eloise, body: { choiceIndex: 1, amount: 20_000 } });
  assert.equal(refus.status, 400);
  assert.equal(refus.data.error, 'Solde insuffisant pour cette mise.');
  assert.equal(lire('SELECT COUNT(*) AS n FROM bets WHERE market_id = ?', state.marche)[0].n, 1);
  assert.equal(lire('SELECT COUNT(*) AS n FROM banque_en_attente')[0].n, 0);
});

test('mise : échec local après le débit → crédit compensatoire', async () => {
  const marche = await creerMarche(state.zoe, 'La transaction locale échoue-t-elle ?');
  const id = compteDe('Éloïse.B');
  const avant = banque.comptes.get(id).solde;
  ecrire(`CREATE TRIGGER refuse_777 BEFORE INSERT ON bets WHEN NEW.amount = 777 BEGIN SELECT RAISE(ABORT, 'refus de test'); END`);
  try {
    const echec = await call(`/api/markets/${marche}/bets`, { cookie: state.eloise, body: { choiceIndex: 0, amount: 777 } });
    assert.equal(echec.status, 500);
  } finally {
    ecrire('DROP TRIGGER refuse_777');
  }
  await attendre(() => banque.mouvements.has(`paris-annule-mise-${marche}-${id}`), 'crédit compensatoire jamais envoyé');
  assert.equal(banque.comptes.get(id).solde, avant);
  assert.equal(banque.mouvements.get(`paris-annule-mise-${marche}-${id}`).montant, 777);
  await attendre(() => lire('SELECT COUNT(*) AS n FROM banque_en_attente')[0].n === 0, 'file non vidée');

  // La clé de mise est consommée : une nouvelle mise sur ce marché est refusée, sans débit.
  const nouvelle = await call(`/api/markets/${marche}/bets`, { cookie: state.eloise, body: { choiceIndex: 0, amount: 777 } });
  assert.equal(nouvelle.status, 409);
  assert.equal(banque.comptes.get(id).solde, avant);
});

test('résolution : réservée au créateur ; gains en file, rejoués après une panne, sans double paiement', async () => {
  const refus = await call(`/api/markets/${state.marche}/resolve`, { cookie: state.cesar, body: { outcomeIndex: 0 } });
  assert.equal(refus.status, 403);

  const id = compteDe('César D.');
  const cle = `paris-gain-${state.marche}-${id}`;
  banque.etat.panne = true;
  const resolu = await call(`/api/markets/${state.marche}/resolve`, { cookie: state.zoe, body: { outcomeIndex: 0 } });
  assert.equal(resolu.status, 200, JSON.stringify(resolu.data));
  const [enAttente] = lire('SELECT * FROM banque_en_attente WHERE cle = ?', cle);
  assert.equal(enAttente.montant, 600);
  assert.equal(enAttente.motif, 'Paris : gain — Zoé finit-elle le marathon ?');
  assert.ok(enAttente.essais >= 1);
  assert.equal(banque.comptes.get(id).solde, 9950);

  // La banque revient mais la réponse du premier envoi se perd : le rejeu ne paie pas deux fois.
  banque.etat.appliquerPuisCouper = 1;
  banque.etat.panne = false;
  await attendre(() => lire('SELECT COUNT(*) AS n FROM banque_en_attente WHERE cle = ?', cle)[0].n === 0, 'gain jamais confirmé');
  assert.equal(banque.journal.filter((entry) => entry.cle === cle).length, 1);
  assert.equal(banque.comptes.get(id).solde, 10_550);
  await attendre(() => lire('SELECT balance FROM users WHERE username = ?', 'César D.')[0].balance === 10_550, 'miroir non mis à jour');
});

test('annulation : remboursements envoyés à la banque', async () => {
  const marche = await creerMarche(state.zoe, 'Ce marché sera-t-il annulé ?');
  const id = compteDe('Éloïse.B');
  const avant = banque.comptes.get(id).solde;
  assert.equal((await call(`/api/markets/${marche}/bets`, { cookie: state.eloise, body: { choiceIndex: 1, amount: 100 } })).status, 200);
  assert.equal(banque.comptes.get(id).solde, avant - 100);
  const annule = await call(`/api/markets/${marche}/cancel`, { cookie: state.zoe, method: 'POST' });
  assert.equal(annule.status, 200);
  assert.equal(banque.comptes.get(id).solde, avant);
  assert.equal(banque.mouvements.get(`paris-rembourse-${marche}-${id}`).motif, 'Paris : remboursement — Ce marché sera-t-il annulé ?');
});

test('banque injoignable : repli sur le miroir, mise non confirmée puis reprise sans double débit', async () => {
  const marche = await creerMarche(state.zoe, 'La banque tombe-t-elle en panne ?');
  const id = compteDe('César D.');
  banque.etat.panne = true;
  try {
    const moi = await call('/api/me', { cookie: state.cesar });
    assert.equal(moi.status, 200);
    assert.equal(moi.data.user.balance, 10_550);
    assert.deepEqual(moi.data.verse, []);
    const classement = await call('/api/leaderboard', { cookie: state.cesar });
    assert.equal(classement.status, 200);
    assert.equal(classement.data.leaders.find((leader) => leader.username === 'César D.').balance, 10_550);
    const connexion = await call('/api/auth/login', { body: { identity: 'Zoé', password: 'motdepasse2' } });
    assert.equal(connexion.status, 503);
    assert.match(connexion.data.error, /ne répond pas/);

    const mise = await call(`/api/markets/${marche}/bets`, { cookie: state.cesar, body: { choiceIndex: 0, amount: 50 } });
    assert.equal(mise.status, 503);
    assert.equal(lire('SELECT essais FROM banque_en_attente WHERE cle = ?', `paris-annule-mise-${marche}-${id}`)[0].essais, -1);
  } finally {
    banque.etat.panne = false;
  }
  // Même montant : la réserve est réutilisée, la mise passe et la clé n'est débitée qu'une fois.
  const reprise = await call(`/api/markets/${marche}/bets`, { cookie: state.cesar, body: { choiceIndex: 0, amount: 50 } });
  assert.equal(reprise.status, 200, JSON.stringify(reprise.data));
  assert.equal(banque.comptes.get(id).solde, 10_500);
  assert.equal(lire('SELECT COUNT(*) AS n FROM banque_en_attente')[0].n, 0);
});

test('débit déjà appliqué par une tentative perdue : refus et remboursement', async () => {
  const marche = await creerMarche(state.zoe, 'Une mise fantôme est-elle rendue ?');
  const id = compteDe('paul');
  const avant = banque.comptes.get(id).solde;
  // Simule un débit appliqué à la banque sans trace locale (réserve perdue).
  banque.mouvements.set(`paris-mise-${marche}-${id}`, { compte: id, montant: -40, motif: 'Paris : mise — fantôme' });
  banque.comptes.get(id).solde -= 40;
  const paul = await call('/api/auth/login', { body: { identity: 'paul', password: 'ancienmdp2' } });
  const mise = await call(`/api/markets/${marche}/bets`, { cookie: paul.cookie, body: { choiceIndex: 0, amount: 40 } });
  assert.equal(mise.status, 409);
  await attendre(() => banque.comptes.get(id).solde === avant, 'mise fantôme non rendue');
  assert.equal(lire('SELECT COUNT(*) AS n FROM bets WHERE market_id = ?', marche)[0].n, 0);
});

test('classement : soldes lus à la banque, membres liés seulement ; un admin banque peut résoudre', async () => {
  banque.comptes.get(compteDe('Éloïse.B')).solde = 77_777;
  const classement = await call('/api/leaderboard?limit=100', { cookie: state.zoe });
  assert.equal(classement.status, 200);
  const premier = classement.data.leaders[0];
  assert.deepEqual(Object.keys(premier).sort(), ['balance', 'id', 'inPlay', 'pnl', 'positions', 'username', 'volume', 'wins']);
  assert.equal(premier.username, 'Éloïse.B');
  assert.equal(premier.balance, 77_777);
  assert.equal(premier.pnl, 77_777 + premier.inPlay - 10_000);
  assert.equal(classement.data.leaders.some((leader) => leader.username === 'marc'), false);
  assert.equal(lire('SELECT balance FROM users WHERE username = ?', 'Éloïse.B')[0].balance, 77_777);

  const marche = await creerMarche(state.zoe, 'Un admin peut-il résoudre ce marché ?');
  assert.equal((await call(`/api/markets/${marche}/resolve`, { cookie: state.eloise, body: { outcomeIndex: 0 } })).status, 403);
  banque.comptes.get(compteDe('Éloïse.B')).admin = true;
  assert.equal((await call('/api/me', { cookie: state.eloise })).data.admin, true);
  assert.equal((await call(`/api/markets/${marche}/resolve`, { cookie: state.eloise, body: { outcomeIndex: 0 } })).status, 200);
});

test('le créateur peut miser sur son propre marché', async () => {
  const marche = await creerMarche(state.zoe, 'Le créateur peut-il miser ici ?');
  const mise = await call(`/api/markets/${marche}/bets`, { cookie: state.zoe, body: { choiceIndex: 0, amount: 10 } });
  assert.equal(mise.status, 200, JSON.stringify(mise.data));
});
