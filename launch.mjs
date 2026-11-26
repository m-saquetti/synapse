import { spawn } from 'node:child_process';
import { access, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isEntryPoint } from './lib/entry.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait,milliseconds));

async function readInstance(dataDir) {
  try { return JSON.parse(await readFile(join(dataDir,'runtime.json'),'utf8')); }
  catch(error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function runningInstance(dataDir) {
  const record = await readInstance(dataDir);
  if (!record) return null;
  const url = new URL(record.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Endereço inválido em .data/runtime.json.');
  }
  let response;
  try { response = await fetch(`${url.origin}/api/health`,{redirect:'error',signal:AbortSignal.timeout(1500)}); }
  catch { return null; }
  const health = response.ok ? await response.json() : null;
  if (!record.instanceId || health?.app !== 'mesa-central' || health?.instanceId !== record.instanceId) {
    throw new Error('A porta respondeu com uma instância diferente ou uma versão anterior da Synapse.');
  }
  return {url:url.origin,instanceId:record.instanceId,version:health.version};
}

// somenteSemTarefas: o servidor só aceita com a fila vazia e, ao aceitar, para de receber tarefas.
// Recusa por tarefas em andamento lança um erro com code 'BUSY'; aoAceitar avisa o ponto sem volta.
export async function stopMesa(dataDir,{somenteSemTarefas=false,aoAceitar}={}) {
  const instance = await runningInstance(dataDir);
  if (!instance) return false;
  const bootstrap = await fetch(`${instance.url}/api/bootstrap`,{redirect:'error',signal:AbortSignal.timeout(30000)});
  if (!bootstrap.ok) throw new Error('Não foi possível identificar a sessão local da Synapse.');
  const {csrfToken, activeJobs} = await bootstrap.json();
  if (somenteSemTarefas && !Array.isArray(activeJobs)) throw new Error('O servidor não informou o estado da fila.');
  const response = await fetch(`${instance.url}/api/admin/shutdown`,{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
    headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},
    body:JSON.stringify({instanceId:instance.instanceId,...(somenteSemTarefas?{onlyIfIdle:true}:{})})
  });
  if (response.status !== 202) {
    const detalhe = await response.json().catch(() => ({}));
    throw Object.assign(new Error(detalhe.error || `A Synapse recusou o encerramento (HTTP ${response.status}).`),{code:detalhe.busy?'BUSY':'REFUSED'});
  }
  await response.json();
  aoAceitar?.();
  for (let attempt=0; attempt<350; attempt++) {
    const record = await readInstance(dataDir);
    if (record && record.instanceId !== instance.instanceId) return true;
    if (!record) {
      const locked = await access(join(dataDir,'instance.lock')).then(() => true,() => false);
      if (!locked) return true;
    }
    await wait(100);
  }
  throw new Error('O encerramento foi solicitado e ainda está em andamento. Consulte .data/server.log.');
}

// Depois que o aplicativo Synapse importa estas salas, iniciar este servidor criaria um segundo histórico.
export const MARCA_MIGRACAO = 'MOVIDA-PARA-ORBITA.json';
export async function migracaoRegistrada(dataDir) {
  try { return JSON.parse(await readFile(join(dataDir,MARCA_MIGRACAO),'utf8')); }
  catch(error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function launch() {
  const dataDir = join(root,'.data');
  if (process.argv.includes('--stop')) {
    console.log(await stopMesa(dataDir) ? 'Synapse encerrada. Histórico preservado.' : 'A Synapse já está encerrada.');
    return;
  }
  const migrada = await migracaoRegistrada(dataDir);
  if (migrada && process.env.ORBITA_PERMITIR_LEGADO !== '1') {
    throw new Error(`Estas salas foram levadas para o aplicativo Synapse em ${new Date(migrada.em).toLocaleString('pt-BR')}. Abra a Synapse pelo menu Iniciar ou pelo atalho da Área de Trabalho.`);
  }
  let instance = await runningInstance(dataDir);
  if (!instance) {
    await mkdir(dataDir,{recursive:true});
    const log = await open(join(dataDir,'server.log'),'a');
    const child = spawn(process.execPath,[join(root,'server.mjs')],{
      cwd:root,detached:true,windowsHide:true,stdio:['ignore',log.fd,log.fd]
    });
    child.unref();
    await log.close();
    for (let attempt=0; attempt<40; attempt++) {
      instance = await runningInstance(dataDir);
      if (instance) break;
      await wait(250);
    }
    if (!instance) throw new Error('Não foi possível iniciar a Synapse. Consulte .data/server.log.');
  }
  const {url} = instance;
  console.log(`Synapse pronta em ${url}`);
  if (process.argv.includes('--no-browser')) return;
  const args = process.platform === 'win32' ? ['-NoProfile','-NonInteractive','-Command',`Start-Process '${url}'`] : [url];
  const executable = process.platform === 'win32' ? 'powershell.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const browser = spawn(executable,args,{detached:true,windowsHide:true,stdio:'ignore'});
  browser.on('error',() => console.log(`Abra ${url} no navegador.`));
  browser.unref();
}

if (isEntryPoint(import.meta.url)) {
  try { await launch(); }
  catch(error) { console.error(error.message); process.exitCode=1; }
}
