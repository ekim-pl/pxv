#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAndroid } from './lib/android-build.mjs';
const resources = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = await buildAndroid(process.argv.slice(2), resources);
if (result) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
