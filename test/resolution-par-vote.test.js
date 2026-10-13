// Résolution par vote : une fois les prises closes, 3 joueurs qui donnent la même réponse
// résolvent le marché, par le même chemin que la résolution du créateur (gains, file banque).
// Le scénario tourne deux fois : en autonome et en mode banque (fausse banque en mémoire).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import test, { after, describe, before } from 'node:test';
import { demarrerFausseBanque } from './aides/fausse-banque.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inviteCode = 'VOTE0001';

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function attendre(condition, message) {
  for (let essai = 0; essai < 100; essai += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

async function demarrerServeur(databasePath, extraEnv) {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: databasePath,
      INITIAL_INVITE_CODE: inviteCode,
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: '',
      VAPID_SUBJECT: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  let ready = false;
  for (let attempt = 0; attempt < 60 && child.exitCode === null; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/me`)).ok) {
        ready = true;
        break;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(ready, true, `Le serveur n'a pas démarré. ${output}`);

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

function scenario(mode) {
  const enBanque = mode === 'banque';
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `duyka-vote-${mode}-`));
  const databasePath = path.join(temporaryDirectory, 'test.sqlite');
  const s = {};

  function lire(requete, ...parametres) {
    const db = new Database(databasePath);
    try {
      return db.prepare(requete).all(...parametres);
    } finally {
      db.close();
    }
  }

  // Clôture un marché sans attendre : on recule sa date de fin en base.
  function cloturer(marketId) {
    const db = new Database(databasePath);
    try {
      db.prepare('UPDATE markets SET ends_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), marketId);
    } finally {
      db.close();
    }
  }

  const compteDe = (username) => lire(`
    SELECT comptes_banque.compte_id AS id FROM comptes_banque JOIN users ON users.id = comptes_banque.user_id
    WHERE users.username = ?
  `, username)[0]?.id;

  // Solde vu par le joueur : banque en mode banque, sinon solde local.
  const solde = (username) => (enBanque
    ? s.banque.comptes.get(compteDe(username)).solde
    : lire('SELECT balance FROM users WHERE username = ?', username)[0].balance);

  async function inscrire(username) {
    const result = await s.server.call('/api/auth/register', { body: { username, password: 'motdepasse1', inviteCode } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.cookie;
  }

  async function creerMarche(title) {
    const result = await s.server.call('/api/markets', {
      cookie: s.createur,
      body: {
        title, description: '', category: 'Community', options: ['Oui', 'Non'],
        endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data.id;
  }

  async function miser(cookie, marketId, choiceIndex, amount) {
    const result = await s.server.call(`/api/markets/${marketId}/bets`, { cookie, body: { choiceIndex, amount } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
  }

  const voter = (cookie, marketId, outcomeIndex) => s.server.call(`/api/markets/${marketId}/votes`, { cookie, body: { outcomeIndex } });

  describe(`résolution par vote (${mode})`, () => {
    before(async () => {
      const extraEnv = {};
      if (enBanque) {
        s.banque = await demarrerFausseBanque();
        Object.assign(extraEnv, { BANQUE_URL: s.banque.url, BANQUE_SECRET: s.banque.secret, BANQUE_RELANCE_MS: '150' });
      }
      s.server = await demarrerServeur(databasePath, extraEnv);
      s.createur = await inscrire('createur');
      s.ana = await inscrire('ana');
      s.ben = await inscrire('ben');
      s.cleo = await inscrire('cleo');
      s.dan = await inscrire('dan');
      // Deux marchés identiques (mêmes mises dans le même ordre, donc mêmes cotes figées) :
      // l'un sera résolu par vote, l'autre par son créateur, pour comparer les paiements.
      s.vote = await creerMarche('Le marché résolu par vote ?');
      s.reference = await creerMarche('Le marché résolu par le créateur ?');
      for (const marketId of [s.vote, s.reference]) {
        await miser(s.ana, marketId, 0, 100);
        await miser(s.ben, marketId, 1, 50);
      }
    });

    after(async () => {
      await s.server?.stop();
      await s.banque?.fermer();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    });

    test('vote refusé tant que le marché est ouvert aux prises', async () => {
      const refus = await voter(s.ana, s.vote, 0);
      assert.equal(refus.status, 409);
      assert.match(refus.data.error, /encore ouvertes/);
      assert.equal(lire('SELECT COUNT(*) AS n FROM market_votes')[0].n, 0);
      const sansSession = await s.server.call(`/api/markets/${s.vote}/votes`, { body: { outcomeIndex: 0 } });
      assert.equal(sansSession.status, 401);
      const inconnu = await voter(s.ana, 'marche-inconnu', 0);
      assert.equal(inconnu.status, 404);
    });

    test('après la clôture : la fiche expose les votes, et un vote peut être changé', async () => {
      cloturer(s.vote);
      cloturer(s.reference);
      const fiche = await s.server.call(`/api/markets/${s.vote}`, { cookie: s.ana });
      assert.equal(fiche.status, 200);
      assert.deepEqual(fiche.data.votes, { counts: [0, 0], mine: null, threshold: 3 });

      const premier = await voter(s.ana, s.vote, 1);
      assert.equal(premier.status, 200, JSON.stringify(premier.data));
      assert.deepEqual(premier.data.votes, { counts: [0, 1], mine: 1, threshold: 3 });
      assert.equal(premier.data.resolved, false);

      // Changer d'avis remplace le vote : toujours une seule voix pour ana.
      const change = await voter(s.ana, s.vote, 0);
      assert.equal(change.status, 200);
      assert.deepEqual(change.data.votes, { counts: [1, 0], mine: 0, threshold: 3 });
      assert.equal(lire('SELECT COUNT(*) AS n FROM market_votes WHERE market_id = ?', s.vote)[0].n, 1);

      const invalide = await voter(s.ana, s.vote, 2);
      assert.equal(invalide.status, 400);
      assert.equal(invalide.data.error, 'Choisissez une des issues proposées.');
      assert.equal((await voter(s.ana, s.vote, 'Oui')).status, 400);
    });

    test('2 votes concordants et 1 différent : pas de résolution', async () => {
      assert.equal((await voter(s.ben, s.vote, 0)).status, 200);
      const cleo = await voter(s.cleo, s.vote, 1);
      assert.equal(cleo.status, 200);
      assert.deepEqual(cleo.data.votes, { counts: [2, 1], mine: 1, threshold: 3 });
      assert.equal(cleo.data.resolved, false);
      const fiche = await s.server.call(`/api/markets/${s.vote}`, { cookie: s.dan });
      assert.equal(fiche.data.market.status, 'open');
      assert.equal(fiche.data.market.outcomeIndex, null);
      assert.deepEqual(fiche.data.votes, { counts: [2, 1], mine: null, threshold: 3 });
    });

    test('3e vote concordant : marché résolu, mêmes gains qu\'une résolution par le créateur', async () => {
      // Référence : le créateur résout le marché jumeau.
      const anaAvantReference = solde('ana');
      const reference = await s.server.call(`/api/markets/${s.reference}/resolve`, { cookie: s.createur, body: { outcomeIndex: 0 } });
      assert.equal(reference.status, 200, JSON.stringify(reference.data));
      const gainReference = solde('ana') - anaAvantReference;
      assert.equal(gainReference, 200, 'mise de 100 à cote figée 2');

      const anaAvant = solde('ana');
      const benAvant = solde('ben');
      const resolu = await voter(s.dan, s.vote, 0);
      assert.equal(resolu.status, 200, JSON.stringify(resolu.data));
      assert.equal(resolu.data.resolved, true);
      assert.deepEqual(resolu.data.votes, { counts: [3, 1], mine: 0, threshold: 3 });
      assert.equal(solde('ana') - anaAvant, gainReference);
      assert.equal(solde('ben'), benAvant, 'le perdant ne reçoit rien');

      const fiche = await s.server.call(`/api/markets/${s.vote}`, { cookie: s.ana });
      assert.equal(fiche.data.market.status, 'resolved');
      assert.equal(fiche.data.market.outcomeIndex, 0);
      assert.equal(fiche.data.market.cancelledAt, null);

      if (enBanque) {
        const id = compteDe('ana');
        const cle = `paris-gain-${s.vote}-${id}`;
        assert.deepEqual(s.banque.mouvements.get(cle), {
          compte: id, montant: 200, motif: 'Paris : gain — Le marché résolu par vote ?',
        });
        assert.equal(s.banque.mouvements.get(`paris-gain-${s.reference}-${id}`).montant, 200);
        // Plusieurs rejeux de la file plus tard, le gain n'est toujours arrivé qu'une fois.
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(s.banque.journal.filter((entry) => entry.cle === cle).length, 1);
        assert.equal(lire('SELECT COUNT(*) AS n FROM banque_en_attente')[0].n, 0);
        await attendre(() => lire('SELECT balance FROM users WHERE username = ?', 'ana')[0].balance === solde('ana'), 'miroir non mis à jour');
      }
    });

    test('vote refusé après la résolution, et sur un marché annulé', async () => {
      const apres = await voter(s.cleo, s.vote, 0);
      assert.equal(apres.status, 409);
      assert.equal(apres.data.error, 'Ce marché est déjà résolu.');
      assert.deepEqual(
        lire('SELECT choice_index FROM market_votes WHERE market_id = ? ORDER BY choice_index', s.vote).map((row) => row.choice_index),
        [0, 0, 0, 1],
      );
      // La résolution directe reste réservée au créateur et ne repaie pas.
      const encore = await s.server.call(`/api/markets/${s.vote}/resolve`, { cookie: s.createur, body: { outcomeIndex: 1 } });
      assert.equal(encore.status, 409);

      const annule = await creerMarche('Le marché annulé avant le vote ?');
      cloturer(annule);
      assert.equal((await s.server.call(`/api/markets/${annule}/cancel`, { cookie: s.createur, method: 'POST' })).status, 200);
      const refus = await voter(s.ana, annule, 0);
      assert.equal(refus.status, 409);
      assert.match(refus.data.error, /annulé/);
    });
  });
}

scenario('autonome');
scenario('banque');
