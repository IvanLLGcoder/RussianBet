# Migration vers DUyka PARIS (refonte Polymarket/Kalshi)

Procédure destinée à un **agent** (Claude Code, Codex) qui migre une instance existante de l'ancienne version (commit `41d60ea`, « NiggaBet / Oddsroom ») vers cette version. Exécute les étapes dans l'ordre. Chaque étape a un critère de **Vérification** : s'il n'est pas rempli, arrête-toi et corrige ou annule, ne passe pas à la suite.

## Ce qu'il faut savoir avant de commencer

- La base SQLite est **compatible dans les deux sens**. Les tables et colonnes existantes ne changent pas, les catégories restent stockées en anglais. La nouvelle version ajoute seulement la table `market_comments` et les index `idx_market_comments_market` et `idx_bets_created`, créés au démarrage. L'ancienne version les ignore : le retour arrière ne demande aucune opération sur la base.
- Inscription sans e-mail : les comptes créés sans adresse reçoivent un e-mail interne `nom.xxxxxxxx@sans-email.invalid` (colonne `users.email` inchangée, `NOT NULL UNIQUE`) ; **aucun changement de schéma**, l'ancienne version lit ces comptes sans problème (connexion par pseudo).
- Les migrations historiques de l'ancienne version (colonnes `decimal_odds`, `expires_at`, `cancelled_at`, table `invite_redemptions`) sont toujours rejouées au démarrage.
- Il n'y a **aucune migration de données** à écrire. Toute la procédure consiste à sauvegarder, tester sur une copie, basculer le code et vérifier.
- Le dépôt contient `.github/deploy.yaml` (un `push` sur `main` appelle un webhook `DEPLOY_URL`). **Attention : le fichier n'est pas dans `.github/workflows/`, GitHub ne l'exécute donc pas en l'état.** Vérifie avec `gh api repos/<propriétaire>/<dépôt>/actions/workflows --jq .total_count` : `0` signifie que pousser sur `main` ne déploie rien. Si l'instance à migrer a déplacé ce fichier dans `.github/workflows/` (et défini `DEPLOY_URL`/`DEPLOY_TOKEN`), alors pousser sur `main` revient à déployer en production : termine les étapes 1 à 6 avant toute fusion et ne bascule (étape 7) que sur accord explicite de l'utilisateur.
- Node 20 ou plus récent est nécessaire (dépendance `better-sqlite3` 12). La refonte est testée avec Node 26.

## 1. Repérer l'installation existante

Trouve comment le serveur tourne, son dossier, sa base et son environnement.

```sh
# Processus Node qui sert l'application
ps aux | grep -E 'server/index\.js' | grep -v grep
# Selon le cas, une seule de ces commandes donnera un résultat utile :
systemctl list-units --type=service | grep -i -E 'bet|odds|duyka|russian'
pm2 jlist 2>/dev/null | head -c 2000
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
```

Une fois le PID connu (`PID`) :

```sh
APP_DIR=$(readlink /proc/$PID/cwd)                 # dossier de l'application
ls -l /proc/$PID/fd | grep -E '\.sqlite'           # fichier de base RÉELLEMENT ouvert
tr '\0' '\n' < /proc/$PID/environ | grep -o -E '^(DB_PATH|PORT|NODE_ENV|INITIAL_INVITE_CODE|VAPID_SUBJECT)=.*'
tr '\0' '\n' < /proc/$PID/environ | grep -o -E '^VAPID_[A-Z_]+'   # noms seulement, jamais les valeurs
```

- systemd : `systemctl cat <unité>` donne `WorkingDirectory`, `ExecStart`, `Environment=` et `EnvironmentFile=` (les VAPID sont souvent dans ce fichier).
- pm2 : `pm2 describe <nom>` et `pm2 env <id>`.
- Docker : `docker inspect <conteneur>` (volumes montés, variables d'environnement). La base doit être sur un **volume**, sinon elle disparaît avec le conteneur. Dans ce cas, fais les commandes `sqlite3` via `docker exec` ou sur le chemin du volume côté hôte.
- Sans `DB_PATH`, la base est `$APP_DIR/data/oddsroom.sqlite`. Le chemin à retenir est celui du `ls -l /proc/$PID/fd`.
- Repère aussi le script côté serveur que le webhook de `.github/deploy.yaml` exécute (`grep -rl DEPLOY_TOKEN /etc /opt /home 2>/dev/null`, sans afficher le contenu du token) : il dit si le déploiement fait `git pull`, `npm ci`, `npm run build` et un redémarrage.

Définis les variables utilisées dans la suite :

```sh
DB_PATH=/chemin/reel/oddsroom.sqlite   # à remplacer
SERVICE=nom-du-service                 # unité systemd, nom pm2 ou conteneur
PORT=3001                              # port de production
BACKUP_DIR=/var/backups/duyka          # hors du dépôt et hors de data/
mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"
```

**Vérification** : `sqlite3 -readonly "$DB_PATH" "SELECT COUNT(*) FROM users;"` renvoie un nombre, et le script de démarrage (unité, config pm2 ou compose) est identifié. Les trois variables `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` sont soit toutes présentes, soit toutes absentes (le serveur refuse de démarrer avec un jeu partiel).

## 2. Noter l'état courant

```sh
cd "$APP_DIR"
git rev-parse HEAD                       # à noter : c'est la cible du rollback (attendu : 41d60ea…)
git status --porcelain                   # doit être vide
node -v                                  # 20 ou plus
sha256sum "$DB_PATH"; ls -l "$DB_PATH"*  # taille et fichiers -wal / -shm
# Empreinte des valeurs VAPID, sans les afficher (à comparer à l'étape 8) :
tr '\0' '\n' < /proc/$PID/environ | grep -E '^VAPID_' | sha256sum
```

Copie les fichiers de configuration du service (unité systemd, `ecosystem.config.js`, `.env`, `docker-compose.yml`) dans `$BACKUP_DIR` avec `chmod 600` : ils contiennent la clé privée VAPID.

**Vérification** : le hash du commit est noté, `git status --porcelain` est vide (sinon demande à l'utilisateur quoi faire des modifications locales, sans rien écraser), Node est en version 20 ou plus.

## 3. Sauvegarde cohérente de la base

La base est en mode WAL : copier uniquement le fichier `.sqlite` pendant que le service tourne donne une sauvegarde incohérente. Utilise l'API de sauvegarde de SQLite, qui est sûre à chaud.

```sh
STAMP=$(date +%Y%m%d-%H%M%S)
sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/avant-migration-$STAMP.sqlite'"
```

Sans l'outil `sqlite3`, depuis un clone du dépôt avec `npm ci` fait :

```sh
node -e "
const Database = require('better-sqlite3');
const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
db.backup(process.argv[2]).then(() => { console.log('sauvegarde ok'); db.close(); })
  .catch((e) => { console.error(e.message); process.exit(1); });
" "$DB_PATH" "$BACKUP_DIR/avant-migration-$STAMP.sqlite"
```

Variante hors ligne (service arrêté) : copie ensemble `oddsroom.sqlite`, `oddsroom.sqlite-wal` et `oddsroom.sqlite-shm` s'ils existent.

```sh
chmod 600 "$BACKUP_DIR"/avant-migration-*.sqlite
sqlite3 "$BACKUP_DIR/avant-migration-$STAMP.sqlite" "PRAGMA integrity_check;"
```

**Vérification** : `integrity_check` affiche `ok`, et le nombre de membres de la sauvegarde est égal à celui de la base en production (requête de l'étape 4). La sauvegarde contient des hachages de mots de passe : ne la copie nulle part hors du serveur sans l'accord de l'utilisateur et ne la commite jamais.

## 4. Empreinte « avant »

Requête de comparaison (réutilisée aux étapes 6 et 8) :

```sh
cat > "$BACKUP_DIR/comparer.sql" <<'SQL'
SELECT
  (SELECT COUNT(*) FROM users)                          AS membres,
  (SELECT COALESCE(SUM(balance), 0) FROM users)         AS somme_soldes,
  (SELECT COUNT(*) FROM markets)                        AS marches,
  (SELECT COUNT(*) FROM markets WHERE status = 'open')  AS marches_ouverts,
  (SELECT COUNT(*) FROM bets)                           AS mises,
  (SELECT COALESCE(SUM(amount), 0) FROM bets)           AS credits_mises,
  (SELECT COUNT(*) FROM push_subscriptions)             AS abonnements_push;
SQL
cat > "$BACKUP_DIR/empreinte.sql" <<'SQL'
SELECT 'users', id, username, balance FROM users ORDER BY id;
SELECT 'bets', id, market_id, user_id, choice_index, amount, decimal_odds FROM bets ORDER BY id;
SELECT 'markets', id, status, outcome_index, cancelled_at FROM markets ORDER BY id;
SQL

sqlite3 -readonly -header "$DB_PATH" < "$BACKUP_DIR/comparer.sql" | tee "$BACKUP_DIR/avant.txt"
sqlite3 -readonly "$DB_PATH" < "$BACKUP_DIR/empreinte.sql" | sha256sum | tee "$BACKUP_DIR/avant.sha"
```

Le second hash couvre chaque solde, chaque mise et chaque marché ligne par ligne. Les tables `sessions` et `invite_codes` sont volontairement exclues : le serveur y supprime au démarrage les sessions expirées et les codes d'amorçage expirés.

**Vérification** : `avant.txt` et `avant.sha` existent et `membres` est supérieur à 0. Si le service reste en ligne, ces valeurs bougeront au gré de l'activité : refais l'empreinte juste avant la bascule (étape 7).

## 5. Installer et tester le nouveau code (dossier séparé)

Ne touche pas à l'instance en production. Travaille dans un autre dossier.

```sh
git clone <URL_DU_DEPOT> /opt/duyka-nouvelle     # clone COMPLET (pas --depth), pour que test/ trouve 41d60ea
cd /opt/duyka-nouvelle
git checkout refonte-polymarket                  # ou la référence indiquée par l'utilisateur
git cat-file -e 41d60ea:server/index.js && echo "ancienne version disponible"
npm ci
npm run build
npm test
```

**Vérification** : `npm ci` et `npm run build` terminent sans erreur, `dist/index.html` existe, `npm test` affiche `fail 0` (aucun test ignoré : si le test de compatibilité est sauté, c'est que le clone est superficiel, corrige-le avec `git fetch --unshallow`). Ces tests utilisent des bases temporaires et ne touchent jamais à `$DB_PATH`.

## 6. Essai à blanc sur une COPIE

Le nouveau serveur est démarré sur une copie de la sauvegarde, avec un autre port et **sans VAPID** (sinon une action de test enverrait de vraies notifications aux abonnés de la copie).

```sh
cd /opt/duyka-nouvelle
cp "$BACKUP_DIR/avant-migration-$STAMP.sqlite" /tmp/essai.sqlite
sqlite3 -readonly -header /tmp/essai.sqlite < "$BACKUP_DIR/comparer.sql" > /tmp/essai-avant.txt
sqlite3 -readonly /tmp/essai.sqlite < "$BACKUP_DIR/empreinte.sql" | sha256sum > /tmp/essai-avant.sha

npm run db:verifier -- /tmp/essai.sqlite          # attendu : avertissements éventuels, RÉSULTAT : OK

DB_PATH=/tmp/essai.sqlite PORT=3999 VAPID_PUBLIC_KEY= VAPID_PRIVATE_KEY= VAPID_SUBJECT= \
  node server/index.js > /tmp/essai.log 2>&1 &
ESSAI_PID=$!
until curl -fsS http://127.0.0.1:3999/api/me 2>/dev/null; do sleep 1; done
echo
curl -s -o /dev/null -w 'activity=%{http_code}\n' http://127.0.0.1:3999/api/activity     # 401 avec la nouvelle version (404 avec l'ancienne)
curl -s -o /dev/null -w 'fiche=%{http_code}\n'    http://127.0.0.1:3999/api/markets/x    # 401 (404 avec l'ancienne)
curl -s http://127.0.0.1:3999/ | grep -o '<title>[^<]*</title>'
kill $ESSAI_PID; wait $ESSAI_PID 2>/dev/null

sqlite3 -readonly -header /tmp/essai.sqlite < "$BACKUP_DIR/comparer.sql" > /tmp/essai-apres.txt
sqlite3 -readonly /tmp/essai.sqlite < "$BACKUP_DIR/empreinte.sql" | sha256sum > /tmp/essai-apres.sha
diff /tmp/essai-avant.txt /tmp/essai-apres.txt && diff /tmp/essai-avant.sha /tmp/essai-apres.sha && echo "IDENTIQUE"
npm run db:verifier -- /tmp/essai.sqlite --strict  # attendu : RÉSULTAT : OK, sans avertissement
sqlite3 -readonly /tmp/essai.sqlite "SELECT name FROM sqlite_master WHERE name IN ('market_comments','idx_market_comments_market','idx_bets_created');"
```

**Vérification** : `/api/me` répond `{"user":null}`, `activity` et `fiche` valent `401`, le titre contient « DUyka PARIS », le journal `/tmp/essai.log` ne contient aucune erreur et affiche `DUyka PARIS API listening`, `diff` ne montre aucune différence et affiche `IDENTIQUE`, le mode `--strict` donne `RÉSULTAT : OK`, et la dernière requête liste les trois objets ajoutés. Supprime ensuite la copie : `rm -f /tmp/essai.sqlite* /tmp/essai-*`.

Si une comparaison diffère, **ne bascule pas** : c'est un bug de migration, signale-le à l'utilisateur avec la sortie des `diff`.

## 7. Bascule

Demande d'abord l'accord explicite de l'utilisateur et annonce l'interruption (quelques secondes). Choisis le cas qui correspond à l'étape 1.

**Cas A, déploiement par webhook (`.github/deploy.yaml`)** : l'utilisateur fusionne ou pousse lui-même sur `main`. Juste avant, refais la sauvegarde de l'étape 3 (nouveau `STAMP`). Après le déclenchement, surveille les journaux du service et passe à l'étape 8. Si le script serveur du webhook ne fait pas `npm ci`, `npm run build` et un redémarrage, fais-le à la main comme dans le cas B.

**Cas B, déploiement manuel dans `$APP_DIR`** :

```sh
sudo systemctl stop "$SERVICE"          # ou : pm2 stop "$SERVICE" / docker compose stop
STAMP=$(date +%Y%m%d-%H%M%S)
sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/juste-avant-bascule-$STAMP.sqlite'"
sqlite3 "$BACKUP_DIR/juste-avant-bascule-$STAMP.sqlite" "PRAGMA integrity_check;"
sqlite3 -readonly -header "$DB_PATH" < "$BACKUP_DIR/comparer.sql" | tee "$BACKUP_DIR/avant.txt"
sqlite3 -readonly "$DB_PATH" < "$BACKUP_DIR/empreinte.sql" | sha256sum | tee "$BACKUP_DIR/avant.sha"

cd "$APP_DIR"
git fetch origin
git checkout refonte-polymarket         # ou la référence validée à l'étape 5
npm ci
npm run build
sudo systemctl start "$SERVICE"         # ou : pm2 start / docker compose up -d --build
```

Les variables d'environnement du service (`DB_PATH`, `PORT`, `NODE_ENV`, VAPID) restent **inchangées** : ne les modifie pas. `data/` est ignoré par git et n'est donc pas touché par `git checkout`.

**Vérification** : le service est actif (`systemctl is-active "$SERVICE"` affiche `active`) et le journal affiche `DUyka PARIS API listening on http://localhost:<PORT>`.

## 8. Vérifications post-déploiement

```sh
curl -fsS "http://127.0.0.1:$PORT/api/me"                                           # {"user":null}
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT/api/activity"      # 401
curl -s "http://127.0.0.1:$PORT/" | grep -o '<title>[^<]*</title>'                   # DUyka PARIS
curl -fsS "http://127.0.0.1:$PORT/manifest.webmanifest" | grep -o '"short_name": "[^"]*"'
curl -fsSI https://<DOMAINE>/ | head -1                                             # HTTP/2 200 (via le proxy HTTPS)

cd "$APP_DIR" && npm run db:verifier -- "$DB_PATH" --strict                          # RÉSULTAT : OK
sqlite3 -readonly -header "$DB_PATH" < "$BACKUP_DIR/comparer.sql"                    # à comparer à avant.txt
sqlite3 -readonly "$DB_PATH" < "$BACKUP_DIR/empreinte.sql" | sha256sum               # à comparer à avant.sha
PID=$(pgrep -f 'server/index.js' | head -1)
tr '\0' '\n' < /proc/$PID/environ | grep -E '^VAPID_' | sha256sum                    # identique à l'étape 2
```

**Vérification** : toutes les commandes ci-dessus donnent le résultat attendu ; `membres`, `somme_soldes`, `marches`, `mises`, `credits_mises` et `abonnements_push` sont égaux à `avant.txt` (si des membres ont joué entre la sauvegarde et maintenant, seules `mises`, `credits_mises` et `somme_soldes` peuvent légitimement bouger, jamais `membres` ni `marches` à la baisse) ; l'empreinte VAPID est identique à celle de l'étape 2 ; le journal ne contient pas d'erreur `Web Push`.

Vérifications à demander à l'utilisateur (elles exigent un compte) : se connecter avec un compte existant et retrouver son solde, ouvrir une fiche marché, publier un commentaire, puis ouvrir **Alertes** et vérifier que les notifications restent actives. Les abonnements push existants restent valides tant que les clés VAPID n'ont pas changé.

## 9. Rollback

Le retour arrière ne touche pas à la base : l'ancienne version fonctionne telle quelle sur la base migrée (elle ignore `market_comments`). Les commentaires déjà publiés restent en base, invisibles, et réapparaîtront si l'utilisateur remigre.

```sh
sudo systemctl stop "$SERVICE"
cd "$APP_DIR"
git checkout <HASH_NOTÉ_À_L_ÉTAPE_2>     # normalement 41d60ea
npm ci
npm run build                            # recrée dist/ de l'ancienne version
sudo systemctl start "$SERVICE"
curl -fsS "http://127.0.0.1:$PORT/api/me"
```

Si le déploiement passe par le webhook, désactive-le (ou dis à l'utilisateur de ne pas pousser sur `main`) tant que le retour arrière est en place : un nouveau `push` redéploierait la refonte.

**Vérification** : `curl http://127.0.0.1:$PORT/api/activity` renvoie `404` (route absente de l'ancienne version), `/api/me` répond, et `sqlite3 -readonly "$DB_PATH" "PRAGMA integrity_check;"` affiche `ok`.

Restaurer la sauvegarde (**dernier recours**, uniquement si la base elle-même est endommagée ; toute activité depuis la sauvegarde est perdue, demande l'accord de l'utilisateur) :

```sh
sudo systemctl stop "$SERVICE"
mv "$DB_PATH" "$DB_PATH.abime-$(date +%s)"
rm -f "$DB_PATH-wal" "$DB_PATH-shm"      # sinon d'anciens journaux WAL corrompent la base restaurée
cp "$BACKUP_DIR/juste-avant-bascule-<STAMP>.sqlite" "$DB_PATH"
sqlite3 "$DB_PATH" "PRAGMA integrity_check;"
sudo systemctl start "$SERVICE"
```

## 10. Points d'attention

- **Nom du site** : il se change uniquement dans `brand.config.json` (`name`, `wordmark`, `tagline`, `description`). Il est lu au build (titre, manifeste) et au démarrage du serveur : après modification, relance `npm run build` puis redémarre le service. Le fichier doit être présent à côté de `server/` à l'exécution (image Docker comprise), sinon le serveur ne démarre pas.
- **HTTPS obligatoire** pour le push et l'app installable (hors `localhost`). Avec `NODE_ENV=production` les cookies de session sont `secure` : en HTTP simple, la connexion échoue.
- **VAPID** : conserve les trois variables à l'identique. Des clés différentes rendent invalides tous les abonnements push existants (les membres devraient les réactiver un par un).
- **Service worker** : la nouvelle version supprime tous les anciens caches. Un rechargement peut être nécessaire pour qu'un navigateur récupère la nouvelle app ; l'app déjà installée sur un téléphone peut garder l'ancien nom ou l'ancienne icône jusqu'à réinstallation.
- **API** : mêmes routes et mêmes formes qu'avant ; les messages d'erreur sont désormais en français. Ajouts : `GET /api/markets/:id`, `POST /api/markets/:id/comments`, `GET /api/activity`, et `GET /api/leaderboard?limit=` (avec `volume`, `positions`, `inPlay`, `pnl` en plus).
- **Cote affichée** : la cote décimale stockée en base ne change pas ; l'interface l'affiche en probabilité et en prix en centimes (≈ 100 / cote).
- **Contrôle de la base à tout moment** : `npm run db:verifier -- <chemin>` (lecture seule, code de sortie non nul en cas de problème).

## 11. Économie commune avec le poker (mode banque)

À faire **après** la migration ci-dessus, et seulement quand le poker expose son API interne de banque. Le contrat complet est dans `/tmp/economie-commune/CONTRAT.md` (ou chez l'orchestrateur).

- **Variables** : `BANQUE_URL=http://poker:8497` (déjà dans `deploy/compose.yaml`, les deux conteneurs sont sur le réseau `npm_default`) et `BANQUE_SECRET`, **identique** à `POKER_BANQUE_SECRET` côté poker. `BANQUE_SECRET` va dans `gamble.env` (0600, hors dépôt, déjà chargé en `env_file` facultatif). Ne jamais afficher, consigner ni commiter sa valeur. Le mode banque n'est actif que si les **deux** variables sont définies : sans le secret, le site reste en autonome.
- **Ordre de déploiement** : 1) poker (avec l'API `/interne/banque/` et son secret) ; 2) réinitialisation unique des soldes poker (script poker, lancé par l'orchestrateur, pas par toi) ; 3) paris, avec `BANQUE_SECRET` dans `gamble.env`. Déployer le paris avant le poker donnerait « Le poker ne répond pas » aux connexions.
- **Schéma** : deux tables additives créées au démarrage, `comptes_banque` et `banque_en_attente`. Aucune colonne ni contrainte existante ne change : l'ancienne version tourne toujours sur la base (rollback inchangé, mais en mode autonome les soldes reviennent aux miroirs locaux).
- **Effets visibles** : les sessions de comptes non liés sont fermées (il faut se reconnecter ; la connexion migre l'ancien compte vers le poker). Les marchés ouverts restent ; un gain ou un remboursement sur une mise d'avant la bascule est versé à la banque si le membre est lié, sinon crédité localement comme avant.
- **Vérification** après bascule : `docker logs gamble` affiche « mode banque » au démarrage ; une connexion avec un compte poker fonctionne ; `sqlite3 donnees/oddsroom.sqlite "SELECT cle, essais, derniere_erreur FROM banque_en_attente WHERE essais >= 0"` est vide en régime normal (des lignes qui persistent avec `essais` croissant = la banque refuse ou ne répond pas : à signaler, ne pas les supprimer).
- **Retour en autonome** : retirer `BANQUE_SECRET` de `gamble.env` et redémarrer. Les mouvements encore en file restent dans `banque_en_attente` et repartiront au prochain passage en mode banque.

## Ce que l'agent ne doit pas faire

- Ne jamais supprimer, déplacer ou écraser `data/` ni le fichier `DB_PATH` et ses `-wal` / `-shm` (pas de `rm -rf data`, pas de `git clean -x`, pas de `git reset --hard` sur le dossier de production, pas de `rsync --delete` qui l'inclurait).
- Ne jamais lancer `scripts/seed-demo.js` sur la production ni sur une copie qu'on pourrait confondre avec elle : c'est un script de développement qui crée de faux comptes.
- Ne jamais copier le seul fichier `.sqlite` d'une base en WAL pendant que le service tourne ; utiliser `.backup` ou arrêter le service.
- Ne jamais démarrer le serveur de test sur la base de production, ni avec les variables VAPID de production sur une copie.
- Ne jamais modifier ni régénérer `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, ni afficher ou consigner leurs valeurs (cette consigne vaut aussi pour `DEPLOY_TOKEN` et `BANQUE_SECRET`).
- Ne jamais pousser, fusionner sur `main` ni déclencher le webhook de déploiement sans l'accord explicite de l'utilisateur.
- Ne jamais commiter une sauvegarde, une copie de base ou un fichier d'environnement.
- Ne jamais créer de comptes, de marchés ou de mises de test en production.
- Ne pas passer à l'étape suivante si un critère de vérification n'est pas rempli.
