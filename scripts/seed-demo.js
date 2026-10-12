// Remplit une base VIDE avec des membres, marchés, prises et commentaires de démonstration.
// Usage (développement uniquement) :
//   DB_PATH=/tmp/demo.sqlite node server/index.js   # une fois, pour créer le schéma, puis Ctrl+C
//   DB_PATH=/tmp/demo.sqlite node scripts/seed-demo.js
// Tous les comptes de démo ont le mot de passe « demo-password ».
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const databasePath = process.env.DB_PATH;
if (!databasePath) throw new Error('Définissez DB_PATH (jamais la base de production).');
const db = new Database(databasePath);
if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0) {
  throw new Error('La base contient déjà des membres : seed annulé.');
}

const hour = 3_600_000;
const now = Date.now();
const iso = (time) => new Date(time).toISOString();
const passwordHash = bcrypt.hashSync('demo-password', 10);
const names = ['ivan', 'simon', 'lea', 'hugo', 'ines', 'nathan', 'chloe', 'yanis', 'manon', 'theo', 'sarah', 'lucas'];
const users = names.map((username, index) => Number(db.prepare(`
  INSERT INTO users (username, email, password_hash, balance, created_at) VALUES (?, ?, ?, 1000, ?)
`).run(username, `${username}@demo.test`, passwordHash, iso(now - (400 - index) * hour)).lastInsertRowid));

const markets = [
  ['Le prochain apéro tombe-t-il un vendredi ?', 'Community', ['Oui', 'Non'], 140, 72, [0.7, 0.3], 'Se résout par « Oui » si l’apéro suivant a lieu un vendredi.'],
  ['Qui gagne le tournoi de FIFA du mois ?', 'Sports', ['Hugo', 'Simon', 'Nathan', 'Yanis'], 200, 96, [0.35, 0.3, 0.2, 0.15], 'Finale jouée au local, en BO3.'],
  ['Le serveur tombe-t-il avant dimanche ?', 'Technology', ['Oui', 'Non'], 60, 30, [0.25, 0.75], 'Panne de plus de 10 minutes constatée par deux membres.'],
  ['La réforme passe-t-elle au Sénat avant Noël ?', 'Politics', ['Oui', 'Non'], 300, 240, [0.45, 0.55], ''],
  ['Quel film fait le plus d’entrées ce mois-ci ?', 'Culture', ['Le blockbuster', 'Le film d’auteur', 'L’animation'], 160, 200, [0.5, 0.15, 0.35], 'Chiffres du box-office France.'],
  ['Une nouvelle exoplanète habitable annoncée cette année ?', 'Science', ['Oui', 'Non'], 380, 600, [0.2, 0.8], ''],
  ['Léa arrive-t-elle à l’heure lundi ?', 'Community', ['Oui', 'Non'], 50, -2, [0.3, 0.7], 'Heure officielle : 8 h 00.'],
  ['Le PSG gagne-t-il samedi ?', 'Sports', ['Oui', 'Non', 'Nul'], 120, -20, [0.55, 0.25, 0.2], ''],
];

const insertMarket = db.prepare(`
  INSERT INTO markets (id, title, description, category, options_json, ends_at, created_at, creator_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertBet = db.prepare(`
  INSERT INTO bets (market_id, user_id, choice_index, amount, decimal_odds, created_at) VALUES (?, ?, ?, ?, ?, ?)
`);
const debit = db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?');
const insertComment = db.prepare('INSERT INTO market_comments (market_id, user_id, body, created_at) VALUES (?, ?, ?, ?)');
const comments = ['Facile, j’ai tout mis.', 'Vous allez tous pleurer à la résolution.', 'La cote est beaucoup trop généreuse.', 'Je couvre, on ne sait jamais.'];

let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

db.transaction(() => {
  markets.forEach(([title, category, options, ageHours, endsInHours, weights, description], marketIndex) => {
    const id = randomUUID();
    const createdAt = now - ageHours * hour;
    const creator = users[marketIndex % users.length];
    insertMarket.run(id, title, description, category, JSON.stringify(options), iso(now + endsInHours * hour), iso(createdAt), creator);
    const bettors = users.filter(() => random() < 0.8);
    const counts = options.map(() => 0);
    const lastBet = Math.min(now, now + endsInHours * hour) - hour / 2;
    bettors.forEach((userId, betIndex) => {
      let pick = 0;
      let roll = random();
      while (pick < weights.length - 1 && roll > weights[pick]) { roll -= weights[pick]; pick += 1; }
      const total = counts.reduce((sum, count) => sum + count, 0);
      const odds = Number(((total + options.length) / (counts[pick] + 1)).toFixed(2));
      const amount = Math.max(5, Math.round((random() * 180) / 5) * 5);
      const time = createdAt + ((lastBet - createdAt) * (betIndex + 1)) / (bettors.length + 1);
      if (debit.run(amount, userId, amount).changes !== 1) return;
      insertBet.run(id, userId, pick, amount, odds, iso(time));
      counts[pick] += 1;
      if (random() < 0.35) insertComment.run(id, userId, comments[Math.floor(random() * comments.length)], iso(time + 60_000));
    });
  });
})();

console.log(`Démo prête : ${users.length} membres (mot de passe « demo-password »), ${markets.length} marchés.`);
