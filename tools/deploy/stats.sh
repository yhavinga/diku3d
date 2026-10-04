#!/usr/bin/env bash
# Visitor statistics for the site from its own nginx log, as one HTML page.
# Gebruik: tools/deploy/stats.sh [uitvoer.html]   (standaard /tmp/diku3d-stats.html)
# Nothing runs in the visitor's browser: GoAccess reads the server's log
# (real visitor addresses, see nginx-diku3d.conf), rotated files included.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
. "$ROOT/.env"
: "${DEPLOY_HOST:?DEPLOY_HOST ontbreekt in .env}"
OUT="${1:-/tmp/diku3d-stats.html}"
ssh "$DEPLOY_HOST" 'cd /var/log/nginx && { sudo zcat -f $(ls -tr diku3d.access.log* 2>/dev/null); } \
  | goaccess - --log-format=COMBINED --ignore-crawlers --html-report-title="diku3d.com" -o html' > "$OUT"
echo "✓ $OUT"
command -v open >/dev/null && open "$OUT" || true
