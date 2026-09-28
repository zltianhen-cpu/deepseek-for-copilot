// Purpose: create symlink fixtures only inside the isolated temporary directory.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
exports.symlinkFixture = (target, link) => {
  const root = fs.realpathSync(os.tmpdir());
  const parent = fs.realpathSync(path.dirname(link));
  const destination = path.join(parent, path.basename(link));
  const resolvedTarget = path.resolve(parent, target);
  const inside = value => value.startsWith(root + path.sep);
  if (!inside(destination) || !inside(resolvedTarget)) throw new Error('Symlink fixture must stay inside isolated TMPDIR');
  // Node permission mode disallows symlink creation even inside its write allow-list.
  // ln gets only these validated fixture paths; runtime code remains permission-bound.
  const result = spawnSync('/bin/ln', ['-s', target, destination], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr);
};
