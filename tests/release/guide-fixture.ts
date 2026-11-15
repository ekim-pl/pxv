import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { product as baseProduct } from '../contracts/fixtures.js';

// Keep product identity distinct from the CLI command and support URL in guide content.
export const product = {
  ...baseProduct,
  name: 'Fixture Product Identity',
  support: { ...baseProduct.support, name: 'Fixture Product Identity' },
};

export async function createGuideFixture(): Promise<string> {
  const root = await mkdtemp('/tmp/pxv-guide-fixture-');
  const descriptor = JSON.parse(await readFile('product.json', 'utf8')) as Record<string, unknown>;
  await writeFile(join(root, 'product.json'), JSON.stringify({ ...descriptor, ...product }));
  await cp('guides', join(root, 'guides'), { recursive: true });
  return root;
}
