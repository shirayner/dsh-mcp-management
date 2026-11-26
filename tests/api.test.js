import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { apply } from '../index.js';
import { resourceKey } from '../server-config.js';

async function host(t, { fetchError, reconnectError, inherited = [], toggleResult } = {}) {
  const originalFetch = globalThis.fetch;
  if (fetchError) globalThis.fetch = async () => { throw fetchError; };
  const profile = await mkdtemp(join(tmpdir(), 'mcp-api-test-'));
  const patch = join(profile, 'cordis.patch.yml');
  await writeFile(patch, '[]\n');
  const routes = new Map(), cleanup = [], secrets = new Map();
  let rows = [], restarts = 0;
  const toggles = [];
  const load = async () => {
    const entries = new Map(inherited.map(entry => [entry.id, { ...entry }]));
    for (const row of parse(await readFile(patch, 'utf8'))) {
      for (const entry of row.insert ?? []) entries.set(entry.id, { ...entry });
      if (row.id && entries.has(row.id)) entries.set(row.id, { ...entries.get(row.id), ...row });
    }
    rows = [...entries.values()].map(row => {
      const entry = {
        id: 'include:' + row.id,
        options: row,
        // Mirror the loader: the effective flag comes from the options, and disposing a
        // fiber outside the entry API marks the entry disabled, as an unload would.
        get disabled() { return !!entry.options.disabled; },
        set disabled(value) { if (value) entry.options.disabled = true; else delete entry.options.disabled; },
        fiber: { async dispose() { entry.options.disabled = true; entry.fiber = undefined; } },
        async init() { restarts++; if (reconnectError) throw reconnectError; entry.fiber = { async dispose() { entry.options.disabled = true; entry.fiber = undefined; } }; },
      };
      return { entry, inherited: row.config ?? {}, override: {} };
    });
  };
  const ctx = {
    credentials: {
      async readRecord(key) { return secrets.get(key); },
      async modifyRecord(key, change) { const next = await change(secrets.get(key)); if (next) secrets.set(key, next); return secrets.get(key); },
      async deleteRecord(key) { secrets.delete(key); },
    },
    configEditor: { documentPath: patch, configuration: () => rows },
    pluginManager: {
      async listPlugins() { return rows.map(row => ({ entryId: row.entry.id, moduleName: row.entry.options.name, enabled: !row.entry.disabled, fiberPhase: 'active', readOnlyReason: row.entry.options.readOnlyReason })); },
      async setPluginEnabled(entryId, enabled) {
        toggles.push({ entryId, enabled });
        const result = toggleResult ?? { application: 'applied', changed: true, warnings: [] };
        if (result.application === 'applied') rows.find(row => row.entry.id === entryId).entry.disabled = !enabled;
        return result;
      },
    },
    connection: { fetch: { register(route) {
      if (routes.has(route.path)) throw new Error('Exact Fetch route is already registered');
      routes.set(route.path, route);
      const stop = () => routes.delete(route.path);
      cleanup.push(stop);
      return stop;
    } } },
    logger: { warn() {} },
    get(name) {
      if (name === 'credentials') return this.credentials;
      if (name === 'authorization') return { registerFlow() { throw new Error('Unexpected authorization registration'); }, begin() { throw new Error('Unexpected authorization start'); } };
      if (name === 'hmr') return { runExclusive: operation => operation(), async reconcileProfile() { await load(); return { warnings: [], pending: [] }; } };
    },
    effect(callback) { const disposer = callback(); if (disposer) cleanup.push(disposer); },
  };
  await load();
  await apply(ctx);
  t.after(async () => { for (const stop of cleanup.reverse()) await stop(); globalThis.fetch = originalFetch; await rm(profile, { recursive: true, force: true }); });
  async function call(path, body) {
    const route = routes.get('/api/mcp-management/' + path);
    const request = new Request('http://localhost/api/mcp-management/' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const result = await route.fetch(request);
    return { status: result.status, body: await result.json() };
  }
  return { routes, call, patch, secrets, toggles, restarts: () => restarts };
}

test('management endpoints are registered only on the authenticated DSH /api carrier', async t => {
  const h = await host(t);
  assert.ok(h.routes.size > 0);
  for (const [path, route] of h.routes) { assert.ok(path.startsWith('/api/mcp-management/')); assert.equal(route.requestBody, 'buffered'); }
  assert.equal(h.routes.has('/mcp-management/servers'), false);
  assert.deepEqual(h.routes.get('/api/mcp-management/settings').methods, ['GET', 'POST']);
  assert.equal((await h.call('settings')).status, 200);
  assert.equal((await h.call('settings', { trustSystemCertificates: false })).status, 200);
});

test('API persists OAuth mode; static headers are never returned and can be retained without reading their values', async t => {
  const h = await host(t);
  const saved = await h.call('save', { serverName: 'private', url: 'https://example.test/mcp', authMode: 'token', headers: { 'X-API-Key': 'unit-test-secret' } });
  assert.equal(saved.body.value.applied, true);
  let result = await h.call('servers');
  assert.deepEqual(result.body.value[0].headerNames, ['X-API-Key']);
  assert.doesNotMatch(JSON.stringify(result.body), /unit-test-secret/);
  assert.doesNotMatch(await readFile(h.patch, 'utf8'), /unit-test-secret/);
  await h.call('save', { serverName: 'private', url: 'https://example.test/mcp', authMode: 'token', headers: {}, keepHeaderNames: ['X-API-Key'] });
  assert.equal([...h.secrets.values()][0].payload.headers['X-API-Key'], 'unit-test-secret');
  await h.call('save', { serverName: 'private', url: 'https://example.test/mcp', authMode: 'oauth' });
  result = await h.call('servers');
  assert.equal(result.body.value[0].authMode, 'oauth');
  assert.equal(result.body.value[0].oauth.required, true);
});

test('metadata-only authentication changes reconnect on Save and Import, but unchanged saves do not', async t => {
  const h = await host(t);
  const spec = { serverName: 'mode-change', url: 'https://example.test/mcp', authMode: 'none' };
  assert.equal((await h.call('save', spec)).status, 200);
  assert.equal(h.restarts(), 0);
  assert.equal((await h.call('save', { ...spec, authMode: 'oauth' })).status, 200);
  assert.equal(h.restarts(), 1);
  await h.call('save', { ...spec, authMode: 'oauth' });
  assert.equal(h.restarts(), 1);
  await h.call('import', { mcpServers: { 'mode-change': { url: spec.url, authMode: 'none' } } });
  assert.equal(h.restarts(), 2);
  assert.equal((await h.call('servers')).body.value[0].authMode, 'none');
});

test('an OAuth reconnect restarts the connection without reporting the server as disabled', async t => {
  const h = await host(t);
  const spec = { serverName: 'restart-me', url: 'https://example.test/mcp', authMode: 'none' };
  await h.call('save', spec);
  assert.equal((await h.call('servers')).body.value[0].enabled, true);
  await h.call('save', { ...spec, authMode: 'oauth' });
  assert.equal(h.restarts(), 1);
  assert.equal((await h.call('servers')).body.value[0].enabled, true);
});

test('a post-save reconnect failure reports the committed configuration rather than a failed save', async t => {
  const h = await host(t, { reconnectError: new Error('initialize failed') });
  const spec = { serverName: 'mode-change', url: 'https://example.test/mcp', authMode: 'none' };
  await h.call('save', spec);
  const result = await h.call('save', { ...spec, authMode: 'oauth' });
  assert.equal(result.status, 200);
  assert.equal(result.body.value.applied, true);
  assert.match(result.body.value.warnings.join(' '), /配置已保存.*initialize failed/);
  assert.equal((await h.call('servers')).body.value[0].authMode, 'oauth');
});

test('missing authorization attempts still return the management error envelope', async t => {
  const h = await host(t);
  const result = await h.call('oauth/status', { attemptId: 'missing' });
  assert.equal(result.status, 400);
  assert.match(result.body.error.message, /Authorization attempt not found/);
});

test('certificate trust failure is actionable but cannot enable system trust implicitly', async t => {
  const error = new TypeError('fetch failed', { cause: Object.assign(new Error('chain not trusted'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) });
  const h = await host(t, { fetchError: error });
  const result = await h.call('oauth/start', { url: 'https://mcp.example.test/mcp' });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'tls/certificate-trust');
  assert.match(result.body.error.message, /使用系统证书/);
  assert.match(result.body.error.message, /重启/);
  assert.equal((await h.call('settings')).body.value.trustSystemCertificates, false);
  assert.equal(await readFile(h.patch, 'utf8'), '[]\n');
  assert.equal(h.secrets.size, 0);
  const enabled = await h.call('settings', { trustSystemCertificates: true });
  assert.equal(enabled.body.value.settings.trustSystemCertificates, true);
  assert.equal(enabled.body.value.requiresRestart, true);
});

test('expired certificates are not treated as a system-trust opt-in', async t => {
  const error = new TypeError('fetch failed', { cause: Object.assign(new Error('certificate expired'), { code: 'CERT_HAS_EXPIRED' }) });
  const h = await host(t, { fetchError: error });
  const result = await h.call('oauth/start', { url: 'https://mcp.example.test/mcp' });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, undefined);
  assert.equal((await h.call('settings')).body.value.trustSystemCertificates, false);
});

const bundleServer = { id: 'bundle-service', name: '@deepseek-ai/dsh-mcp-client', config: { url: 'https://example.test/mcp' } };

test('toggle delegates the loader identity and exposes saved versus applied outcomes', async t => {
  const h = await host(t, { inherited: [bundleServer], toggleResult: { application: 'restart-required', changed: true, restartReason: 'no-hmr', warnings: [] } });
  const result = await h.call('toggle', { entryId: 'include:bundle-service', enabled: false });
  assert.equal(result.status, 200);
  assert.equal(result.body.value.applied, false);
  assert.deepEqual(h.toggles, [{ entryId: 'include:bundle-service', enabled: false }]);
});

test('a structured host failure is not wrapped as a successful toggle', async t => {
  const h = await host(t, { inherited: [bundleServer], toggleResult: { application: 'failed', changed: false, error: { code: 'not-writable', message: 'profile is not writable' } } });
  const result = await h.call('toggle', { entryId: 'include:bundle-service', enabled: false });
  assert.equal(result.status, 400);
  assert.match(result.body.error.message, /profile is not writable/);
});

test('writable inherited servers can be removed from this profile without deleting their bundle or grant', async t => {
  const h = await host(t, { inherited: [bundleServer] });
  const scope = (await h.call('settings')).body.value.profileScope;
  const key = resourceKey(scope, bundleServer.config.url);
  h.secrets.set(key, { kind: 'grant', payload: { version: 1, profileScope: scope, resource: bundleServer.config.url, accessToken: 'test-sentinel' } });
  const result = await h.call('remove', { serverName: bundleServer.id });
  assert.equal(result.status, 200);
  assert.equal(result.body.value.applied, true);
  assert.equal((await h.call('servers')).body.value.length, 0);
  assert.equal(h.secrets.get(key).payload.accessToken, 'test-sentinel');
  assert.match(await readFile(h.patch, 'utf8'), /disabled: true/);
  await h.call('save', { serverName: bundleServer.id, url: bundleServer.config.url, authMode: 'none' });
  const list = (await h.call('servers')).body.value;
  assert.equal(list.length, 1);
  assert.equal(list[0].enabled, true);
});

test('read-only and non-MCP targets cannot be removed or toggled through management', async t => {
  const h = await host(t, { inherited: [{ ...bundleServer, readOnlyReason: 'profile-read-only' }, { id: 'other', name: 'other-plugin', config: {} }] });
  assert.equal((await h.call('servers')).body.value[0].readOnly, true);
  assert.equal((await h.call('remove', { serverName: bundleServer.id })).status, 400);
  assert.equal((await h.call('toggle', { entryId: 'include:bundle-service', enabled: false })).status, 400);
  assert.equal((await h.call('remove', { serverName: 'other' })).status, 400);
  assert.equal((await h.call('remove', { serverName: 'missing' })).status, 400);
  assert.equal(h.toggles.length, 0);
  assert.equal(await readFile(h.patch, 'utf8'), '[]\n');
});

test('invalid payload is rejected before touching profile settings', async t => {
  const h = await host(t);
  assert.equal((await h.call('save', { serverName: 'bad name', command: 'node' })).status, 400);
  assert.equal(await readFile(h.patch, 'utf8'), '[]\n');
  const route = h.routes.get('/api/mcp-management/save');
  const result = await route.fetch(new Request('http://localhost/api/mcp-management/save', { method: 'POST', body: '{}' }));
  assert.equal(result.status, 415);
});
