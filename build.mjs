// Build driver. No framework: four esbuild entrypoints plus a static copy step.
//
// Deliberate choices:
//   - no minification, so the shipped bundle stays readable and maps 1:1 onto
//     this repo when you unzip the signed XPI;
//   - `version` is injected into manifest.json from package.json, so package.json
//     is the single source of truth for release numbering;
//   - IIFE output, because Firefox event pages and content scripts both take
//     plain scripts and we declare no `"type": "module"` anywhere.

import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = resolve(root, 'src');
const dist = resolve(root, 'dist');

const dev = process.argv.includes('--dev');
const watch = process.argv.includes('--watch');

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['firefox128'],
  minify: false,
  legalComments: 'inline',
  sourcemap: dev ? 'linked' : false,
  logLevel: 'info',
  define: {
    __VERSION__: JSON.stringify(pkg.version),
    __DEV__: JSON.stringify(dev),
  },
  loader: {
    // UI styles land in the bundle as a string constant, injected into the
    // shadow root. No separate CSS file means no web_accessible_resources.
    '.css': 'text',
  },
};

const entries = [
  { in: resolve(src, 'main-world/interceptor.ts'), out: resolve(dist, 'main-world.js') },
  { in: resolve(src, 'content/index.ts'), out: resolve(dist, 'content.js') },
  { in: resolve(src, 'background/index.ts'), out: resolve(dist, 'background.js') },
  { in: resolve(src, 'options/options.ts'), out: resolve(dist, 'options/options.js') },
];

async function copyStatic() {
  const manifest = JSON.parse(await readFile(resolve(src, 'manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  await mkdir(resolve(dist, 'options'), { recursive: true });
  await writeFile(resolve(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await cp(resolve(src, 'icons'), resolve(dist, 'icons'), { recursive: true });
  await cp(resolve(src, 'options/options.html'), resolve(dist, 'options/options.html'));
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await copyStatic();

if (watch) {
  const contexts = await Promise.all(
    entries.map((e) => esbuild.context({ ...common, entryPoints: [e.in], outfile: e.out })),
  );
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching…');
} else {
  await Promise.all(
    entries.map((e) => esbuild.build({ ...common, entryPoints: [e.in], outfile: e.out })),
  );
  console.log(`built x-thread-md ${pkg.version}${dev ? ' (dev)' : ''} -> dist/`);
}
