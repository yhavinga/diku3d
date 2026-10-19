#!/usr/bin/env node
/**
 * The terminal gateway: play diku3d over SSH, with no page and no 3D.
 *
 *     cd server && npm ci
 *     node main.mjs &                     # the game server, :4011
 *     node ssh.mjs [--port 2222] [--host 0.0.0.0] [--game ws://127.0.0.1:4011/ws] [--key data/ssh_host_ed25519_key]
 *     ssh -p 2222 localhost
 *
 * The host key is made on the first start and kept in --key; see gateway.mjs.
 */

import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { startGateway } from './gateway.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function parseArgs(argv) {
  const args = { port: 2222, host: '0.0.0.0', game: 'ws://127.0.0.1:4011/ws', key: join(here, 'data/ssh_host_ed25519_key') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--port') args.port = Number(next());
    else if (a === '--host') args.host = next();
    else if (a === '--game') args.game = next();
    else if (a === '--key') args.key = resolve(next());
    else if (a === '--help' || a === '-h') { console.log('node ssh.mjs [--port 2222] [--host 0.0.0.0] [--game ws://127.0.0.1:4011/ws] [--key FILE]'); process.exit(0); }
    else throw new Error(`unknown argument ${a} (try --help)`);
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error(`--port ${args.port} is not a port`);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gateway = await startGateway({
    root, port: args.port, host: args.host, game: args.game, keyPath: args.key,
    log: (text) => console.log(`${new Date().toISOString().slice(11, 19)} ${text}`),
  });
  const stop = () => { gateway.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
