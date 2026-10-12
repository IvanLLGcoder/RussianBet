// Vérifie une base SQLite de « DUyka PARIS » en LECTURE SEULE.
// Usage : node scripts/verifier-base.js <chemin/vers/base.sqlite> [--strict]
//   (ou : npm run db:verifier -- <chemin/vers/base.sqlite>)
//
// Contrôles : tables et colonnes attendues par la nouvelle version ET par l'ancienne
// (commit 41d60ea), PRAGMA integrity_check, PRAGMA foreign_key_check, cohérence des
// mises et des marchés, puis totaux (membres, soldes, marchés, mises, commentaires).
//
// Les éléments que le serveur recrée tout seul au démarrage (colonnes issues des
// anciennes migrations, table market_comments, index) sont signalés par un
// avertissement, non bloquant, sauf avec --strict.
//
// Code de sortie : 0 = tout va bien, 1 = problème détecté, 2 = mauvaise utilisation.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const arguments_ = process.argv.slice(2);
const strict = arguments_.includes('--strict');
const databasePath = arguments_.find((argument) => !argument.startsWith('--'));
if (!databasePath) {
  console.error('Usage : node scripts/verifier-base.js <chemin/vers/base.sqlite> [--strict]');
  process.exit(2);
}
if (!fs.existsSync(databasePath)) {
  console.error(`Fichier introuvable : ${databasePath}`);
  process.exit(2);
}

// Schéma attendu. « migrable » = recréé automatiquement au démarrage du serveur
// (nouvelle comme ancienne version), donc son absence n'est pas bloquante.
const expectedTables = {
  users: { columns: ['id', 'username', 'email', 'password_hash', 'balance', 'created_at'] },
  sessions: { columns: ['token_hash', 'user_id', 'expires_at'] },
  invite_codes: {
    columns: ['code', 'created_by', 'created_at', 'redeemed_by', 'redeemed_at'],
    migrableColumns: ['expires_at'],
  },
  invite_redemptions: { columns: ['invite_code', 'user_id', 'redeemed_at'], migrable: true },
  markets: {
    columns: [
      'id', 'title', 'description', 'category', 'options_json', 'outcome_index',
      'status', 'ends_at', 'created_at', 'creator_id',
    ],
    migrableColumns: ['cancelled_at'],
  },
  bets: {
    columns: ['id', 'market_id', 'user_id', 'choice_index', 'amount', 'created_at'],
    migrableColumns: ['decimal_odds'],
  },
  push_subscriptions: { columns: ['endpoint', 'user_id', 'p256dh', 'auth', 'created_at'], migrable: true },
  notification_preferences: {
    columns: ['user_id', 'new_polls', 'participated_resolutions'],
    migrable: true,
  },
  // Ajout de la refonte : ignoré par l'ancienne version.
  market_comments: { columns: ['id', 'market_id', 'user_id', 'body', 'created_at'], migrable: true },
};
const expectedIndexes = [
  'idx_markets_status_ends', 'idx_bets_market', 'idx_push_subscriptions_user',
  'idx_market_comments_market', 'idx_bets_created',
];

const errors = [];
const warnings = [];
const problem = (message, { migrable = false } = {}) => {
  if (migrable && !strict) warnings.push(`${message} (sera créé au prochain démarrage du serveur)`);
  else errors.push(message);
};

let db;
try {
  db = new Database(databasePath, { readonly: true, fileMustExist: true });
} catch (error) {
  console.error(`Impossible d'ouvrir la base en lecture seule : ${error.message}`);
  process.exit(2);
}

console.log(`Base : ${path.resolve(databasePath)}`);
try {
  console.log(`Mode journal : ${db.pragma('journal_mode', { simple: true })}`);
} catch (error) {
  console.log(`\nProblèmes\n  - Fichier illisible comme base SQLite : ${error.message}\n\nRÉSULTAT : ÉCHEC`);
  process.exit(1);
}

// 1. Schéma.
const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
  .map((row) => row.name));
const columnsOf = new Map();
for (const [table, spec] of Object.entries(expectedTables)) {
  if (!tables.has(table)) {
    problem(`Table manquante : ${table}`, { migrable: Boolean(spec.migrable) });
    continue;
  }
  const present = new Set(db.pragma(`table_info(${table})`).map((column) => column.name));
  columnsOf.set(table, present);
  for (const column of spec.columns) {
    if (!present.has(column)) problem(`Colonne manquante : ${table}.${column}`);
  }
  for (const column of spec.migrableColumns ?? []) {
    if (!present.has(column)) problem(`Colonne manquante : ${table}.${column}`, { migrable: true });
  }
}
const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()
  .map((row) => row.name));
for (const index of expectedIndexes) {
  if (!indexes.has(index)) problem(`Index manquant : ${index}`, { migrable: true });
}

// 2. Intégrité SQLite.
const integrity = db.pragma('integrity_check').map((row) => row.integrity_check);
if (integrity.length !== 1 || integrity[0] !== 'ok') {
  problem(`integrity_check : ${integrity.slice(0, 5).join(' | ')}`);
}
const foreignKeyViolations = db.pragma('foreign_key_check');
if (foreignKeyViolations.length > 0) {
  const sample = foreignKeyViolations.slice(0, 5)
    .map((row) => `${row.table}#${row.rowid} -> ${row.parent}`).join(', ');
  problem(`foreign_key_check : ${foreignKeyViolations.length} violation(s) (${sample})`);
}

// 3. Cohérence des données (seulement si les colonnes nécessaires existent).
const has = (table, ...columns) => columnsOf.has(table) && columns.every((c) => columnsOf.get(table).has(c));
if (has('users', 'balance')) {
  const negative = db.prepare('SELECT COUNT(*) AS count FROM users WHERE balance < 0').get().count;
  if (negative > 0) problem(`${negative} membre(s) avec un solde négatif`);
}
if (has('markets', 'status', 'outcome_index', 'options_json')) {
  const markets = db.prepare(`SELECT id, options_json, status, outcome_index
    ${has('markets', 'cancelled_at') ? ', cancelled_at' : ', NULL AS cancelled_at'} FROM markets`).all();
  const optionCounts = new Map();
  for (const market of markets) {
    let options;
    try {
      options = JSON.parse(market.options_json);
      if (!Array.isArray(options) || options.length < 2) throw new Error('moins de 2 issues');
    } catch (error) {
      problem(`Marché ${market.id} : options_json invalide (${error.message})`);
      continue;
    }
    optionCounts.set(market.id, options.length);
    if (market.status !== 'open' && market.status !== 'resolved') {
      problem(`Marché ${market.id} : statut inconnu « ${market.status} »`);
    }
    if (market.status === 'resolved' && !market.cancelled_at
      && !(Number.isInteger(market.outcome_index) && market.outcome_index >= 0
        && market.outcome_index < options.length)) {
      problem(`Marché ${market.id} : résolu sans issue gagnante valide`);
    }
  }
  if (has('bets', 'market_id', 'choice_index')) {
    let outOfRange = 0;
    for (const bet of db.prepare('SELECT market_id, choice_index FROM bets').iterate()) {
      const count = optionCounts.get(bet.market_id);
      if (count !== undefined && !(bet.choice_index >= 0 && bet.choice_index < count)) outOfRange += 1;
    }
    if (outOfRange > 0) problem(`${outOfRange} mise(s) sur une issue qui n'existe pas`);
  }
}

// 4. Totaux.
const scalar = (sql) => db.prepare(sql).get().value;
const totals = [];
if (has('users', 'balance')) {
  totals.push(['Membres', scalar('SELECT COUNT(*) AS value FROM users')]);
  totals.push(['Somme des soldes', scalar('SELECT COALESCE(SUM(balance), 0) AS value FROM users')]);
}
if (has('markets', 'status')) {
  const cancelled = has('markets', 'cancelled_at');
  const count = (condition) => scalar(`SELECT COUNT(*) AS value FROM markets WHERE ${condition}`);
  totals.push(['Marchés au total', scalar('SELECT COUNT(*) AS value FROM markets')]);
  totals.push(['Marchés ouverts', count("status = 'open'")]);
  totals.push(['Marchés résolus', count(cancelled ? "status = 'resolved' AND cancelled_at IS NULL" : "status = 'resolved'")]);
  totals.push(['Marchés annulés', cancelled ? count('cancelled_at IS NOT NULL') : 0]);
}
if (has('bets', 'amount')) {
  totals.push(['Mises', scalar('SELECT COUNT(*) AS value FROM bets')]);
  totals.push(['Crédits misés', scalar('SELECT COALESCE(SUM(amount), 0) AS value FROM bets')]);
}
if (has('market_comments', 'id')) {
  totals.push(['Commentaires', scalar('SELECT COUNT(*) AS value FROM market_comments')]);
}
console.log('\nTotaux');
for (const [label, value] of totals) console.log(`  ${label.padEnd(20)} ${value}`);

db.close();

// 5. Verdict.
if (warnings.length > 0) {
  console.log('\nAvertissements');
  for (const warning of warnings) console.log(`  - ${warning}`);
}
if (errors.length > 0) {
  console.log('\nProblèmes');
  for (const error of errors) console.log(`  - ${error}`);
  console.log('\nRÉSULTAT : ÉCHEC');
  process.exit(1);
}
console.log('\nRÉSULTAT : OK');
