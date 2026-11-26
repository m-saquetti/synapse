import { open, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync=promisify(execFile);
let ownStart;
async function processStartTime(pid) {
  if(process.platform!=='win32') return null;
  try {
    const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],{windowsHide:true,timeout:5000,maxBuffer:4096});
    const stamp=Date.parse(stdout.trim());
    return Number.isFinite(stamp)?stamp:null;
  }catch{return null;}
}

export function hasReusedPid(owner, actualStart) {
  if(!Number.isFinite(actualStart)) return false;
  if(Number.isFinite(owner.processStartedAt)) return actualStart!==owner.processStartedAt;
  const created=Date.parse(owner.createdAt);
  // Old locks have no start marker. A process born after the lock cannot own it.
  return Number.isFinite(created) && actualStart>created+1000;
}

export async function acquireLock(dataDir) {
  const path=join(dataDir,'instance.lock');
  const nonce=randomUUID();
  ownStart ??= processStartTime(process.pid);
  const processStartedAt=await ownStart;
  for(let attempt=0;attempt<2;attempt++) {
    try {
      const handle=await open(path,'wx');
      await handle.writeFile(JSON.stringify({pid:process.pid,nonce,createdAt:new Date().toISOString(),processStartedAt}));
      await handle.close();
      return async () => {
        try { if(JSON.parse(await readFile(path,'utf8')).nonce===nonce) await unlink(path); }
        catch(error) { if(error.code!=='ENOENT') throw error; }
      };
    } catch(error) {
      if(error.code!=='EEXIST') throw error;
      let owner;
      try { owner=JSON.parse(await readFile(path,'utf8')); }
      catch { throw new Error('O diretório de dados está bloqueado. Verifique se outra Synapse está aberta antes de remover .data/instance.lock.'); }
      if(!Number.isInteger(owner.pid) || owner.pid<=0) throw new Error('Bloqueio de dados inválido. Verifique .data/instance.lock.');
      let alive=true;
      try { process.kill(owner.pid,0); }
      catch(e) { if(e.code==='ESRCH') alive=false; }
      if(alive && hasReusedPid(owner,await processStartTime(owner.pid))) alive=false;
      if(alive) throw new Error('A Synapse já está usando este histórico. Abra a instância existente em vez de iniciar outra.');
      // Remove only the stale lock that we actually inspected.
      const current=JSON.parse(await readFile(path,'utf8'));
      if(current.nonce===owner.nonce && current.pid===owner.pid) await unlink(path);
    }
  }
  throw new Error('Não foi possível obter acesso exclusivo ao histórico.');
}
