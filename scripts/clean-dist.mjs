import { lstat, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(projectRoot, 'dist');
if (target !== resolve(projectRoot, `dist`) || !target.startsWith(projectRoot + sep)) {
  throw new Error(`Refusing to clean an unexpected build path: ${target}`);
}
try {
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refusing to clean non-directory build path: ${target}`);
  await rm(target, { recursive: true, force: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
