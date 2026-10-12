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
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'oddsroom-test-'));
const databasePath = path.join(temporaryDirectory, 'test.sqlite');
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
  return {
    status: response.status,
    data,
    cookie: token ? `sid=${token}` : cookie,
  };
}

before(async () => {
  const legacyDatabase = new Database(databasePath);
  legacyDatabase.exec(`
    CREATE TABLE bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      choice_index INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (market_id, user_id)
    );
    CREATE TABLE invite_codes (
      code TEXT PRIMARY KEY,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      redeemed_by INTEGER,
      redeemed_at TEXT
    );
  `);
  legacyDatabase.prepare('INSERT INTO invite_codes (code, created_at) VALUES (?, ?)')
    .run('LEGACY01', new Date().toISOString());
  legacyDatabase.close();

  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: databasePath,
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
      const response = await fetch(`${baseUrl}/api/me`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(ready, true, `API server did not start. ${serverOutput}`);
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    const exited = once(serverProcess, 'exit');
    serverProcess.kill();
    await exited;
  }
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('members create markets, place one wager, and receive the correct payout', async () => {
  const stamp = Date.now();
  const inviteDatabase = new Database(databasePath);
  const bootstrapCode = inviteDatabase.prepare(`
    SELECT code FROM invite_codes WHERE created_by IS NULL AND redeemed_at IS NULL
  `).get().code;
  inviteDatabase.close();

  const hiddenMarkets = await call('/api/markets');
  assert.equal(hiddenMarkets.status, 401);
  const hiddenLeaderboard = await call('/api/leaderboard');
  assert.equal(hiddenLeaderboard.status, 401);
  const hiddenInvites = await call('/api/invites');
  assert.equal(hiddenInvites.status, 401);
  const hiddenNotificationSettings = await call('/api/notifications/settings');
  assert.equal(hiddenNotificationSettings.status, 401);
  const missingInvite = await call('/api/auth/register', {
    body: {
      username: `blocked_${stamp}`,
      email: `blocked_${stamp}@example.test`,
      password: 'test-password-123',
    },
  });
  assert.equal(missingInvite.status, 400);

  const creator = await call('/api/auth/register', {
    body: {
      username: `maker_${stamp}`,
      email: `maker_${stamp}@example.test`,
      password: 'test-password-123',
      inviteCode: bootstrapCode,
    },
  });
  assert.equal(creator.status, 201);
  assert.equal(creator.data.user.balance, 1000);

  const notificationSettings = await call('/api/notifications/settings', { cookie: creator.cookie });
  assert.equal(notificationSettings.status, 200);
  assert.equal(notificationSettings.data.pushEnabled, false);
  assert.deepEqual(notificationSettings.data.preferences, {
    newPolls: false,
    participatedResolutions: false,
  });
  const malformedPreferences = await call('/api/notifications/preferences', {
    cookie: creator.cookie,
    body: { newPolls: true },
    method: 'PUT',
  });
  assert.equal(malformedPreferences.status, 400);
  const savedPreferences = await call('/api/notifications/preferences', {
    cookie: creator.cookie,
    body: { newPolls: true, participatedResolutions: true },
    method: 'PUT',
  });
  assert.equal(savedPreferences.status, 200);
  const unavailablePushSubscription = await call('/api/notifications/subscriptions', {
    cookie: creator.cookie,
    body: {
      endpoint: 'https://push.example.test/subscription',
      keys: { p256dh: 'public-key', auth: 'auth-key' },
    },
  });
  assert.equal(unavailablePushSubscription.status, 503);
  await call('/api/notifications/preferences', {
    cookie: creator.cookie,
    body: { newPolls: false, participatedResolutions: false },
    method: 'PUT',
  });

  const migratedDatabase = new Database(databasePath);
  assert.ok(migratedDatabase.pragma('table_info(bets)').some((column) => column.name === 'decimal_odds'));
  assert.ok(migratedDatabase.pragma('table_info(invite_codes)').some((column) => column.name === 'expires_at'));
  assert.ok(migratedDatabase.pragma('table_info(markets)').some((column) => column.name === 'cancelled_at'));
  assert.ok(migratedDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'push_subscriptions'").get());
  assert.ok(migratedDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notification_preferences'").get());
  migratedDatabase.close();
  const reusedBootstrap = await call('/api/auth/register', {
    body: {
      username: `reused_${stamp}`,
      email: `reused_${stamp}@example.test`,
      password: 'test-password-123',
      inviteCode: bootstrapCode,
    },
  });
  assert.equal(reusedBootstrap.status, 201);

  const invalidDuration = await call('/api/invites', {
    cookie: creator.cookie,
    body: { validForDays: 2 },
  });
  assert.equal(invalidDuration.status, 400);
  const invitation = await call('/api/invites', {
    cookie: creator.cookie,
    body: { validForDays: 7 },
  });
  assert.equal(invitation.status, 201);
  assert.equal(invitation.data.invite.redeemedCount, 0);
  assert.ok(Date.parse(invitation.data.invite.expiresAt) - Date.now() > 6 * 24 * 60 * 60 * 1000);

  const marketResponse = await call('/api/markets', {
    cookie: creator.cookie,
    body: {
      title: 'Will this integration test resolve?',
      description: '',
      category: 'Community',
      options: ['Yes', 'No'],
      endsAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    },
  });
  assert.equal(marketResponse.status, 201);
  const editedMarket = await call(`/api/markets/${marketResponse.data.id}`, {
    method: 'PATCH',
    cookie: creator.cookie,
    body: {
      title: 'Will this edited integration test resolve?',
      description: 'Updated market context.',
      category: 'Technology',
      endsAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      options: ['Ignored choice change', 'Choices are fixed'],
    },
  });
  assert.equal(editedMarket.status, 200);

  const multichoiceResponse = await call('/api/markets', {
    cookie: creator.cookie,
    body: {
      title: 'Which answer format is supported?',
      description: '',
      category: 'Technology',
      options: ['One', 'Two', 'Three'],
      endsAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    },
  });
  assert.equal(multichoiceResponse.status, 201);
  const initialMarkets = await call('/api/markets', { cookie: creator.cookie });
  const initialMultichoice = initialMarkets.data.markets.find((market) => market.id === multichoiceResponse.data.id);
  assert.deepEqual(initialMultichoice.optionStats.map((option) => option.odds), [3, 3, 3]);

  // Le créateur résout son marché : il ne peut donc pas miser dessus.
  const makerBet = await call(`/api/markets/${marketResponse.data.id}/bets`, {
    cookie: creator.cookie,
    body: { choiceIndex: 0, amount: 10 },
  });
  assert.equal(makerBet.status, 403);

  const bettor = await call('/api/auth/register', {
    body: {
      username: `caller_${stamp}`,
      email: `caller_${stamp}@example.test`,
      password: 'test-password-123',
      inviteCode: invitation.data.invite.code,
    },
  });
  assert.equal(bettor.status, 201);
  const forbiddenEdit = await call(`/api/markets/${marketResponse.data.id}`, {
    method: 'PATCH',
    cookie: bettor.cookie,
    body: {
      title: 'Unauthorized market edit attempt',
      description: '',
      category: 'Community',
      endsAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    },
  });
  assert.equal(forbiddenEdit.status, 403);

  const secondInvitee = await call('/api/auth/register', {
    body: {
      username: `c2_${stamp}`,
      email: `caller2_${stamp}@example.test`,
      password: 'test-password-123',
      inviteCode: invitation.data.invite.code,
    },
  });
  assert.equal(secondInvitee.status, 201);
  const firstBet = await call(`/api/markets/${marketResponse.data.id}/bets`, {
    cookie: secondInvitee.cookie,
    body: { choiceIndex: 0, amount: 10 },
  });
  assert.equal(firstBet.status, 200);
  assert.equal(firstBet.data.user.balance, 990);
  const listedInvites = await call('/api/invites', { cookie: creator.cookie });
  assert.equal(listedInvites.data.invites[0].redeemedCount, 2);

  const expiredInvite = await call('/api/invites', {
    cookie: creator.cookie,
    body: { validForDays: 1 },
  });
  assert.equal(expiredInvite.status, 201);
  const expiryDatabase = new Database(databasePath);
  expiryDatabase.prepare('UPDATE invite_codes SET expires_at = ? WHERE code = ?')
    .run(new Date(Date.now() - 1000).toISOString(), expiredInvite.data.invite.code);
  expiryDatabase.close();
  const expiredRegistration = await call('/api/auth/register', {
    body: {
      username: `exp_${stamp}`,
      email: `expired_${stamp}@example.test`,
      password: 'test-password-123',
      inviteCode: expiredInvite.data.invite.code,
    },
  });
  assert.equal(expiredRegistration.status, 400);

  const bet = await call(`/api/markets/${marketResponse.data.id}/bets`, {
    cookie: bettor.cookie,
    body: { choiceIndex: 0, amount: 125 },
  });
  assert.equal(bet.status, 200);
  assert.equal(bet.data.user.balance, 875);

  const oddsAfterFirstPick = await call('/api/markets', { cookie: bettor.cookie });
  const updatedMarket = oddsAfterFirstPick.data.markets.find((market) => market.id === marketResponse.data.id);
  assert.equal(updatedMarket.optionStats[0].odds, 1.33);
  assert.equal(updatedMarket.optionStats[1].odds, 4);
  assert.equal(updatedMarket.myBet.odds, 1.5);

  const duplicateBet = await call(`/api/markets/${marketResponse.data.id}/bets`, {
    cookie: bettor.cookie,
    body: { choiceIndex: 1, amount: 50 },
  });
  assert.equal(duplicateBet.status, 409);

  // Seul le créateur peut résoudre.
  const forbiddenResolve = await call(`/api/markets/${marketResponse.data.id}/resolve`, {
    cookie: bettor.cookie,
    body: { outcomeIndex: 1 },
  });
  assert.equal(forbiddenResolve.status, 403);
  const resolved = await call(`/api/markets/${marketResponse.data.id}/resolve`, {
    cookie: creator.cookie,
    body: { outcomeIndex: 0 },
  });
  assert.equal(resolved.status, 200);

  const updatedBalance = await call('/api/me', { cookie: bettor.cookie });
  assert.equal(updatedBalance.data.user.balance, 1062);

  const firstBettorBalance = await call('/api/me', { cookie: secondInvitee.cookie });
  assert.equal(firstBettorBalance.data.user.balance, 1010);
  const creatorBalance = await call('/api/me', { cookie: creator.cookie });
  assert.equal(creatorBalance.data.user.balance, 1000);

  const markets = await call('/api/markets', { cookie: bettor.cookie });
  const resolvedMarket = markets.data.markets.find((market) => market.id === marketResponse.data.id);
  const multichoiceMarket = markets.data.markets.find((market) => market.id === multichoiceResponse.data.id);
  assert.equal(resolvedMarket.status, 'resolved');
  assert.equal(resolvedMarket.title, 'Will this edited integration test resolve?');
  assert.equal(resolvedMarket.description, 'Updated market context.');
  assert.equal(resolvedMarket.category, 'Technology');
  assert.deepEqual(resolvedMarket.options, ['Yes', 'No']);
  assert.equal(resolvedMarket.myBet.odds, 1.5);
  assert.equal(resolvedMarket.optionStats[0].odds, 1.33);
  assert.deepEqual(multichoiceMarket.options, ['One', 'Two', 'Three']);

  const cancelableMarket = await call('/api/markets', {
    cookie: creator.cookie,
    body: {
      title: 'Will this poll be cancelled and refunded?',
      description: '',
      category: 'Community',
      options: ['Yes', 'No'],
      endsAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    },
  });
  assert.equal(cancelableMarket.status, 201);
  const creatorPick = await call(`/api/markets/${cancelableMarket.data.id}/bets`, {
    cookie: secondInvitee.cookie,
    body: { choiceIndex: 0, amount: 30 },
  });
  const callerPick = await call(`/api/markets/${cancelableMarket.data.id}/bets`, {
    cookie: bettor.cookie,
    body: { choiceIndex: 1, amount: 40 },
  });
  assert.equal(creatorPick.status, 200);
  assert.equal(callerPick.status, 200);

  const unauthorizedCancel = await call(`/api/markets/${cancelableMarket.data.id}/cancel`, {
    method: 'POST',
    cookie: bettor.cookie,
  });
  assert.equal(unauthorizedCancel.status, 403);

  const cancelled = await call(`/api/markets/${cancelableMarket.data.id}/cancel`, {
    method: 'POST',
    cookie: creator.cookie,
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.refundedCredits, 70);
  assert.equal(cancelled.data.refundedCallers, 2);
  assert.equal(cancelled.data.user.balance, creatorBalance.data.user.balance);
  const refundedFirstBettor = await call('/api/me', { cookie: secondInvitee.cookie });
  assert.equal(refundedFirstBettor.data.user.balance, creatorPick.data.user.balance + 30);
  const refundedCaller = await call('/api/me', { cookie: bettor.cookie });
  assert.equal(refundedCaller.data.user.balance, callerPick.data.user.balance + 40);

  const cancellationDatabase = new Database(databasePath);
  assert.equal(cancellationDatabase.prepare('SELECT COUNT(*) AS count FROM bets WHERE market_id = ?')
    .get(cancelableMarket.data.id).count, 2);
  cancellationDatabase.close();
  const cancelledMarket = (await call('/api/markets', { cookie: bettor.cookie }))
    .data.markets.find((market) => market.id === cancelableMarket.data.id);
  assert.equal(cancelledMarket.status, 'resolved');
  assert.ok(cancelledMarket.cancelledAt);
  assert.equal(cancelledMarket.totalStaked, 70);
  const repeatedCancel = await call(`/api/markets/${cancelableMarket.data.id}/cancel`, {
    method: 'POST',
    cookie: creator.cookie,
  });
  assert.equal(repeatedCancel.status, 409);
});