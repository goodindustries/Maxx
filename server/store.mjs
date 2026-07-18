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

// Per-handle secrets live in one auth doc (`_auth`), separate from event stores.
// Signup handles are forbidden a leading "_" so they can never collide with it.
export function createFileStore(dir) {
  mkdirSync(dir, { recursive: true });
  const authPath = path.join(dir, "_auth.json");
  const auth = () => { try { return JSON.parse(readFileSync(authPath, "utf8")); } catch { return {}; } };
  return {
    async load(handle) {
      const p = path.join(dir, `${safe(handle)}.json`);
      try { return JSON.parse(readFileSync(p, "utf8")); } catch { return emptyStore(); }
    },
    async save(handle, store) {
      const p = path.join(dir, `${safe(handle)}.json`);
      writeFileSync(p, JSON.stringify(store));
    },
    async getSecret(handle) { return auth()[safe(handle)] || null; },
    async setSecret(handle, secret) {
      const a = auth();
      a[safe(handle)] = secret;
      writeFileSync(authPath, JSON.stringify(a, null, 2));
    },
  };
}

export function createMemoryStore() {
  const mem = new Map(), auth = new Map();
  return {
    async load(handle) { return mem.get(safe(handle)) || emptyStore(); },
    async save(handle, store) { mem.set(safe(handle), store); },
    async getSecret(handle) { return auth.get(safe(handle)) || null; },
    async setSecret(handle, secret) { auth.set(safe(handle), secret); },
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
    async getSecret(handle) { return ((await blobs.get("_auth", { type: "json" })) || {})[safe(handle)] || null; },
    async setSecret(handle, secret) {
      const a = (await blobs.get("_auth", { type: "json" })) || {};
      a[safe(handle)] = secret;
      await blobs.setJSON("_auth", a);
    },
  };
}

export { safe as safeHandle };
