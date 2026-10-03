import CachePolicy from 'http-cache-semantics';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const USEFUL_HEADERS = ['cache-control', 'age', 'date', 'expires', 'etag', 'last-modified', 'vary', 'cdn-cache-control', 'cache-status', 'cf-cache-status', 'x-cache'];

function validUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('URL must be an absolute http or https URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL must be an absolute http or https URL');
  return url;
}

export async function probe(input, { timeout = 10000, maxRedirects = 5, fetcher = fetch } = {}) {
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000) throw new Error('timeout must be 1 to 120000 milliseconds');
  let url = validUrl(input);
  const redirects = [];
  const seen = new Set();
  const signal = AbortSignal.timeout(timeout);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (seen.has(url.href)) throw new Error('redirect loop detected');
    seen.add(url.href);
    let response;
    const requestTime = Date.now();
    try {
      response = await fetcher(url, { method: 'GET', redirect: 'manual', signal });
    } catch (error) {
      if (signal.aborted) throw new Error(`request timed out after ${timeout} ms`);
      throw new Error(`request failed: ${error.message}`);
    }
    const headers = Object.fromEntries(response.headers.entries());
    const status = response.status;
    const responseTime = Date.now();
    await response.body?.cancel();
    if (REDIRECTS.has(status) && headers.location) {
      if (hop === maxRedirects) throw new Error(`more than ${maxRedirects} redirects`);
      const next = validUrl(new URL(headers.location, url).href);
      redirects.push({ url: url.href, status, headers, requestTime, responseTime, location: next.href });
      url = next;
      continue;
    }
    return { url: url.href, status, headers, requestTime, responseTime, redirects };
  }
}

function policyFor(response, shared) {
  const request = { url: response.url, method: 'GET', headers: {} };
  const headers = { ...response.headers };
  if (shared && headers['cache-control']) {
    // Version 4.2.0 treats proxy-revalidate as zero freshness, including while fresh.
    headers['cache-control'] = headers['cache-control'].replace(/(?:^|,)\s*proxy-revalidate\s*(?=,|$)/gi, '');
  }
  const policy = new CachePolicy(request, { status: response.status, headers }, { shared });
  const storable = policy.storable();
  const now = Date.now();
  const requestTime = response.requestTime ?? now;
  const responseTime = response.responseTime ?? now;
  const dateValue = Date.parse(response.headers.date);
  const apparentAge = Number.isFinite(dateValue) ? Math.max(0, (responseTime - dateValue) / 1000) : 0;
  const headerAge = Number(response.headers.age);
  const correctedAge = Math.max(apparentAge, (Number.isFinite(headerAge) && headerAge >= 0 ? headerAge : 0) + Math.max(0, (responseTime - requestTime) / 1000));
  const currentAgeSeconds = correctedAge + Math.max(0, (now - responseTime) / 1000);
  const lifetimeSeconds = policy.maxAge();
  const fresh = storable && lifetimeSeconds > currentAgeSeconds;
  const cc = response.headers['cache-control'] || '';
  const cannotServeStale = /\b(no-cache|must-revalidate)\b/i.test(cc) || (shared && /\b(proxy-revalidate|s-maxage)\b/i.test(cc));
  const mayServeStale = storable && !fresh && !cannotServeStale && /\bstale-while-revalidate\s*=/i.test(cc) && lifetimeSeconds + Number(cc.match(/\bstale-while-revalidate\s*=\s*(\d+)/i)?.[1] || 0) > currentAgeSeconds;
  const fieldScoped = /\b(?:private|no-cache)\s*=\s*"/i.test(cc);
  const uncertain = fieldScoped || (storable && !fresh && !mayServeStale && !/\b(?:max-age|s-maxage|no-cache|no-store)\b/i.test(cc) && !response.headers.expires && !response.headers['last-modified']);
  return {
    storable,
    fresh,
    mayServeStale,
    uncertain,
    remainingSeconds: fresh ? Math.max(0, Math.floor(lifetimeSeconds - currentAgeSeconds)) : 0,
    lifetimeSeconds,
    currentAgeSeconds
  };
}

function invalidFreshnessDirective(cacheControl, shared) {
  const directives = cacheControl.split(',');
  const hasSharedMaxAge = shared && directives.some(directive => directive.trim().split('=', 1)[0].toLowerCase() === 's-maxage');
  const name = hasSharedMaxAge ? 's-maxage' : 'max-age';
  const directive = directives.findLast(value => value.trim().split('=', 1)[0].toLowerCase() === name);
  if (directive === undefined) return null;
  const value = directive.trim().split('=').slice(1).join('=').trim();
  return /^"?\d+"?$/.test(value) ? null : name;
}

function reason(headers, result, shared) {
  const cc = headers['cache-control'] || '';
  if (result.uncertain && /\b(?:private|no-cache)\s*=\s*"/i.test(cc)) return 'field-scoped directive; cache support varies';
  if (/\bno-store\b/i.test(cc)) return 'no-store forbids storage';
  if (shared && /\bprivate\b/i.test(cc)) return 'private excludes shared caches';
  if (/\bno-cache\b/i.test(cc)) return 'no-cache requires revalidation';
  if (result.mayServeStale) return 'stale-while-revalidate may serve stale while refreshing';
  if (headers.vary === '*') return 'Vary: * prevents reuse';
  const invalidDirective = invalidFreshnessDirective(cc, shared);
  if (invalidDirective && !result.fresh) return `invalid ${invalidDirective}; response requires revalidation`;
  if (shared && /\bs-maxage\s*=/i.test(cc)) return 's-maxage sets shared freshness';
  if (/\bmax-age\s*=/i.test(cc)) return 'max-age sets freshness';
  if (headers.expires) return 'Expires sets freshness';
  if (headers['last-modified']) return 'Last-Modified may allow heuristic freshness';
  if (result.fresh) return 'response may be fresh by HTTP rules';
  if (headers.etag || headers['last-modified']) return 'stale response may be revalidated';
  return result.uncertain ? 'storable; freshness is not established by these headers' : result.storable ? 'storable, but requires a new request' : 'response is not storable';
}

export function analyze(response) {
  const browser = policyFor(response, false);
  const shared = policyFor(response, true);
  browser.reason = reason(response.headers, browser, false);
  shared.reason = reason(response.headers, shared, true);
  const warning = response.status === 404 && browser.fresh
    ? `A browser may reuse this 404 response for up to ${formatDuration(browser.remainingSeconds)}.`
    : response.status === 404 && browser.uncertain ? 'A cache may give this 404 a heuristic lifetime.' : null;
  const redirects = response.redirects.map(hop => {
    const browserHop = policyFor(hop, false);
    const sharedHop = policyFor(hop, true);
    return { ...hop, browser: browserHop, shared: sharedHop };
  });
  return { ...response, redirects, browser, shared, warning, observedHeaders: Object.fromEntries(USEFUL_HEADERS.filter(k => response.headers[k] !== undefined).map(k => [k, response.headers[k]])) };
}

export function formatDuration(seconds) {
  if (seconds >= 86400) return `${Math.ceil(seconds / 86400)} day${Math.ceil(seconds / 86400) === 1 ? '' : 's'}`;
  if (seconds >= 3600) return `${Math.ceil(seconds / 3600)} hour${Math.ceil(seconds / 3600) === 1 ? '' : 's'}`;
  if (seconds >= 60) return `${Math.ceil(seconds / 60)} minute${Math.ceil(seconds / 60) === 1 ? '' : 's'}`;
  return `${Math.ceil(seconds)} second${Math.ceil(seconds) === 1 ? '' : 's'}`;
}
