// The page's security headers are written twice -- in nginx for diku3d.com
// (tools/deploy/nginx-diku3d.conf) and in serve.py, so that every local and
// headless run is under the policy production has -- and the policy names each
// inline <script> in index.html by its hash. Nothing else notices when these
// drift: a changed import map without its new hash leaves a page that does not
// start, and only in the browser. This holds them together:
//
//   - every inline script in index.html has its sha256 in script-src, and every
//     hash there is one of them (a stale hash is a script nobody meant to allow);
//   - script-src allows neither 'unsafe-inline' nor 'unsafe-eval';
//   - serve.py's headers and nginx's are the same names with the same values;
//   - in nginx, the diku3d.com server sends all of them `always`, and so does
//     every location in it with an add_header of its own, since a location
//     with one inherits none from the server.
//
//   node tools/csp-check.mjs
//
// Prints what it checked, and every fault it finds; exits 1 if there is one.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ROOT = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');
const NAMES = ['Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy'];

const faults = [];
const fault = (text) => faults.push(text);

// -- serve.py: SECURITY_HEADERS = { 'Name': "value", ... } ---------------------
const py = read('serve.py');
const pyBlock = /^SECURITY_HEADERS = \{\n([\s\S]*?)\n\}/m.exec(py);
if (!pyBlock) throw new Error('serve.py: no SECURITY_HEADERS = { ... } block');
const served = new Map();
for (const line of pyBlock[1].split('\n')) {
  const m = /^\s*'([A-Za-z-]+)':\s*(?:"([^"]*)"|'([^']*)'),\s*$/.exec(line);
  if (!m) throw new Error(`serve.py: cannot read this SECURITY_HEADERS line: ${line}`);
  served.set(m[1], m[2] ?? m[3]);
}
for (const name of NAMES) if (!served.has(name)) fault(`serve.py does not send ${name}`);

// -- nginx: a small reader for blocks and directives, quote-aware -------------
function parseNginx(text) {
  const root = { head: [], directives: [], blocks: [] };
  const stack = [root];
  let words = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let word = '';
      while (j < text.length && text[j] !== c) { if (text[j] === '\\') j++; word += text[j]; j++; }
      if (j >= text.length) throw new Error(`nginx-diku3d.conf: unclosed quote at offset ${i}`);
      words.push(word);
      i = j + 1;
      continue;
    }
    if (c === ';') { stack.at(-1).directives.push(words); words = []; i++; continue; }
    if (c === '{') { const block = { head: words, directives: [], blocks: [] }; stack.at(-1).blocks.push(block); stack.push(block); words = []; i++; continue; }
    if (c === '}') { if (stack.length < 2) throw new Error('nginx-diku3d.conf: unbalanced }'); stack.pop(); i++; continue; }
    let j = i;
    while (j < text.length && !/[\s;{}#"']/.test(text[j])) j++;
    words.push(text.slice(i, j));
    i = j;
  }
  if (stack.length !== 1) throw new Error('nginx-diku3d.conf: unbalanced {');
  return root;
}

const conf = parseNginx(read('tools/deploy/nginx-diku3d.conf'));
const site = conf.blocks.find((b) => b.head[0] === 'server'
  && b.directives.some((d) => d[0] === 'server_name' && d.includes('diku3d.com'))
  && b.directives.some((d) => d[0] === 'root'));
if (!site) throw new Error('nginx-diku3d.conf: no server block for diku3d.com with a root');

/** The add_header directives of one block, by name; faults for any not sent `always`. */
function headersOf(block, label) {
  const found = new Map();
  for (const d of block.directives) {
    if (d[0] !== 'add_header') continue;
    if (d.at(-1) !== 'always') fault(`${label}: add_header ${d[1]} without "always" (a 404 or 500 would go without it)`);
    found.set(d[1], d[2]);
  }
  return found;
}
function sameAsServed(found, label) {
  for (const name of NAMES) {
    if (!found.has(name)) { fault(`${label} does not send ${name}`); continue; }
    if (found.get(name) !== served.get(name)) {
      fault(`${label} sends a different ${name} from serve.py:\n    nginx:    ${found.get(name)}\n    serve.py: ${served.get(name)}`);
    }
  }
}
sameAsServed(headersOf(site, 'nginx server diku3d.com'), 'nginx server diku3d.com');
let locations = 0;
const walk = (block) => {
  for (const inner of block.blocks) {
    if (inner.head[0] === 'location') {
      const label = `nginx location ${inner.head.slice(1).join(' ')}`;
      const found = headersOf(inner, label);
      if (found.size) { locations++; sameAsServed(found, label); }
    }
    walk(inner);
  }
};
walk(site);

// -- index.html's inline scripts against script-src ---------------------------
const policy = served.get('Content-Security-Policy') || '';
const directives = new Map(policy.split(';').map((part) => part.trim().split(/\s+/)).filter((p) => p[0]).map(([name, ...values]) => [name, values]));
const scriptSrc = directives.get('script-src');
if (!scriptSrc) fault('the policy has no script-src');
else {
  for (const unsafe of ["'unsafe-inline'", "'unsafe-eval'"]) if (scriptSrc.includes(unsafe)) fault(`script-src allows ${unsafe}`);
  const html = read('index.html');
  const hashes = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    const hash = `'sha256-${createHash('sha256').update(m[2], 'utf8').digest('base64')}'`;
    hashes.push(hash);
    if (!scriptSrc.includes(hash)) {
      fault(`index.html: the inline script <script${m[1]}> starting ${JSON.stringify(m[2].trim().slice(0, 60))} has ${hash}, which script-src does not list`);
    }
  }
  for (const value of scriptSrc) {
    if (value.startsWith("'sha256-") && !hashes.includes(value)) fault(`script-src lists ${value}, which no inline script in index.html has`);
  }
  console.log(`${hashes.length} inline scripts in index.html, each hashed in script-src`);
}
console.log(`${NAMES.length} headers: serve.py, the nginx server and ${locations} location${locations === 1 ? '' : 's'} with headers of its own`);

if (faults.length) {
  for (const f of faults) console.log(`FAIL ${f}`);
  process.exit(1);
}
console.log('ok   csp-check');
