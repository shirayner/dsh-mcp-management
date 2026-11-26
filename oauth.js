/**
 * OAuth for HTTP MCP servers that sit behind an OAuth 2.1 resource server.
 *
 * dsh-mcp-client sends only the static headers in its config, so this module
 *  1. runs a device-code authorization through `ctx.authorization` and stores the
 *     grant in `ctx.credentials` (never in a patch file), and
 *  2. wraps `globalThis.fetch`, which the MCP SDK resolves on every request, to
 *     attach the bearer token for authorized server URLs and refresh it on expiry.
 */
import { randomUUID } from 'node:crypto';
import tls from 'node:tls';
import { resourceIdentity, resourceKey } from './server-config.js';

const SCOPE = 'openid profile email';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** Refresh slightly before expiry so a request never leaves with a token that dies in flight. */
const REFRESH_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const ATTEMPT_TTL_MS = 30 * 60_000;

/** Canonical form used to match a request URL against a stored grant. */
export const normalizeResource = resourceIdentity;

function oauthEndpoint(input) {
  const url = new URL(resourceIdentity(input));
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new Error('OAuth endpoints must use HTTPS (HTTP is allowed only on loopback)');
  return url.href;
}

function payloadOf(record) {
  return record?.kind === 'grant' ? record.payload : undefined;
}

export function certificateTrustError(error) {
  const code = error?.cause?.code ?? error?.code;
  if (!['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code)) return null;
  return {
    code: 'tls/certificate-trust',
    message: `无法验证服务器证书链（${code}）。如果操作系统已信任该证书，请启用“使用系统证书”并完整重启 DSH 后重试；不要关闭 TLS 证书校验。`,
  };
}

function errorText(err) {
  return certificateTrustError(err)?.message ?? String(err?.cause?.code ?? err?.message ?? err);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Trust the OS certificate store in addition to Node's bundled roots. Corporate
 * gateways are signed by an internal CA that Windows trusts but Node does not,
 * so HTTPS MCP servers fail with UNABLE_TO_VERIFY_LEAF_SIGNATURE without this.
 * @returns a restore function, or a no-op when the runtime lacks the API.
 */
export function trustSystemCertificates(logger) {
  if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') {
    return () => {};
  }
  const previous = tls.getCACertificates('default');
  try {
    tls.setDefaultCACertificates([...new Set([...previous, ...tls.getCACertificates('system')])]);
  } catch (err) {
    logger?.warn('mcp-management: could not add system CA certificates: %s', errorText(err));
    return () => {};
  }
  return () => tls.setDefaultCACertificates(previous);
}
/* ════════════════════════════════════════════════════════════
   Protocol: discovery (RFC 9728 / 8414), registration (RFC 7591),
   device authorization (RFC 8628), refresh
   ════════════════════════════════════════════════════════════ */

async function readJson(fetchImpl, url, init = {}, signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetchImpl(oauthEndpoint(url), { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const text = await res.text();
  if (text.length > 65536) throw new Error('OAuth response exceeds the size limit');
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { throw new Error('OAuth endpoint returned invalid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid OAuth response');
  return { res, body };
}

async function discover(fetchImpl, mcpUrl) {
  const u = new URL(mcpUrl);
  const path = u.pathname.replace(/\/+$/, '');
  let prm;
  for (const candidate of [`${u.origin}/.well-known/oauth-protected-resource${path}`, `${u.origin}/.well-known/oauth-protected-resource`]) {
    const { res, body } = await readJson(fetchImpl, candidate);
    if (res.ok && Array.isArray(body.authorization_servers) && body.authorization_servers.length > 0) { prm = body; break; }
  }
  if (!prm) throw new Error('该地址没有 OAuth 元数据（.well-known/oauth-protected-resource），不是 OAuth 保护的 MCP 服务器');

  const issuer = oauthEndpoint(String(prm.authorization_servers[0])).replace(/\/+$/, '');
  const as = new URL(issuer);
  const candidates = [...new Set([`${as.origin}/.well-known/oauth-authorization-server${as.pathname === '/' ? '' : as.pathname}`, `${issuer}/.well-known/oauth-authorization-server`])];
  let meta;
  for (const candidate of candidates) {
    const response = await readJson(fetchImpl, candidate);
    if (response.res.ok) { meta = response.body; break; }
  }
  if (!meta?.token_endpoint) throw new Error('Cannot discover the authorization server');
  if (meta.issuer && oauthEndpoint(meta.issuer).replace(/\/+$/, '') !== issuer) throw new Error('Authorization server issuer mismatch');
  for (const field of ['token_endpoint', 'registration_endpoint', 'device_authorization_endpoint', 'revocation_endpoint']) if (meta[field]) meta[field] = oauthEndpoint(meta[field]);
  if (!meta.device_authorization_endpoint) throw new Error('This server does not support Device Code; authorization-code login is not implemented');
  const resourceParam = prm.resource ? resourceIdentity(prm.resource) : resourceIdentity(mcpUrl);
  if (new URL(resourceParam).origin !== new URL(mcpUrl).origin) throw new Error('OAuth resource origin differs from the MCP server');
  return { resourceParam, issuer, meta };
}

async function registerClient(fetchImpl, meta, signal) {
  if (!meta.registration_endpoint) throw new Error('授权服务器不支持动态注册客户端');
  const { res, body } = await readJson(fetchImpl, meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'DSH MCP Management',
      redirect_uris: ['http://127.0.0.1/callback'],
      grant_types: [DEVICE_GRANT, 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    }),
  }, signal);
  if (!res.ok || !body.client_id) throw new Error(`注册客户端失败：HTTP ${res.status}`);
  return { clientId: body.client_id, clientSecret: body.client_secret ?? null };
}

function tokenRequest(fetchImpl, grant, form, signal) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (grant.clientSecret) {
    headers.authorization = 'Basic ' + Buffer.from(`${grant.clientId}:${grant.clientSecret}`).toString('base64');
  }
  return readJson(fetchImpl, grant.tokenEndpoint, { method: 'POST', headers, body: form.toString() }, signal);
}

function withTokens(grant, token) {
  return {
    ...grant,
    accessToken: token.access_token,
    // Authorization servers may rotate refresh tokens; persist the replacement atomically.
    refreshToken: token.refresh_token ?? grant.refreshToken ?? null,
    expiresAt: token.expires_in ? Date.now() + Number(token.expires_in) * 1000 : null,
    scope: token.scope ?? grant.scope ?? SCOPE,
    refreshedAt: Date.now(),
  };
}

async function deviceAuthorize(fetchImpl, grant, session) {
  const form = new URLSearchParams({ client_id: grant.clientId, scope: SCOPE, resource: grant.resourceParam });
  const { res, body: device } = await readJson(fetchImpl, grant.deviceEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  }, session.signal);
  if (!res.ok || !device.device_code) throw new Error(`申请设备码失败：HTTP ${res.status}`);

  session.notify({
    message: '在浏览器中打开链接并确认授权',
    url: oauthEndpoint(device.verification_uri_complete ?? device.verification_uri),
    code: device.user_code,
  });

  const deadline = Date.now() + Number(device.expires_in ?? 600) * 1000;
  let interval = Math.max(1, Number(device.interval ?? 5));
  while (Date.now() < deadline) {
    await sleep(interval * 1000, session.signal);
    const poll = new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: device.device_code, client_id: grant.clientId, resource: grant.resourceParam });
    const { res: tr, body: token } = await tokenRequest(fetchImpl, grant, poll, session.signal);
    if (tr.ok && token.access_token) return withTokens({ ...grant, authorizedAt: Date.now() }, token);
    if (token.error === 'authorization_pending') continue;
    if (token.error === 'slow_down') { interval += 5; continue; }
    if (token.error === 'access_denied') throw new Error('你在浏览器中拒绝了授权');
    if (token.error === 'expired_token') break;
    throw new Error(`换取 token 失败：${token.error ?? `HTTP ${tr.status}`}`);
  }
  throw new Error('设备码已过期，请重新授权');
}
/* ════════════════════════════════════════════════════════════
   Manager
   ════════════════════════════════════════════════════════════ */

/**
 * @param ctx - plugin context; `authorization` and `credentials` are looked up per call.
 * @param reconnect - `(resource) => Promise<number>` restarting the MCP entries for one URL.
 */
export function createOAuthManager(ctx, reconnect, { scope, authFor = async () => ({ authMode: 'none' }), headersFor = async () => ({}), configuredUrls = async () => [] } = {}) {
  if (!scope) throw new Error('A DSH profile credential scope is required');
  const keyFor = resource => resourceKey(scope, resource);
  const rawFetch = globalThis.fetch;
  /** normalized resource → credential key, for every stored grant. */
  const grants = new Map();
  /** normalized resource → last upstream observation, for MCP URLs we watch. */
  const observed = new Map();
  /** normalized MCP server URLs from the running config, granted or not. */
  const watched = new Set();
  const epochs = new Map();

  function reset(resource) {
    epochs.set(resource, (epochs.get(resource) ?? 0) + 1);
    observed.delete(resource);
  }
  const flows = new Map();
  const pendingTargets = new Map();
  const attempts = new Map();
  let active = true;

  function credentials() {
    const service = ctx.get('credentials');
    if (!service) throw new Error('DSH 凭据服务不可用');
    return service;
  }

  async function refreshGrant(key, rejectedToken) {
    const record = await credentials().modifyRecord(key, async (current) => {
      const grant = payloadOf(current);
      if (!grant?.refreshToken) return undefined;
      const stale = rejectedToken
        ? grant.accessToken === rejectedToken
        : !grant.expiresAt || grant.expiresAt - Date.now() < REFRESH_MARGIN_MS;
      if (!stale) return undefined;
      const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: grant.refreshToken, client_id: grant.clientId });
      const { res, body } = await tokenRequest(rawFetch, grant, form);
      if (!res.ok || !body.access_token) throw new Error(`刷新 token 失败：${body.error ?? `HTTP ${res.status}`}`);
      return { kind: 'grant', payload: withTokens(grant, body) };
    });
    return payloadOf(record);
  }

  async function grantFor(resource, key) {
    const grant = payloadOf(await credentials().readRecord(key));
    if (!grant) return undefined;
    if (grant.version !== 1 || grant.profileScope !== scope || grant.resource !== resource || typeof grant.accessToken !== 'string' || !grant.accessToken) throw new Error('Invalid stored OAuth grant');
    return grant;
  }

  /** Current access token for one grant, refreshing it when expiring or just rejected. */
  async function accessTokenFor(resource, key, rejectedToken) {
    let grant = await grantFor(resource, key);
    const expiring = grant?.expiresAt && grant.expiresAt - Date.now() < REFRESH_MARGIN_MS;
    if (grant && (rejectedToken || expiring)) grant = await refreshGrant(key, rejectedToken) ?? grant;
    return grant?.accessToken;
  }

  async function currentRequest(resource, mode, token, epoch, explicitAuth, sent) {
    if (!active || epoch !== (epochs.get(resource) ?? 0)) return false;
    if ((await authFor(resource)).authMode !== mode.authMode) return false;
    if (sent && mode.authMode === 'oauth' && !explicitAuth) {
      const key = grants.get(resource);
      const grant = key ? await grantFor(resource, key) : undefined;
      if (token !== grant?.accessToken) return false;
    }
    return active && epoch === (epochs.get(resource) ?? 0);
  }

  function record(resource, res, method, facts) {
    const challenge = res.headers.get('www-authenticate') ?? '';
    const prior = observed.get(resource);
    const bearerChallenge = res.status === 401 && /^Bearer\b/i.test(challenge);
    const connectionState = !res.ok ? (bearerChallenge && !facts.explicitAuth ? 'needs-authorization' : 'failed')
      : ['tools/list', 'tools/call', 'resources/list'].includes(method) ? 'connected'
      : prior?.connectionState === 'connected' ? 'connected' : 'connecting';
    observed.set(resource, { ...facts, status: res.status, bearerChallenge, connectionState, error: null, at: Date.now() });
  }

  function requestHeaders(input, init) {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
    return headers;
  }

  async function interceptedFetch(input, init) {
    if (!active) return rawFetch(input, init);
    let resource;
    try { resource = normalizeResource(input instanceof Request ? input.url : String(input)); } catch { return rawFetch(input, init); }
    const key = grants.get(resource);
    if (!key && !watched.has(resource)) return rawFetch(input, init);
    const epoch = epochs.get(resource) ?? 0;
    const mode = await authFor(resource);
    const oauthEnabled = mode.authMode === 'oauth';
    const secretHeaders = mode.authMode === 'token' ? await headersFor(mode.headerKey) : {};
    const baseHeaders = requestHeaders(input, init);
    const explicitAuth = baseHeaders.has('authorization');
    let method;
    try { if (typeof init?.body === 'string') method = JSON.parse(init.body).method; } catch { /* Non-RPC requests do not establish MCP readiness. */ }
    const send = token => {
      const headers = new Headers(baseHeaders);
      for (const [name, value] of Object.entries(secretHeaders)) if (!headers.has(name)) headers.set(name, value);
      if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
      // Do not follow redirects while injecting a credential into a different resource.
      return rawFetch(input, { ...init, headers, redirect: 'error' });
    };
    let token, sent = false;
    try {
      token = key && oauthEnabled && !explicitAuth ? await accessTokenFor(resource, key) : undefined;
      sent = true;
      let res = await send(token);
      const replayable = !(input instanceof Request) && (init?.body === undefined || typeof init.body === 'string');
      if (res.status === 401 && token && replayable && (await authFor(resource)).authMode === 'oauth') {
        const fresh = await accessTokenFor(resource, key, token);
        if (fresh && fresh !== token) { await res.body?.cancel(); token = fresh; res = await send(token); }
      }
      if (await currentRequest(resource, mode, token, epoch, explicitAuth, sent)) {
        record(resource, res, method, { token, epoch, authMode: mode.authMode, explicitAuth, sent });
      }
      return res;
    } catch (error) {
      if (await currentRequest(resource, mode, token, epoch, explicitAuth, sent)) {
        observed.set(resource, { token, epoch, authMode: mode.authMode, explicitAuth, sent, connectionState: 'failed', status: null, bearerChallenge: false, error: errorText(error), at: Date.now() });
      }
      throw error;
    }
  }
  globalThis.fetch = interceptedFetch;
  async function runFlow(key, session) {
    const target = pendingTargets.get(key);
    if (!target) throw new Error('授权目标已失效，请重新发起');
    const previous = payloadOf(await credentials().readRecord(key));
    const client = previous?.clientId && previous.issuer === target.issuer
      ? { clientId: previous.clientId, clientSecret: previous.clientSecret ?? null }
      : await registerClient(rawFetch, target.meta, session.signal);
    const grant = await deviceAuthorize(rawFetch, {
      version: 1,
      profileScope: scope,
      resource: target.resource,
      resourceParam: target.resourceParam,
      issuer: target.issuer,
      tokenEndpoint: target.meta.token_endpoint,
      deviceEndpoint: target.meta.device_authorization_endpoint,
      revocationEndpoint: target.meta.revocation_endpoint ?? null,
      ...client,
    }, session);
    await session.commit({ kind: 'grant', payload: grant });
  }

  function ensureFlow(authorization, key, resource) {
    if (flows.has(key)) return;
    flows.set(key, authorization.registerFlow({
      key,
      label: `MCP OAuth · ${resource}`,
      methods: [{ id: 'device-code', label: '浏览器授权' }],
      run: (session) => runFlow(key, session),
    }));
  }

  function prune() {
    const cutoff = Date.now() - ATTEMPT_TTL_MS;
    for (const [id, attempt] of attempts) if (attempt.status !== 'pending' && attempt.updatedAt < cutoff) attempts.delete(id);
  }

  /** Start a device-code authorization; resolves as soon as discovery succeeds. */
  async function start(url) {
    const authorization = ctx.get('authorization');
    if (!authorization) throw new Error('DSH 授权服务不可用');
    credentials();
    const resource = normalizeResource(url);
    const key = keyFor(resource);
    const target = { resource, ...await discover(rawFetch, url) };

    for (const attempt of attempts.values()) {
      if (attempt.key === key && attempt.status === 'pending') return { attemptId: attempt.id };
    }
    pendingTargets.set(key, target);
    ensureFlow(authorization, key, resource);

    prune();
    const attempt = {
      id: randomUUID(), key, resource, status: 'pending', notice: null, error: null,
      controller: new AbortController(), updatedAt: Date.now(),
    };
    attempts.set(attempt.id, attempt);
    const settle = (patch) => Object.assign(attempt, patch, { updatedAt: Date.now() });

    attempt.promise = authorization.begin({
      key,
      signal: attempt.controller.signal,
      interaction: {
        notify: (notice) => settle({ notice: { message: notice.message, url: notice.url ?? null, code: notice.code ?? null } }),
        prompt: () => Promise.reject(new Error('device-code flow asks no questions')),
      },
    }).then(async (outcome) => {
      if (outcome.status !== 'authorized') { settle({ status: 'cancelled' }); return; }
      grants.set(resource, key);
      reset(resource);
      let restarted = 0, connectionError = null;
      try { restarted = await reconnect(resource); }
      catch (error) { connectionError = errorText(error); }
      settle({ status: 'authorized', restarted, connectionError });
    }).catch(err => settle({ status: attempt.controller.signal.aborted ? 'cancelled' : 'failed', error: attempt.controller.signal.aborted ? null : errorText(err), errorCode: attempt.controller.signal.aborted ? null : certificateTrustError(err)?.code ?? null }))
      .finally(() => { if (pendingTargets.get(key) === target) pendingTargets.delete(key); });

    return { attemptId: attempt.id };
  }

  async function status(attemptId) {
    const attempt = attempts.get(attemptId);
    if (!attempt) return undefined;
    const { id, resource, status: state, notice, error, restarted, connectionError } = attempt;
    return { attemptId: id, resource, status: state, notice, error, restarted: restarted ?? 0, connectionError: connectionError ?? null, errorCode: attempt.errorCode ?? null, oauth: await summary(resource) };
  }

  function cancel(attemptId) {
    const attempt = attempts.get(attemptId);
    if (attempt?.status === 'pending') {
      attempt.controller.abort(new Error('cancelled'));
      ctx.get('authorization')?.cancel(attempt.key);
    }
  }

  async function revoke(url) {
    const resource = normalizeResource(url);
    const key = keyFor(resource);
    for (const attempt of attempts.values()) {
      if (attempt.key === key && attempt.status === 'pending') { cancel(attempt.id); await attempt.promise; }
    }
    const grant = await grantFor(resource, key);
    if (grant?.revocationEndpoint && grant.refreshToken) {
      const form = new URLSearchParams({ token: grant.refreshToken, token_type_hint: 'refresh_token', client_id: grant.clientId });
      const response = await tokenRequest(rawFetch, { ...grant, tokenEndpoint: grant.revocationEndpoint }, form);
      if (!response.res.ok) throw new Error('The authorization server rejected revocation; the local grant is retained');
    }
    await credentials().deleteRecord(key);
    grants.delete(resource);
    reset(resource);
    await reconnect(resource);
  }

  /** Non-secret OAuth facts for one server URL, for the list and detail views. */
  async function summary(url) {
    let resource;
    try { resource = normalizeResource(url); } catch { return null; }
    const key = grants.get(resource);
    let grant, error = null;
    if (key) {
      try { grant = await grantFor(resource, key); }
      catch (failure) { error = errorText(failure); }
    }
    const mode = await authFor(resource);
    const oauthEnabled = mode.authMode === 'oauth';
    const candidate = observed.get(resource);
    const seen = candidate?.epoch === (epochs.get(resource) ?? 0) && candidate.authMode === mode.authMode
      && (!oauthEnabled || candidate.explicitAuth || !candidate.sent || candidate.token === grant?.accessToken) ? candidate : undefined;
    error ??= seen?.error ?? null;
    if (!grant && !seen && !error && !oauthEnabled) return null;
    return {
      // Authorization records and upstream token acceptance are independent facts.
      authorized: oauthEnabled && !!grant,
      configured: !!grant,
      connectionState: seen?.connectionState ?? 'unknown',
      authorizedAt: grant?.authorizedAt ?? null,
      expiresAt: grant?.expiresAt ?? null,
      lastStatus: seen?.status ?? null,
      rejected: !!(oauthEnabled && grant && seen?.token === grant.accessToken && !seen.explicitAuth && seen.bearerChallenge),
      required: oauthEnabled,
      error,
      checkedAt: Date.now(),
    };
  }

  /** Load stored grants so restarts keep authorization without a new login. */
  async function loadIndex() {
    const store = ctx.get('credentials');
    if (!store) return [];
    const urls = await configuredUrls();
    for (const url of urls) {
      const resource = resourceIdentity(url);
      const key = keyFor(resource);
      const grant = await grantFor(resource, key);
      if (grant) grants.set(resource, key);
    }
    return [...grants.keys()];
  }

  function watch(urls) {
    watched.clear();
    for (const url of urls) {
      try { watched.add(normalizeResource(url)); } catch { /* not an http URL */ }
    }
  }

  function dispose() {
    active = false;
    if (globalThis.fetch === interceptedFetch) globalThis.fetch = rawFetch;
    for (const attempt of attempts.values()) attempt.controller.abort(new Error('plugin disposed'));
    for (const unregister of flows.values()) unregister();
    flows.clear();
  }

  return { start, status, cancel, revoke, summary, loadIndex, watch, reset, dispose };
}
