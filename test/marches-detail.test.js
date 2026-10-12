// Nouvelles routes de la refonte : fiche marché, commentaires, fil d'activité,
// champs supplémentaires du classement. Même principe que api.test.js : le serveur
// tourne dans un processus enfant, sur une base temporaire.
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
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'duyka-detail-test-'));
const databasePath = path.join(temporaryDirectory, 'test.sqlite');
const inviteCode = 'DETAIL01';
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

async function register(username) {
  const result = await call('/api/auth/register', {
    body: { username, email: `${username}@example.test`, password: 'mot-de-passe-solide', inviteCode },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.cookie;
}

async function createMarket(cookie, title, options) {
  const result = await call('/api/markets', {
    cookie,
    body: {
      title,
      description: '',
      category: 'Community',
      options,
      endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data.id;
}

async function bet(cookie, marketId, choiceIndex, amount) {
  const result = await call(`/api/markets/${marketId}/bets`, { cookie, body: { choiceIndex, amount } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data.user;
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

  state.alice = await register('alice');
  state.bob = await register('bob');
  state.carol = await register('carol');
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    const exited = once(serverProcess, 'exit');
    serverProcess.kill();
    await exited;
  }
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('fiche marché : historique, détenteurs et activité cohérents avec les mises', async () => {
  const { alice, bob, carol } = state;
  state.marketId = await createMarket(alice, 'Qui gagne le tournoi de la bande ?', ['Alice', 'Bob', 'Carol']);
  const marketId = state.marketId;

  const empty = await call(`/api/markets/${marketId}`, { cookie: alice });
  assert.equal(empty.status, 200);
  assert.equal(empty.data.market.id, marketId);
  assert.equal(empty.data.history.length, 1);
  assert.equal(empty.data.history[0].t, empty.data.market.createdAt);
  for (const probability of empty.data.history[0].p) assert.ok(Math.abs(probability - 1 / 3) < 1e-9);
  assert.deepEqual(empty.data.activity, []);
  assert.deepEqual(empty.data.holders, [[], [], []]);
  assert.deepEqual(empty.data.comments, []);

  await bet(alice, marketId, 0, 100);
  await bet(bob, marketId, 0, 50);
  await bet(carol, marketId, 1, 200);

  const detail = await call(`/api/markets/${marketId}`, { cookie: bob });
  assert.equal(detail.status, 200);
  const { market, history, activity, holders } = detail.data;

  // Un point initial plus un point par mise, probabilités = (prises + 1) / (total + issues).
  assert.equal(history.length, 4);
  const expected = [[1 / 3, 1 / 3, 1 / 3], [2 / 4, 1 / 4, 1 / 4], [3 / 5, 1 / 5, 1 / 5], [3 / 6, 2 / 6, 1 / 6]];
  history.forEach((point, index) => {
    assert.equal(point.p.length, 3);
    point.p.forEach((value, option) => assert.ok(Math.abs(value - expected[index][option]) < 1e-9, `point ${index}`));
    assert.ok(Math.abs(point.p.reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
  });
  const times = history.map((point) => Date.parse(point.t));
  assert.deepEqual([...times].sort((first, second) => first - second), times);

  // Détenteurs : triés par mise décroissante, cote figée et gain potentiel.
  assert.deepEqual(holders[0], [
    { username: 'alice', amount: 100, odds: 3, payout: 300 },
    { username: 'bob', amount: 50, odds: 2, payout: 100 },
  ]);
  assert.deepEqual(holders[1], [{ username: 'carol', amount: 200, odds: 5, payout: 1000 }]);
  assert.deepEqual(holders[2], []);

  // Activité : la plus récente d'abord.
  assert.deepEqual(activity.map((entry) => entry.username), ['carol', 'bob', 'alice']);
  assert.deepEqual(activity.map((entry) => entry.choiceIndex), [1, 0, 0]);
  assert.deepEqual(activity.map((entry) => entry.amount), [200, 50, 100]);

  // Le résumé du marché reste cohérent avec la liste, et « myBet » dépend de l'appelant.
  assert.equal(market.bettorsCount, 3);
  assert.equal(market.totalStaked, 350);
  assert.deepEqual(market.optionStats.map((option) => option.count), [2, 1, 0]);
  assert.deepEqual(market.myBet, { choiceIndex: 0, amount: 50, odds: 2 });
  assert.equal(market.commentsCount, 0);
  const listed = (await call('/api/markets', { cookie: bob })).data.markets.find((entry) => entry.id === marketId);
  assert.deepEqual(listed.optionStats, market.optionStats);
});

test('fiche marché : 404 sur un id inconnu, 401 sans session', async () => {
  const unknown = await call('/api/markets/identifiant-inconnu', { cookie: state.alice });
  assert.equal(unknown.status, 404);
  const anonymous = await call(`/api/markets/${state.marketId}`);
  assert.equal(anonymous.status, 401);
});

test('commentaires : 201, validation 1 à 500 caractères, 401 sans session', async () => {
  const { alice, bob } = state;
  const endpoint = `/api/markets/${state.marketId}/comments`;

  const created = await call(endpoint, { cookie: alice, body: { body: '  Je sens le coup !  ' } });
  assert.equal(created.status, 201);
  assert.equal(created.data.comment.body, 'Je sens le coup !');
  assert.equal(created.data.comment.username, 'alice');
  assert.ok(Number.isInteger(created.data.comment.id));

  assert.equal((await call(endpoint, { cookie: alice, body: { body: '' } })).status, 400);
  assert.equal((await call(endpoint, { cookie: alice, body: { body: '   ' } })).status, 400);
  assert.equal((await call(endpoint, { cookie: alice, body: {} })).status, 400);
  assert.equal((await call(endpoint, { cookie: alice, body: { body: 42 } })).status, 400);
  assert.equal((await call(endpoint, { cookie: alice, body: { body: 'x'.repeat(501) } })).status, 400);
  assert.equal((await call(endpoint, { cookie: alice, body: { body: 'y'.repeat(500) } })).status, 201);
  assert.equal((await call(endpoint, { body: { body: 'anonyme' } })).status, 401);
  assert.equal((await call('/api/markets/inconnu/comments', { cookie: alice, body: { body: 'salut' } })).status, 404);

  // Un commentaire d'un membre sans position n'a pas d'issue associée.
  const lurker = await register('dave');
  assert.equal((await call(endpoint, { cookie: lurker, body: { body: 'Je regarde.' } })).status, 201);
  await call(endpoint, { cookie: bob, body: { body: 'Moi aussi !' } });

  const detail = await call(`/api/markets/${state.marketId}`, { cookie: alice });
  const { comments, market } = detail.data;
  assert.equal(comments.length, 4);
  assert.equal(market.commentsCount, 4);
  assert.deepEqual(comments.map((comment) => comment.username), ['bob', 'dave', 'alice', 'alice']);
  assert.equal(comments[0].choiceIndex, 0);
  assert.equal(comments[1].choiceIndex, null);
  assert.equal(comments[3].body, 'Je sens le coup !');
  const listed = (await call('/api/markets', { cookie: alice })).data.markets.find((entry) => entry.id === state.marketId);
  assert.equal(listed.commentsCount, 4);
});

test('/api/activity : prises de tous les marchés, plus récentes d\'abord', async () => {
  assert.equal((await call('/api/activity')).status, 401);

  const secondMarketId = await createMarket(state.alice, 'Alice mange-t-elle un kebab ce soir ?', ['Oui', 'Non']);
  state.secondMarketId = secondMarketId;
  await bet(state.alice, secondMarketId, 1, 40);

  const result = await call('/api/activity', { cookie: state.bob });
  assert.equal(result.status, 200);
  const { activity } = result.data;
  assert.equal(activity.length, 4);
  assert.deepEqual(activity[0], {
    id: activity[0].id,
    marketId: secondMarketId,
    choiceIndex: 1,
    amount: 40,
    odds: 2,
    createdAt: activity[0].createdAt,
    username: 'alice',
    marketTitle: 'Alice mange-t-elle un kebab ce soir ?',
    outcome: 'Non',
  });
  assert.equal(activity[1].marketId, state.marketId);
  assert.equal(activity[1].username, 'carol');
  assert.equal(activity[1].outcome, 'Bob');
  const ids = activity.map((entry) => entry.id);
  assert.deepEqual([...ids].sort((first, second) => second - first), ids);
});

test('classement : champs additionnels (volume, positions, inPlay, pnl)', async () => {
  // Alice a 100 sur le marché 1 (ouvert) et 40 sur le marché 2 ; on résout le marché 1 sur « Alice ».
  const resolved = await call(`/api/markets/${state.marketId}/resolve`, { cookie: state.alice, body: { outcomeIndex: 0 } });
  assert.equal(resolved.status, 200);

  const result = await call('/api/leaderboard', { cookie: state.alice });
  assert.equal(result.status, 200);
  const byName = Object.fromEntries(result.data.leaders.map((leader) => [leader.username, leader]));
  // Alice : 1000 - 100 + 300 - 40 ; Bob : 1000 - 50 + 100 ; Carol : 1000 - 200.
  assert.deepEqual(byName.alice, {
    id: byName.alice.id, username: 'alice', balance: 1160, wins: 1,
    volume: 140, positions: 2, inPlay: 40, pnl: 200,
  });
  assert.deepEqual(byName.bob, {
    id: byName.bob.id, username: 'bob', balance: 1050, wins: 1,
    volume: 50, positions: 1, inPlay: 0, pnl: 50,
  });
  assert.deepEqual(byName.carol, {
    id: byName.carol.id, username: 'carol', balance: 800, wins: 0,
    volume: 200, positions: 1, inPlay: 0, pnl: -200,
  });
  assert.deepEqual(byName.dave, {
    id: byName.dave.id, username: 'dave', balance: 1000, wins: 0,
    volume: 0, positions: 0, inPlay: 0, pnl: 0,
  });
  assert.deepEqual(result.data.leaders.slice(0, 3).map((leader) => leader.username), ['alice', 'bob', 'dave']);

  const detail = await call(`/api/markets/${state.marketId}`, { cookie: state.alice });
  assert.equal(detail.data.market.status, 'resolved');
  assert.equal(detail.data.market.outcomeIndex, 0);
});

test('classement : paramètre limit et plafond de 30 entrées pour /api/activity', async () => {
  // Ajoute 40 membres et 40 prises directement en base pour dépasser les plafonds.
  const database = new Database(databasePath);
  const insertUser = database.prepare(`
    INSERT INTO users (username, email, password_hash, balance, created_at) VALUES (?, ?, 'x', 1000, ?)
  `);
  const insertBet = database.prepare(`
    INSERT INTO bets (market_id, user_id, choice_index, amount, decimal_odds, created_at) VALUES (?, ?, 0, 1, 2, ?)
  `);
  database.transaction(() => {
    for (let index = 0; index < 40; index += 1) {
      const stamp = new Date(Date.now() + 60_000 + index * 1000).toISOString();
      const userId = Number(insertUser.run(`bot${index}`, `bot${index}@example.test`, stamp).lastInsertRowid);
      insertBet.run(state.secondMarketId, userId, stamp);
    }
  })();
  database.close();

  const names = async (query) => (await call(`/api/leaderboard${query}`, { cookie: state.alice })).data.leaders.length;
  assert.equal(await names(''), 8);
  assert.equal(await names('?limit=3'), 3);
  assert.equal(await names('?limit=0'), 1);
  assert.equal(await names('?limit=-5'), 1);
  assert.equal(await names('?limit=abc'), 8);
  assert.equal(await names('?limit=2.5'), 8);
  assert.equal(await names('?limit=1000'), 44);

  const activity = await call('/api/activity', { cookie: state.alice });
  assert.equal(activity.data.activity.length, 30);
  assert.equal(activity.data.activity[0].username, 'bot39');
});
