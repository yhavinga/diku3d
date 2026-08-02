// `node --check` only parses a file; it never resolves an import or runs a line
// of top-level code. This actually loads every module the way the browser will,
// with 'three' and 'three/addons/' pointed at the vendored copies, so a typo in
// an import path or a broken top-level statement fails here instead of in the
// browser three minutes later.
//
// Run: node tools/import-check.mjs
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendor = pathToFileURL(join(root, 'vendor', 'three')).href;

register('data:text/javascript,' + encodeURIComponent(`
  const VENDOR = ${JSON.stringify(vendor)};
  export async function resolve(specifier, context, next) {
    if (specifier === 'three') return next(VENDOR + '/build/three.module.js', context);
    if (specifier.startsWith('three/addons/')) {
      return next(VENDOR + '/examples/jsm/' + specifier.slice('three/addons/'.length), context);
    }
    return next(specifier, context);
  }
`), import.meta.url);

// Minimal browser surface: these modules only touch the DOM inside functions,
// but a canvas is cheap to stub and keeps the import honest.
globalThis.window ??= { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800, addEventListener() {} };
globalThis.self ??= globalThis.window;
globalThis.document ??= {
  createElement: () => ({ getContext: () => null, style: {}, setAttribute() {} }),
  createElementNS: () => ({ style: {}, setAttribute() {} }),
  addEventListener() {},
  getElementById: () => null,
  querySelector: () => null,
  body: { appendChild() {} },
  hidden: false,
};

// main.js is the entry point: importing it boots the whole app against a page
// that isn't there. It gets `node --check` and the browser instead.
const ENTRY_POINTS = new Set(['main.js']);

const files = readdirSync(join(root, 'src'))
  .filter((f) => f.endsWith('.js') && !ENTRY_POINTS.has(f)).sort();
let failed = 0;
for (const file of files) {
  const href = pathToFileURL(join(root, 'src', file)).href;
  try {
    const module = await import(href);
    console.log(`${file.padEnd(14)} ok   exports: ${Object.keys(module).join(', ') || '(none)'}`);
  } catch (error) {
    failed++;
    console.log(`${file.padEnd(14)} FAILED  ${error.message.split('\n')[0]}`);
  }
}
console.log(`\n${files.length - failed}/${files.length} modules import cleanly`);
process.exit(failed ? 1 : 0);
