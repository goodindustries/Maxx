/**
 * Per-handle store abstraction for the maxx tally.
 *
 * The handler is storage-agnostic: give it any adapter with async load(handle)
 * and save(handle, store). Local dev/test uses a file-backed store; production
 * on Netlify swaps in a Blobs adapter (same two methods) with zero handler
 * changes. A store doc is exactly what server/tally.mjs's emptyStore() returns.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { emptyStore } from "./tally.mjs";

const safe = (h) => String(h).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "unknown";

export function createFileStore(dir) {
  mkdirSync(dir, { recursive: true });
  return {
    async load(handle) {
      const p = path.join(dir, `${safe(handle)}.json`);
      try { return JSON.parse(readFileSync(p, "utf8")); } catch { return emptyStore(); }
    },
    async save(handle, store) {
      const p = path.join(dir, `${safe(handle)}.json`);
      writeFileSync(p, JSON.stringify(store));
    },
  };
}

export function createMemoryStore() {
  const mem = new Map();
  return {
    async load(handle) { return mem.get(safe(handle)) || emptyStore(); },
    async save(handle, store) { mem.set(safe(handle), store); },
  };
}

/**
 * Netlify Blobs adapter — the production store. Wire in the deploy:
 *   import { getStore } from "@netlify/blobs";
 *   createBlobStore(getStore("maxx-tally"))
 * The blobs object needs get(key,{type:'json'}) and setJSON(key,val).
 */
export function createBlobStore(blobs) {
  return {
    async load(handle) { return (await blobs.get(safe(handle), { type: "json" })) || emptyStore(); },
    async save(handle, store) { await blobs.setJSON(safe(handle), store); },
  };
}

export { safe as safeHandle };
