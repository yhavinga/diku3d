/**
 * One of bakery.js's texture workers. Given textures.js's source text, it
 * bakes whatever bake it is handed -- or reads it back from IndexedDB if this
 * browser baked the same text before -- and transfers the pixel buffers to
 * the page. What it baked is packed before the hand-over and written to the
 * cache only once the page says every bake is in (`store`): deflating while
 * the next bake runs made the first visit's bake 1.6 s instead of 1.1.
 */
import { openBakeDB, cacheGet, cachePut, pack, compress, unpack, weightOf, buffersOf } from './bakery.js';

let textures = null;
let db = null;
let hash = null;
const unstored = [];

const fail = (key, error) => self.postMessage({ type: 'error', key, message: String(error?.message || error), stack: error?.stack });

async function init({ source, three, hash: h }) {
  const imports = source.match(/from\s+['"]three['"]/g) || [];
  if (imports.length !== 1) throw new Error(`textures.js should import 'three' exactly once, found ${imports.length}`);
  const text = source.replace(/from\s+['"]three['"]/, `from ${JSON.stringify(three)}`);
  const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  textures = await import(url);
  URL.revokeObjectURL(url);
  hash = h;
  if (hash) {
    try { db = await openBakeDB(); } catch (error) {
      self.postMessage({ type: 'warn', message: `IndexedDB unavailable in the worker (${error.message || error})` });
    }
  }
}

async function run(job, cached) {
  const t = performance.now();
  const key = `${hash}/${job.key}`;
  let maps = null;
  let bytes = 0;
  if (db && cached) {
    try {
      const record = await cacheGet(db, key);
      if (record) { maps = await unpack(record); bytes = record.body.byteLength; }
    } catch (error) {
      self.postMessage({ type: 'warn', message: `cannot read ${job.key} back (${error.message || error})` });
      maps = null;
    }
  }
  const from = maps ? 'cache' : 'bake';
  if (!maps) maps = textures.runBake(job);
  // Packed before the hand-over: transferring detaches the buffers.
  const packed = from === 'bake' && hash ? pack(maps) : null;
  self.postMessage({ type: 'done', key: job.key, maps, from, bytes, weight: weightOf(job), ms: performance.now() - t }, buffersOf(maps));
  if (packed) unstored.push({ job, key, packed });
}

async function store() {
  for (const { job, key, packed } of unstored.splice(0)) {
    let written = 0;
    try {
      if (!db) throw new Error('no database');
      const body = await compress(packed.planes);
      await cachePut(db, key, { header: packed.header, body });
      written = body.byteLength;
    } catch (error) {
      // Quota, a closed database: this bake is simply not remembered.
      if (db) self.postMessage({ type: 'warn', message: `cannot store ${job.key} (${error.message || error})` });
      db = null;
    }
    self.postMessage({ type: 'stored', key: job.key, bytes: written });
  }
}

self.onmessage = ({ data }) => {
  if (data.type === 'init') {
    init(data).then(() => self.postMessage({ type: 'ready' }), (error) => fail(null, error));
  } else if (data.type === 'job') {
    run(data.job, data.cached).catch((error) => fail(data.job.key, error));
  } else if (data.type === 'store') {
    store().catch((error) => fail('store', error));
  }
};
