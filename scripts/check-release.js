import { access, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { parse } from 'yaml';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(packageJson.license, 'MIT', 'Package metadata must match the project license');
const license = await readFile(join(root, 'LICENSE'), 'utf8');
assert.match(license, /^MIT License\r?\n/);
assert.ok(license.includes('Permission is hereby granted, free of charge'));
assert.ok(license.includes('THE SOFTWARE IS PROVIDED "AS IS"'));
for (const name of ['LICENSE', 'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md']) {
  await access(join(root, name));
  assert.ok(packageJson.files.includes(name), 'Required release document is missing from package files: ' + name);
}
const bundle = parse(await readFile(join(root, 'cordis.patch.yml'), 'utf8'));
assert.deepEqual(bundle, [{ insert: [{ id: 'mcp-management', name: packageJson.name }] }], 'The package bundle must not contain user servers');
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    assert.ok(!['plugin-data', 'backups', '.ace'].includes(entry.name), 'Runtime directory in repository: ' + path);
    assert.ok(!/(?:[.](?:bak|tmp|tgz|log)$|^[.]env(?:$|[.](?!example$)))/.test(entry.name), 'Private/generated artifact in repository: ' + path);
    if (entry.isDirectory()) await walk(path);
    else files.push(path);
  }
}
await walk(root);
const forbidden = new RegExp([
  ['ct', 'rip(?:corp)?[.]com'].join(''),
  ['trip', '[.]larkenterprise[.]com'].join(''),
].join('|'), 'i');
const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}[.]eyJ[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+/;
function inspect(text, location) {
  assert.equal(forbidden.test(text), false, 'Private-domain residue: ' + location);
  assert.equal(secret.test(text), false, 'Possible credential residue: ' + location);
}
let documentLinks = 0;
for (const path of files) {
  const text = (await readFile(path)).toString('utf8');
  inspect(text, path);
  if (path.endsWith('.js')) execFileSync(process.execPath, ['--check', path]);
  if (path.endsWith('.md')) {
    const markdown = text.replace(/```[\s\S]*?```/g, '');
    for (const match of markdown.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
      const href = match[1].trim().replace(/^<|>$/g, '');
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) continue;
      const target = fileURLToPath(new URL(href, pathToFileURL(path)));
      const within = relative(root, target);
      assert.ok(!within.startsWith('..') && !isAbsolute(within), 'Document link escapes the repository: ' + path);
      await access(target);
      documentLinks++;
    }
  }
}

// Scan all locally present objects, including unreachable history and notes, not only HEAD.
const objects = execFileSync('git', ['-C', root, 'cat-file', '--batch-all-objects', '--batch'], { maxBuffer: 64 * 1024 * 1024 });
let offset = 0, objectCount = 0;
while (offset < objects.length) {
  const end = objects.indexOf(10, offset);
  assert.ok(end !== -1, 'Invalid Git object header');
  const [id, type, rawSize] = objects.subarray(offset, end).toString('ascii').split(' ');
  const size = Number(rawSize);
  assert.ok(Number.isSafeInteger(size) && size >= 0, 'Invalid Git object size');
  offset = end + 1;
  assert.ok(offset + size < objects.length, 'Truncated Git object');
  inspect(objects.subarray(offset, offset + size).toString('utf8'), 'Git ' + type + ' ' + id);
  offset += size;
  assert.equal(objects[offset++], 10, 'Invalid Git object delimiter');
  objectCount++;
}
const installedFiles = packageJson.files;
assert.ok(installedFiles.includes('profile-store.js') && installedFiles.includes('server-config.js'));
assert.equal(installedFiles.some(path => /plugin-data|backups|settings[.]json|[.]env/.test(path)), false);
for (const name of ['index.js', 'profile-store.js', 'oauth.js', 'client.js']) {
  const text = await readFile(join(root, name), 'utf8');
  assert.doesNotMatch(text, /migrateLegacy|legacyIdentity|legacyKey|legacyShared|legacyImported/, 'Removed compatibility path in ' + name);
}
console.log(`Release checks passed: ${files.length} files, ${objectCount} Git objects, ${documentLinks} local documentation links and MIT package metadata; bundle contains no user data.`);
console.log('Checks cover known patterns, not every possible secret; use a dedicated scanner before publishing.');
