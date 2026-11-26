import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { certificateTrustError, createOAuthManager } from '../oauth.js';
import { resourceKey } from '../server-config.js';
import { setTimeout as delay } from 'node:timers/promises';

const RESOURCE = 'https://mcp.example.test/mcp?tenant=one';
const ISSUER = 'https://auth.example.test';

async function fixture(t, { expires = 3600, autoApprove = true, resource = RESOURCE, onRequest } = {}) {
  const original = globalThis.fetch;
  const records = new Map(), flows = new Map();
  const state = { access: '', refresh: '', issued: 0, polls: 0, rotations: 0, registrations: 0, revocations: 0, outgoing: [] };
  const issue = () => { state.issued++; state.access = 'access-' + state.issued; state.refresh = 'refresh-' + state.issued; return { access_token: state.access, refresh_token: state.refresh, token_type: 'Bearer', expires_in: expires }; };
  const json = (body, status = 200, headers) => new Response(JSON.stringify(body), { status, headers });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input), form = new URLSearchParams(init.body);
    if (url.includes('/.well-known/oauth-protected-resource')) return json({ resource, authorization_servers: [ISSUER] });
    if (url === ISSUER + '/.well-known/oauth-authorization-server') return json({ issuer: ISSUER, token_endpoint: ISSUER + '/token', registration_endpoint: ISSUER + '/register', device_authorization_endpoint: ISSUER + '/device', revocation_endpoint: ISSUER + '/revoke' });
    if (url === ISSUER + '/register') return json({ client_id: 'public-client-' + ++state.registrations });
    if (url === ISSUER + '/device') return json({ device_code: 'device', user_code: 'EXAMPLE', verification_uri: ISSUER + '/verify', expires_in: 30, interval: 1 });
    if (url === ISSUER + '/token') {
      if (form.get('grant_type') === 'refresh_token') {
        if (form.get('refresh_token') !== state.refresh) return json({ error: 'invalid_grant' }, 400);
        state.rotations++;
        return json(issue());
      }
      state.polls++;
      return autoApprove && state.polls >= 2 ? json(issue()) : json({ error: 'authorization_pending' }, 400);
    }
    if (url === ISSUER + '/revoke') { state.revocations++; return json({}); }
    const auth = new Headers(init.headers).get('authorization');
    state.outgoing.push({ url, auth, headers: new Headers(init.headers) });
    const override = await onRequest?.({ url, auth, state });
    if (override) return override;
    return auth === 'Bearer ' + state.access && !!state.access ? json({ result: {} })
      : json({ error: 'invalid_token' }, 401, { 'www-authenticate': 'Bearer error="invalid_token"' });
  };
  let chain = Promise.resolve();
  const store = {
    async readRecord(key) { return records.get(key); },
    async modifyRecord(key, change) {
      const result = chain.then(async () => { const next = await change(records.get(key)); if (next) records.set(key, next); return records.get(key); });
      chain = result.catch(() => {}); return result;
    },
    async deleteRecord(key) { records.delete(key); },
  };
  const authorization = {
    registerFlow(flow) { assert.equal(flows.has(flow.key), false); flows.set(flow.key, flow); return () => flows.delete(flow.key); },
    cancel() {},
    async begin(request) {
      await flows.get(request.key).run({ signal: request.signal, notify: request.interaction.notify,
        async commit(record) { if (request.signal.aborted) throw request.signal.reason; await store.modifyRecord(request.key, async () => record); },
      });
      return { status: 'authorized' };
    },
  };
  let mode = 'oauth', restarts = 0;
  const manager = createOAuthManager({ get: name => name === 'credentials' ? store : name === 'authorization' ? authorization : undefined }, async () => ++restarts, {
    scope: 'mcp-management-profile-a', authFor: async () => ({ authMode: mode }), configuredUrls: async () => [resource],
  });
  t.after(() => { manager.dispose(); globalThis.fetch = original; });
  manager.watch([resource]);
  async function approve() {
    const start = await manager.start(resource);
    let status;
    for (let i = 0; i < 50; i++) { status = await manager.status(start.attemptId); if (status.status !== 'pending') break; await delay(100); }
    assert.equal(status.status, 'authorized');
    return status;
  }
  return { manager, state, records, store, approve, setMode: value => { mode = value; }, restarts: () => restarts };
}

const request = () => globalThis.fetch(RESOURCE, { method: 'POST', body: JSON.stringify({ method: 'tools/list' }) });

test('device-code login, bearer injection, rotation and revocation use the DSH credential service', async t => {
  const f = await fixture(t);
  await request();
  assert.equal((await f.manager.summary(RESOURCE)).connectionState, 'needs-authorization');
  const done = await f.approve();
  assert.equal(done.restarted, 1);
  assert.equal((await request()).status, 200);
  assert.equal((await f.manager.summary(RESOURCE)).connectionState, 'connected');
  f.state.access = 'rejected';
  assert.equal((await request()).status, 200);
  assert.equal(f.state.rotations, 1);
  const record = f.records.get(resourceKey('mcp-management-profile-a', RESOURCE));
  assert.equal(record.payload.refreshToken, 'refresh-2');
  f.setMode('none');
  await request();
  assert.equal(f.state.outgoing.at(-1).auth, null);
  await f.manager.revoke(RESOURCE);
  assert.equal(f.records.size, 0);
});

test('query variants do not receive a different tenant credential', async t => {
  const f = await fixture(t);
  await f.approve();
  await globalThis.fetch('https://mcp.example.test/mcp?tenant=two', {});
  assert.equal(f.state.outgoing.at(-1).auth, null);
});

test('cancelling an in-flight device flow cannot commit a grant later', async t => {
  const f = await fixture(t, { autoApprove: false });
  const { attemptId } = await f.manager.start(RESOURCE);
  await delay(10);
  f.manager.cancel(attemptId);
  await delay(30);
  assert.equal((await f.manager.status(attemptId)).status, 'cancelled');
  assert.equal(f.records.size, 0);
});

for (const resource of ['https://mcp.example.test/mcp', RESOURCE]) {
  test('unscoped credentials are never adopted for ' + resource, async t => {
    const f = await fixture(t, { resource });
    const unscoped = 'mcp-management/oauth-' + createHash('sha256').update(resource.split('?')[0]).digest('hex').slice(0, 16);
    f.records.set(unscoped, { kind: 'grant', payload: { resource, accessToken: 'unscoped-test-value' } });
    assert.deepEqual(await f.manager.loadIndex(), []);
    await globalThis.fetch(resource, { method: 'POST', body: JSON.stringify({ method: 'tools/list' }) });
    assert.equal(f.state.outgoing.at(-1).auth, null);
    assert.equal(f.records.size, 1);
    assert.equal(f.records.has(resourceKey('mcp-management-profile-a', resource)), false);
  });
}

test('a different profile grant cannot authorize this profile', async t => {
  const f = await fixture(t);
  const otherKey = resourceKey('mcp-management-profile-b', RESOURCE);
  const other = { kind: 'grant', payload: { version: 1, profileScope: 'mcp-management-profile-b', resource: RESOURCE, accessToken: 'other-profile-value' } };
  f.records.set(otherKey, other);
  assert.deepEqual(await f.manager.loadIndex(), []);
  await request();
  assert.equal(f.state.outgoing.at(-1).auth, null);
  await f.manager.revoke(RESOURCE);
  assert.deepEqual(f.records.get(otherKey), other);
});

test('stored grants must match the exact profile and resource schema', async t => {
  const f = await fixture(t);
  const key = resourceKey('mcp-management-profile-a', RESOURCE);
  f.records.set(key, { kind: 'grant', payload: { version: 1, profileScope: 'mcp-management-profile-b', resource: RESOURCE, accessToken: 'test-value' } });
  await assert.rejects(f.manager.loadIndex(), /Invalid stored OAuth grant/);
  assert.equal(f.state.outgoing.length, 0);
  f.records.set(key, { kind: 'grant', payload: { version: 1, profileScope: 'mcp-management-profile-a', resource: 'https://mcp.example.test/other', accessToken: 'test-value' } });
  await assert.rejects(f.manager.loadIndex(), /Invalid stored OAuth grant/);
});

test('certificate guidance applies only to chain-trust errors, not expired or mismatched certificates', () => {
  for (const code of ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT']) {
    const result = certificateTrustError(new TypeError('fetch failed', { cause: { code } }));
    assert.equal(result.code, 'tls/certificate-trust');
    assert.ok(result.message.includes(code));
    assert.match(result.message, /不要关闭 TLS/);
  }
  for (const code of ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ENOTFOUND']) assert.equal(certificateTrustError({ cause: { code } }), null);
});

const rejectedResponse = () => new Response('{}', { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' } });

test('a committed grant remains configured when the server rejects even its refreshed token', async t => {
  const f = await fixture(t, { onRequest: rejectedResponse });
  const done = await f.approve();
  assert.equal((await request()).status, 401);
  assert.equal(f.state.rotations, 1);
  const summary = await f.manager.summary(RESOURCE);
  assert.equal(summary.configured, true);
  assert.equal(summary.authorized, true);
  assert.equal(summary.rejected, true);
  assert.equal(summary.connectionState, 'needs-authorization');
  const status = await f.manager.status(done.attemptId);
  assert.ok(status.oauth.checkedAt >= summary.checkedAt);
  assert.deepEqual({ ...status.oauth, checkedAt: summary.checkedAt }, summary);
  assert.doesNotMatch(JSON.stringify(status), /access-[0-9]|refresh-[0-9]/);
});

test('an unauthenticated request completing after authorization cannot overwrite the new connection', async t => {
  const entered = Promise.withResolvers(), response = Promise.withResolvers();
  const f = await fixture(t, { onRequest: ({ auth }) => { if (!auth) { entered.resolve(); return response.promise; } } });
  const old = request();
  await entered.promise;
  await f.approve();
  await request();
  response.resolve(rejectedResponse());
  assert.equal((await old).status, 401);
  const summary = await f.manager.summary(RESOURCE);
  assert.equal(summary.authorized, true);
  assert.equal(summary.rejected, false);
  assert.equal(summary.connectionState, 'connected');
});

test('a failed request from an older grant cannot replace the successful reauthorization state', async t => {
  const entered = Promise.withResolvers(), response = Promise.withResolvers();
  const f = await fixture(t, { onRequest: ({ auth }) => { if (auth === 'Bearer access-1') { entered.resolve(); return response.promise; } } });
  await f.approve();
  const old = request();
  const oldFailure = assert.rejects(old, /old connection failed/);
  await entered.promise;
  await f.approve();
  await request();
  response.reject(new Error('old connection failed'));
  await oldFailure;
  const summary = await f.manager.summary(RESOURCE);
  assert.equal(summary.connectionState, 'connected');
  assert.equal(summary.authorized, true);
  assert.equal(summary.error, null);
});

test('an explicit caller Authorization rejection is not a rejection of the stored OAuth grant', async t => {
  const f = await fixture(t);
  await f.approve();
  assert.equal((await globalThis.fetch(RESOURCE, { headers: { authorization: 'Bearer caller-token' } })).status, 401);
  assert.equal(f.state.outgoing.at(-1).auth, 'Bearer caller-token');
  const summary = await f.manager.summary(RESOURCE);
  assert.equal(summary.configured, true);
  assert.equal(summary.authorized, true);
  assert.equal(summary.rejected, false);
  assert.equal(summary.connectionState, 'failed');
  assert.equal(f.state.rotations, 0);
});

test('Authorization on a Request remains explicit when init adds unrelated headers', async t => {
  const f = await fixture(t);
  await f.approve();
  const input = new Request(RESOURCE, { headers: { authorization: 'Bearer caller-token' } });
  assert.equal((await globalThis.fetch(input, { headers: { accept: 'application/json' } })).status, 401);
  assert.equal(f.state.outgoing.at(-1).auth, 'Bearer caller-token');
  const summary = await f.manager.summary(RESOURCE);
  assert.equal(summary.rejected, false);
  assert.equal(summary.authorized, true);
  assert.equal(summary.connectionState, 'failed');
  assert.equal(f.state.rotations, 0);
});

test('a network failure does not erase the saved grant or claim token rejection', async t => {
  const f = await fixture(t, { onRequest: () => { throw new Error('network unavailable'); } });
  await f.approve();
  await assert.rejects(request(), /network unavailable/);
  const summary = await f.manager.summary(RESOURCE);
  assert.equal(summary.configured, true);
  assert.equal(summary.authorized, true);
  assert.equal(summary.rejected, false);
  assert.equal(summary.connectionState, 'failed');
  assert.match(summary.error, /network unavailable/);
});

test('non-loopback HTTP OAuth is rejected before discovery', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.start('http://unsafe.example.test/mcp'), /HTTPS/);
});
