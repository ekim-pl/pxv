import { registerHooks } from 'node:module';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { transformSync } from 'esbuild';
/** @type {{generation:number,mocks:Map<string,(original:<T = Record<string,unknown>>()=>Promise<T>)=>unknown>,values:Map<string,Record<string,unknown>>,bypass:Set<string>}} */
export const state = { generation: 0, mocks: new Map(), values: new Map(), bypass: new Set() };
Reflect.set(globalThis, '__pxvTestMocks', state.values);
const root = resolve(import.meta.dirname, '..');
/** @param {string} specifier @param {string} [parentURL] */
export function sourceURL(specifier, parentURL = pathToFileURL(root + '/').href) {
  if (specifier.startsWith('node:')) return specifier;
  if (specifier.startsWith('@pxv/')) {
    const [name, sub] = specifier.slice(5).split('/');
    return pathToFileURL(resolve(root, 'packages', name ?? '', 'src', (sub ?? 'index') + '.ts')).href;
  }
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')) {
    return fileSourceURL(specifier, parentURL);
  }
  return specifier;
}
registerHooks({
  resolve(specifier, context, next) {
    const canonical = sourceURL(specifier, context.parentURL);
    const original = originalImport(canonical, specifier);
    if (mockedURL(canonical, original))
      return {
        url: 'pxv-mock:' + encodeURIComponent(canonical) + '?g=' + state.generation,
        shortCircuit: true,
      };
    if (
      canonical.startsWith('file:') &&
      canonical.includes('/packages/') &&
      !canonical.includes('/node_modules/')
    ) {
      const url = new URL(canonical);
      url.searchParams.set('pxv-generation', String(state.generation));
      if (original) url.searchParams.set('pxv-original', '1');
      return next(url.href, context);
    }
    if (canonical.startsWith('file:') && canonical.endsWith('.ts')) return next(canonical, context);
    const result = next(specifier, context);
    if (mockedURL(result.url, original))
      return {
        url: 'pxv-mock:' + encodeURIComponent(result.url) + '?g=' + state.generation,
        shortCircuit: true,
      };
    return result;
  },
  load(url, context, next) {
    if (url.startsWith('pxv-mock:')) {
      const key = decodeURIComponent(url.slice(9).split('?')[0] ?? '');
      const value = state.values.get(key);
      if (!value) throw new Error('Unknown module mock: ' + key);
      const source = Object.keys(value)
        .map((name) =>
          name === 'default'
            ? `export default globalThis.__pxvTestMocks.get(${JSON.stringify(key)}).default;`
            : `export const ${name} = globalThis.__pxvTestMocks.get(${JSON.stringify(key)})[${JSON.stringify(name)}];`,
        )
        .join('\n');
      return { format: 'module', source, shortCircuit: true };
    }
    if (url.startsWith('file:') && new URL(url).pathname.endsWith('.ts')) {
      const filename = fileURLToPath(url),
        source = readFileSync(filename, 'utf8');
      const result = transformSync(source, {
        loader: 'ts',
        format: 'esm',
        target: 'node24',
        sourcemap: 'inline',
        sourcesContent: true,
        sourcefile: filename,
      });
      return { format: 'module', source: result.code, shortCircuit: true };
    }
    return next(url, context);
  },
});

/** @param {string} specifier @param {string} parentURL */
function fileSourceURL(specifier, parentURL) {
  const url = new URL(specifier, parentURL);
  url.search = '';
  const file = fileURLToPath(url);
  if (file.endsWith('.js') && existsSync(file.slice(0, -3) + '.ts'))
    return pathToFileURL(file.slice(0, -3) + '.ts').href;
  return existsSync(file) ? pathToFileURL(realpathSync(file)).href : url.href;
}

/** @param {string} canonical @param {string} specifier */
function originalImport(canonical, specifier) {
  return state.bypass.has(canonical) || specifier.includes('pxv-original=1');
}
/** @param {string} url @param {boolean} original */
function mockedURL(url, original) {
  return !original && state.values.has(url);
}
