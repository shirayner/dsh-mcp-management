// Real DSH integration probe. --mutate exercises temporary loopback servers; no OAuth registration is requested.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ProfileStore } from '../profile-store.js';
import { isMap } from 'yaml';

const mutate = process.argv.includes('--mutate');
const ui = process.argv.includes('--ui');
if (ui && !mutate) throw new Error('--ui requires --mutate');
const profileAt = process.argv.indexOf('--profile-dir');
const profileDir = profileAt === -1 ? null : process.argv[profileAt + 1];
if (mutate && !profileDir) throw new Error('--mutate requires the active web --profile-dir for cleanup');
const sourceDir = fileURLToPath(new URL('..', import.meta.url));
const sourceFiles = ['index.js', 'profile-store.js', 'server-config.js', 'oauth.js', 'client.js', 'cordis.patch.yml', 'package.json'];
const sourceBefore = new Map(await Promise.all(sourceFiles.map(async name => [name, await readFile(join(sourceDir, name))])));

async function mutations(base, headers, baseline, launch) {
  const initialStore = new ProfileStore(join(profileDir, 'cordis.patch.yml'));
  let metadataExisted = true;
  try { await readFile(initialStore.metadataPath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; metadataExisted = false; }
  const names = ['probe-add-' + randomUUID().slice(0, 12), 'probe-import-' + randomUUID().slice(0, 12)];
  let initializations = 0;
  const uiFinished = Promise.withResolvers();
  const mcp = createServer(async (request, response) => {
    if (ui && request.method === 'GET' && request.url === '/ui') { response.writeHead(302, { location: launch }).end(); return; }
    if (ui && request.method === 'GET' && request.url === '/ui-done') { response.writeHead(200).end('UI probe finished'); uiFinished.resolve(); return; }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let text = '';
    for await (const bytes of request) text += bytes;
    const rpc = JSON.parse(text);
    if (rpc.method === 'initialize') initializations++;
    if (rpc.id === undefined) { response.writeHead(202).end(); return; }
    const result = rpc.method === 'initialize'
      ? { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'loopback-probe', version: '1.0.0' } }
      : { tools: [] };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise(resolve => mcp.listen(0, '127.0.0.1', resolve));
  const spec = { url: `http://127.0.0.1:${mcp.address().port}/mcp`, authMode: 'none' };
  async function call(path, body) {
    const result = await fetch(base + '/api/mcp-management/' + path, { headers: body ? { ...headers, 'content-type': 'application/json' } : headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    const envelope = await result.json();
    assert.equal(result.status, 200, path + ': ' + envelope.error?.message);
    assert.equal(envelope.ok, true, path + ': ' + envelope.error?.message);
    return envelope.value;
  }
  const counts = [baseline];
  try {
    assert.equal((await call('save', { ...spec, serverName: names[0] })).applied, true);
    counts.push((await call('servers')).length);
    assert.equal(counts.at(-1), baseline + 1);
    let target = (await call('servers')).find(server => server.serverName === names[0]);
    assert.equal((await call('toggle', { entryId: target.entryId, enabled: false })).applied, true);
    assert.equal((await call('servers')).find(server => server.serverName === names[0]).enabled, false);
    const beforeEnable = initializations;
    target = (await call('servers')).find(server => server.serverName === names[0]);
    assert.equal((await call('toggle', { entryId: target.entryId, enabled: true })).applied, true);
    assert.equal((await call('servers')).find(server => server.serverName === names[0]).enabled, true);
    assert.ok(initializations > beforeEnable, 'Re-enabling must initialize the actual MCP connection again');
    assert.equal((await call('import', { mcpServers: { [names[1]]: spec } })).applied, true);
    counts.push((await call('servers')).length);
    assert.equal(counts.at(-1), baseline + 2);
    for (const serverName of names) await call('remove', { serverName });
    counts.push((await call('servers')).length);
    assert.equal(counts.at(-1), baseline);
    await call('save', { ...spec, serverName: names[0] });
    assert.ok((await call('servers')).some(server => server.serverName === names[0] && server.enabled));
    await call('remove', { serverName: names[0] });
    assert.equal((await call('servers')).length, baseline);
    console.log(JSON.stringify({ liveMutationCounts: counts, toggleOffAndOnApplied: true, connectionReinitialized: true, removedNameCanBeAddedAgain: true }));
    if (ui) {
      const uiName = 'probe-ui-' + randomUUID().slice(0, 12);
      names.push(uiName);
      await call('save', { ...spec, serverName: uiName });
      const beforeUi = initializations;
      console.log(JSON.stringify({ uiEntry: new URL('/ui', spec.url).href, uiDone: new URL('/ui-done', spec.url).href, uiServerName: uiName }));
      const timer = setTimeout(() => uiFinished.reject(new Error('UI probe did not finish within five minutes')), 300000);
      try { await uiFinished.promise; } finally { clearTimeout(timer); }
      assert.ok(initializations > beforeUi, 'Browser re-enable must reinitialize the MCP connection');
      assert.equal((await call('servers')).some(server => server.serverName === uiName), false, 'Browser delete must remove the test server');
      console.log('Browser-controlled temporary-server re-enable and deletion verified.');
    }
  } finally {
    try {
      const servers = await call('servers');
      for (const serverName of names) if (servers.some(server => server.serverName === serverName)) await call('remove', { serverName });
      const store = new ProfileStore(join(profileDir, 'cordis.patch.yml'));
      await store.mutation(async doc => {
        doc.contents.items = doc.contents.items.filter(row => !isMap(row) || !names.includes(row.get('id')) || row.items.some(pair => !['id', 'disabled'].includes(pair.key.value)));
        return {};
      });
      const metadata = await store.metadata();
      assert.ok(names.every(name => !Object.hasOwn(metadata.servers, name)), 'Temporary server metadata must be removed');
      if (!metadataExisted) await store.exclusive(async () => {
        const current = await store.metadata();
        if (JSON.stringify(current) === JSON.stringify({ version: 1, servers: {}, settings: { trustSystemCertificates: false } }) && JSON.stringify(await readdir(store.dataDir)) === JSON.stringify(['settings.json'])) {
          await unlink(store.metadataPath);
          await rmdir(store.dataDir);
        }
      });
    } finally {
      mcp.closeAllConnections();
      await new Promise(resolve => mcp.close(resolve));
    }
  }
}

const child = spawn('bash', ['-lc', 'exec dsh web --no-open --port 0'], { stdio: ['ignore', 'pipe', 'pipe'] });
const runFile = promisify(execFile);
function diagnostics(text) {
  return text.split('\n').filter(line => /mcp-management|Error|ERR_|Cannot find| at /.test(line)).join('\n')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/token=[A-Za-z0-9_-]+/g, 'token=<redacted>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted>')
    .slice(-6000);
}
let output = '', base;
child.stdout.on('data', bytes => { output += bytes.toString(); });
child.stderr.on('data', bytes => { output += bytes.toString(); });
try {
  let launch;
  for (let i = 0; i < 90; i++) {
    launch = output.match(/http:\/\/127[.]0[.]0[.]1:[0-9]+\/\?token=[A-Za-z0-9_-]+/)?.[0];
    if (launch || child.exitCode !== null) break;
    await delay(500);
  }
  if (!launch) throw new Error('DSH did not start: ' + output.replace(/token=[A-Za-z0-9_-]+/g, 'token=<redacted>').slice(-1000));
  base = new URL(launch).origin;
  const unauthenticated = await fetch(base + '/api/mcp-management/servers');
  assert.ok([401, 403].includes(unauthenticated.status), 'Unauthenticated management request must be rejected');
  let next = launch;
  const cookies = new Map();
  for (let i = 0; i < 10; i++) {
    const headers = { cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; ') };
    const res = await fetch(next, { redirect: 'manual', headers });
    for (const cookie of res.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]; const at = pair.indexOf('=');
      cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    await res.body?.cancel();
    const location = res.headers.get('location');
    if (!location) break;
    next = new URL(location, next).href;
  }
  const headers = { origin: base, cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; ') };
  const res = await fetch(base + '/api/mcp-management/servers', { headers });
  assert.equal(res.status, 200, 'Authenticated browser must reach plugin routes');
  const list = await res.json();
  assert.equal(list.ok, true);
  assert.ok(Array.isArray(list.value));
  assert.ok(list.value.every(server => !Object.hasOwn(server, 'headers')), 'No secret headers in server DTO');
  const crossOrigin = await fetch(base + '/api/mcp-management/servers', { headers: { ...headers, origin: 'https://untrusted.example.test' } });
  assert.equal(crossOrigin.status, 403);
  const debug = await fetch(base + '/api/mcp-management/debug', { headers }).then(res => res.json());
  assert.equal(debug.value.version, '0.2.0');
  console.log(JSON.stringify({ unauthenticated: unauthenticated.status, authenticated: res.status, crossOrigin: crossOrigin.status, servers: list.value.length, oauthGrants: list.value.filter(server => server.oauth?.authorized).length, connectedHttpServers: list.value.filter(server => server.oauth?.connectionState === 'connected').length, pluginVersion: debug.value.version }));
  if (mutate) await mutations(base, headers, list.value.length, launch);
  for (const [name, before] of sourceBefore) assert.deepEqual(await readFile(join(sourceDir, name)), before, 'Runtime operation modified package file ' + name);
  console.log('Package files are byte-for-byte unchanged by the real DSH run.');
} catch (error) {
  console.error('DSH startup diagnostics (URLs and tokens redacted):\n' + diagnostics(output));
  throw error;
} finally {
  let cleanupError;
  if (child.exitCode === null) {
    if (process.platform === 'win32') {
      try { await runFile('taskkill', ['/PID', String(child.pid), '/T', '/F']); }
      catch (error) { cleanupError = error; }
    } else child.kill('SIGTERM');
    if (child.exitCode === null) await Promise.race([once(child, 'exit'), delay(3000)]);
  }
  child.stdout.destroy();
  child.stderr.destroy();
  if (child.exitCode === null) throw cleanupError ?? new Error('Probe child did not exit');
  if (base) {
    // A pooled HTTP socket can reset after taskkill; check the listener on a fresh TCP connection.
    const closed = await new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(base).port) });
      socket.setTimeout(1500);
      socket.once('connect', () => { socket.destroy(); resolve(false); });
      socket.once('error', error => { if (error.code === 'ECONNREFUSED') resolve(true); else reject(error); });
      socket.once('timeout', () => { socket.destroy(); reject(new Error('Probe listener shutdown check timed out')); });
    });
    assert.ok(closed, 'The DSH instance created by this probe must stop');
    console.log('Probe process exited and its listener is closed.');
  }
}
