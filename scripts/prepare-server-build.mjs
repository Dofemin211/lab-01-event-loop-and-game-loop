import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist/server-runtime');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
let gitSha = process.env.GIT_SHA;

if (!gitSha) {
  try {
    gitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    gitSha = 'unknown';
    console.warn('Git metadata is unavailable; production health will report gitSha=unknown.');
  }
}

const sharedOutput = path.join(output, 'shared/src');
const runtimeShared = path.join(output, 'node_modules/@dogfight/shared');
await mkdir(path.dirname(runtimeShared), { recursive: true });
await cp(sharedOutput, path.join(runtimeShared, 'src'), { recursive: true });
await writeFile(
  path.join(runtimeShared, 'package.json'),
  `${JSON.stringify(
    {
      name: '@dogfight/shared',
      type: 'module',
      exports: {
        './prng': './src/prng.js',
        './protocol': './src/protocol.js',
        './codec': './src/codec.js',
        './sim': './src/sim/index.js',
        './sim/*': './src/sim/*.js',
      },
    },
    null,
    2,
  )}\n`,
);
await writeFile(
  path.join(output, 'package.json'),
  `${JSON.stringify({ type: 'module', version: packageJson.version }, null, 2)}\n`,
);
await writeFile(
  path.join(output, 'server/src/build-info.js'),
  `export const BUILD_INFO = Object.freeze(${JSON.stringify({
    version: packageJson.version,
    gitSha,
  })});\n`,
);
