// « Continuer avec le poker » et « Je suis déjà au poker » : un joueur qui a déjà un compte au
// poker ne doit jamais en recréer un en passant par un lien d'invitation. Le poker est simulé par
// la fausse banque (ticket à usage unique, liste des noms).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import { demarrerFausseBanque } from './aides/fausse-banque.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'duyka-connexion-poker-'));
const inviteCode = 'POKER001';
const pokerPublic = 'https://poker.exemple.test';
let serverProcess;
let baseUrl;
let banque;
let output = '';

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

// Requête sans suivre les redirections ; renvoie aussi les cookies posés.
async function brut(endpoint, { cookie, body } = {}) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: body ? 'POST' : 'GET',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const cookies = response.headers.getSetCookie();
  const data = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
  return { status: response.status, location: response.headers.get('location'), cookies, data };
}

const valeurCookie = (cookies, nom) => cookies.find((c) => c.startsWith(`${nom}=`))?.split(';')[0];

// Départ vers le poker : renvoie le cookie d'état et l'état transmis au poker.
async function depart(suite) {
  const r = await brut(`/api/auth/poker${suite ? `?suite=${encodeURIComponent(suite)}` : ''}`);
  assert.equal(r.status, 302);
  const cible = new URL(r.location);
  assert.equal(`${cible.origin}${cible.pathname}`, `${pokerPublic}/lien-paris`);
  const etat = cible.searchParams.get('etat');
  assert.match(etat, /^[A-Za-z0-9_-]{16,64}$/);
  const cookie = valeurCookie(r.cookies, 'poker_etat');
  assert.ok(cookie, 'cookie d’état posé');
  assert.match(r.cookies.find((c) => c.startsWith('poker_etat=')), /Path=\/api\/auth\/poker/);
  return { etat, cookie };
}

before(async () => {
  banque = await demarrerFausseBanque();
  banque.creer('Mathéo', 'motdepasse1');
  banque.creer('Inès', 'motdepasse2');
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(temporaryDirectory, 'test.sqlite'),
      INITIAL_INVITE_CODE: inviteCode,
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: '',
      VAPID_SUBJECT: '',
      BANQUE_URL: banque.url,
      BANQUE_SECRET: banque.secret,
      POKER_URL_PUBLIQUE: `${pokerPublic}/`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (chunk) => { output += chunk; });
  serverProcess.stderr.on('data', (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/me`)).ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.fail(`Le serveur n'a pas démarré. ${output}`);
});

after(async () => {
  serverProcess?.kill();
  await banque?.fermer();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('le site annonce la connexion par le poker', async () => {
  const me = await brut('/api/me');
  assert.equal(me.data.connexionPoker, true);
});

test('aller-retour par le poker : session ouverte sur le compte poker existant, sans nouveau compte', async () => {
  const comptesAvant = banque.comptes.size;
  const { etat, cookie } = await depart('/market/abc');
  const ticket = banque.delivrerTicket(banque.parNom('Mathéo').id);
  const retour = await brut(`/api/auth/poker/retour?ticket=${encodeURIComponent(ticket)}&etat=${etat}`, { cookie });
  assert.equal(retour.status, 302);
  assert.equal(retour.location, '/market/abc?poker=ok');
  const sid = valeurCookie(retour.cookies, 'sid');
  assert.ok(sid, 'session ouverte');
  const me = await brut('/api/me', { cookie: sid });
  assert.equal(me.data.user.username, 'Mathéo');
  assert.equal(me.data.user.balance, 10_000);
  assert.equal(banque.comptes.size, comptesAvant, 'aucun compte créé au poker');

  // Le ticket ne sert qu'une fois
  const rejoue = await depart('/');
  const encore = await brut(`/api/auth/poker/retour?ticket=${encodeURIComponent(ticket)}&etat=${rejoue.etat}`, { cookie: rejoue.cookie });
  assert.equal(encore.location, '/?poker=expire');
  assert.equal(valeurCookie(encore.cookies, 'sid'), undefined);
});

test('état absent ou différent : refus, même avec un ticket valide', async () => {
  const ticket = () => banque.delivrerTicket(banque.parNom('Inès').id);
  const { etat, cookie } = await depart('/');
  for (const [requete, avecCookie] of [
    [`/api/auth/poker/retour?ticket=${ticket()}&etat=${etat}`, undefined],          // pas de cookie d'état
    [`/api/auth/poker/retour?ticket=${ticket()}&etat=autre-etat-0123456789`, cookie], // état falsifié
    [`/api/auth/poker/retour?etat=${etat}`, cookie],                                 // pas de ticket
  ]) {
    const r = await brut(requete, { cookie: avecCookie });
    assert.equal(r.status, 302);
    assert.equal(r.location, '/?poker=expire');
    assert.equal(valeurCookie(r.cookies, 'sid'), undefined);
  }
});

test('la page de retour reste interne au site', async () => {
  for (const suite of ['//ailleurs.example/x', 'https://ailleurs.example', '/\\ailleurs.example']) {
    const { etat, cookie } = await depart(suite);
    const ticket = banque.delivrerTicket(banque.parNom('Inès').id);
    const r = await brut(`/api/auth/poker/retour?ticket=${ticket}&etat=${etat}`, { cookie });
    assert.equal(r.location, '/?poker=ok');
  }
});

test('« Je suis déjà au poker » : liste des noms réservée aux invitations valides', async () => {
  const liste = await brut(`/api/invites/${inviteCode.toLowerCase()}/joueurs`);
  assert.equal(liste.status, 200);
  assert.deepEqual(liste.data.noms.sort(), ['Inès', 'Mathéo']);
  const refus = await brut('/api/invites/FAUXCODE/joueurs');
  assert.equal(refus.status, 404);
  assert.equal(refus.data.noms, undefined);
});

test('inscription avec un nom déjà pris au poker : refus explicite, pas de doublon', async () => {
  const r = await brut('/api/auth/register', { body: { username: 'Inès', password: 'motdepasse9', inviteCode } });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /déjà pris/);
  // … et la connexion avec le compte poker fonctionne
  const connexion = await brut('/api/auth/login', { body: { identity: 'Inès', password: 'motdepasse2' } });
  assert.equal(connexion.status, 200);
  assert.equal(connexion.data.user.username, 'Inès');
});
