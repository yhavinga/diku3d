// Players without a page: a WebSocket each, logged in to a diku3d server,
// standing where they are told and typing what they are told. They are the
// promo's party -- the camera's page draws them as it draws anyone else.
//
//   const party = await startBots(['Kestrel', 'Thorne'], { port: 4051, password });
//   party.Kestrel.stand(zone, x, y, z, yaw);   // client coordinates, feet
//   party.Kestrel.cmd('follow beorn');
//   party.Kestrel.heard                         // every line the server told it
//
// The server judges every position it is sent (server/mud.mjs `position`):
// a point outside the room the body is in is refused and answered with 'at'.
// A bot keeps the last 'at' (where the server put it) and its sequence number.
import WebSocket from '../../server/node_modules/ws/index.js';

export async function startBot(name, { port = 4051, password = 'promo1993', log = () => {} } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const bot = { name, ws, seq: 0, at: null, room: null, heard: [], listeners: [] };
  let resolveEnter;
  const entered = new Promise((r) => { resolveEnter = r; });
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.t === 'hello') ws.send(JSON.stringify({ t: 'login', name, password }));
    else if (msg.t === 'login' && !msg.ok) throw new Error(`${name}: login refused: ${msg.why}`);
    else if (msg.t === 'enter') { bot.seq = msg.seq; bot.room = msg.room; resolveEnter(msg); }
    else if (msg.t === 'at') { bot.seq = msg.seq; bot.at = msg; bot.room = msg.room; }
    else if (msg.t === 'ev') {
      for (const e of msg.e || []) {
        if (e.kind === 'follow' && e.to) bot.room = e.to;
        if (e.text) { bot.heard.push(e.text); log(`${name} hears: ${e.text}`); }
        for (const fn of bot.listeners) fn(e);
      }
    }
  });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  await entered;
  bot.cmd = (line) => ws.send(JSON.stringify({ t: 'cmd', line }));
  bot.stand = (zone, x, y, z, yaw = 0) => ws.send(JSON.stringify({ t: 'pos', zone, x, y: y + 1.72, z, yaw, seq: bot.seq }));
  bot.close = () => ws.close();
  return bot;
}

export async function startBots(names, options) {
  const out = {};
  for (const name of names) out[name] = await startBot(name, options);
  return out;
}
