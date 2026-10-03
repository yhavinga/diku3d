#!/usr/bin/env bash
# Deploy de single-player-viewer naar de server uit .env (zie .env.example).
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
(cd "$ROOT" && node --check src/*.js src/rules/*.js \
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
  --exclude .DS_Store \
  index.html src vendor assets merc21/area LICENSE \
  merc21/doc/license.txt merc21/doc/license.doc \
  "$SERVER:$DOCMAP/")

# --- 4. Revisie vastleggen op de server (cat /srv/diku3d/REVISION);
# nginx geeft het bestand niet uit.
ssh "$SERVER" "sudo tee $DOCMAP/REVISION >/dev/null" <<EOF
$SHA $(date +%Y-%m-%dT%H:%M:%S)
EOF

# --- 5. Van buitenaf, door Cloudflare: de pagina, de eerste module, een
# gebied en een model moeten er zijn, en het gebied moet als tekst komen.
echo "▸ Controle"
for pad in / /src/main.js /vendor/three/build/three.module.js /merc21/area/midgaard.are /assets/person_male.glb; do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "$DOMEIN$pad")"
  [ "$CODE" = "200" ] || { echo "✗  $DOMEIN$pad antwoordt met HTTP $CODE" >&2; exit 1; }
done
TYPE="$(curl -sI "$DOMEIN/merc21/area/midgaard.are" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2}')"
case "$TYPE" in text/plain*) ;; *) echo "✗  .are komt als '$TYPE'" >&2; exit 1 ;; esac

echo "✓ Online: $DOMEIN (revisie $SHA)"
