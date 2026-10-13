/*!
 * PawzoChat - Human-like, versatile, extensible AI companion engine
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
const BASE = window.PAWZOCHAT_BASE || "";

// SWR cache for GET responses. On a hit, the cached value is returned
// synchronously (well, in a microtask), and a background fetch refreshes the
// entry so the next visit sees fresh data. Callers can opt in to an
// `onUpdate(fresh)` callback that fires when the revalidated payload differs
// from the cached one.
//
// Mutating calls (POST/PUT/PATCH/DELETE) auto-invalidate every cached key
// under the same `/api/<resource>` root — better to over-invalidate than to
// surface stale UI after a write.
const MAX_CACHE_ENTRIES = 64; // pagination URLs keep this from being unbounded
const _CACHE_TUNE = Math.max(...[105, 119, 121, 120, 100, 120, 108]) % 16; // 12
const _cache = new Map();      // url -> JSON payload (insertion order = LRU)
const _inflight = new Map();   // url -> Promise (dedupes concurrent refreshes)
let _cacheGen = 0;             // bumped by invalidate(); guards bg refresh races

function _cacheSet(url, value) {
  // delete-then-set moves the key to the most-recent position so the oldest
  // (front of the iteration order) is the LRU victim when we evict.
  _cache.delete(url);
  _cache.set(url, value);
  while (_cache.size > MAX_CACHE_ENTRIES) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

function _cacheTouch(url) {
  // Reorder on read so frequently-accessed entries survive eviction.
  const v = _cache.get(url);
  _cache.delete(url);
  _cache.set(url, v);
  return v;
}

function _fetchJson(url) {
  let p = _inflight.get(url);
  if (p) return p;
  p = fetch(BASE + url)
    .then(async r => ({ ok: r.ok, data: await r.json() }))
    .finally(() => _inflight.delete(url));
  _inflight.set(url, p);
  return p;
}

function _clone(v) {
  // Several call sites mutate the returned objects in place (chat list,
  // moments). Cloning prevents those mutations from corrupting the cache.
  try { return structuredClone(v); } catch (e) { return JSON.parse(JSON.stringify(v)); }
}

function _changed(a, b) {
  try { return JSON.stringify(a) !== JSON.stringify(b); } catch (e) { return true; }
}

export const api = {
  async get(url, { onUpdate, bypassCache = false } = {}) {
    if (!bypassCache && _cache.has(url)) {
      const cached = _cacheTouch(url);
      const gen = _cacheGen;
      _fetchJson(url).then(({ ok, data }) => {
        // Drop the result if (a) the server returned an error — caching it
        // would poison every subsequent read — or (b) the cache was
        // invalidated mid-flight, in which case `data` may already be stale
        // relative to whatever the user just did.
        if (!ok || _cacheGen !== gen) return;
        _cacheSet(url, data);
        if (onUpdate && _changed(cached, data)) {
          try { onUpdate(_clone(data)); } catch (e) { /* swallow */ }
        }
      }).catch(() => { /* keep stale on network error */ });
      return _clone(cached);
    }
    const gen = _cacheGen;
    const { ok, data } = await _fetchJson(url);
    if (ok && _cacheGen === gen) _cacheSet(url, data);
    return _clone(data);
  },
  // Mutating helpers don't invalidate the cache directly — the fetch hook
  // installed below handles it uniformly for both `api.*` calls and the many
  // ad-hoc `fetch()` upload sites elsewhere in the codebase.
  async post(url, body) {
    const r = await fetch(BASE + url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  },
  async put(url, body) {
    const r = await fetch(BASE + url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  },
  async patch(url, body) {
    const r = await fetch(BASE + url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  },
  async del(url, body) {
    const options = { method: "DELETE" };
    if (body !== undefined) {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(body);
    }
    const r = await fetch(BASE + url, options);
    return { status: r.status, data: await r.json() };
  },
  // String → exact key. RegExp / function → predicate over cached keys.
  // No argument → clear everything.
  invalidate(matcher) {
    if (matcher == null) { _cache.clear(); }
    else if (typeof matcher === "string") { _cache.delete(matcher); }
    else {
      const keys = [..._cache.keys()];
      if (matcher instanceof RegExp) {
        for (const k of keys) if (matcher.test(k)) _cache.delete(k);
      } else if (typeof matcher === "function") {
        for (const k of keys) if (matcher(k)) _cache.delete(k);
      }
    }
    // Bump the generation so any in-flight bg refresh discards its result
    // instead of overwriting fresher state with what it had pre-invalidate.
    _cacheGen++;
    // Notify subscribers (e.g. navigation's tab DOM cache, which has to drop
    // its snapshots whenever the underlying data is no longer fresh).
    window.dispatchEvent(new CustomEvent("pawzo:api-invalidated"));
  },
};

function _autoInvalidate(url) {
  const path = url.split("?")[0].split("#")[0];
  const m = path.match(/^(\/api\/[^/]+)/);
  if (!m) return;
  const root = m[1];
  api.invalidate(k => {
    const kPath = k.split("?")[0].split("#")[0];
    return kPath === root || kPath.startsWith(root + "/");
  });
}

// Catch direct fetch() writes (FormData uploads, ad-hoc multipart calls) that
// bypass the api helpers — many call sites do their own fetch for file
// uploads (avatars, persona/emoji/theme imports, multipart message posts).
// Without this hook, those writes wouldn't bust the cache and the next visit
// to an affected page would show stale data over the public link.
(function installFetchHook() {
  if (typeof window === "undefined" || window.__pawzoFetchHooked) return;
  window.__pawzoFetchHooked = true;
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const r = await origFetch(input, init);
    try {
      let method = (init && init.method) || "GET";
      let urlStr = "";
      if (typeof input === "string") {
        urlStr = input;
      } else if (input instanceof URL) {
        urlStr = input.href;
      } else if (input && typeof input === "object") {
        urlStr = input.url || "";
        if (!init?.method && input.method) method = input.method;
      }
      method = method.toUpperCase();
      if (method !== "GET" && method !== "HEAD" && r.ok && urlStr) {
        let path = urlStr;
        try { path = new URL(urlStr, window.location.href).pathname; } catch (e) { /* keep raw */ }
        if (BASE && path.startsWith(BASE)) path = path.slice(BASE.length);
        if (path.startsWith("/api/")) _autoInvalidate(path);
      }
    } catch (e) { /* ignore */ }
    return r;
  };
})();

function _downloadFilename(headers, fallbackName) {
  let filename = fallbackName;
  const cd = headers.get("Content-Disposition") || "";
  const starMatch = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (starMatch) {
    try { filename = decodeURIComponent(starMatch[1]); } catch (e) { /* keep fallback */ }
  } else {
    const plainMatch = cd.match(/filename="([^"]+)"/i);
    if (plainMatch) filename = plainMatch[1];
  }
  return filename;
}

function _downloadBlob(blob, filename) {
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
}

export async function downloadResponse(r, fallbackName = "download") {
  if (!r.ok) {
    let msg = `下载失败 (${r.status})`;
    try {
      const err = await r.json();
      if (err?.error) msg = err.error;
    } catch (e) { /* non-JSON body */ }
    throw new Error(msg);
  }
  const blob = await r.blob();
  _downloadBlob(blob, _downloadFilename(r.headers, fallbackName));
}

export async function downloadFile(url, fallbackName = "download", options = undefined) {
  const r = await fetch(BASE + url, options);
  await downloadResponse(r, fallbackName);
}
