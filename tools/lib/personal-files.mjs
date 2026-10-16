import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

export const seedvaultDirectory = '.SeedVaultAndroidBackup';
/** @param {unknown} value @returns {string} */
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
/** @param {string} path @returns {Promise<any>} */
export async function readJson(path) {
  await safePath(path);
  if (!(await lstat(path)).isFile()) throw new Error('Expected a regular JSON file: ' + path);
  return JSON.parse(await readFile(path, 'utf8'));
}
/** Reject symlinks in every existing component, including ancestors. @param {string} path */
export async function safePath(path) {
  const absolute = resolve(path);
  /** @type {string} */
  let current = sep;
  for (const part of absolute.split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error('Symlinks are not allowed: ' + current);
  }
  return absolute;
}
/** @param {string} root @param {string} name */
export function contained(root, name) {
  if (
    !name ||
    isAbsolute(name) ||
    name.includes('\\') ||
    name.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw new Error('Unsafe relative backup path: ' + name);
  const path = resolve(root, name);
  if (relative(resolve(root), path).startsWith('..' + sep)) throw new Error('Path escapes backup root');
  return path;
}
/** @param {string[]} paths */
export async function distinctRoots(paths) {
  const roots = await Promise.all(paths.map(safePath));
  for (let i = 0; i < roots.length; i++)
    for (let j = i + 1; j < roots.length; j++) {
      const a = roots[i] + sep,
        b = roots[j] + sep;
      if (a.startsWith(b) || b.startsWith(a))
        throw new Error('Project, source, USB and master paths must not overlap');
    }
}
/** @param {string} path */
export async function absent(path) {
  await safePath(path);
  const info = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (info) throw new Error('Refusing to overwrite an existing destination: ' + path);
}
/** @param {string} path */
export async function fileHash(path) {
  await safePath(path);
  if (!(await lstat(path)).isFile()) throw new Error('Only regular backup files are supported: ' + path);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
/** @param {string} root @param {string} [prefix] @returns {Promise<string[]>} */
export async function treeFiles(root, prefix = '') {
  await safePath(root);
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) files.push(...(await treeFiles(join(root, entry.name), name)));
    else if (entry.isFile()) files.push(name);
    else throw new Error('Backup trees may contain only regular files and directories: ' + name);
  }
  return files.sort();
}
/** @param {string} root @param {string} [prefix] @returns {Promise<string[]>} */
export async function treeDirectories(root, prefix = '') {
  await safePath(root);
  const directories = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) directories.push(name, ...(await treeDirectories(join(root, entry.name), name)));
    else if (!entry.isFile())
      throw new Error('Backup trees may contain only regular files and directories: ' + name);
  }
  return directories.sort();
}
/** @param {string} source @param {string} destination */
export async function copyPrivate(source, destination) {
  await safePath(source);
  await absent(destination);
  if (!(await lstat(source)).isFile()) throw new Error('Expected a regular source file');
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await pipeline(createReadStream(source), createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  await syncPath(destination);
  const hash = await fileHash(source);
  if ((await fileHash(destination)) !== hash) throw new Error('File changed during backup: ' + source);
  return { sha256: hash, bytes: (await lstat(destination)).size };
}
/** Includes hidden files; refuses links, special files and existing destinations. @param {string} source @param {string} destination */
export async function copyTree(source, destination) {
  const directories = await treeDirectories(source);
  const files = await treeFiles(source);
  if (!files.length) throw new Error('The encrypted Seedvault tree is empty');
  await absent(destination);
  await mkdir(destination, { mode: 0o700, recursive: true });
  for (const name of directories) await mkdir(contained(destination, name), { mode: 0o700, recursive: true });
  for (const name of files) await copyPrivate(contained(source, name), contained(destination, name));
  if (canonical(await treeFiles(source)) !== canonical(files))
    throw new Error('Source backup tree changed during the copy');
  if (canonical(await treeDirectories(source)) !== canonical(directories))
    throw new Error('Source backup directories changed during the copy');
  for (const name of files)
    if ((await fileHash(contained(source, name))) !== (await fileHash(contained(destination, name))))
      throw new Error('Source backup changed after copying: ' + name);
}
/** @param {string} path @param {unknown} value */
export async function privateJson(path, value) {
  await safePath(path);
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await syncPath(path);
}
/** @param {string} destination */
export async function incompleteGeneration(destination) {
  await absent(destination);
  const path = join(dirname(resolve(destination)), '.incomplete-' + randomUUID());
  await mkdir(path, { mode: 0o700 });
  await privateJson(join(path, 'INCOMPLETE.json'), {
    complete: false,
    intendedDestination: resolve(destination),
  });
  return path;
}
/** @param {string} source @param {string} destination */
export async function publishGeneration(source, destination) {
  await absent(destination);
  await rename(source, destination);
  await syncPath(dirname(resolve(destination)));
}
/** @param {string} path */
async function syncPath(path) {
  const file = await open(path, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
