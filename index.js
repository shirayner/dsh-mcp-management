import { isDeepStrictEqual } from 'node:util';
import { ProfileStore } from './profile-store.js';
import { MCP_CLIENT, serverConfig, validateHeaders, resourceIdentity } from './server-config.js';
import { certificateTrustError, createOAuthManager, trustSystemCertificates } from './oauth.js';

export const inject = ['pluginManager', 'configEditor', 'connection', 'credentials'];

export async function apply(ctx) {
  const pm = ctx.pluginManager;
  const ce = ctx.configEditor;
  const store = new ProfileStore(ce.documentPath, {
    credentials: ctx.credentials,
    reconcile: async operation => {
      const hmr = ctx.get('hmr');
      if (!hmr) return { ...await operation(), applied: false, restartReason: 'no-hmr', warnings: [] };
      return hmr.runExclusive(async () => {
        const value = await operation();
        const { warnings, pending, restartReason } = await hmr.reconcileProfile();
        const restart = restartReason ?? pending[0]?.reason;
        return { ...value, applied: !restart, warnings, ...(restart ? { restartReason: restart } : {}) };
      });
    },
  });

  function liveServers() {
    return ce.configuration().filter(row => row.entry.options.name === MCP_CLIENT).map(row => ({
      name: row.entry.options.id,
      entry: row.entry,
      config: { ...row.inherited, ...row.override },
    }));
  }

  // Cordis marks an entry disabled when its fiber is disposed outside the entry API,
  // because that disposal is indistinguishable from an unload. Reopening a connection
  // needs exactly that disposal, so flag the restart here and restore the entry's own
  // flag afterwards; otherwise an authorized server reports as stopped while it runs.
  async function restartEntry(entry) {
    const disabled = entry.options.disabled;
    entry.options.disabled = true;
    try {
      if (entry.fiber) { await entry.fiber.dispose(); entry.fiber = undefined; }
      await entry.init();
    } finally {
      if (disabled === undefined) delete entry.options.disabled;
      else entry.options.disabled = disabled;
    }
  }

  async function reconnect(resource) {
    const run = async () => {
      let count = 0;
      for (const server of liveServers()) {
        if (!server.config.url || resourceIdentity(server.config.url) !== resource || server.entry.disabled) continue;
        await restartEntry(server.entry);
        count++;
      }
      return count;
    };
    const hmr = ctx.get('hmr');
    return hmr ? hmr.runExclusive(run) : run();
  }

  const metadata = await store.metadata();
  if (metadata.settings.trustSystemCertificates) ctx.effect(() => trustSystemCertificates(ctx.logger));
  const oauth = createOAuthManager(ctx, reconnect, {
    scope: store.scope,
    authFor: url => store.authFor(url, liveServers()),
    headersFor: key => store.headersFor(key),
    configuredUrls: async () => liveServers().map(server => server.config.url).filter(Boolean),
  });
  ctx.effect(() => () => oauth.dispose());
  oauth.watch(liveServers().map(server => server.config.url).filter(Boolean));
  // Do not block plugin activation on network retries for restored MCP entries.
  oauth.loadIndex().then(resources => Promise.all(resources.map(resource => reconnect(resource))))
    .catch(error => ctx.logger.warn('mcp-management: restoring profile grants failed: %s', error.message));

  async function listServers() {
    const [plugins, metadata] = await Promise.all([pm.listPlugins(), store.metadata()]);
    const configs = new Map(liveServers().map(server => [server.entry.id, server]));
    const servers = [];
    for (const plugin of plugins.filter(plugin => plugin.moduleName === MCP_CLIENT)) {
      const live = configs.get(plugin.entryId);
      const config = live?.config ?? {};
      const name = live?.name ?? plugin.entryId.split(':').at(-1);
      const saved = Object.hasOwn(metadata.servers, name) ? metadata.servers[name] : {};
      if (saved.removed) continue;
      const secretHeaders = await store.headersFor(saved.headerKey);
      servers.push({
        entryId: plugin.entryId, serverName: name,
        transport: config.transport ?? 'streamable-http', url: config.url ?? '', command: config.command ?? '',
        args: config.args ?? [],
        cwd: config.cwd ?? '', env: config.env ? Object.keys(config.env) : [],
        enabled: plugin.enabled, fiberPhase: plugin.fiberPhase,
        readOnly: !!plugin.readOnlyReason,
        readOnlyReason: plugin.readOnlyReason ?? null,
        authMode: saved.authMode ?? (config.headers ? 'token' : 'none'),
        headerNames: Object.keys({ ...config.headers, ...secretHeaders }),
        toolCallTimeoutMs: config.toolCallTimeoutMs ?? 60000,
        reconnect: config.reconnect ?? { enabled: true, maxAttempts: 10 },
        failOnStartupError: config.failOnStartupError ?? false,
        oauth: config.url ? await oauth.summary(config.url) : null,
      });
    }
    oauth.watch(servers.map(server => server.url).filter(Boolean));
    return servers;
  }

  const routes = new Map();
  function route(method, path, handler) {
    if (!routes.has(path)) routes.set(path, new Map());
    const handlers = routes.get(path);
    if (handlers.has(method)) throw new Error('Duplicate management endpoint');
    handlers.set(method, handler);
  }

  function response(status, body) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }

  async function persistServers(specs, live) {
    const metadata = await store.metadata();
    const authChanges = new Set();
    const urls = specs.map(spec => {
      const before = live.get(spec.serverName);
      const config = serverConfig(spec, before);
      const priorMode = metadata.servers[spec.serverName]?.authMode ?? (before?.headers ? 'token' : 'none');
      if (before && config.url && spec.authMode && spec.authMode !== priorMode && isDeepStrictEqual(config, before)) authChanges.add(config.url);
      return config.url;
    }).filter(Boolean);
    oauth.watch([...liveServers().map(server => server.config.url), ...urls].filter(Boolean));
    const result = await store.import(specs, live);
    if (result.applied) for (const url of authChanges) {
      // Metadata-only auth changes are invisible to the host's config reconciliation.
      oauth.reset(url);
      try { await reconnect(url); }
      catch (error) { result.warnings.push('配置已保存，但重新连接失败：' + (certificateTrustError(error)?.message ?? error.message)); }
    }
    return result;
  }

  route('GET', 'servers', listServers);
  route('GET', 'settings', async () => ({ ...await store.metadata().then(data => data.settings), profileScope: store.scope }));
  route('POST', 'settings', settings => store.updateSettings(settings));
  route('POST', 'save', async spec => {
    if (ce.configuration().some(row => row.entry.options.id === spec.serverName && row.entry.options.name !== MCP_CLIENT)) throw new Error('Server name conflicts with a non-MCP plugin');
    if (spec.headers) validateHeaders(spec.headers);
    return persistServers([spec], new Map(liveServers().map(server => [server.name, server.config])));
  });
  route('POST', 'import', async input => {
    const servers = input.mcpServers ?? input;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('Expected mcpServers object');
    const specs = Object.entries(servers).map(([serverName, spec]) => {
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Invalid server specification');
      return { ...spec, serverName };
    });
    if (!specs.length) throw new Error('No servers to import');
    const live = new Map(liveServers().map(server => [server.name, server.config]));
    const result = await persistServers(specs, live);
    return { ...result, total: (await listServers()).length };
  });
  route('POST', 'remove', async ({ serverName }) => {
    const target = (await listServers()).find(server => server.serverName === serverName);
    if (!target) throw new Error('Invalid MCP removal target');
    if (target.readOnly) throw new Error('MCP server is read-only: ' + target.readOnlyReason);
    return store.remove(serverName, { allowUnmanaged: true });
  });
  route('POST', 'toggle', async ({ entryId, enabled }) => {
    const target = (await listServers()).find(server => server.entryId === entryId);
    if (typeof enabled !== 'boolean' || !target) throw new Error('Invalid MCP toggle target');
    if (target.readOnly) throw new Error('MCP server is read-only: ' + target.readOnlyReason);
    const result = await pm.setPluginEnabled(entryId, enabled);
    if (result.application === 'failed' || result.application === 'cancelled') throw new Error(result.error?.message ?? result.error?.code ?? 'DSH could not change MCP enablement');
    return { ...result, applied: result.application === 'applied' };
  });
  route('POST', 'oauth/start', ({ url }) => oauth.start(resourceIdentity(url)));
  route('POST', 'oauth/status', async ({ attemptId }) => {
    const status = await oauth.status(attemptId);
    if (!status) throw new Error('Authorization attempt not found');
    return status;
  });
  route('POST', 'oauth/cancel', ({ attemptId }) => { oauth.cancel(attemptId); return { cancelled: true }; });
  route('POST', 'oauth/revoke', async ({ url }) => { await oauth.revoke(resourceIdentity(url)); return { revoked: true }; });
  route('GET', 'debug', async () => ({ serverCount: (await listServers()).length, profileScope: store.scope, version: '0.2.0' }));

  // DSH registers exact paths once, with all supported methods on that registration.
  for (const [path, handlers] of routes) ctx.connection.fetch.register({
    path: '/api/mcp-management/' + path, methods: [...handlers.keys()], requestBody: 'buffered',
    fetch: async request => {
      const handler = handlers.get(request.method);
      if (!handler) return response(405, { ok: false, error: { message: 'Method not allowed' } });
      try {
        let body = {};
        if (request.method === 'POST') {
          if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return response(415, { ok: false, error: { message: 'JSON content type is required' } });
          const text = await request.text();
          if (Buffer.byteLength(text) > 262144) return response(413, { ok: false, error: { message: 'Request is too large' } });
          body = JSON.parse(text || '{}');
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected a JSON object');
        }
        return response(200, { ok: true, value: await handler(body) });
      } catch (error) {
        const failures = error instanceof AggregateError ? error.errors : [error];
        ctx.logger.warn('mcp-management: %s %s failed (%s)', request.method, path, failures.map(failure => failure.cause?.code ?? failure.code ?? failure.name).join(', '));
        return response(400, { ok: false, error: certificateTrustError(error) ?? { message: error.message } });
      }
    },
  });
}
