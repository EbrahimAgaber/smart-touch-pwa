/**
 * src/services/swrRpcCache.js
 * P1.7: IndexedDB SWR cache for Supabase POST RPCs.
 *
 * Problem: Browser Cache API cannot cache HTTP POST requests. Supabase RPCs
 * (supabase.rpc()) use POST — so Workbox cannot cache them. This engine
 * provides Stale-While-Revalidate semantics via IndexedDB.
 *
 * Usage:
 *   callRpcWithSwr(supabase, 'get_consolidated_executive_stats', { p_date: today }, {
 *     onStale: (cached, cachedAt) => setStats(cached),   // instant
 *     onFresh: (fresh)            => setStats(fresh),     // after network
 *     onError: (err)              => console.error(err),
 *   });
 */

const DB_NAME    = 'smart_touch_pos_cache';
const DB_VERSION = 1;
const STORE_NAME = 'rpc_cache';

let dbPromise = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }
  return dbPromise;
}

function cacheKey(rpcName, params = {}) {
  return `rpc:${rpcName}:${JSON.stringify(params, Object.keys(params).sort())}`;
}

export async function getCachedRpc(rpcName, params = {}) {
  try {
    const db  = await getDb();
    const key = cacheKey(rpcName, params);
    return new Promise((resolve) => {
      const tx    = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req   = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function setCachedRpc(rpcName, params = {}, payload) {
  try {
    const db  = await getDb();
    const key = cacheKey(rpcName, params);
    return new Promise((resolve) => {
      const tx    = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req   = store.put({ key, payload, cachedAt: Date.now() });
      req.onsuccess = () => resolve(true);
      req.onerror   = () => resolve(false);
    });
  } catch {
    return false;
  }
}

/**
 * Stale-While-Revalidate pattern for a Supabase POST RPC.
 * 1. Reads IndexedDB immediately → calls onStale (instant)
 * 2. Fetches from network → calls onFresh, updates IndexedDB
 * 3. If offline and no cache → calls onError
 */
export async function callRpcWithSwr(supabase, rpcName, params, { onStale, onFresh, onError }) {
  const cached = await getCachedRpc(rpcName, params);
  let hasStale = false;

  if (cached?.payload) {
    hasStale = true;
    onStale?.(cached.payload, cached.cachedAt);
  }

  if (!navigator.onLine) {
    if (!hasStale) {
      onError?.(new Error('لا يوجد اتصال بالإنترنت ولا توجد بيانات مخزنة محلياً'));
    }
    return;
  }

  try {
    const { data, error } = await supabase.rpc(rpcName, params);
    if (error) throw error;

    await setCachedRpc(rpcName, params, data);
    onFresh?.(data);
  } catch (err) {
    if (!hasStale) {
      onError?.(err);
    }
    // If we had stale data, the UI already shows it — suppress the error
  }
}
