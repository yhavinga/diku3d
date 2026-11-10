# Security

If you find a way to harm the game server, its players or the people who open
the page, please tell me privately before telling anyone else.

## How to report

On GitHub, open this repository's **Security** tab and choose **Report a
vulnerability**. That goes to me alone; nobody else can read it. Please do not
open a public issue or a pull request for it.

Say what you did, what happened, and what you expected. A script or the exact
messages you sent are worth more than a description.

## What counts

- the game server (`server/`): anything a client can send that crashes it,
  gets into another player's account, reads what it should not, or gives a
  character what the rules would not;
- the terminal gateway (`server/gateway.mjs`, `server/term.mjs`);
- the page (`index.html`, `src/`): script or markup that a link, a name or a
  server can put into it;
- the configuration in `tools/deploy/` and `deploy.sh`.

A way to win a fight the mud would have you lose is a bug, not a
vulnerability: an ordinary issue is fine for that.

## Trying things out

Try them on a server of your own, not on diku3d.com, where people are playing:

    cd server && npm ci
    node main.mjs --data /tmp/diku3d-data      # ws://127.0.0.1:4011/ws
    python3 serve.py                           # the page, on http://localhost:8173/

`node tools/hostile-check.mjs` is a client that does not play by the page's
rules; it shows how to talk to a server in a few lines, and a new case for it
is the best form a report can take.

## What happens next

This is one person's project, so there is no bounty and no promised hours. I
read every report, fix what is real, and say so in the commit; if you want to
be named for it, tell me how.
