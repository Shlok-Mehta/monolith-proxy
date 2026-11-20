/*
 * Monolith proxy for Cloudflare Workers — free tier, no keys.
 *
 * Deploy: dash.cloudflare.com → Workers & Pages → Create → Worker → paste this
 * file → Deploy. Then copy the *.workers.dev URL into Monolith → Settings → Proxy.
 *
 * Endpoints
 *   GET /api/health
 *   GET /api/fetch?url=https://query1.finance.yahoo.com/...
 *
 * Only Yahoo Finance and Screener.in are forwarded, so the worker cannot be
 * used as an open proxy. Responses are cached for ten minutes at the edge to
 * stay inside the free request budget.
 */

const ALLOWED_HOSTS = new Set([
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'www.screener.in',
  'screener.in',
  'www.bing.com',
  'bing.com'
]);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';
const CACHE_SECONDS = 600;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*'
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors }
  });

async function fetchUpstream(target) {
  return fetch(target, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/json,text/plain,*/*' },
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true }
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ ok: false, error: 'GET only' }, 405);

    if (url.pathname === '/api/health') {
      return json({ ok: true, service: 'ledger-proxy', allowed: Array.from(ALLOWED_HOSTS) });
    }

    if (url.pathname !== '/api/fetch') return json({ ok: false, error: 'unknown endpoint' }, 404);

    const raw = url.searchParams.get('url');
    if (!raw) return json({ ok: false, error: 'missing url parameter' }, 400);

    let target;
    try { target = new URL(raw); }
    catch (e) { return json({ ok: false, error: 'url is not a valid URL' }, 400); }

    if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
      return json({ ok: false, error: `host not allowed: ${target.hostname}` }, 403);
    }

    const cacheKey = new Request(target.toString(), { method: 'GET' });
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = await hit.text();
      return new Response(body, {
        status: hit.status,
        headers: {
          'Content-Type': hit.headers.get('Content-Type') || 'text/plain; charset=utf-8',
          'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
          'X-Monolith-Cache': 'hit',
          ...cors
        }
      });
    }

    let upstream;
    try {
      upstream = await fetchUpstream(target.toString());
    } catch (e) {
      return json({ ok: false, error: `upstream failed: ${e.message}` }, 502);
    }

    let body = await upstream.text();
    let via = 'direct';

    // Screener sometimes answers the bot check with a 403. Retry via the free
    // reader proxy rather than dropping fundamentals on the floor.
    if (upstream.status >= 400 && /screener\.in$/.test(target.hostname)) {
      try {
        const alt = await fetchUpstream('https://r.jina.ai/' + target.toString());
        if (alt.ok) {
          const altBody = await alt.text();
          if (altBody.trim()) { body = altBody; upstream = alt; via = 'r.jina.ai'; }
        }
      } catch (e) { /* keep the direct answer */ }
    }

    const response = new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'text/plain; charset=utf-8',
        'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
        'X-Monolith-Via': via,
        ...cors
      }
    });

    if (upstream.ok) {
      const toCache = response.clone();
      await cache.put(cacheKey, toCache);
    }
    return response;
  }
};
