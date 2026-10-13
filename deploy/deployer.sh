#!/bin/sh
# Envoie le code sur le serveur et reconstruit le conteneur « gamble » (lui seul).
#   sh deploy/deployer.sh            # tests, sauvegarde de la base, rsync, rebuild, vérifications
#   FORCER=1 sh deploy/deployer.sh   # accepte que le rsync supprime des fichiers modifiés en prod
set -eu
cd "$(dirname "$0")/.."

SERVEUR=hermes-ivan
DOSSIER=/home/evg/ivan/gamble                     # src/ (code), donnees/ (base SQLite), compose.yaml
SAUVEGARDES=/home/evg/ivan/gamble-deploiements    # une copie horodatée de la base avant chaque rebuild
URL_PUBLIQUE=${URL_PUBLIQUE:-https://gamble.dyuka.com}   # domaine dédié (l'ancienne adresse poker.dyuka.com/paris/ redirige ici)

# 1. Tests locaux : on n'envoie rien si ça casse.
npm test

# 2. Préparation des dossiers sur le serveur.
ssh "$SERVEUR" "mkdir -p '$DOSSIER/src' '$DOSSIER/donnees' '$SAUVEGARDES'"

# 3. Garde-fou : rsync --delete écraserait toute modification faite directement dans src/ en prod.
#    On liste d'abord (simulation) ce qui serait supprimé ; on s'arrête s'il y en a, sauf FORCER=1.
suppressions=$(rsync -azn --delete --itemize-changes --exclude-from=.dockerignore ./ "$SERVEUR:$DOSSIER/src/" \
  | grep '^\*deleting' || true)
if [ -n "$suppressions" ] && [ "${FORCER:-0}" != 1 ]; then
  echo "ABANDON : le rsync supprimerait ces fichiers présents en prod mais pas en local :"
  echo "$suppressions"
  echo "Compare avec « diff -r » puis relance, ou utilise FORCER=1 si c'est voulu."
  exit 2
fi

# 4. Sauvegarde horodatée de la base AVANT toute reconstruction.
#    Ordre de préférence : sqlite3 .backup, sinon l'API de sauvegarde de python3 (même mécanisme,
#    sans arrêt), sinon arrêt du conteneur puis copie de la base et de ses -wal/-shm.
ssh "$SERVEUR" "sh -s" "$DOSSIER" "$SAUVEGARDES" <<'DISTANT'
set -eu
DOSSIER=$1
SAUVEGARDES=$2
BASE="$DOSSIER/donnees/oddsroom.sqlite"
if [ ! -f "$BASE" ]; then
  echo "Sauvegarde : pas encore de base (premier déploiement), rien à copier."
  exit 0
fi
DEST="$SAUVEGARDES/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$BASE" ".backup '$DEST/oddsroom.sqlite'"
  echo "Sauvegarde (sqlite3 .backup) : $DEST/oddsroom.sqlite"
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$BASE" "$DEST/oddsroom.sqlite" <<'PY'
import sqlite3, sys
src = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
ok = dst.execute("PRAGMA integrity_check").fetchone()[0]
dst.close(); src.close()
if ok != "ok":
    sys.exit("Sauvegarde corrompue : " + ok)
PY
  echo "Sauvegarde (python3, API backup) : $DEST/oddsroom.sqlite"
else
  # Dernier recours : base au repos, on arrête le conteneur le temps de la copie.
  ( cd "$DOSSIER" && docker compose stop gamble </dev/null ) || true
  for f in "$BASE" "$BASE-wal" "$BASE-shm"; do
    [ -f "$f" ] && cp -p "$f" "$DEST/"
  done
  echo "Sauvegarde (copie après arrêt) : $DEST"
fi
DISTANT

# 5. Envoi du code et du compose.
rsync -az --delete --exclude-from=.dockerignore ./ "$SERVEUR:$DOSSIER/src/"
scp -q deploy/compose.yaml "$SERVEUR:$DOSSIER/compose.yaml"

# 6. Reconstruction et redémarrage du seul conteneur gamble.
ssh "$SERVEUR" "cd '$DOSSIER' && docker compose build -q && docker compose up -d --no-deps gamble"

# 7. Vérifications : état compose, puis healthcheck (jusqu'à ~90 s).
ssh "$SERVEUR" "cd '$DOSSIER' && docker compose ps"
etat=starting
for _ in $(seq 30); do
  etat=$(ssh "$SERVEUR" "docker inspect --format '{{.State.Health.Status}}' gamble" 2>/dev/null || echo absent)
  [ "$etat" = healthy ] && break
  sleep 3
done
if [ "$etat" != healthy ]; then
  echo "ÉCHEC : le conteneur gamble n'est pas « healthy » (état : $etat)."
  ssh "$SERVEUR" "docker logs --tail 40 gamble" || true
  echo "La sauvegarde de la base est dans $SAUVEGARDES (ssh $SERVEUR ls -t $SAUVEGARDES | head -1)."
  exit 1
fi
echo "OK : conteneur gamble healthy."

# 8. Contrôle public, à titre d'information (échoue tant que l'hôte NPM / le DNS ne sont pas en place).
code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$URL_PUBLIQUE/api/me" || true)
echo "Contrôle public $URL_PUBLIQUE/api/me : HTTP ${code:-000} (attendu : 200 une fois NPM + DNS configurés)."
