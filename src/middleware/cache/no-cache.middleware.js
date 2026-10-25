// src/middleware/cache/no-cache.middleware.js
// Marks a response as non-cacheable so:
//   1. Browsers don't serve a stale body from their HTTP cache
//   2. Shared caches (CDN, proxies) don't serve one user's data to another
//   3. Express doesn't short-circuit to a 304 based on a stale ETag
export function noCache(req, res, next) {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");
    const prev = res.getHeader("Vary");
    res.set("Vary", prev ? `${prev}, Cookie` : "Cookie");

    // Force Express's res.send() to skip its `if (req.fresh) → 304` branch.
    // Express reads `req.fresh` internally after computing an ETag; overriding
    // the getter to return false disables 304 responses on this request.
    Object.defineProperty(req, "fresh", {
        get: () => false,
        configurable: true,
    });

    next();
}