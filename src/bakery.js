/**
 * Where the texture bake runs and what it remembers.
 *
 * Every surface is still generated in this browser (textures.js); this only
 * moves the work off the main thread -- a small pool of module workers, so
 * the page keeps painting and the loading bar can say how far it has got --
 * and keeps what this browser baked before in IndexedDB, so a repeat visit
 * reads pixels back instead of computing them again.
 *
 * The cache key is the SHA-256 of textures.js's whole source text plus the
 * bake's own key (surface and size). Deliberately coarse: recipes share
 * helper functions, so any edit to the file invalidates every entry, and the
 * entries of any other hash are deleted on boot. Only pixel data is stored,
 * never a three.js object. `?bake=fresh` bakes everything and rewrites it.
 *
 * The worker imports textures.js from the very text that was hashed, with its
 * one `'three'` import pointed at the vendored module: a worker has no import
 * map, and baking from a different text than the key names would defeat it.
 */

export const BAKE_DB = 'diku3d-bake';
const STORE = 'maps';

export function openBakeDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BAKE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

const done = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
export const cacheGet = (db, key) => done(db.transaction(STORE).objectStore(STORE).get(key));
export function cachePut(db, key, value) {
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(value, key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

/**
 * Delete every entry baked from another version of textures.js; resolve to
 * the keys that are left. Those are the only ones a worker asks for: a
 * lookup that misses still queues behind the other workers' writes, and on a
 * first visit that made eight workers mostly wait -- 69 s of worker time for
 * 9 s of baking.
 */
async function purge(db, hash) {
  const keys = await done(db.transaction(STORE).objectStore(STORE).getAllKeys());
  const stale = keys.filter((k) => !String(k).startsWith(`${hash}/`));
  const kept = new Set(keys.filter((k) => String(k).startsWith(`${hash}/`)).map((k) => String(k).slice(hash.length + 1)));
  if (!stale.length) return { purged: 0, kept };
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const k of stale) store.delete(k);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  return { purged: stale.length, kept };
}

/**
 * Maps as stored: every RGBA channel that holds one value throughout (the
 * alpha of an opaque albedo, the red of a roughness map) is kept as that
 * value; the rest are laid out channel by channel, which deflates better than
 * interleaved texels. Lossless both ways -- `unpack(pack(x))` is `x` byte for
 * byte.
 */
export function pack(maps) {
  const header = [];
  const planes = [];
  for (const [name, { data, width, height }] of Object.entries(maps)) {
    const n = width * height;
    const consts = [];
    for (let c = 0; c < 4; c++) {
      const v = data[c];
      let same = true;
      for (let i = c; i < data.length; i += 4) if (data[i] !== v) { same = false; break; }
      if (same) { consts.push(v); continue; }
      consts.push(null);
      const plane = new Uint8Array(n);
      for (let i = 0; i < n; i++) plane[i] = data[i * 4 + c];
      planes.push(plane);
    }
    header.push({ name, width, height, consts });
  }
  return { header, planes };
}

export async function compress(planes) {
  const stream = new Blob(planes).stream().pipeThrough(new CompressionStream('deflate'));
  return new Response(stream).arrayBuffer();
}

export async function unpack({ header, body }) {
  const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate'));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const maps = {};
  let at = 0;
  for (const { name, width, height, consts } of header) {
    const n = width * height;
    const data = new Uint8ClampedArray(n * 4);
    for (let c = 0; c < 4; c++) {
      if (consts[c] !== null) {
        if (consts[c]) for (let i = c; i < data.length; i += 4) data[i] = consts[c];
        continue;
      }
      if (at + n > raw.length) throw new Error(`cached ${name} is short`);
      for (let i = 0; i < n; i++) data[i * 4 + c] = raw[at + i];
      at += n;
    }
    maps[name] = { data, width, height };
  }
  if (at !== raw.length) throw new Error(`cached bake has ${raw.length - at} bytes too many`);
  return maps;
}

/** What a bake costs, roughly: its pixels. Orders the queue and weights the bar. */
export const weightOf = (job) => job.px * job.px;

export const buffersOf = (maps) => Object.values(maps).map((m) => m.data.buffer);

/**
 * Bake `jobs` (textures.js `bakeJobs`) and resolve to a Map of key -> maps,
 * as textures.js `createMaterials` takes it. `onProgress(fraction, label)`
 * after every finished bake, `onStart({ jobs, cached })` once it is known
 * how many the cache holds. `runBake` is the main thread's own copy of
 * textures.js `runBake`, used only when no worker can be started.
 *
 * `stats` on the result says what came from where; `stats.stored` resolves
 * once the cache has been written, which happens in the workers after the
 * pixels have been handed over, so the boot does not wait for it.
 */
export async function bakeTextures(jobs, runBake, { fresh = false, onStart = () => {}, onProgress = () => {} } = {}) {
  const started = performance.now();
  const stats = { jobs: jobs.length, cached: 0, baked: 0, bytes: 0, purged: 0, workers: 0, ms: 0, workMs: 0, fresh };
  const warnings = [];
  // One console line however many bakes it touches: the textures are still
  // baked, they are only not remembered (or not read back).
  const warn = (message) => { if (!warnings.length) console.warn(`textures: bake cache not used: ${message}`); warnings.push(message); };
  const total = jobs.reduce((s, j) => s + weightOf(j), 0);
  let finished = 0;
  const baked = new Map();

  const sourceURL = new URL('./textures.js', import.meta.url);
  const response = await fetch(sourceURL);
  if (!response.ok) throw new Error(`cannot read ${sourceURL}: HTTP ${response.status}`);
  const source = await response.text();
  let hash = null;
  let kept = new Set();
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const db = await openBakeDB();
    ({ purged: stats.purged, kept } = await purge(db, hash));
    db.close();
  } catch (error) {
    warn(`IndexedDB unavailable (${error.message || error})`);
    hash = null;
  }
  stats.hash = hash;
  onStart({ jobs: jobs.length, cached: fresh ? 0 : jobs.filter((j) => kept.has(j.key)).length });

  const queue = [...jobs].sort((a, b) => weightOf(b) - weightOf(a));
  const count = Math.max(1, Math.min(queue.length, 8, (navigator.hardwareConcurrency || 4) - 2));
  const workers = [];
  let stores = 0;
  let storesDone = () => {};
  const stored = new Promise((resolve) => { storesDone = resolve; });
  const result = await new Promise((resolve, reject) => {
    const failed = (error) => { for (const w of workers) w.terminate(); reject(error); };
    const take = (worker) => {
      const job = queue.shift();
      if (job) worker.postMessage({ type: 'job', job, cached: !fresh && kept.has(job.key) });
    };
    const settle = () => {
      if (baked.size === jobs.length && stores === 0) {
        for (const w of workers) w.terminate();
        storesDone(stats.bytes);
      }
    };
    let ready = 0;
    for (let i = 0; i < count; i++) {
      let worker;
      try {
        worker = new Worker(new URL('./bakeworker.js', import.meta.url), { type: 'module' });
      } catch (error) {
        if (i > 0) break;
        // No module workers at all: bake here, without the cache, and say so.
        warn(`no module worker (${error.message || error})`);
        resolve(bakeHere(jobs, runBake, onProgress, total, baked, stats));
        return;
      }
      workers.push(worker);
      worker.onerror = (event) => failed(new Error(`bake worker: ${event.message || 'failed to load'} (${event.filename || ''}:${event.lineno || ''})`));
      worker.onmessage = ({ data }) => {
        if (data.type === 'ready') { ready++; take(worker); return; }
        if (data.type === 'error') { failed(new Error(`bake worker, ${data.key || 'init'}: ${data.message}\n${data.stack || ''}`)); return; }
        if (data.type === 'warn') { warn(data.message); return; }
        if (data.type === 'stored') {
          stores--;
          stats.bytes += data.bytes;
          settle();
          return;
        }
        // 'done'
        baked.set(data.key, data.maps);
        stats.workMs += data.ms;
        if (data.from === 'cache') { stats.cached++; stats.bytes += data.bytes; } else { stats.baked++; if (hash) stores++; }
        finished += data.weight;
        onProgress(finished / total, data.key);
        if (baked.size === jobs.length) {
          stats.ms = performance.now() - started;
          resolve(baked);
          for (const w of workers) w.postMessage({ type: 'store' });
          settle();
        } else take(worker);
      };
      worker.postMessage({ type: 'init', source, three: import.meta.resolve('three'), hash });
    }
    stats.workers = workers.length;
  });
  stats.ms = performance.now() - started;
  stats.warnings = warnings;
  stats.stored = workers.length && hash ? stored : Promise.resolve(stats.bytes);
  return { baked: result, stats };
}

/** The fallback: one bake at a time on this thread, letting a frame paint between them. */
async function bakeHere(jobs, runBake, onProgress, total, baked, stats) {
  let finished = 0;
  for (const job of jobs) {
    baked.set(job.key, runBake(job));
    stats.baked++;
    finished += weightOf(job);
    onProgress(finished / total, job.key);
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }
  return baked;
}

