import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client';
export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
export const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;

export function profileScope(profileDir) {
  const path = resolve(profileDir).replaceAll('\\', '/');
  const canonical = process.platform === 'win32' ? path.toLowerCase() : path;
  return 'mcp-management-' + createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function resourceIdentity(input) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP(S) URL without embedded credentials');
  }
  url.hash = '';
  // Query and trailing slash may identify different servers; neither may be discarded.
  return url.href;
}

export function resourceKey(scope, url) {
  return `mcp-management/oauth-${scope.replace(/^mcp-management-/, '')}-${createHash('sha256').update(resourceIdentity(url)).digest('hex').slice(0, 32)}`;
}

export function headerKey(scope, name) {
  return `mcp-management/headers-${scope.replace(/^mcp-management-/, '')}-${createHash('sha256').update(name).digest('hex').slice(0, 32)}`;
}

export function validateHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new Error('headers must be an object');
  const result = {};
  const names = new Set();
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name) || typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('Invalid HTTP header');
    if (names.has(name.toLowerCase())) throw new Error('Duplicate HTTP header');
    if (['host', 'connection', 'content-length', 'transfer-encoding', '__proto__', 'prototype', 'constructor'].includes(name.toLowerCase())) throw new Error('Reserved HTTP header');
    names.add(name.toLowerCase());
    result[name] = value;
  }
  return result;
}

export function parseArgs(input) {
  if (input === undefined || input === '') return [];
  if (Array.isArray(input)) {
    if (!input.every(value => typeof value === 'string')) throw new Error('args must contain strings');
    return [...input];
  }
  if (typeof input !== 'string') throw new Error('args must be a string array');
  if (input.trim().startsWith('[')) return parseArgs(JSON.parse(input));
  const args = [];
  let token = '', quote = '', started = false;
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = '';
      else token += char;
      started = true;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) {
      if (started) args.push(token);
      token = ''; started = false;
    } else { token += char; started = true; }
  }
  if (quote) throw new Error('Unclosed argument quote');
  if (started) args.push(token);
  return args;
}

export function serverConfig(spec, existing = {}) {
  if (!spec || !SERVER_NAME.test(spec.serverName || '')) throw new Error('Server name must be 1–32 ASCII letters, digits, underscores or hyphens');
  const config = { ...existing, serverName: spec.serverName, failOnStartupError: spec.failOnStartupError ?? existing.failOnStartupError ?? false };
  if (spec.url) {
    config.transport = 'streamable-http'; config.url = resourceIdentity(spec.url);
    delete config.command; delete config.args; delete config.env; delete config.cwd;
  } else if (typeof spec.command === 'string' && spec.command.trim()) {
    config.transport = 'stdio'; config.command = spec.command.trim(); config.args = parseArgs(spec.args ?? existing.args);
    if (spec.env !== undefined) {
      if (!spec.env || typeof spec.env !== 'object' || Array.isArray(spec.env) || !Object.values(spec.env).every(v => typeof v === 'string')) throw new Error('env must be a string map');
      config.env = { ...spec.env };
    }
    if (spec.cwd !== undefined) {
      if (typeof spec.cwd !== 'string') throw new Error('cwd must be a string');
      config.cwd = spec.cwd;
    }
    delete config.url;
  } else throw new Error('A server needs url or command');
  if (spec.toolCallTimeoutMs !== undefined) {
    if (!Number.isSafeInteger(spec.toolCallTimeoutMs) || spec.toolCallTimeoutMs < 1 || spec.toolCallTimeoutMs > 2147483647) throw new Error('Invalid timeout');
    config.toolCallTimeoutMs = spec.toolCallTimeoutMs;
  }
  if (typeof config.failOnStartupError !== 'boolean') throw new Error('Invalid failOnStartupError');
  if (spec.reconnect !== undefined) {
    if (!spec.reconnect || typeof spec.reconnect !== 'object' || Array.isArray(spec.reconnect)) throw new Error('Invalid reconnect policy');
    const policy = { ...existing.reconnect, ...spec.reconnect };
    if (policy.enabled !== undefined && typeof policy.enabled !== 'boolean') throw new Error('Invalid reconnect.enabled');
    for (const field of ['maxAttempts', 'initialDelayMs', 'maxDelayMs']) if (policy[field] !== undefined && (!Number.isSafeInteger(policy[field]) || policy[field] < 1 || policy[field] > 2147483647)) throw new Error('Invalid reconnect policy');
    config.reconnect = policy;
  }
  delete config.headers;
  return config;
}
