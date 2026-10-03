import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { analyze, probe } from '../src/index.js';
import { parseArgs, render } from '../src/cli.js';

async function withServer(handler, callback) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('a cached 404 is fresh in browser and shared caches', async () => {
  await withServer((request, response) => {
    assert.equal(request.method, 'GET');
    response.writeHead(404, { 'Cache-Control': 'public, max-age=2678400' });
    response.end('missing');
  }, async url => {
    const result = analyze(await probe(`${url}/missing.js`));
    assert.equal(result.status, 404);
    assert.equal(result.browser.fresh, true);
    assert.equal(result.shared.fresh, true);
    assert.match(result.warning, /31 days/);
    assert.match(render(result, false), /404 warning/);
  });
});

test('a new no-store response is distinct from no-cache', async () => {
  for (const cc of ['no-store', 'no-cache, max-age=2678400']) {
    const result = analyze({ url: 'https://example.test/missing', status: 404, headers: { 'cache-control': cc, etag: '"v1"' }, redirects: [] });
    assert.equal(result.browser.fresh, false);
    assert.equal(result.warning, null);
    assert.equal(result.browser.storable, cc.startsWith('no-cache'));
    assert.match(result.browser.reason, cc.startsWith('no-cache') ? /revalidation/ : /forbids storage/);
  }
});

test('s-maxage applies only to shared caches', () => {
  const result = analyze({ url: 'https://example.test/shared', status: 200, headers: { 'cache-control': 'max-age=0, s-maxage=600' }, redirects: [] });
  assert.equal(result.browser.fresh, false);
  assert.equal(result.shared.fresh, true);
  assert.match(result.shared.reason, /s-maxage/);
});

test('invalid freshness values explain why a response must be revalidated', () => {
  const result = analyze({ url: 'https://example.test/misconfigured', status: 200, headers: { 'cache-control': 'max-age=600, s-maxage=tomorrow' }, redirects: [] });
  assert.equal(result.browser.fresh, true);
  assert.equal(result.shared.fresh, false);
  assert.match(result.browser.reason, /max-age sets freshness/);
  assert.match(result.shared.reason, /invalid s-maxage.*revalidation/);
});

test('private allows browser reuse but excludes shared caches', () => {
  const result = analyze({ url: 'https://example.test/private', status: 200, headers: { 'cache-control': 'private, max-age=3600' }, redirects: [] });
  assert.equal(result.browser.fresh, true);
  assert.equal(result.shared.storable, false);
});

test('Age reduces remaining freshness', () => {
  const result = analyze({ url: 'https://example.test/old', status: 200, headers: { 'cache-control': 'max-age=100', age: '90' }, redirects: [] });
  assert.equal(result.browser.fresh, true);
  assert.ok(result.browser.remainingSeconds <= 10);
  assert.ok(result.browser.remainingSeconds >= 8);
});

test('must-revalidate and proxy-revalidate permit fresh reuse', () => {
  const result = analyze({ url: 'https://example.test/file', status: 200, headers: { 'cache-control': 'public, max-age=600, must-revalidate, proxy-revalidate' }, redirects: [] });
  assert.equal(result.browser.fresh, true);
  assert.equal(result.shared.fresh, true);
});

test('stale-while-revalidate is a separate outcome', () => {
  const result = analyze({ url: 'https://example.test/file', status: 200, headers: { 'cache-control': 'max-age=1, stale-while-revalidate=60', age: '2' }, redirects: [] });
  assert.equal(result.browser.fresh, false);
  assert.equal(result.browser.mayServeStale, true);
  assert.match(render(result, false), /SERVE STALE/);
});

test('request delay counts toward current age', () => {
  const now = Date.now();
  const result = analyze({ url: 'https://example.test/slow', status: 200, headers: { 'cache-control': 'max-age=5', age: '0' }, requestTime: now - 10000, responseTime: now, redirects: [] });
  assert.equal(result.browser.fresh, false);
});

test('headerless 404 reports uncertain heuristic freshness', () => {
  const result = analyze({ url: 'https://example.test/missing', status: 404, headers: {}, redirects: [] });
  assert.equal(result.browser.uncertain, true);
  assert.match(result.warning, /heuristic/);
});

test('redirect policy is reported separately from final response', () => {
  const now = Date.now();
  const report = analyze({ url: 'https://example.test/new', status: 200, headers: { 'cache-control': 'max-age=3600' }, redirects: [{ url: 'https://example.test/old', status: 302, location: 'https://example.test/new', headers: { 'cache-control': 'no-store' }, requestTime: now, responseTime: now }] });
  assert.equal(report.browser.fresh, true);
  assert.equal(report.redirects[0].browser.storable, false);
  assert.match(render(report, false), /new request needed/);
});

test('follows redirects and records each hop', async () => {
  await withServer((request, response) => {
    if (request.url === '/start') { response.writeHead(302, { Location: '/end' }); response.end(); }
    else { response.writeHead(200, { 'Cache-Control': 'max-age=60' }); response.end('ok'); }
  }, async url => {
    const result = analyze(await probe(`${url}/start`));
    assert.equal(result.redirects.length, 1);
    assert.equal(result.url, `${url}/end`);
    assert.equal(result.browser.fresh, true);
  });
});

test('rejects redirect loops and invalid schemes', async () => {
  await withServer((_request, response) => { response.writeHead(302, { Location: '/loop' }); response.end(); }, async url => {
    await assert.rejects(probe(`${url}/loop`), /redirect loop/);
  });
  await assert.rejects(probe('file:///etc/passwd'), /http or https/);
  await assert.rejects(probe('example.com'), /absolute http or https URL/);
});

test('CLI arguments and plain output', () => {
  assert.deepEqual(parseArgs(['https://example.test', '--json', '--timeout', '2500']), { json: true, timeout: 2500, url: 'https://example.test' });
  assert.throws(() => parseArgs([]), /give a URL/);
  assert.throws(() => parseArgs(['https://example.test', '--bad']), /unknown option/);
});
