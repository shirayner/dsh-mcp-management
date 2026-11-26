import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ProfileStore, profileDocument, atomicWrite } from '../profile-store.js';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { setTimeout as delay } from 'node:timers/promises';
import { resourceIdentity, resourceKey, profileScope, serverConfig, validateHeaders, parseArgs } from '../server-config.js';

function credentials() {
  const records = new Map();
  return { records,
    async readRecord(key) { return records.get(key); },
    async modifyRecord(key, change) { const next = await change(records.get(key)); if (next) records.set(key, next); return records.get(key); },
    async deleteRecord(key) { records.delete(key); },
  };
}

async function fixture(t, text = '[]\n') {
  const root = await mkdtemp(join(tmpdir(), 'mcp-profile-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const patch = join(root, 'cordis.patch.yml');
  await writeFile(patch, text);
  const secrets = credentials();
  const store = new ProfileStore(patch, { credentials: secrets });
  return { root, patch, secrets, store };
}

const http = name => ({ serverName: name, url: `https://example.com/${name}` });

function failPatchRename(t, patch, failures = 1) {
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === patch && failures-- > 0) throw Object.assign(new Error('Simulated patch write failure'), { code: 'EIO' });
    return rename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test('save/import/remove write only to the current profile and preserve unrelated YAML', async t => {
  const { store, patch } = await fixture(t, '# user settings\n- id: theme\n  config:\n    dark: true\n- id: dynamic\n  config:\n    token: !!js process.env.EXAMPLE_TOKEN\n');
  await store.save(http('alpha'));
  await store.import([http('beta'), http('gamma')]);
  const text = await readFile(patch, 'utf8');
  assert.match(text, /# user settings/);
  assert.match(text, /!!js process.env.EXAMPLE_TOKEN/);
  assert.match(text, /id: alpha/);
  assert.match(text, /id: beta/);
  await store.remove('beta');
  const rows = profileDocument(await readFile(patch, 'utf8')).contents.toJSON();
  assert.equal(rows.find(row => row.id === 'theme').config.dark, true);
  assert.equal(rows.find(row => row.id === 'beta').disabled, true);
  assert.equal((await store.metadata()).servers.beta, undefined);
});

test('concurrent modifications do not lose either server', async t => {
  const { store } = await fixture(t);
  const second = new ProfileStore(store.patchPath, { credentials: store.credentials });
  await Promise.all([store.save(http('first')), second.save(http('second'))]);
  assert.deepEqual(Object.keys((await store.metadata()).servers).sort(), ['first', 'second']);
});

test('profile mutations wait for the same package lock used by DSH ConfigEditor', async t => {
  const { store, root, patch } = await fixture(t);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const holder = withFileLock(join(root, 'package.json'), async () => { enter(); await gate; });
  await entered;
  const saving = store.save(http('first'));
  try {
    await delay(60);
    assert.equal(await readFile(patch, 'utf8'), '[]\n');
    assert.equal(store.lockPath, join(root, 'package.json.lock'));
  } finally { release(); await Promise.all([holder, saving]); }
  assert.match(await readFile(patch, 'utf8'), /id: first/);
});

test('transient Windows rename errors are retried without weakening non-Windows failures', async t => {
  const { patch } = await fixture(t);
  const rename = fs.rename;
  let calls = 0;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === patch && ++calls === 1) throw Object.assign(new Error('Simulated Windows file interference'), { code: 'EPERM' });
    return rename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  if (process.platform === 'win32') {
    await atomicWrite(patch, '# replacement\n[]\n');
    assert.equal(calls, 2);
    assert.equal(await readFile(patch, 'utf8'), '# replacement\n[]\n');
  } else {
    await assert.rejects(atomicWrite(patch, '# replacement\n[]\n'), { code: 'EPERM' });
    assert.equal(await readFile(patch, 'utf8'), '[]\n');
  }
});

test('secret values stay in credentials; edit retains or removes by header name', async t => {
  const { store, patch, secrets } = await fixture(t);
  await store.save({ ...http('secret'), authMode: 'token', headers: { 'X-API-Key': 'test-secret', Authorization: 'Bearer test' } });
  const meta = (await store.metadata()).servers.secret;
  assert.equal((await store.headersFor(meta.headerKey))['X-API-Key'], 'test-secret');
  assert.doesNotMatch(await readFile(patch, 'utf8'), /test-secret|Bearer test|headers:/);
  assert.doesNotMatch(await readFile(store.metadataPath, 'utf8'), /test-secret|Bearer test/);
  await store.save({ ...http('secret'), authMode: 'token', headers: {}, keepHeaderNames: ['X-API-Key'] });
  assert.deepEqual(await store.headersFor(meta.headerKey), { 'X-API-Key': 'test-secret' });
  await store.remove('secret');
  assert.equal(secrets.records.size, 0);
});

test('profile identities isolate headers and OAuth even when the server URL is identical', async t => {
  const { root, store, secrets } = await fixture(t);
  const other = new ProfileStore(join(root, 'other', 'cordis.patch.yml'), { credentials: secrets });
  await store.save({ ...http('same'), headers: { 'X-API-Key': 'a' }, authMode: 'token' });
  await other.save({ ...http('same'), headers: { 'X-API-Key': 'b' }, authMode: 'token' });
  const a = (await store.metadata()).servers.same.headerKey;
  const b = (await other.metadata()).servers.same.headerKey;
  assert.notEqual(a, b);
  assert.notEqual(resourceKey(store.scope, http('same').url), resourceKey(other.scope, http('same').url));
  assert.equal((await store.headersFor(a))['X-API-Key'], 'a');
});

test('batch validation fails without changing the profile or committing credentials', async t => {
  const { store, patch, secrets } = await fixture(t);
  await assert.rejects(store.import([http('good'), { ...http('bad name'), headers: { Key: 'secret' } }]));
  assert.equal(await readFile(patch, 'utf8'), '[]\n');
  assert.equal(secrets.records.size, 0);
});

test('fresh profiles have explicit auth modes and do not create compatibility backups', async t => {
  const { store, root, patch } = await fixture(t);
  assert.deepEqual(await store.metadata(), { version: 1, servers: {}, settings: { trustSystemCertificates: false } });
  await assert.rejects(store.save({ ...http('first'), authMode: 'auto' }), /Invalid authMode/);
  assert.equal(await readFile(patch, 'utf8'), '[]\n');
  await store.save(http('first'));
  assert.equal((await store.metadata()).servers.first.authMode, 'none');
  assert.equal(store.dataDir, join(root, 'plugin-data', 'mcp-management'));
  assert.deepEqual(await fs.readdir(store.dataDir), ['settings.json']);
});

test('server names and retry policies match the MCP client constraints before any writes', async t => {
  const { store, patch, secrets } = await fixture(t);
  assert.equal(serverConfig(http('a'.repeat(32))).serverName.length, 32);
  assert.equal(serverConfig(http('_server')).serverName, '_server');
  await assert.rejects(store.save({ ...http('a'.repeat(33)), headers: { 'X-API-Key': 'test-value' } }), /1–32/);
  assert.throws(() => serverConfig({ ...http('first'), reconnect: { maxAttempts: 0 } }), /Invalid reconnect/);
  assert.throws(() => serverConfig({ ...http('first'), reconnect: { initialDelayMs: 0 } }), /Invalid reconnect/);
  assert.equal(await readFile(patch, 'utf8'), '[]\n');
  assert.equal(secrets.records.size, 0);
});

test('URL identities retain tenant queries and trailing slashes; embedded credentials are forbidden', () => {
  assert.notEqual(resourceIdentity('https://example.com/mcp?tenant=a'), resourceIdentity('https://example.com/mcp?tenant=b'));
  assert.notEqual(resourceIdentity('https://example.com/mcp/'), resourceIdentity('https://example.com/mcp'));
  assert.throws(() => resourceIdentity('https://user:secret@example.com/mcp'));
  assert.notEqual(profileScope('/a'), profileScope('/b'));
});

test('argument arrays, Windows paths and unknown transport fields survive an edit', () => {
  assert.deepEqual(parseArgs('"C:\\Program Files\\app.mjs" --name "hello world"'), ['C:\\Program Files\\app.mjs', '--name', 'hello world']);
  assert.throws(() => parseArgs('"unclosed'));
  const config = serverConfig({ serverName: 'local', command: 'node', args: ['a b'] }, { cwd: '/work', env: { KEY: 'value' }, maxInstructionBytes: 8192 });
  assert.equal(config.cwd, '/work');
  assert.equal(config.maxInstructionBytes, 8192);
  assert.deepEqual(config.env, { KEY: 'value' });
});

test('a later staging error cannot commit the first server credential', async t => {
  const { store, patch, secrets } = await fixture(t);
  await assert.rejects(store.import([
    { ...http('first'), headers: { 'X-API-Key': 'test-value' } },
    { ...http('second'), authMode: 'token', headers: {}, keepHeaderNames: ['missing'] },
  ]), /Retained header/);
  assert.equal(secrets.records.size, 0);
  assert.equal(await readFile(patch, 'utf8'), '[]\n');
  await assert.rejects(readFile(store.metadataPath), { code: 'ENOENT' });
});

test('patch write failure restores both files and the prior credential', async t => {
  const { store, patch, secrets } = await fixture(t);
  await store.save({ ...http('first'), headers: { 'X-API-Key': 'original-value' } });
  const beforePatch = await readFile(patch, 'utf8');
  const beforeMetadata = await readFile(store.metadataPath, 'utf8');
  const beforeRecords = structuredClone([...secrets.records]);
  failPatchRename(t, patch);
  await assert.rejects(store.save({ ...http('first'), url: 'https://example.com/changed', headers: { 'X-API-Key': 'replacement-value' } }), /Simulated patch write failure/);
  assert.equal(await readFile(patch, 'utf8'), beforePatch);
  assert.equal(await readFile(store.metadataPath, 'utf8'), beforeMetadata);
  assert.deepEqual([...secrets.records], beforeRecords);
});

test('incomplete patch rollback still restores metadata and credentials and reports the failure', async t => {
  const { store, patch, secrets } = await fixture(t);
  await store.save({ ...http('first'), headers: { 'X-API-Key': 'original-value' } });
  const beforeMetadata = await readFile(store.metadataPath, 'utf8');
  const beforeRecords = structuredClone([...secrets.records]);
  failPatchRename(t, patch, Infinity);
  await assert.rejects(store.save({ ...http('second'), headers: { 'X-API-Key': 'test-value' } }), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /rollback was incomplete/);
    return true;
  });
  assert.equal(await readFile(store.metadataPath, 'utf8'), beforeMetadata);
  assert.deepEqual([...secrets.records], beforeRecords);
});

test('credential commit failure rolls back earlier records without touching the profile', async t => {
  const { store, patch, secrets } = await fixture(t);
  const modify = secrets.modifyRecord;
  let calls = 0;
  secrets.modifyRecord = async (key, change) => {
    if (++calls === 2) throw new Error('Simulated credential write failure');
    return modify(key, change);
  };
  await assert.rejects(store.import([
    { ...http('first'), headers: { 'X-API-Key': 'test-one' } },
    { ...http('second'), headers: { 'X-API-Key': 'test-two' } },
  ]), /Simulated credential write failure/);
  assert.equal(secrets.records.size, 0);
  assert.equal(await readFile(patch, 'utf8'), '[]\n');
});

test('rollback does not overwrite a credential subsequently changed by another writer', async t => {
  const { store, patch, secrets } = await fixture(t);
  await store.save({ ...http('first'), headers: { 'X-API-Key': 'original-value' } });
  const key = (await store.metadata()).servers.first.headerKey;
  const beforePatch = await readFile(patch, 'utf8');
  const modify = secrets.modifyRecord;
  let calls = 0;
  secrets.modifyRecord = async (id, change) => {
    if (++calls === 2) {
      secrets.records.set(key, { kind: 'grant', payload: { headers: { 'X-API-Key': 'newer-owner-value' } } });
      throw new Error('Simulated credential write failure');
    }
    return modify(id, change);
  };
  await assert.rejects(store.import([
    { ...http('first'), headers: { 'X-API-Key': 'replacement-value' } },
    { ...http('second'), headers: { 'X-API-Key': 'test-two' } },
  ]), error => error instanceof AggregateError && /rollback was incomplete/.test(error.message));
  assert.equal((await store.headersFor(key))['X-API-Key'], 'newer-owner-value');
  assert.equal(await readFile(patch, 'utf8'), beforePatch);
});

test('a removed server name can be added again instead of remaining a disabled tombstone', async t => {
  const { store, patch } = await fixture(t);
  await store.save(http('first'));
  await store.remove('first');
  await store.save(http('first'));
  const rows = parse(await readFile(patch, 'utf8'));
  assert.equal(rows.flatMap(row => row.insert ?? []).filter(entry => entry.id === 'first').length, 1);
  assert.equal(rows.find(row => row.id === 'first').disabled, false);
});

test('editing updates the effective override and cannot replace an unrelated profile entry', async t => {
  const { store, patch } = await fixture(t, '- id: unrelated\n  config:\n    setting: keep\n');
  await assert.rejects(store.save(http('unrelated')), /conflicts/);
  await store.save(http('first'));
  await writeFile(patch, await readFile(patch, 'utf8') + '- id: first\n  config:\n    url: https://example.com/override\n');
  await store.save({ ...http('first'), url: 'https://example.com/updated' });
  const rows = parse(await readFile(patch, 'utf8'));
  assert.equal(rows.find(row => row.id === 'first').config.url, 'https://example.com/updated');
  assert.equal(rows.find(row => row.id === 'unrelated').config.setting, 'keep');
});

test('retained headers and replacements are validated together case-insensitively', async t => {
  const { store, secrets } = await fixture(t);
  await store.save({ ...http('first'), headers: { Authorization: 'test-value' } });
  const before = structuredClone([...secrets.records]);
  await assert.rejects(store.save({ ...http('first'), keepHeaderNames: ['Authorization'], headers: { authorization: 'replacement-value' } }), /Duplicate HTTP header/);
  assert.deepEqual([...secrets.records], before);
});

test('headers reject duplicates, newlines, reserved fields and invalid names', () => {
  assert.throws(() => validateHeaders({ Authorization: 'a', authorization: 'b' }));
  assert.throws(() => validateHeaders({ Key: 'a\nb' }));
  assert.throws(() => validateHeaders({ Host: 'example.com' }));
  assert.throws(() => validateHeaders({ 'Bad:Name': 'x' }));
});
