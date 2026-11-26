import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { setImmediate as flush } from 'node:timers/promises';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const RESOURCE = 'https://mcp.example.test/mcp';
const saved = { configured: true, authorized: true, rejected: true, connectionState: 'needs-authorization', lastStatus: 401, error: null, checkedAt: 20 };

function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.children)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join(' ');
  return tree && typeof tree === 'object' ? text(tree.children) : typeof tree === 'string' ? tree : '';
}
function component(tree, name) { return nodes(tree).find(node => typeof node.type === 'function' && node.type.name === name); }

// Exercise the host's actual module/slot entry; a minimal hooks renderer keeps
// state and effect lifetimes deterministic without adding a React build stack.
async function client({ oauth = saved, status, action } = {}) {
  const frames = new Map(), timers = new Map(), opened = [], actions = [];
  let removed = false;
  let active, timerId = 0, root, statusCalls = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const React = {
    Fragment: 'fragment',
    createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
    useState(initial) {
      const frame = active, index = frame.index++;
      if (!frame.slots[index]) frame.slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [frame.slots[index].value, next => { frame.slots[index].value = typeof next === 'function' ? next(frame.slots[index].value) : next; }];
    },
    useRef(initial) { return React.useState({ current: initial })[0]; },
    useMemo(callback, deps) {
      const index = active.index++, prior = active.slots[index];
      if (!prior || !same(prior.deps, deps)) active.slots[index] = { deps, value: callback() };
      return active.slots[index].value;
    },
    useCallback(callback, deps) { return React.useMemo(() => callback, deps); },
    useEffect(callback, deps) {
      const frame = active, index = frame.index++, prior = frame.slots[index];
      if (!prior || !same(prior.deps, deps)) frame.pending.push(() => {
        prior?.cleanup?.(); frame.slots[index] = { deps, cleanup: callback() };
      });
    },
  };
  const server = { serverName: 'service', entryId: 'include:service', transport: 'streamable-http', url: RESOURCE, authMode: 'oauth', enabled: true, fiberPhase: 'active', oauth, headerNames: [] };
  const sandbox = {
    URL: globalThis.URL,
    document: { baseURI: 'http://localhost/', head: { appendChild() {} }, createElement: () => ({ setAttribute() {}, remove() {} }) },
    window: { open: url => opened.push(url), alert() {}, __ModuleLoader__: { load({ factory }) {
      factory(name => { assert.equal(name, 'react'); return React; }).apply({ effect: callback => callback(), slots: { inject: (_, callback) => callback(), register: (_, value) => { root = value; } } });
    } } },
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (path, init) => {
      let value;
      if (path.endsWith('/toggle') || path.endsWith('/remove')) {
        const kind = path.split('/').at(-1), body = JSON.parse(init.body);
        actions.push({ kind, body });
        const result = action ? await action(kind, body) : { applied: true, warnings: [] };
        if (result?.error) return { status: 400, json: async () => ({ ok: false, error: { message: result.error } }) };
        if (kind === 'toggle' && result.applied) server.enabled = body.enabled;
        if (kind === 'remove' && result.applied) removed = true;
        value = result;
      }
      else if (path.endsWith('/servers')) value = removed ? [] : [server];
      else if (path.endsWith('/settings')) value = { trustSystemCertificates: false };
      else if (path.endsWith('/oauth/start')) value = { attemptId: 'attempt' };
      else if (path.endsWith('/oauth/status')) { statusCalls++; value = status ? await status() : { attemptId: 'attempt', status: 'authorized', restarted: 1, oauth: saved }; }
      else throw new Error('Unexpected UI request: ' + path);
      return { status: 200, json: async () => ({ ok: true, value }) };
    },
  };
  vm.runInNewContext(source, sandbox);
  const keyOf = element => element.props.key ? element.type.name + ':' + element.props.key : element.type;
  function render(element) {
    const key = keyOf(element);
    if (!frames.has(key)) frames.set(key, { slots: [] });
    active = frames.get(key); active.index = 0; active.pending = [];
    const tree = element.type(element.props);
    for (const effect of active.pending) effect();
    return tree;
  }
  const rootElement = { type: root, props: {} };
  render(rootElement); await flush();
  function list() { return component(render(rootElement), 'ListView'); }
  function form() { return component(render(rootElement), 'FormView'); }
  const listElement = list();
  listElement.props.onOpen(server);
  component(render(rootElement), 'DetailView').props.onEdit();
  function panel() { return component(render(form()), 'OAuthPanel'); }
  async function begin() {
    nodes(render(panel())).find(node => node.type === 'button' && /去授权|重新授权/.test(text(node))).props.onClick();
    await flush(); render(panel());
  }
  return {
    render, list: () => listElement, form, panel, begin, server, opened, timers, actions,
    root: () => render(rootElement),
    detail: () => { listElement.props.onOpen(server); return component(render(rootElement), 'DetailView'); },
    statusCalls: () => statusCalls,
    tick: () => { const [id, callback] = timers.entries().next().value; timers.delete(id); return callback(); },
    unmount: element => { for (const slot of frames.get(keyOf(element)).slots) slot.cleanup?.(); frames.delete(keyOf(element)); },
  };
}

const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node).trim() === label);

async function confirmDelete(f) {
  button(f.render(f.detail()), '删除').props.onClick();
  return button(f.render(f.detail()), '确认').props.onClick();
}

test('delete errors are visible in detail and a retry succeeds', async () => {
  let count = 0;
  const f = await client({ action: () => ++count === 1 ? { error: 'delete denied' } : { applied: true } });
  await confirmDelete(f); await flush();
  assert.match(text(f.root()), /delete denied/);
  assert.ok(component(f.root(), 'DetailView'));
  button(f.render(f.detail()), '确认').props.onClick();
  await flush();
  assert.ok(component(f.root(), 'ListView'));
  assert.equal(f.actions.length, 2);
  assert.match(text(f.root()), /已删除/);
});

test('cancelling the delete confirmation makes no request', async () => {
  const f = await client();
  button(f.render(f.detail()), '删除').props.onClick();
  button(f.render(f.detail()), '取消').props.onClick();
  assert.equal(f.actions.length, 0);
  assert.ok(button(f.render(f.detail()), '删除'));
});

test('server actions show pending feedback and suppress duplicate clicks', async () => {
  const response = Promise.withResolvers();
  const f = await client({ action: () => response.promise });
  f.detail().props.onBack(); await flush();
  const list = component(f.root(), 'ListView');
  list.props.onToggle(f.server);
  list.props.onToggle(f.server);
  assert.equal(f.actions.length, 1);
  const current = component(f.root(), 'ListView');
  assert.match(text(f.root()), /处理中/);
  const row = component(f.render(current), 'ServerRow');
  const sw = component(f.render(row), 'Switch');
  assert.equal(f.render(sw).props.disabled, true);
  response.resolve({ applied: true }); await flush();
  assert.equal(f.server.enabled, false);
  assert.match(text(f.root()), /已停用/);
  assert.ok(current);
});

test('toggle errors and restart-required outcomes are visible without claiming enablement', async () => {
  const f = await client({ action: () => ({ error: 'enable denied' }) });
  f.list().props.onToggle(f.server); await flush();
  assert.match(text(f.root()), /enable denied/);
  const g = await client({ action: () => ({ applied: false, application: 'restart-required', restartReason: 'no-hmr' }) });
  g.list().props.onToggle(g.server); await flush();
  assert.match(text(g.root()), /重启 DSH/);
  assert.equal(g.server.enabled, true);
});

test('list and editor distinguish a saved grant from a rejected token', async () => {
  const f = await client();
  const row = component(f.render(f.list()), 'ServerRow');
  const listText = text(f.render(row));
  assert.match(listText, /OAuth · 授权已保存/);
  assert.match(listText, /token 被拒绝（401）/);
  assert.doesNotMatch(listText, /未授权|授权已失效/);
  assert.match(text(f.render(f.panel())), /授权已保存，但服务器拒绝了当前 token（HTTP 401）/);
});

test('completed authorization uses fresh status rather than the editor opening snapshot', async () => {
  const f = await client({ oauth: { configured: false, checkedAt: 1 } });
  await f.begin(); await f.tick();
  assert.match(text(f.render(f.panel())), /授权已保存，但服务器拒绝了当前 token（HTTP 401）/);
  f.server.oauth = { ...saved, rejected: false, connectionState: 'connected', checkedAt: 30 };
  await f.form().props.onRefresh();
  const current = text(f.render(f.panel()));
  assert.match(current, /授权已保存/);
  assert.doesNotMatch(current, /拒绝了当前 token/);
});

test('polling is serialized and disposed panels cannot open a late authorization link', async () => {
  const response = Promise.withResolvers();
  const f = await client({ status: () => response.promise });
  await f.begin();
  const pending = f.tick();
  assert.equal(f.statusCalls(), 1);
  assert.equal(f.timers.size, 0, 'No second poll is scheduled while the first is unresolved');
  f.unmount(f.panel());
  response.resolve({ attemptId: 'attempt', status: 'pending', notice: { url: 'https://auth.example.test/verify' } });
  await pending;
  assert.deepEqual(f.opened, []);
  assert.equal(f.timers.size, 0);
});

test('changing the resource URL remounts the panel without retaining its prior authorization', async () => {
  const f = await client();
  const oldPanel = f.panel();
  const urlInput = nodes(f.render(f.form())).find(node => node.type === 'input' && node.props.value === RESOURCE);
  urlInput.props.onChange({ target: { value: RESOURCE + '?tenant=other' } });
  const next = f.panel();
  assert.notEqual(next.props.key, oldPanel.props.key);
  assert.equal(next.props.oauth, null);
  assert.doesNotMatch(text(f.render(next)), /授权已保存/);
});
