#!/usr/bin/env bash
# Deploy de viewer en de spelserver naar de server uit .env (zie .env.example).
# Gebruik: ./deploy.sh — vanuit de repo-root of waar dan ook.
# Volgorde: rooktest → nginx-config → rsync → revisienotitie → controles.
#
# Eenmalig ingericht, niet door dit script:
# - Cloudflare: A-record van het domein naar de server en CNAME www, beide
#   geproxied; SSL-modus "Full (strict)", Always Use HTTPS, minimaal TLS 1.2.
# - Server: Cloudflare Origin CA-certificaat in /etc/ssl/certs/diku3d.com.origin.pem,
#   sleutel in /etc/ssl/private/diku3d.com.key (alleen root). Geen certbot:
#   alleen Cloudflare hoeft dit certificaat te vertrouwen.
# - ssh naar DEPLOY_HOST zonder wachtwoord, met sudo zonder wachtwoord.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
# Waar het heen gaat staat niet in de repo, maar in het gitignorede .env.
[ -f "$ROOT/.env" ] || { echo "✗  $ROOT/.env ontbreekt; kopieer .env.example en vul het in" >&2; exit 1; }
# shellcheck source=/dev/null
. "$ROOT/.env"
: "${DEPLOY_HOST:?DEPLOY_HOST ontbreekt in .env}"
SERVER="$DEPLOY_HOST"
DOCMAP="${DEPLOY_DIR:-/srv/diku3d}"
SITE="${DEPLOY_SITE:-diku3d-com}"
DOMEIN="${DEPLOY_URL:-https://diku3d.com}"

# --- 0. Revisie bepalen; niet-gecommit werk mag mee, maar niet ongemerkt.
SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  echo "⚠︎  Werkboom bevat niet-gecommitte wijzigingen — die worden mee gedeployed." >&2
fi
echo "▸ Deploy $SHA → $SERVER:$DOCMAP"

# --- 1. Rooktest. Er is geen build; dit zijn de goedkope checks uit CLAUDE.md
# die een kapotte pagina tegenhouden (syntaxis, imports, alle 45 .are-bestanden).
echo "▸ Rooktest"
(cd "$ROOT" && node --check src/*.js src/rules/*.js server/*.mjs \
  && node tools/import-check.mjs >/dev/null \
  && node tools/parse-check.mjs >/dev/null)
[ -f "$ROOT/merc21/area/midgaard.are" ] || { echo "✗  merc21/ is niet uitgecheckt (git submodule update --init)" >&2; exit 1; }

# --- 2. nginx-config uit de repo; alleen herladen als hij veranderd is, en
# nooit zonder dat `nginx -t` hem goedkeurt (de andere sites draaien mee).
echo "▸ nginx"
ssh "$SERVER" "sudo tee /etc/nginx/sites-available/$SITE.new >/dev/null" < "$ROOT/tools/deploy/nginx-diku3d.conf"
ssh "$SERVER" "set -e
  cd /etc/nginx/sites-available
  if sudo cmp -s $SITE.new $SITE; then sudo rm $SITE.new; exit 0; fi
  [ -f $SITE ] && sudo cp $SITE $SITE.prev
  sudo mv $SITE.new $SITE
  sudo ln -sf ../sites-available/$SITE /etc/nginx/sites-enabled/$SITE
  sudo mkdir -p $DOCMAP
  if sudo nginx -t 2>/dev/null; then sudo systemctl reload nginx; echo '  config vernieuwd'
  else
    echo '✗  nginx -t keurt de nieuwe config af; vorige teruggezet' >&2
    if [ -f $SITE.prev ]; then sudo mv $SITE.prev $SITE; else sudo rm -f $SITE /etc/nginx/sites-enabled/$SITE; fi
    sudo nginx -t; exit 1
  fi"

# --- 3. Alleen wat de browser ophaalt, plus de licenties (Diku en Merc eisen
# dat de credits meegaan). -R houdt de paden relatief aan de repo; de map is
# van root, dus rsync draait via sudo. -t bewaart tijdstempels, zodat
# ongewijzigde bestanden met een 304 afgaan.
echo "▸ rsync"
(cd "$ROOT" && rsync -rlptR --delete --rsync-path="sudo rsync" \
  --exclude .DS_Store --exclude /server/node_modules --exclude /server/data \
  index.html src vendor assets merc21/area LICENSE server \
  merc21/doc/license.txt merc21/doc/license.doc \
  "$SERVER:$DOCMAP/")

# --- 4. Revisie vastleggen op de server (cat /srv/diku3d/REVISION);
# nginx geeft het bestand niet uit.
ssh "$SERVER" "sudo tee $DOCMAP/REVISION >/dev/null" <<EOF
$SHA $(date +%Y-%m-%dT%H:%M:%S)
EOF

# --- 4b. De spelserver (server/, systemd diku3d-server op 127.0.0.1:4000).
# Spelersbestanden, notes, bans en de wizlock staan in $DATA, buiten de
# gedeployde boom; bij de allereerste start staat de wizlock aan (alleen
# immortals), tot een implementor hem met `wizlock` uitzet.
DATA="${DEPLOY_DATA:-/srv/diku3d-data}"
echo "▸ spelserver"
ssh "$SERVER" "sudo tee /etc/systemd/system/diku3d-server.service.new >/dev/null" < "$ROOT/tools/deploy/diku3d-server.service"
ssh "$SERVER" "set -e
  id diku3d >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin diku3d
  sudo install -d -o diku3d -g diku3d -m 750 $DATA
  [ -f $DATA/site.json ] || echo '{ \"version\": 1, \"wizlock\": true, \"bans\": [] }' | sudo -u diku3d tee $DATA/site.json >/dev/null
  cd $DOCMAP/server && sudo npm ci --omit=dev --no-audit --no-fund --silent
  cd /etc/systemd/system
  if ! sudo cmp -s diku3d-server.service.new diku3d-server.service; then
    sudo mv diku3d-server.service.new diku3d-server.service && sudo systemctl daemon-reload && echo '  unit vernieuwd'
  else sudo rm diku3d-server.service.new; fi
  sudo systemctl enable --quiet diku3d-server
  sudo systemctl restart diku3d-server
  sleep 2
  systemctl is-active --quiet diku3d-server || { sudo journalctl -u diku3d-server -n 30 --no-pager; exit 1; }"

# --- 5. Van buitenaf, door Cloudflare: de pagina, de eerste module, een
# gebied en een model moeten er zijn, en het gebied moet als tekst komen.
echo "▸ Controle"
for pad in / /src/main.js /vendor/three/build/three.module.js /merc21/area/midgaard.are /assets/person_male.glb; do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "$DOMEIN$pad")"
  [ "$CODE" = "200" ] || { echo "✗  $DOMEIN$pad antwoordt met HTTP $CODE" >&2; exit 1; }
done
TYPE="$(curl -sI "$DOMEIN/merc21/area/midgaard.are" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2}')"
case "$TYPE" in text/plain*) ;; *) echo "✗  .are komt als '$TYPE'" >&2; exit 1 ;; esac
# De WebSocket moet door Cloudflare en nginx tot de server komen (101), en
# de broncode van de server mag niet als website uitgeleverd worden.
WS="$(curl -s --http1.1 --max-time 5 -o /dev/null -w '%{http_code}' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$DOMEIN/ws" || true)"
[ "$WS" = "101" ] || { echo "✗  $DOMEIN/ws geeft $WS in plaats van 101" >&2; exit 1; }
SRC="$(curl -s -o /dev/null -w '%{http_code}' "$DOMEIN/server/main.mjs")"
[ "$SRC" = "404" ] || { echo "✗  $DOMEIN/server/main.mjs geeft $SRC in plaats van 404" >&2; exit 1; }

echo "✓ Online: $DOMEIN (revisie $SHA)"
