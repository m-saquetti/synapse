import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { stopMesa } from '../launch.mjs';
import { buildPrompt } from '../lib/orchestrator.mjs';
import { Store } from '../lib/store.mjs';
import { get as httpGet } from 'node:http';

const connected = async () => Object.fromEntries(['codex','claude'].map(agent=>[agent,{available:true,authenticated:true,label:agent,version:'test',detail:'test only'}]));
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate) {
  for(let n=0;n<150;n++) { const value=await predicate(); if(value) return value; await sleep(20); }
  throw new Error('Timed out waiting for job');
}
async function fixture(t, runAgent, extra={}) {
  const dataDir=await mkdtemp(join(tmpdir(),'mesa-test-'));
  const app=await createApp({dataDir,getAgentStatus:connected,runAgent,...extra});
  const url=await app.listen(0);
  const bootstrap=await (await fetch(`${url}/api/bootstrap`)).json();
  const roomId=bootstrap.rooms[0].id;
  t.after(async()=>{ await app.close(); assert.ok(dataDir.startsWith(join(tmpdir(),'mesa-test-'))); await rm(dataDir,{recursive:true,force:true}); });
  async function request(path,body,method='POST',headers={}) {
    const res=await fetch(`${url}${path}`,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':bootstrap.csrfToken,...headers},body:JSON.stringify(body)});
    return {status:res.status,...await res.json()};
  }
  const state=async(id=roomId)=>(await fetch(`${url}/api/rooms/${id}`)).json();
  const done=async id=>until(async()=>{const j=app.store.getJob(id); return !['queued','running'].includes(j.status) && j;});
  return {app,url,bootstrap,roomId,request,state,done,dataDir};
}

test('build runs four stages against the same workspace, settings and real files',async t=>{
  const calls=[];
  const f=await fixture(t,async args=>{
    calls.push(args);
    if(calls.length===1) await writeFile(join(args.cwd,'proof.txt'),'shared artifact');
    else assert.equal(await readFile(join(args.cwd,'proof.txt'),'utf8'),'shared artifact');
    args.onActivity({title:'File verified',status:'completed',detail:'proof.txt'});
    return {text:'Etapa verificada',model:args.settings[`${args.agent}Model`]};
  });
  assert.equal((await f.request(`/api/rooms/${f.roomId}/messages`,{content:'Construa',mode:'build'})).status,400);
  await f.request(`/api/rooms/${f.roomId}`,{settings:{access:'project',internet:true,effort:'high',codexModel:'gpt-6-astra',claudeModel:'claude-opus-5-5'}},'PATCH');
  const {job}=await f.request(`/api/rooms/${f.roomId}/messages`,{content:'Construa',mode:'build'});
  assert.equal((await f.done(job.id)).status,'completed');
  assert.deepEqual(calls.map(c=>c.agent),['codex','claude','codex','claude']);
  assert.equal(new Set(calls.map(c=>c.cwd)).size,1);
  assert.equal(calls[1].settings.codexModel,'gpt-6-astra');
  assert.match(calls[1].prompt,/arquivos reais/);
  assert.equal((await f.state()).events.length,4);
  assert.equal((await f.state()).messages[2].model,'claude-opus-5-5');
});

test('settings persist, active runs freeze them and invalid models never reach an agent',async t=>{
  let release,args;
  const f=await fixture(t,a=>{args=a;return new Promise(r=>{release=()=>r({text:'Ok'});});});
  assert.equal((await f.request(`/api/rooms/${f.roomId}`,{settings:{codexModel:'--help'}},'PATCH')).status,400);
  await f.request(`/api/rooms/${f.roomId}`,{settings:{access:'project',codexModel:'custom-valid',timeoutMinutes:2}},'PATCH');
  const {job}=await f.request(`/api/rooms/${f.roomId}/messages`,{content:'Verifique',target:'codex'});
  await until(()=>release);
  assert.equal((await f.request(`/api/rooms/${f.roomId}`,{settings:{codexModel:'changed'}},'PATCH')).status,409);
  assert.equal(args.settings.codexModel,'custom-valid');assert.equal(args.timeoutMs,120000);
  release();await f.done(job.id);
  assert.equal(f.app.store.getJob(job.id).settings.codexModel,'custom-valid');
});

test('file browser previews and downloads exact bytes, confines paths and isolates generated HTML',async t=>{
  const f=await fixture(t,async()=>({text:'unused'}));
  const root=(await f.state()).room.workspacePath;
  await mkdir(join(root,'nested'),{recursive:true});
  await writeFile(join(root,'index.html'),'<h1>Proof</h1><script>window.secret="no parent access"</script>');
  await writeFile(join(root,'nested','data.txt'),'Olá ✓');
  const listing=await f.request(`/api/rooms/${f.roomId}/files`,{});
  assert.equal(listing.files[0].directory,true);
  const read=await f.request(`/api/rooms/${f.roomId}/file`,{path:'nested/data.txt'});
  assert.equal(read.text,'Olá ✓');
  const preview=await f.request(`/api/rooms/${f.roomId}/file`,{path:'index.html'});
  const response=await fetch(`${f.url}${preview.previewUrl}`);
  const policy=response.headers.get('content-security-policy');
  assert.match(policy,/sandbox allow-scripts/);assert.ok(!policy.includes('allow-same-origin'));
  assert.match(policy,/connect-src 'none'/);assert.match(await response.text(),/Proof/);
  const download=await fetch(`${f.url}/api/rooms/${f.roomId}/file`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':f.bootstrap.csrfToken},body:JSON.stringify({path:'nested/data.txt',download:true})});
  assert.equal(await download.text(),'Olá ✓');assert.match(download.headers.get('content-disposition'),/attachment/);
  assert.equal((await f.request(`/api/rooms/${f.roomId}/file`,{path:'../../mesa.sqlite'})).status,403);
  assert.equal((await f.request(`/api/rooms/${f.roomId}/file`,{path:'C:\\Windows\\win.ini'})).status,400);
  assert.equal((await f.request(`/api/rooms/${f.roomId}/file`,{path:'index.html'},'POST',{'X-CSRF-Token':'bad'})).status,403);
  const outside=join(f.dataDir,'outside');await mkdir(outside);await writeFile(join(outside,'private.txt'),'outside');
  await symlink(outside,join(root,'escape'),'junction');
  assert.equal((await f.request(`/api/rooms/${f.roomId}/file`,{path:'escape/private.txt'})).status,403);
});

test('existing v0.1 databases migrate without losing rooms or messages',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'mesa-migrate-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const path=join(folder,'db.sqlite'),old=new DatabaseSync(path);
  old.exec("CREATE TABLE rooms(id TEXT PRIMARY KEY,title TEXT NOT NULL,brief TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL); INSERT INTO rooms VALUES('old','Original','brief','2026-01-01','2026-01-01');");old.close();
  const store=new Store(path);store.addMessage('old','user','Preservado');
  assert.equal(store.getRoom('old').title,'Original');assert.equal(store.getRoom('old').settings.access,'chat');
  store.updateRoom('old',{settings:{codexModel:'gpt-6-astra'}});store.close();
  const reopened=new Store(path);assert.equal(reopened.messages('old')[0].content,'Preservado');assert.equal(reopened.getRoom('old').settings.codexModel,'gpt-6-astra');reopened.close();
});

test('selected folders are validated and browsing never recreates a removed external folder',async t=>{
  const f=await fixture(t,async()=>({text:'unused'}));
  const selected=join(f.dataDir,'selected-folder');await mkdir(selected);
  await writeFile(join(selected,'existing.txt'),'existing');
  const folders=await f.request('/api/folders',{path:f.dataDir});
  assert.ok(folders.folders.some(folder=>folder.name==='selected-folder'));
  const saved=await f.request(`/api/rooms/${f.roomId}`,{settings:{workspace:selected,access:'project'}},'PATCH');
  assert.equal(saved.status,200);assert.equal(saved.room.workspacePath,selected);
  assert.equal((await f.request(`/api/rooms/${f.roomId}/files`,{})).files[0].name,'existing.txt');
  assert.equal((await f.request(`/api/rooms/${f.roomId}`,{settings:{workspace:join(selected,'existing.txt')}},'PATCH')).status,400);
  await rm(selected,{recursive:true});
  assert.equal((await f.request(`/api/rooms/${f.roomId}/files`,{})).status,404);
  await assert.rejects(readFile(join(selected,'existing.txt')),{code:'ENOENT'});
  assert.equal((await f.request(`/api/rooms/${f.roomId}`,{settings:{workspace:selected}},'PATCH')).status,404);
});

test('two real adapters can share a room through sequential context (injected agents)',async t=>{
  const calls=[];
  const f=await fixture(t,async ({agent,prompt})=>{calls.push({agent,prompt});return {text:agent==='codex'?'Proposta verificável ALFA':'Revisão de ALFA'};});
  const response=await f.request(`/api/rooms/${f.roomId}/messages`,{content:'Defina o projeto',target:'both',mode:'conversation'});
  assert.equal(response.status,202);
  assert.equal((await f.done(response.job.id)).status,'completed');
  assert.deepEqual(calls.map(c=>c.agent),['codex','claude']);
  assert.match(calls[1].prompt,/Proposta verificável ALFA/);
  assert.deepEqual((await f.state()).messages.map(m=>m.role),['user','codex','claude']);
  const exported=await (await fetch(`${f.url}/api/rooms/${f.roomId}/export`)).text();
  assert.match(exported,/Revisão de ALFA/);
});

test('debate has exactly four turns, bounded and alternating',async t=>{
  const calls=[];
  const f=await fixture(t,async({agent})=>{calls.push(agent);return {text:`turno ${calls.length}`};});
  const {job}=await f.request(`/api/rooms/${f.roomId}/messages`,{content:'Debatam a solução',target:'both',mode:'debate'});
  const result=await f.done(job.id);
  assert.equal(result.step,4); assert.equal(result.status,'completed');
  assert.deepEqual(calls,['codex','claude','codex','claude']);
});

test('failure is visible and preserves the first successful response',async t=>{
  const f=await fixture(t,async({agent})=>{if(agent==='claude') throw new Error('Limite de uso atingido');return {text:'Resposta preservada'};});
  const {job}=await f.request(`/api/rooms/${f.roomId}/messages`,{content:'Teste',target:'both'});
  const result=await f.done(job.id);
  assert.equal(result.status,'failed'); assert.match(result.error,/Limite de uso/);
  assert.deepEqual((await f.state()).messages.map(m=>m.role),['user','codex']);
});

test('running cancellation aborts agent and never starts the next participant',async t=>{
  const calls=[];
  const f=await fixture(t,({agent,signal})=>new Promise((resolve,reject)=>{
    calls.push(agent); signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});
  }));
  const {job}=await f.request(`/api/rooms/${f.roomId}/messages`,{content:'Teste',target:'both'});
  await until(()=>calls.length===1);
  const duplicate=await f.request(`/api/rooms/${f.roomId}/messages`,{content:'Outra'});
  assert.equal(duplicate.status,409);
  assert.equal((await f.request(`/api/jobs/${job.id}/cancel`,{})).job.status,'cancelled');
  await until(()=>!f.app.orchestrator.active);
  assert.deepEqual(calls,['codex']); assert.equal((await f.state()).messages.length,1);
});

test('global queue is serial and queued jobs can be cancelled without running',async t=>{
  let release; const calls=[];
  const f=await fixture(t,({agent})=>{calls.push(agent);return new Promise(resolve=>{release=()=>resolve({text:'Pronto'});});});
  const first=await f.request(`/api/rooms/${f.roomId}/messages`,{content:'Primeira',target:'codex'});
  await until(()=>calls.length===1);
  const {room}=await f.request('/api/rooms',{title:'Segunda sala'});
  const second=await f.request(`/api/rooms/${room.id}/messages`,{content:'Segunda',target:'claude'});
  assert.equal(second.job.status,'queued');
  await f.request(`/api/jobs/${second.job.id}/cancel`,{});
  release(); await f.done(first.job.id);
  assert.deepEqual(calls,['codex']);
  assert.equal(f.app.store.getJob(second.job.id).status,'cancelled');
});

test('cross-origin requests, forged CSRF and path traversal are rejected',async t=>{
  const f=await fixture(t,async()=>({text:'Unused'}));
  assert.equal((await fetch(`${f.url}/api/bootstrap`,{headers:{Origin:'https://untrusted.example'}})).status,403);
  assert.equal((await f.request('/api/rooms',{title:'Unsafe'},'POST',{'X-CSRF-Token':'bad'})).status,403);
  const forgedHostStatus=await new Promise((resolve,reject)=>httpGet(`${f.url}/api/health`,{headers:{Host:'rebind.example'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject));
  assert.equal(forgedHostStatus,403);
  assert.equal((await fetch(`${f.url}/.data/mesa.sqlite`)).status,404);
  assert.equal((await f.request(`/api/rooms/${f.roomId}/messages`,{content:'x',target:'claude',mode:'debate'})).status,400);
  assert.equal((await f.request(`/api/rooms/${f.roomId}/messages`,{content:'x'.repeat(24001)})).status,400);
  assert.equal((await f.state()).messages.length,0);
});

test('room briefing persists and is included in prompts',async t=>{
  let prompt;
  const f=await fixture(t,async args=>{prompt=args.prompt;return {text:'Certo'};});
  await f.request(`/api/rooms/${f.roomId}`,{brief:'Requisito indispensável: acessibilidade',title:'Produto'},'PATCH');
  const {job}=await f.request(`/api/rooms/${f.roomId}/messages`,{content:'Planeje',target:'codex'});
  await f.done(job.id); assert.match(prompt,/acessibilidade/);
  const reader=new Store(join(f.dataDir,'mesa.sqlite'));
  assert.equal(reader.getRoom(f.roomId).title,'Produto'); reader.close();
});

test('a restarted store marks unfinished jobs interrupted instead of rerunning',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mesa-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const s=new Store(join(dir,'db.sqlite'));
  const room=s.createRoom('Persistência'); const job=s.createJob(room.id,'both','debate',4);
  s.updateJob(job.id,{status:'running',step:2}); s.addMessage(room.id,'codex','Resposta salva'); s.close();
  const restarted=new Store(join(dir,'db.sqlite'));
  restarted.recoverInterruptedJobs();
  assert.equal(restarted.getJob(job.id).status,'interrupted');
  assert.equal(restarted.messages(room.id)[0].content,'Resposta salva');
  restarted.close();
});

test('a second server cannot touch an active instance history',async t=>{
  const f=await fixture(t,({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('stop')),{once:true})));
  const {job}=await f.request(`/api/rooms/${f.roomId}/messages`,{content:'Mantenha a rodada',target:'codex'});
  await until(()=>f.app.store.getJob(job.id).status==='running');
  await assert.rejects(createApp({dataDir:f.dataDir,getAgentStatus:connected,runAgent:async()=>({text:'unused'})}),/já está usando/);
  assert.equal(f.app.store.getJob(job.id).status,'running');
  await f.request(`/api/jobs/${job.id}/cancel`,{});
});

test('the shutdown launcher checks ownership, interrupts its agent, and preserves the room',async t=>{
  let started = false, interrupted = false;
  const f = await fixture(t,({signal}) => new Promise((resolve,reject) => {
    started = true;
    signal.addEventListener('abort',() => { interrupted=true; reject(new Error('interrompido')); },{once:true});
  }));
  const {job} = await f.request(`/api/rooms/${f.roomId}/messages`,{content:'Mensagem preservada',target:'codex'});
  await until(() => started);
  assert.equal((await f.request('/api/admin/shutdown',{instanceId:'outra-instancia'})).status,409);
  assert.equal((await f.request('/api/admin/shutdown',{},'POST',{'X-CSRF-Token':'invalido'})).status,403);
  assert.equal(interrupted,false);
  assert.equal(await stopMesa(f.dataDir),true);
  assert.equal(interrupted,true);
  assert.equal(await stopMesa(f.dataDir),false);
  const reader = new Store(join(f.dataDir,'mesa.sqlite'));
  try {
    assert.equal(reader.getJob(job.id).status,'interrupted');
    assert.equal(reader.messages(f.roomId)[0].content,'Mensagem preservada');
  } finally { reader.close(); }
});

test('context budget preserves latest request and discloses omitted history',()=>{
  const messages=Array.from({length:100},(_,i)=>({role:i%2?'claude':'user',status:'completed',content:`MESSAGE_${i}:`+'x'.repeat(4000)}));
  const prompt=buildPrompt({room:{title:'Test',brief:''},messages,agent:'codex',mode:'conversation',step:1,totalSteps:1});
  assert.ok(prompt.length<62000); assert.match(prompt,/MESSAGE_99/); assert.match(prompt,/mensagens antigas foi omitida/); assert.doesNotMatch(prompt,/MESSAGE_0:/);
});

test('JSON escaping and a large briefing still respect the adapter prompt budget',()=>{
  const messages=Array.from({length:3},()=>({role:'user',status:'completed',content:'\\'.repeat(24000)}));
  const prompt=buildPrompt({room:{title:'Test',brief:'\u0000'.repeat(10000)},messages,agent:'codex',mode:'conversation',step:1,totalSteps:1});
  assert.ok(prompt.length<90000); assert.match(prompt,/truncada/);
});
