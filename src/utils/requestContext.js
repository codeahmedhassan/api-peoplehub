import { AsyncLocalStorage } from "node:async_hooks";

const requestStorage = new AsyncLocalStorage();

/**
 * Executes `fn` inside an isolated per-HTTP-request context Map.
 * Used to deduplicate repeated DB lookups (User, Workspace, Employee) within the same request.
 */
export function runWithRequestContext(fn) {
    return requestStorage.run(new Map(), fn);
}

/**
 * Returns the active request's Map cache, or null outside an HTTP request.
 */
export function getRequestCache() {
    return requestStorage.getStore() || null;
}

/**
 * Returns a cached value/promise from the current HTTP request context, or runs `loader`.
 */
export function getOrSetRequestCache(key, loader) {
    const store = getRequestCache();
    if (!store) return loader();
    if (store.has(key)) return store.get(key);
    const promise = Promise.resolve().then(loader).catch((err) => {
        store.delete(key);
        throw err;
    });
    store.set(key, promise);
    return promise;
}
