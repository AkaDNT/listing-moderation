import { readdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const allowed = [
  { directory: 'tests', suffix: '.test.mjs' },
  { directory: 'dist/tests', suffix: '.test.js' },
];

export async function discoverTests(root = process.cwd()) {
  const found = [];
  for (const { directory, suffix } of allowed) {
    const base = resolve(root, directory);
    async function visit(path) {
      let entries;
      try { entries = await readdir(path, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const full = join(path, entry.name);
        const info = await lstat(full);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory() && entry.name !== 'fixtures') await visit(full);
        else if (info.isFile() && entry.name.endsWith(suffix) && !entry.name.endsWith('.fixture.test.mjs') && !entry.name.endsWith('.fixture.test.js')) found.push(full);
      }
    }
    await visit(base);
  }
  return [...new Set(found)].sort((a, b) => a.localeCompare(b));
}
