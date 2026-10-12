// Compatibilité ascendante : une base créée / migrée par le NOUVEAU serveur doit rester
// utilisable par l'ANCIEN serveur (commit 41d60ea), et inversement. C'est ce qui rend
// le retour arrière possible sans toucher à la base.
//
// L'ancien server/index.js est extrait de git, écrit dans un fichier temporaire du dossier
// server/ (pour que ses imports et sa racine `..` se résolvent), puis supprimé.
// Il ne lit pas brand.config.json (vérifié : c'est un ajout de la refonte).
// Sans l'objet git (clone superficiel), le test est sauté.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ANCIEN_COMMIT = '41d60ea';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inviteCode = 'COMPAT01';

function ancienServeurDisponible() {
  try {
    execFileSync('git', ['cat-file', '-e', `${ANCIEN_COMMIT}:server/index.js`], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function startServer(scriptPath, databasePath) {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [scriptPath], {
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
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  let ready = false;
  for (let attempt = 0; attempt < 80 && child.exitCode === null; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/me`)).ok) {
        ready = true;
        break;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!ready) {
    child.kill();
    assert.fail(`Le serveur ${path.basename(scriptPath)} n'a pas démarré. ${output}`);
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
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
  return { call, stop };
}

async function register(server, username) {
  const result = await server.call('/api/auth/register', {
    body: { username, email: `${username}@example.test`, password: 'mot-de-passe-solide', inviteCode },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.cookie;
}

function market(title, options, category = 'Community') {
  return {
    title,
    description: 'Créé pendant le test de compatibilité.',
    category,
    options,
    endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

test('l\'ancien serveur (41d60ea) sert une base créée par le nouveau, et réciproquement', async (t) => {
  if (!ancienServeurDisponible()) {
    t.skip(`objet git ${ANCIEN_COMMIT} indisponible (clone superficiel ?)`);
    return;
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'duyka-compat-test-'));
  const databasePath = path.join(temporaryDirectory, 'test.sqlite');
  const ancienScript = path.join(root, 'server', `ancien-index-${process.pid}.tmp.js`);
  const nouveauScript = path.join(root, 'server', 'index.js');
  const running = [];
  const launch = async (script) => {
    const server = await startServer(script, databasePath);
    running.push(server);
    return server;
  };

  try {
    fs.writeFileSync(ancienScript, execFileSync('git', ['show', `${ANCIEN_COMMIT}:server/index.js`], {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
    }));

    // 1. Le NOUVEAU serveur crée la base et y met des données, commentaire compris.
    const nouveau = await launch(nouveauScript);
    const alice = await register(nouveau, 'alice');
    const bob = await register(nouveau, 'bob');
    const binary = await nouveau.call('/api/markets', { cookie: alice, body: market('Le tournoi a-t-il lieu samedi ?', ['Oui', 'Non'], 'Sports') });
    const triple = await nouveau.call('/api/markets', { cookie: alice, body: market('Qui paie la tournée ?', ['Alice', 'Bob', 'Carol'], 'Culture') });
    assert.equal(binary.status, 201);
    assert.equal(triple.status, 201);
    assert.equal((await nouveau.call(`/api/markets/${binary.data.id}/bets`, { cookie: alice, body: { choiceIndex: 0, amount: 100 } })).status, 200);
    assert.equal((await nouveau.call(`/api/markets/${triple.data.id}/bets`, { cookie: bob, body: { choiceIndex: 2, amount: 30 } })).status, 200);
    assert.equal((await nouveau.call(`/api/markets/${binary.data.id}/comments`, { cookie: bob, body: { body: 'Pour moi, oui.' } })).status, 201);
    const avant = (await nouveau.call('/api/markets', { cookie: alice })).data.markets;
    assert.equal(avant.length, 2);
    await nouveau.stop();

    // 2. L'ANCIEN serveur démarre sur la même base, reconnaît les sessions et sert les marchés.
    const ancien = await launch(ancienScript);
    const moiAncien = await ancien.call('/api/me', { cookie: alice });
    assert.equal(moiAncien.data.user.username, 'alice');
    assert.equal(moiAncien.data.user.balance, 900);
    const vusParAncien = await ancien.call('/api/markets', { cookie: alice });
    assert.equal(vusParAncien.status, 200);
    assert.deepEqual(vusParAncien.data.markets.map((entry) => entry.id).sort(), avant.map((entry) => entry.id).sort());
    for (const entry of avant) {
      const vu = vusParAncien.data.markets.find((candidate) => candidate.id === entry.id);
      assert.equal(vu.title, entry.title);
      assert.equal(vu.category, entry.category);
      assert.deepEqual(vu.options, entry.options);
      assert.deepEqual(vu.optionStats, entry.optionStats);
      assert.equal(vu.totalStaked, entry.totalStaked);
    }
    assert.equal((await ancien.call('/api/leaderboard', { cookie: alice })).status, 200);

    // L'ancien serveur peut aussi écrire : une mise, un nouveau marché, un nouveau membre.
    assert.equal((await ancien.call(`/api/markets/${binary.data.id}/bets`, { cookie: bob, body: { choiceIndex: 1, amount: 25 } })).status, 200);
    const cree = await ancien.call('/api/markets', { cookie: bob, body: market('Marché créé par l\'ancienne version', ['Pour', 'Contre'], 'Technology') });
    assert.equal(cree.status, 201);
    await register(ancien, 'carol');
    await ancien.stop();

    // 3. Retour sur le NOUVEAU serveur : tout ce que l'ancien a écrit est visible, les commentaires aussi.
    const retour = await launch(nouveauScript);
    const marches = (await retour.call('/api/markets', { cookie: alice })).data.markets;
    assert.equal(marches.length, 3);
    const duAncien = marches.find((entry) => entry.id === cree.data.id);
    assert.equal(duAncien.category, 'Technology');
    assert.equal(duAncien.commentsCount, 0);
    const fiche = (await retour.call(`/api/markets/${binary.data.id}`, { cookie: alice })).data;
    assert.equal(fiche.history.length, 3, 'création + mise d\'alice + mise de bob (posée via l\'ancien serveur)');
    assert.deepEqual(fiche.holders[1], [{ username: 'bob', amount: 25, odds: 3, payout: 75 }]);
    assert.equal(fiche.comments.length, 1);
    assert.equal((await retour.call('/api/me', { cookie: bob })).data.user.balance, 1000 - 30 - 25);
    await retour.stop();

    // 4. Le script de vérification valide la base ainsi passée d'une version à l'autre.
    const verification = spawnSync(process.execPath, [path.join(root, 'scripts', 'verifier-base.js'), databasePath], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(verification.status, 0, verification.stdout + verification.stderr);
    assert.match(verification.stdout, /Membres\s+3\b/);
    assert.match(verification.stdout, /Marchés au total\s+3\b/);
    assert.match(verification.stdout, /Mises\s+3\b/);
    assert.match(verification.stdout, /Commentaires\s+1\b/);
  } finally {
    await Promise.all(running.map((server) => server.stop()));
    fs.rmSync(ancienScript, { force: true });
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
