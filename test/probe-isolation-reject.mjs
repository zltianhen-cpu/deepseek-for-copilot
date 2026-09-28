// Purpose: a negative probe must exit nonzero when attempting an out-of-bound write.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {makeTestEnv} from '../tools/run-tests.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'isolation-negative-'));
try {const dir=path.join(root,'allowed');fs.mkdirSync(dir);const target=path.join(root,'forbidden');const r=spawnSync(process.execPath,['-e',`require('fs').writeFileSync(${JSON.stringify(target)},'must not happen')`],{env:makeTestEnv(dir),encoding:'utf8'});console.log(r.stderr);process.exitCode=r.status||0;}finally{fs.rmSync(root,{recursive:true,force:true})}
