# DUyka PARIS

Un marché de prédiction entre amis, joué en crédits virtuels, dans le style de Polymarket et Kalshi. Les membres créent des marchés (oui/non ou à choix multiples), prennent position avec des crédits virtuels, suivent l'évolution des probabilités, commentent, et le résultat est réglé une fois l'événement passé.

Le nom du site est défini une seule fois dans `brand.config.json` (`name`, `wordmark`, `tagline`, `description`). Après une modification, relancez `npm run build` et redémarrez le serveur.

## Lancer en local

Node.js 20 ou plus récent est nécessaire.

```sh
npm install
npm run dev
```

Ouvrez `http://localhost:5173`. L'API tourne sur le port 3001 et les données sont partagées par la base SQLite du serveur, `data/oddsroom.sqlite`. Les personnes du même réseau peuvent utiliser l'adresse réseau affichée par Vite dans le terminal.

La création de compte se fait uniquement sur invitation, avec **juste un nom et un mot de passe** (6 caractères minimum, e-mail facultatif côté API et absent de l'interface). Sur une base vide, le serveur affiche dans la console un code d'invitation d'amorçage, valable 30 jours, pour le premier membre (ou utilisez `INITIAL_INVITE_CODE`). Ensuite, tout membre connecté a son lien d'invitation personnel (`/?invite=CODE`, valable 30 jours, réutilisable) via le bouton **Inviter** (onglet du bas sur téléphone, menu utilisateur sur ordinateur) : « Partager » ou « Copier le lien ». Une personne qui ouvre ce lien voit « <nom> t'invite sur DUyka PARIS » et ne remplit que son nom et son mot de passe.

Routes : `POST /api/invites/link` (connecté, renvoie le lien rapide de l'utilisateur, idempotent), `GET /api/invites/:code` (public, `{ valid, inviter }`), `POST /api/auth/register` (`username`, `password`, `inviteCode`, `email` facultatif). Sans e-mail, le serveur stocke une adresse interne `nom.xxxxxxxx@sans-email.invalid` (TLD réservé, jamais renvoyée au client ni utilisable pour se connecter).

## Production

```sh
npm ci
npm run build
npm start
```

Le serveur Express sert le site compilé (`dist/`) et l'API sur le port 3001.

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `PORT` | Port du serveur | `3001` |
| `DB_PATH` | Fichier de la base SQLite (mode WAL : des fichiers `-wal` et `-shm` apparaissent à côté) | `data/oddsroom.sqlite` |
| `NODE_ENV` | `production` rend les cookies de session `secure` (HTTPS obligatoire) | non défini |
| `INITIAL_INVITE_CODE` | Code d'invitation d'amorçage (6 à 32 lettres, chiffres ou tirets), utilisé seulement si la base est vide | généré au hasard |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Notifications push : les trois ensemble, ou aucune | non défini |

Le dossier `data/` contient toutes les données : ne le supprimez jamais et incluez-le dans vos sauvegardes.

## Migrer depuis l'ancienne version

Le schéma de la base est compatible dans les deux sens : la refonte ajoute seulement une table `market_comments` et deux index, et l'ancienne version les ignore. La procédure complète (sauvegarde, essai à blanc sur une copie, bascule, vérifications, retour arrière) est dans [`MIGRATION.md`](MIGRATION.md), rédigée pour qu'un agent (Claude Code, Codex) puisse l'exécuter.

Pour contrôler une base à tout moment, en lecture seule :

```sh
npm run db:verifier -- data/oddsroom.sqlite
```

Le script vérifie les tables et colonnes attendues (par cette version comme par l'ancienne), lance `integrity_check` et `foreign_key_check`, affiche les totaux (membres, somme des soldes, marchés, mises, commentaires) et se termine avec un code non nul en cas de problème. L'option `--strict` rend aussi bloquants les éléments que le serveur recrée tout seul au démarrage.

## Données de démonstration (développement uniquement)

`scripts/seed-demo.js` remplit une base **vide** avec de faux membres, marchés, prises et commentaires. Il est réservé au développement : ne le lancez jamais sur la base de production.

```sh
DB_PATH=/tmp/demo.sqlite node server/index.js   # une fois, pour créer le schéma, puis Ctrl+C
DB_PATH=/tmp/demo.sqlite node scripts/seed-demo.js
```

## Installer l'application

Le site est une application web installable. Déployez-le en HTTPS, ouvrez-le dans un navigateur compatible, puis utilisez l'action **Installer l'application** ou **Ajouter à l'écran d'accueil**. L'enveloppe de l'app peut s'ouvrir hors ligne après un premier chargement réussi ; les comptes et les marchés nécessitent toujours une connexion au serveur.

## Notifications du navigateur

Les membres connectés peuvent activer les notifications push depuis **Alertes** et choisir de les recevoir pour les nouveaux marchés ou pour la résolution des marchés où ils ont une position. Elles sont désactivées par défaut. Le push exige HTTPS (sauf sur localhost) et des clés VAPID ; sans configuration serveur, le reste de l'application fonctionne mais le push ne peut pas être activé.

Générez une paire de clés VAPID avec `npx web-push generate-vapid-keys`, puis définissez `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` et `VAPID_SUBJECT` (par exemple une adresse `mailto:` de l'administrateur) dans l'environnement du service Node. Gardez la clé privée secrète et hors du dépôt, et redémarrez le serveur après modification. Conservez ces clés lors des migrations : des clés différentes invalident les abonnements existants.

## Règles des crédits

- Un nouveau compte reçoit 1 000 crédits virtuels.
- Chaque inscription demande un code d'invitation non expiré (nom + mot de passe d'au moins 6 caractères) ; un code est réutilisable jusqu'à son expiration.
- Un membre, créateur du marché compris, peut prendre une seule position par marché, d'un montant entier, dans la limite de son solde disponible.
- Le créateur peut modifier la question, la description, la catégorie et la clôture tant que le marché n'est pas résolu ; les issues restent figées.
- Le créateur peut annuler un marché non résolu : chaque participant est remboursé de sa mise, et le marché annulé ainsi que les positions restent visibles.
- Chaque issue affiche une cote décimale calculée à partir du nombre de prises : `(prises totales + nombre d'issues) / (prises sur l'issue + 1)`. Une prise fictive par issue au départ garde la cote définie quand le marché est vide.
- La cote est figée au moment de la prise : les prises suivantes ne changent pas le gain. La mise est débitée immédiatement ; une prise gagnante rapporte `mise × cote figée`, en crédits entiers arrondis à l'inférieur. Les mises perdantes ne sont pas rendues.
- Tout membre connecté peut désigner le résultat à tout moment, y compris avant la clôture. La première résolution réussie règle le marché et paie les gagnants.
- Les crédits n'ont aucune valeur monétaire et ne peuvent être ni déposés ni retirés.

### Affichage en prix et en probabilité

L'interface affiche chaque issue comme sur Polymarket : une probabilité en pourcentage et un prix en centimes (¢). La probabilité vaut `(prises sur l'issue + 1) / (prises totales + nombre d'issues)`, soit l'inverse de la cote, et le prix en ¢ vaut environ `100 / cote` (une cote de 4 donne 25 ¢, soit 25 %). L'historique d'un marché rejoue les prises une à une à partir d'une répartition uniforme.

Ce projet est un prototype mono-serveur, pas un service de paris à argent réel durci. Un déploiement public devrait ajouter une limitation de débit et un processus de contestation des résultats, et utiliser HTTPS avec les cookies de production activés.

## Vérifications

```sh
npm test
npm run build
npm audit
```

`npm test` démarre le serveur dans un processus enfant sur une base temporaire. Le test de compatibilité extrait aussi l'ancien serveur (commit `41d60ea`) depuis git pour vérifier qu'il fonctionne sur une base créée par la nouvelle version ; il est ignoré dans un clone superficiel.
