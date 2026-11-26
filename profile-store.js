import { readFile, mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { parseDocument, isMap, isSeq } from 'yaml';
import { MCP_CLIENT, SERVER_NAME, headerKey, profileScope, resourceIdentity, serverConfig, validateHeaders } from './server-config.js';

async function readOptional(path, fallback) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function atomicWrite(path, text) {
  return writeFileAtomic(path, text, { mode: 0o600, dirMode: 0o700 });
}

export function profileDocument(text) {
  // Keep the YAML AST, including comments and custom tags such as !!js; never evaluate it here.
  const doc = parseDocument(text || '[]', { uniqueKeys: true });
  if (doc.errors.length) throw new Error('The DSH profile patch is invalid YAML');
  if (!doc.contents) doc.contents = doc.createNode([]);
  if (!isSeq(doc.contents)) throw new Error('The DSH profile patch must be a sequence');
  return doc;
}

function patchConfig(doc, name) {
  let config;
  for (const row of doc.contents.items) {
    if (!isMap(row)) continue;
    const insert = row.get('insert', true);
    if (isSeq(insert)) for (const entry of insert.items) {
      if (isMap(entry) && entry.get('id') === name) config = entry.get('config', true)?.toJSON() ?? {};
    }
    if (row.get('id') === name && row.has('config')) config = { ...config, ...row.get('config', true).toJSON() };
  }
  return config;
}

function putServer(doc, name, config, inherited, restore) {
  let target;
  for (const row of doc.contents.items) {
    if (!isMap(row)) continue;
    const insert = row.get('insert', true);
    if (isSeq(insert)) for (const entry of insert.items) {
      if (isMap(entry) && entry.get('id') === name) target = entry;
    }
    if (row.get('id') === name) {
      if (row.has('config')) target = row;
      if (restore && row.get('disabled') === true) row.set('disabled', false);
    }
  }
  if (target) target.set('config', doc.createNode(config));
  else doc.contents.add(doc.createNode(inherited
    ? { id: name, config }
    : { insert: [{ id: name, name: MCP_CLIENT, config }] }));
}

function removeServer(doc, name) {
  doc.contents.items = doc.contents.items.filter(row => {
    if (!isMap(row)) return true;
    if (row.get('id') === name) return false;
    const insert = row.get('insert', true);
    if (isSeq(insert)) {
      insert.items = insert.items.filter(entry => !isMap(entry) || entry.get('id') !== name);
      if (!insert.items.length && row.items.length === 1) return false;
    }
    return true;
  });
}

export class ProfileStore {
  constructor(patchPath, { credentials, reconcile } = {}) {
    if (!patchPath) throw new Error('DSH configEditor.documentPath is required');
    this.patchPath = patchPath;
    this.profileDir = dirname(patchPath);
    this.dataDir = join(this.profileDir, 'plugin-data', 'mcp-management');
    this.metadataPath = join(this.dataDir, 'settings.json');
    this.lockPath = join(this.profileDir, 'package.json.lock');
    this.scope = profileScope(this.profileDir);
    this.credentials = credentials;
    this.reconcile = reconcile;
  }

  async metadata() {
    const data = JSON.parse(await readOptional(this.metadataPath, '{"version":1,"servers":{},"settings":{"trustSystemCertificates":false}}'));
    if (data.version !== 1 || !data.servers || !data.settings || Object.keys(data).some(key => !['version', 'servers', 'settings'].includes(key))) throw new Error('Unsupported management settings');
    for (const meta of Object.values(data.servers)) if (!['none', 'token', 'oauth'].includes(meta.authMode)) throw new Error('Invalid stored authMode');
    return data;
  }

  async exclusive(operation) {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    // Share ConfigEditor's writer lock rather than racing other DSH profile edits.
    return withFileLock(join(this.profileDir, 'package.json'), operation, { waitMs: 10000 });
  }

  async mutation(operation) {
    const run = () => this.exclusive(async () => {
      const beforePatch = await readOptional(this.patchPath, '[]\n');
      const beforeMetadata = await readOptional(this.metadataPath, null);
      const metadata = await this.metadata();
      const doc = profileDocument(beforePatch);
      const changes = new Map(), committed = [];
      let filesStarted = false;
      const stageRecord = async (key, mutate) => {
        const original = changes.has(key) ? changes.get(key).before : await this.credentials.readRecord(key);
        const current = changes.has(key) ? changes.get(key).after : original;
        const after = await mutate(current);
        changes.set(key, { before: original, after });
      };
      try {
        const value = await operation(doc, metadata, stageRecord);
        for (const [key, change] of changes) {
          if (change.after === null) await this.credentials.deleteRecord(key);
          else await this.credentials.modifyRecord(key, async current => {
            if (JSON.stringify(current) !== JSON.stringify(change.before)) throw new Error('Credential changed during save; reload and retry');
            return change.after;
          });
          committed.push([key, change]);
        }
        filesStarted = true;
        await atomicWrite(this.metadataPath, JSON.stringify(metadata, null, 2) + '\n');
        await atomicWrite(this.patchPath, doc.toString({ lineWidth: 0 }));
        return value;
      } catch (error) {
        const recoveryErrors = [];
        if (filesStarted) {
          try { await atomicWrite(this.patchPath, beforePatch); }
          catch (recovery) { recoveryErrors.push(recovery); }
          try {
            if (beforeMetadata === null) await unlink(this.metadataPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
            else await atomicWrite(this.metadataPath, beforeMetadata);
          } catch (recovery) { recoveryErrors.push(recovery); }
        }
        for (const [key, change] of committed.reverse()) {
          try {
            const current = await this.credentials.readRecord(key);
            if (JSON.stringify(current) !== JSON.stringify(change.after === null ? undefined : change.after)) throw new Error('Credential changed during rollback; not overwritten');
            if (change.before === undefined) await this.credentials.deleteRecord(key);
            else await this.credentials.modifyRecord(key, async current => {
              if (JSON.stringify(current) !== JSON.stringify(change.after)) throw new Error('Credential changed during rollback; not overwritten');
              return change.before;
            });
          } catch (recovery) { recoveryErrors.push(recovery); }
        }
        if (recoveryErrors.length) throw new AggregateError([error, ...recoveryErrors], 'Save failed and rollback was incomplete; check the profile before retrying');
        throw error;
      }
    });
    return this.reconcile ? this.reconcile(run) : { ...await run(), applied: false, restartReason: 'no-hmr', warnings: [] };
  }

  async save(spec, existing) { return this.import([spec], existing === undefined ? new Map() : new Map([[spec.serverName, existing]])); }

  async import(specs, live = new Map()) {
    // Validate all entries before any writes, including credential writes.
    for (const spec of specs) {
      serverConfig(spec, live.get(spec.serverName) ?? {});
      if (spec.headers !== undefined) validateHeaders(spec.headers);
      if (spec.authMode !== undefined && !['none', 'token', 'oauth'].includes(spec.authMode)) throw new Error('Invalid authMode');
      if (spec.keepHeaderNames && (!Array.isArray(spec.keepHeaderNames) || !spec.keepHeaderNames.every(name => typeof name === 'string'))) throw new Error('Invalid retained headers');
    }
    return this.mutation(async (doc, metadata, stageRecord) => {
      const added = [], updated = [];
      for (const spec of specs) {
        const name = spec.serverName;
        const prior = Object.hasOwn(metadata.servers, name) ? metadata.servers[name] : {};
        const existing = patchConfig(doc, name) ?? live.get(name) ?? {};
        if (!Object.hasOwn(metadata.servers, name) && !live.has(name) && patchConfig(doc, name)) throw new Error('Server name conflicts with an existing profile entry');
        for (const row of doc.contents.items) {
          const insert = isMap(row) ? row.get('insert', true) : undefined;
          if (isSeq(insert) && insert.items.some(entry => isMap(entry) && entry.get('id') === name && entry.get('name') !== MCP_CLIENT)) throw new Error('Server name conflicts with a non-MCP plugin');
        }
        const config = serverConfig(spec, existing);
        const authMode = spec.authMode ?? prior.authMode ?? (spec.headers ? 'token' : 'none');
        const secretKey = headerKey(this.scope, name);
        if (spec.headers !== undefined || spec.keepHeaderNames !== undefined || (authMode === 'token' && existing.headers)) {
          if (!this.credentials) throw new Error('DSH credentials service is required for secret headers');
          await stageRecord(secretKey, async current => {
            const oldHeaders = current?.kind === 'grant' ? current.payload.headers ?? {} : existing.headers ?? {};
            const headers = {};
            for (const key of spec.keepHeaderNames ?? []) {
              if (!Object.hasOwn(oldHeaders, key)) throw new Error('Retained header no longer exists; reload the form');
              headers[key] = oldHeaders[key];
            }
            Object.assign(headers, validateHeaders(spec.headers ?? existing.headers ?? {}));
            return { kind: 'grant', payload: { headers: validateHeaders(headers), serverName: name, profileScope: this.scope } };
          });
        }
        const value = { ...prior, authMode, managed: true, headerKey: secretKey };
        delete value.removed;
        (Object.hasOwn(metadata.servers, name) && !prior.removed ? updated : added).push(name);
        metadata.servers[name] = value;
        putServer(doc, name, config, live.has(name), !prior.managed);
      }
      return { added, updated };
    });
  }

  async remove(name, { allowUnmanaged = false } = {}) {
    if (!SERVER_NAME.test(name)) throw new Error('Invalid server name');
    return this.mutation(async (doc, metadata, stageRecord) => {
      if (!allowUnmanaged && (!Object.hasOwn(metadata.servers, name) || !metadata.servers[name].managed)) throw new Error('This server is not managed by this profile');
      const ownedEntry = doc.contents.items.some(row => {
        const insert = isMap(row) ? row.get('insert', true) : undefined;
        return isSeq(insert) && insert.items.some(entry => isMap(entry) && entry.get('id') === name);
      });
      removeServer(doc, name);
      if (ownedEntry) delete metadata.servers[name];
      else metadata.servers[name] = { authMode: 'none', managed: false, removed: true };
      // Prevent an inherited bundle definition from resurrecting a deleted server.
      doc.contents.add(doc.createNode({ id: name, disabled: true }));
      if (this.credentials) await stageRecord(headerKey(this.scope, name), async () => null);
      return { removed: name };
    });
  }

  async authFor(url, liveServers = []) {
    const resource = resourceIdentity(url);
    const metadata = await this.metadata();
    for (const server of liveServers) {
      if (server.config?.url && resourceIdentity(server.config.url) === resource) {
        const meta = Object.hasOwn(metadata.servers, server.name) ? metadata.servers[server.name] : {};
        if (meta.removed) continue;
        return { authMode: meta.authMode ?? 'none', headerKey: meta.headerKey ?? null };
      }
    }
    return { authMode: 'none', headerKey: null };
  }

  async headersFor(key) {
    if (!key || !this.credentials) return {};
    const record = await this.credentials.readRecord(key);
    return record?.kind === 'grant' ? record.payload.headers ?? {} : {};
  }

  async updateSettings(settings) {
    if (Object.keys(settings).some(key => key !== 'trustSystemCertificates') || typeof settings.trustSystemCertificates !== 'boolean') throw new Error('Invalid settings');
    return this.mutation(async (_doc, metadata) => { metadata.settings = { ...metadata.settings, ...settings }; return { settings: metadata.settings, requiresRestart: true }; });
  }
}
