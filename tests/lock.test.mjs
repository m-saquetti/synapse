import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hasReusedPid,acquireLock} from '../lib/lock.mjs';

test('process identity distinguishes a reused PID while preserving uncertain live locks',()=>{
  assert.equal(hasReusedPid({processStartedAt:10000},10000),false);
  assert.equal(hasReusedPid({processStartedAt:10000},20000),true);
  assert.equal(hasReusedPid({processStartedAt:10000},null),false);
  assert.equal(hasReusedPid({createdAt:'2026-11-12T00:00:00Z'},Date.parse('2026-11-15T00:00:00Z')),true);
  assert.equal(hasReusedPid({createdAt:'2026-11-12T00:00:00Z'},Date.parse('2026-11-11T00:00:00Z')),false);
  assert.equal(hasReusedPid({createdAt:'invalid'},Date.now()),false);
});

test('Windows safely recovers an old lock whose PID now belongs to a newer process',{skip:process.platform!=='win32'},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mesa-lock-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'instance.lock'),JSON.stringify({pid:process.pid,nonce:'stale',createdAt:'2000-01-01T00:00:00.000Z'}));
  const release=await acquireLock(dir);
  assert.notEqual(JSON.parse(await readFile(join(dir,'instance.lock'),'utf8')).nonce,'stale');
  await assert.rejects(acquireLock(dir),/já está usando/);
  await release();
});
