/**
 * The per-address socket cap and its operator overrides (LIMITS.siteSockets,
 * DIKU_SITE_SOCKETS): capFor over the address forms, the env format, and a
 * real mud on a free port that refuses the Nth socket from an address, the
 * way nginx's x-real-ip header names it.
 *
 *     (cd server && npm ci) && node tools/site-sockets-check.mjs
 *
 * Exits non-zero if any assertion fails.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'server/package.json'));
let WebSocket;
try { WebSocket = require('ws'); } catch (error) {
  throw new Error(`tools/site-sockets-check.mjs needs the server's dependencies: (cd server && npm ci) -- ${error.message}`);
}
const { startMud, capFor, parseSiteSockets } = await import('../server/mud.mjs');

const failures = [];
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail !== undefined ? `  (${detail})` : ''}`);
  if (!ok) failures.push(label);
};

const lim = {
  socketsPerSite: 4,
  siteSockets: [
    { site: '2001:db8:1:2::/64', n: 8 },
    { site: '203.0.113.7', n: 6 },
    { site: '2001:db8:5::9', n: 3 },
    { site: '2001:db8:a000::/36', n: 5 },
  ],
};
check(capFor('203.0.113.7', lim) === 6, 'exact v4');
check(capFor('203.0.113.8', lim) === 4, 'other v4 keeps the default');
check(capFor('2001:db8:5::9', lim) === 3, 'exact v6');
check(capFor('2001:db8:5::a', lim) === 4, 'neighbouring v6 keeps the default');
check(capFor('2001:db8:1:2:aaaa:bbbb:cccc:dddd', lim) === 8, '/64, first interface id');
check(capFor('2001:db8:1:2::1', lim) === 8, '/64, second interface id');
check(capFor('2001:db8:1:3::1', lim) === 4, 'v6 outside the /64');
check(capFor('2001:DB8:1:2:0:0:0:ABCD', lim) === 8, 'uppercase, written out in full');
check(capFor('2001:0db8:0001:0002::1', lim) === 8, 'leading zeros');
check(capFor('::ffff:203.0.113.7', lim) === 6, 'IPv4-mapped counts as the IPv4 address');
check(capFor('::ffff:cb00:7108', lim) === 4, 'mapped hex form of another address');
check(capFor('::ffff:cb00:0107', lim) === 4, 'mapped hex form of 203.0.1.7 is not 203.0.113.7');
check(capFor('2001:db8:a000::1', lim) === 5 && capFor('2001:db8:afff:1::1', lim) === 5 && capFor('2001:db8:b000::1', lim) === 4, 'prefix off a nibble boundary (/36)');
check(capFor('?', lim) === 4, 'an unreadable host gets the default');
check(capFor('1.2.3.4', { socketsPerSite: 4, siteSockets: [{ site: '1.2.3.0/24', n: 9 }] }) === 9, 'v4 prefix');
check(capFor('1.2.3.4', { socketsPerSite: 4 }) === 4, 'no list at all');

console.log('env format');
const parsed = parseSiteSockets('2001:db8:1:2::/64=8, 203.0.113.7=6');
check(parsed.length === 2 && parsed[0].site === '2001:db8:1:2::/64' && parsed[0].n === 8 && parsed[1].n === 6, 'two entries read');
check(parseSiteSockets('').length === 0 && parseSiteSockets(undefined).length === 0, 'empty and unset give no overrides');
for (const bad of ['203.0.113.7', '203.0.113.7=', '203.0.113.7=0', '203.0.113.7=-2', '203.0.113.7=1.5', '203.0.113.7=x', 'nonsense=4', '2001:db8::/129=4', '2001:db8:::1=4', '1.2.3.4/33=4', '203.0.113.7=6,oops']) {
  let message = null;
  try { parseSiteSockets(bad); } catch (error) { message = error.message; }
  check(message !== null && message.includes('DIKU_SITE_SOCKETS') && message.includes(bad.split(',').pop().trim()), `malformed ${JSON.stringify(bad)} throws and names the entry`);
}

console.log('a real mud');
const data = mkdtempSync(join(tmpdir(), 'diku3d-site-sockets-'));
const mud = await startMud({
  root, dataDir: data, port: 0, seed: 4011, log: () => {},
  limits: { socketsPerSite: 2, siteSockets: [{ site: '2001:db8:1:2::/64', n: 4 }] },
});
const url = `ws://127.0.0.1:${mud.port}/ws`;
const open = (ip) => new Promise((resolve) => {
  const ws = new WebSocket(url, { headers: { 'x-real-ip': ip } });
  ws.on('open', () => resolve({ ws, ok: true }));
  ws.on('close', (code) => resolve({ ws, ok: false, code }));
  ws.on('error', () => {});
});
// An accepted socket is told hello; a refused one is closed with 1013 and never says anything.
const settle = (c) => new Promise((resolve) => {
  if (!c.ok) return resolve(c.code);
  const timer = setTimeout(() => resolve('open'), 400);
  c.ws.on('close', (code) => { clearTimeout(timer); resolve(code); });
});
const held = [];
const try1 = async (ip) => { const c = await open(ip); const r = await settle(c); held.push(c.ws); return r; };
const ips = ['2001:db8:1:2::a', '2001:db8:1:2::b', '2001:db8:1:2::a', '2001:db8:1:2::b'];
const results = [];
for (const ip of ips) results.push(await try1(ip));
check(results.every((r) => r === 'open'), 'four sockets from two ids in the /64 are accepted', results.join(','));
const fifth = await try1('2001:db8:1:2::c');
check(fifth === 1013, 'the fifth from the /64 is refused with 1013', fifth);
const other = [await try1('2001:db8:9::1'), await try1('2001:db8:9::1'), await try1('2001:db8:9::1')];
check(other[0] === 'open' && other[1] === 'open' && other[2] === 1013, 'from outside the list the third is refused', other.join(','));

for (const ws of held) ws.terminate();
mud.close();
rmSync(data, { recursive: true, force: true });
if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
console.log('\nall passed');
process.exit(0);
