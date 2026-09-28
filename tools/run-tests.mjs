// Purpose: run all smoke tests with isolated defaults and a native Node write boundary.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function makeTestEnv(directory) {
  const root = fs.realpathSync(directory);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('DEEPSEEK_')) delete env[key];
  for (const name of ['home', 'data', 'diagnostics', 'tmp']) fs.mkdirSync(path.join(root, name), { recursive: true });
  return {
    ...env,
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    DEEPSEEK_DATA_DIR: path.join(root, 'data'),
    DEEPSEEK_DIAG_DIR: path.join(root, 'diagnostics'),
    DEEPSEEK_INDEX_PATH: path.join(root, 'data', 'index.json'),
    TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'),
    // No inherited allow-list or preloads. Child Node processes inherit this boundary.
    // Subprocess support is needed by existing ZIP/build-preflight fixtures. This is
    // an accidental-write guard, not a sandbox for malicious child executables.
    NODE_OPTIONS: `--permission --allow-fs-read=* --allow-fs-write=${root} --allow-child-process`,
  };
}

export function runTests(args = process.argv.slice(2)) {
  const all = fs.readdirSync(path.join(repo, 'test')).filter(n => /^smoke-.*\.js$/.test(n)).sort();
  let file, pattern;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--file' && all.includes(args[i + 1])) file = args[i + 1];
    else if (args[i] === '--pattern' && args[i + 1]) pattern = args[i + 1];
    else throw new Error('Usage: run-tests.mjs [--file smoke-name.js] [--pattern name]');
  }
  const tests = file ? [path.join('test', file)] : all.map(n => path.join('test', n));
  if (!file) tests.push('tools/check-i18n-models.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isolated-smoke-'));
  try {
    for (const [i, testFile] of tests.entries()) {
      const dir = path.join(root, String(i)); fs.mkdirSync(dir);
      const argv = pattern ? ['--test', `--test-name-pattern=${pattern}`, testFile] : [testFile];
      const result = spawnSync(process.execPath, argv, { cwd: repo, env: makeTestEnv(dir), stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) return result.status || 1;
    }
    console.log(`Isolated test entry points passed: ${tests.length}`);
    return 0;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runTests(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
