// Tests de scripts/verifier-base.js : lecture seule, détection des problèmes, code de sortie.
// Le serveur démarre une fois pour créer le schéma complet ; la base obtenue sert de modèle
// (copiée pour chaque test, car certains tests l'abîment volontairement).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import test, { after, before } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'verifier-base.js');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'duyka-verifier-test-'));
const templatePath = path.join(temporaryDirectory, 'modele.sqlite');

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

function copyTemplate(name) {
  const target = path.join(temporaryDirectory, `${name}.sqlite`);
  fs.copyFileSync(templatePath, target);
  return target;
}

function verify(...args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
}

const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

before(async () => {
  // 1. Le serveur crée le schéma complet, puis on le tue.
  const port = await availablePort();
  const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: templatePath,
      INITIAL_INVITE_CODE: 'VERIF001',
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: '',
      VAPID_SUBJECT: '',
    },
    stdio: 'ignore',
  });
  let ready = false;
  for (let attempt = 0; attempt < 60 && child.exitCode === null; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/me`)).ok) {
        ready = true;
        break;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  assert.equal(ready, true, 'Le serveur n\'a pas démarré.');

  // 2. Quelques données, puis la base est ramenée à un seul fichier (hors mode WAL).
  const database = new Database(templatePath);
  const stamp = new Date().toISOString();
  const addUser = database.prepare(`
    INSERT INTO users (username, email, password_hash, balance, created_at) VALUES (?, ?, 'x', ?, ?)
  `);
  const alice = Number(addUser.run('alice', 'alice@example.test', 900, stamp).lastInsertRowid);
  const bob = Number(addUser.run('bob', 'bob@example.test', 1100, stamp).lastInsertRowid);
  const addMarket = database.prepare(`
    INSERT INTO markets (id, title, description, category, options_json, outcome_index, status, ends_at, created_at, creator_id, cancelled_at)
    VALUES (?, ?, '', 'Community', '["Oui","Non"]', ?, ?, ?, ?, ?, ?)
  `);
  addMarket.run('m-ouvert', 'Marché ouvert pour le test', null, 'open', stamp, stamp, alice, null);
  addMarket.run('m-resolu', 'Marché résolu pour le test', 0, 'resolved', stamp, stamp, alice, null);
  addMarket.run('m-annule', 'Marché annulé pour le test', null, 'resolved', stamp, stamp, bob, stamp);
  database.prepare(`
    INSERT INTO bets (market_id, user_id, choice_index, amount, decimal_odds, created_at) VALUES ('m-ouvert', ?, 0, 100, 2, ?)
  `).run(alice, stamp);
  database.prepare(`
    INSERT INTO market_comments (market_id, user_id, body, created_at) VALUES ('m-ouvert', ?, 'Salut', ?)
  `).run(bob, stamp);
  database.pragma('wal_checkpoint(TRUNCATE)');
  database.pragma('journal_mode = DELETE');
  database.close();
});

after(() => {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('base saine : code 0, totaux affichés et base inchangée (lecture seule)', () => {
  const base = copyTemplate('saine');
  const before = sha(base);
  const result = verify(base);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /RÉSULTAT : OK/);
  assert.match(result.stdout, /Membres\s+2\b/);
  assert.match(result.stdout, /Somme des soldes\s+2000\b/);
  assert.match(result.stdout, /Marchés ouverts\s+1\b/);
  assert.match(result.stdout, /Marchés résolus\s+1\b/);
  assert.match(result.stdout, /Marchés annulés\s+1\b/);
  assert.match(result.stdout, /Mises\s+1\b/);
  assert.match(result.stdout, /Commentaires\s+1\b/);
  assert.doesNotMatch(result.stdout, /Avertissements/);
  assert.equal(sha(base), before);
  assert.deepEqual(fs.readdirSync(temporaryDirectory).filter((name) => name.startsWith('saine')), ['saine.sqlite']);
});

test('base issue de l\'ancienne version : avertissements non bloquants, bloquants avec --strict', () => {
  const base = copyTemplate('ancienne');
  const database = new Database(base);
  database.exec('DROP TABLE market_comments; DROP INDEX idx_bets_created;');
  database.close();

  const tolerant = verify(base);
  assert.equal(tolerant.status, 0, tolerant.stdout + tolerant.stderr);
  assert.match(tolerant.stdout, /Avertissements/);
  assert.match(tolerant.stdout, /Table manquante : market_comments/);
  assert.match(tolerant.stdout, /Index manquant : idx_bets_created/);

  const strict = verify(base, '--strict');
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /RÉSULTAT : ÉCHEC/);
});

test('table indispensable manquante : code 1', () => {
  const base = copyTemplate('sans-sessions');
  const database = new Database(base);
  database.exec('DROP TABLE sessions');
  database.close();
  const result = verify(base);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Table manquante : sessions/);
});

test('violation de clé étrangère et mise sur une issue inexistante : code 1', () => {
  const base = copyTemplate('incoherente');
  const database = new Database(base);
  database.pragma('foreign_keys = OFF');
  const stamp = new Date().toISOString();
  database.prepare(`
    INSERT INTO bets (market_id, user_id, choice_index, amount, decimal_odds, created_at) VALUES ('fantome', 1, 0, 5, 2, ?)
  `).run(stamp);
  database.prepare(`
    INSERT INTO bets (market_id, user_id, choice_index, amount, decimal_odds, created_at) VALUES ('m-resolu', 1, 7, 5, 2, ?)
  `).run(stamp);
  database.close();
  const result = verify(base);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /foreign_key_check : 1 violation/);
  assert.match(result.stdout, /1 mise\(s\) sur une issue qui n'existe pas/);
});

test('fichier corrompu : code non nul', () => {
  const base = path.join(temporaryDirectory, 'corrompue.sqlite');
  fs.writeFileSync(base, 'ceci n\'est pas une base SQLite, '.repeat(200));
  const result = verify(base);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /RÉSULTAT : ÉCHEC/);
});

test('mauvaise utilisation : code 2 sans argument ou avec un fichier inexistant', () => {
  assert.equal(verify().status, 2);
  assert.equal(verify(path.join(temporaryDirectory, 'nexiste-pas.sqlite')).status, 2);
});
