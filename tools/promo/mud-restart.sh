#!/bin/sh
# Fresh promo server: the party re-seeded into room $1, the world reset (so
# the mobiles stand where the area files put them). Port 4051, data /tmp/promo-data.
cd "$(dirname "$0")/../.." || exit 1
pids=$(lsof -ti tcp:4051); [ -n "$pids" ] && kill $pids; sleep 1
node tools/promo/mp-seed.mjs /tmp/promo-data "${1:-3014}" > /dev/null || exit 1
(cd server && nohup node main.mjs --port 4051 --data /tmp/promo-data > /tmp/promo-server.log 2>&1 &)
sleep 4; tail -1 /tmp/promo-server.log
