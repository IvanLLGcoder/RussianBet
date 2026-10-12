// Inscription rapide par lien : e-mail facultatif (adresse interne non routable), mot de passe de
// 6 caractères minimum, lien d'invitation réutilisable et aperçu public. Même principe que
// api.test.js : le serveur tourne dans un processus enfant, sur une base temporaire.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import test, { after, before } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'duyka-invitation-test-'));
const databasePath = path.join(temporaryDirectory, 'test.sqlite');
const inviteCode = 'LIEN0001';
let serverProcess;
let baseUrl;
let serverOutput = '';

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
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  const token = response.headers.get('set-cookie')?.match(/sid=([^;]+)/)?.[1];
  return { status: response.status, data, cookie: token ? `sid=${token}` : cookie };
}

async function inscrire(username, password = 'secret6', extra = {}) {
  return call('/api/auth/register', { body: { username, password, inviteCode, ...extra } });
}

// État partagé entre les tests (ils s'exécutent dans l'ordre du fichier).
const state = {};

before(async () => {
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: databasePath,
      INITIAL_INVITE_CODE: inviteCode,
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
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

function lireBase(requete, ...parametres) {
  const base = new Database(databasePath, { readonly: true });
  try {
    return base.prepare(requete).all(...parametres);
  } finally {
    base.close();
  }
}

test('inscription sans e-mail puis connexion par nom', async () => {
  const inscription = await inscrire('alice');
  assert.equal(inscription.status, 201, JSON.stringify(inscription.data));
  assert.deepEqual(Object.keys(inscription.data.user).sort(), ['balance', 'id', 'username']);
  state.alice = inscription.cookie;

  const [ligne] = lireBase('SELECT email FROM users WHERE username = ?', 'alice');
  assert.match(ligne.email, /^alice\.[0-9a-f]{8}@sans-email\.invalid$/);

  const connexion = await call('/api/auth/login', { body: { identity: 'ALICE', password: 'secret6' } });
  assert.equal(connexion.status, 200, JSON.stringify(connexion.data));
  assert.equal(connexion.data.user.username, 'alice');

  const mauvais = await call('/api/auth/login', { body: { identity: 'alice', password: 'autre-mdp' } });
  assert.equal(mauvais.status, 401);

  // L'adresse interne n'est pas un identifiant de connexion.
  const parAdresseInterne = await call('/api/auth/login', { body: { identity: ligne.email, password: 'secret6' } });
  assert.equal(parAdresseInterne.status, 401);
});

test('deux inscriptions sans e-mail ne se heurtent pas à l’unicité', async () => {
  const bob = await inscrire('bob');
  const carol = await inscrire('carol');
  assert.equal(bob.status, 201, JSON.stringify(bob.data));
  assert.equal(carol.status, 201, JSON.stringify(carol.data));
  state.bob = bob.cookie;
  state.carol = carol.cookie;

  const emails = lireBase('SELECT email FROM users').map((ligne) => ligne.email);
  assert.equal(new Set(emails).size, emails.length);

  // Un nom déjà pris reste refusé proprement.
  const doublon = await inscrire('Alice');
  assert.equal(doublon.status, 409);
});

test('un e-mail fourni reste validé, et l’adresse interne ne peut pas être revendiquée', async () => {
  const invalide = await inscrire('dave', 'secret6', { email: 'pas-un-email' });
  assert.equal(invalide.status, 400);
  const usurpation = await inscrire('dave', 'secret6', { email: 'x@sans-email.invalid' });
  assert.equal(usurpation.status, 400);

  const valide = await inscrire('dave', 'secret6', { email: 'Dave@Example.test' });
  assert.equal(valide.status, 201, JSON.stringify(valide.data));
  const parEmail = await call('/api/auth/login', { body: { identity: 'dave@example.test', password: 'secret6' } });
  assert.equal(parEmail.status, 200);
  assert.equal(JSON.stringify(valide.data).includes('example.test'), false);
});

test('mot de passe : 6 caractères acceptés, 5 refusés', async () => {
  const court = await inscrire('court', '12345');
  assert.equal(court.status, 400);
  assert.match(court.data.error, /6 caractères/);
  const limite = await inscrire('limite', '123456');
  assert.equal(limite.status, 201, JSON.stringify(limite.data));
  const trop = await inscrire('trop_long', 'x'.repeat(129));
  assert.equal(trop.status, 400);
  const sansCode = await call('/api/auth/register', { body: { username: 'sans_code', password: 'secret6' } });
  assert.equal(sansCode.status, 400);
});

test('aucune réponse de l’API ne contient d’adresse e-mail', async () => {
  const { alice, bob } = state;
  const marche = await call('/api/markets', {
    cookie: alice,
    body: {
      title: 'Qui gagne le tournoi ?',
      description: '',
      category: 'Community',
      options: ['Alice', 'Bob'],
      endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
  });
  assert.equal(marche.status, 201, JSON.stringify(marche.data));
  const marketId = marche.data.id;
  assert.equal((await call(`/api/markets/${marketId}/bets`, { cookie: alice, body: { choiceIndex: 0, amount: 10 } })).status, 200);
  assert.equal((await call(`/api/markets/${marketId}/bets`, { cookie: bob, body: { choiceIndex: 1, amount: 20 } })).status, 200);
  assert.equal((await call(`/api/markets/${marketId}/comments`, { cookie: bob, body: { body: 'Allez Bob' } })).status, 201);

  const reponses = [
    await call('/api/me', { cookie: alice }),
    await call('/api/leaderboard', { cookie: alice }),
    await call('/api/activity', { cookie: alice }),
    await call('/api/markets', { cookie: alice }),
    await call(`/api/markets/${marketId}`, { cookie: alice }),
    await call('/api/invites', { cookie: alice }),
    await call('/api/invites/link', { cookie: alice, method: 'POST' }),
    await call(`/api/invites/${inviteCode}`),
  ];
  for (const reponse of reponses) {
    assert.equal(reponse.status, 200, JSON.stringify(reponse.data));
    const texte = JSON.stringify(reponse.data);
    assert.equal(texte.includes('sans-email'), false, texte);
    assert.equal(/@/.test(texte), false, texte);
    assert.equal('email' in (reponse.data.user ?? {}), false);
  }
});

test('POST /api/invites/link : idempotent, un seul code créé', async () => {
  const { alice, bob } = state;
  const sansSession = await call('/api/invites/link', { method: 'POST', body: {} });
  assert.equal(sansSession.status, 401);

  const premier = await call('/api/invites/link', { cookie: alice, method: 'POST' });
  const second = await call('/api/invites/link', { cookie: alice, method: 'POST' });
  assert.equal(premier.status, 200, JSON.stringify(premier.data));
  assert.match(premier.data.invite.code, /^[0-9A-F]{12}$/);
  assert.equal(premier.data.invite.redeemedCount, 0);
  assert.deepEqual(Object.keys(premier.data.invite).sort(), ['code', 'expiresAt', 'redeemedCount']);
  assert.deepEqual(second.data, premier.data);
  const dureeJours = (new Date(premier.data.invite.expiresAt).getTime() - Date.now()) / 86_400_000;
  assert.ok(dureeJours > 29.9 && dureeJours <= 30, `durée : ${dureeJours}`);

  const liste = await call('/api/invites', { cookie: alice });
  assert.equal(liste.data.invites.length, 1);

  // Chaque membre a son propre lien.
  const celuiDeBob = await call('/api/invites/link', { cookie: bob, method: 'POST' });
  assert.notEqual(celuiDeBob.data.invite.code, premier.data.invite.code);

  // Le lien sert à plusieurs personnes et le compteur suit.
  state.lien = premier.data.invite.code;
  for (const nom of ['ami_un', 'ami_deux']) {
    const ami = await inscrire(nom, 'secret6', { inviteCode: state.lien.toLowerCase() });
    assert.equal(ami.status, 201, JSON.stringify(ami.data));
  }
  const apres = await call('/api/invites/link', { cookie: alice, method: 'POST' });
  assert.equal(apres.data.invite.code, state.lien);
  assert.equal(apres.data.invite.redeemedCount, 2);
});

test('POST /api/invites/link : un code qui expire bientôt est remplacé', async () => {
  const eve = (await inscrire('eve')).cookie;
  const ancien = (await call('/api/invites/link', { cookie: eve, method: 'POST' })).data.invite.code;
  const base = new Database(databasePath);
  base.prepare('UPDATE invite_codes SET expires_at = ? WHERE code = ?')
    .run(new Date(Date.now() + 3 * 86_400_000).toISOString(), ancien);
  base.close();

  const nouveau = await call('/api/invites/link', { cookie: eve, method: 'POST' });
  assert.notEqual(nouveau.data.invite.code, ancien);
  const encore = await call('/api/invites/link', { cookie: eve, method: 'POST' });
  assert.equal(encore.data.invite.code, nouveau.data.invite.code);
  // L'ancien code (3 jours restants) reste utilisable.
  assert.equal((await call(`/api/invites/${ancien}`)).data.valid, true);
});

test('GET /api/invites/:code : valide, invalide et expiré (public)', async () => {
  const valide = await call(`/api/invites/${state.lien.toLowerCase()}`);
  assert.equal(valide.status, 200);
  assert.deepEqual(valide.data, { valid: true, inviter: 'alice' });

  // Code d'amorçage : valide mais sans invitant.
  assert.deepEqual((await call(`/api/invites/${inviteCode}`)).data, { valid: true, inviter: null });

  const inconnu = await call('/api/invites/AAAAAAAAAAAA');
  assert.equal(inconnu.status, 200);
  assert.deepEqual(inconnu.data, { valid: false, inviter: null });

  const base = new Database(databasePath);
  base.prepare('UPDATE invite_codes SET expires_at = ? WHERE code = ?')
    .run(new Date(Date.now() - 1000).toISOString(), state.lien);
  base.close();
  assert.deepEqual((await call(`/api/invites/${state.lien}`)).data, { valid: false, inviter: null });
  const inscriptionExpiree = await inscrire('trop_tard', 'secret6', { inviteCode: state.lien });
  assert.equal(inscriptionExpiree.status, 400);
});
