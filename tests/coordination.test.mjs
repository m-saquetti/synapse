import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,writeFile,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { chooseAgent,quotaPressure,parseHandoff } from '../lib/routing.mjs';
import { normalizeSettings } from '../lib/settings.mjs';
import { AgentError } from '../lib/agents.mjs';
import { Store } from '../lib/store.mjs';
import { codexUsage,claudeUsage } from '../lib/providers.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let n=0;n<200;n++){const value=await fn();if(value)return value;await wait(20);}throw new Error('Test timed out');}
const connected=(usage={})=>Object.fromEntries(['codex','claude','gemini'].map(p=>[p,{available:true,authenticated:true,usage:usage[p]===undefined?null:{windows:[{label:'5 horas',usedPercent:usage[p]}]}}]));
const result=(status='complete',summary='Entrega verificada')=>({text:`${summary}\n<mesa_status>${JSON.stringify({status,summary,next:status==='continue'?['Corrigir item pendente']:[],decisions:['Usar uma solução simples'],tests:['Verificação local concluída']})}</mesa_status>`});
async function fixture(t,runAgent,getStatus=async()=>connected()) {
  const dataDir=await mkdtemp(join(tmpdir(),'mesa-v03-test-'));
  const app=await createApp({dataDir,runAgent,getAgentStatus:getStatus}),url=await app.listen(0);
  const boot=await(await fetch(url+'/api/bootstrap')).json(),room=boot.rooms[0];
  const request=async(path,body={},method='POST')=>{const response=await fetch(url+path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':boot.csrfToken},body:JSON.stringify(body)});return {status:response.status,...await response.json()};};
  const state=async()=>(await fetch(`${url}/api/rooms/${room.id}`)).json();
  const done=id=>until(()=>{const job=app.store.getJob(id);return !['queued','running'].includes(job.status)&&job;});
  await request(`/api/rooms/${room.id}`,{settings:{access:'project',internet:true}},'PATCH');
  t.after(async()=>{await app.close();assert.ok(dataDir.startsWith(join(tmpdir(),'mesa-v03-test-')));await rm(dataDir,{recursive:true,force:true});});
  return {app,url,room,request,state,done,dataDir};
}

test('routing balances task preference with measured usage; unknown usage is never zero',()=>{
  const settings=normalizeSettings(),status=connected({claude:90,codex:40,gemini:20});
  assert.equal(chooseAgent({status,settings,lane:'code'}).agent,'codex');
  assert.equal(chooseAgent({status:connected({claude:30,codex:10,gemini:5}),settings,lane:'code'}).agent,'claude');
  assert.equal(chooseAgent({status:connected({claude:100,codex:100,gemini:100}),settings,lane:'code'}),null);
  assert.equal(quotaPressure(null),null);
  assert.equal(quotaPressure({windows:[{usedPercent:100,resetsAt:'2000-01-01T00:00:00Z'}]}),100,'a past reset does not prove capacity');
  assert.equal(chooseAgent({status:connected(),settings,lane:'code'}).reason.includes('não informado'),true);
});
test('native quota formats keep percentages, model scope and unknown windows accurate',()=>{
  const g=codexUsage({ordinaryUsageAllowed:false,rateLimits:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:1800000000},secondary:{usedPercent:5,windowDurationMins:10080}}});
  assert.equal(g.windows[0].usedPercent,25);assert.equal(g.ordinaryUsageAllowed,false);
  const c=claudeUsage({rate_limits:{five_hour:{utilization:0.5,resets_at:null},seven_day:null,seven_day_opus:{utilization:100,resets_at:null}}});
  assert.equal(c.windows[0].usedPercent,0.5);assert.equal(c.windows.length,2);assert.equal(quotaPressure(c,'claude-sonnet-5'),0.5);assert.equal(quotaPressure(c,'claude-opus-5'),100);
});
test('code continues beyond four turns, shares checkpoints and stops after independent review',async t=>{
  // Claude lidera e implementa; GPT e Gemini revisam em sequência; uma crítica leva ao refino; a segunda
  // passada aprova a versão atual e a tarefa termina.
  const calls=[];
  const f=await fixture(t,async args=>{
    calls.push(args);
    const implementing=/Implementação|Refino/.test(args.prompt.split('SEU PAPEL')[1] || '');
    if(implementing)await writeFile(join(args.cwd,'project.txt'),`version ${calls.length}`);
    return result(calls.length===2?'continue':'complete',`Estado ${calls.length}`);
  });
  const {job}=await f.request(`/api/rooms/${f.room.id}/messages`,{content:'Construa e revise',target:'auto',mode:'code'});
  assert.equal((await f.done(job.id)).status,'completed');assert.equal(calls.length,6);
  assert.deepEqual(calls.map(c=>c.agent),['claude','codex','gemini','claude','codex','gemini']);
  assert.match(calls[1].prompt,/Estado 1/);
  const state=await f.state();assert.equal(state.checkpoints.length,6);assert.ok(!state.messages.at(-1).content.includes('mesa_status'));
  const versions=await(await fetch(`${f.url}/api/rooms/${f.room.id}/versions`)).json();assert.equal(versions.versions.length,12);
  const first=versions.versions.find(v=>v.phase==='after'&&v.files.length && v.files[0].size===9);
  assert.ok(first);
});
test('rate exhaustion hands unfinished files and context to a different agent',async t=>{
  const calls=[];let limited=false;
  const f=await fixture(t,async args=>{
    calls.push(args.agent);
    if(args.agent==='claude'){await writeFile(join(args.cwd,'partial.txt'),'já criado');limited=true;throw new AgentError('Limite atingido','RATE_LIMIT');}
    assert.equal(await readFile(join(args.cwd,'partial.txt'),'utf8'),'já criado');assert.match(args.prompt,/Participação interrompida/);return result();
  },async()=>connected(limited?{claude:100}:{}));
  const {job}=await f.request(`/api/rooms/${f.room.id}/messages`,{content:'Continue o arquivo',target:'auto',mode:'code'});
  assert.equal((await f.done(job.id)).status,'completed');assert.deepEqual(calls,['claude','codex','gemini']);
});
test('all quotas exhausted pauses durably, then resume chooses the preferred eligible agent',async t=>{
  let blocked=true;const calls=[];
  const f=await fixture(t,async args=>{calls.push(args.agent);return result();},async()=>connected(blocked?{codex:100,claude:100,gemini:100}:{}));
  const {job}=await f.request(`/api/rooms/${f.room.id}/messages`,{content:'Faça o projeto',target:'auto',mode:'code'});
  assert.equal((await f.done(job.id)).status,'waiting_capacity');assert.equal(calls.length,0);
  assert.equal((await f.request(`/api/rooms/${f.room.id}/messages`,{content:'Outro',mode:'code'})).status,409);
  blocked=false;await f.request(`/api/jobs/${job.id}/resume`);assert.equal((await f.done(job.id)).status,'completed');assert.deepEqual(calls,['claude','codex','gemini']);
});
test('native session IDs persist separately by Chat/Code and resume only within the same binding',async t=>{
  const calls=[];
  const f=await fixture(t,async args=>{calls.push(args);args.onSession('session-code-123');return {...result(),sessionId:'session-code-123'};});
  const send=async mode=>{const {job}=await f.request(`/api/rooms/${f.room.id}/messages`,{content:'Continue',target:'codex',mode});await f.done(job.id);};
  await send('code');await send('code');await send('chat');
  assert.equal(calls[0].sessionId,undefined);assert.equal(calls[1].sessionId,'session-code-123');assert.equal(calls[2].sessionId,undefined);assert.equal(calls[2].settings.access,'chat');
  assert.equal((await f.state()).sessions.length,2);
});
test('real permission promises wait for Mesa response, preserve refusal and reject replay',async t=>{
  let answer;
  const f=await fixture(t,async args=>{answer=await args.requestApproval({kind:'permission',title:'Criar arquivo',detail:'teste.txt'});return result();});
  const {job}=await f.request(`/api/rooms/${f.room.id}/messages`,{content:'Teste',target:'codex',mode:'code'});
  const approval=await until(async()=>{const s=await f.state();return s.approvals[0];});
  assert.equal(answer,undefined);
  assert.equal((await f.request(`/api/approvals/${approval.id}`,{decision:'deny'})).status,200);
  await f.done(job.id);assert.equal(answer.decision,'deny');
  assert.equal((await f.request(`/api/approvals/${approval.id}`,{decision:'allow'})).status,409);
  assert.equal((await f.state()).approvals[0].status,'denied');
});
test('cancelling a pending permission closes it without allowing an action',async t=>{
  let answer;
  const f=await fixture(t,async args=>{answer=await args.requestApproval({kind:'permission',title:'Comando'});return result();});
  const {job}=await f.request(`/api/rooms/${f.room.id}/messages`,{content:'Teste',target:'codex',mode:'code'});
  await until(async()=>(await f.state()).approvals.length);await f.request(`/api/jobs/${job.id}/cancel`);await until(()=>answer);
  assert.equal(answer.decision,'deny');assert.equal((await f.state()).approvals[0].status,'expired');assert.equal((await f.done(job.id)).status,'cancelled');
});
test('budget pause requires explicit continuation and retains completed stages',async t=>{
  let count=0;const f=await fixture(t,async()=>{count++;return result('continue');});
  await f.request(`/api/rooms/${f.room.id}`,{settings:{maxSteps:2}},'PATCH');
  const {job}=await f.request(`/api/rooms/${f.room.id}/messages`,{content:'Construa',mode:'code'});
  assert.equal((await f.done(job.id)).status,'paused_budget');assert.equal(count,2);
  await f.request(`/api/jobs/${job.id}/resume`);assert.equal((await f.done(job.id)).status,'paused_budget');assert.equal(count,4);assert.equal((await f.state()).checkpoints.length,4);
});
test('versions recover exact prior bytes and omit dependencies, credentials and escapes',async t=>{
  const f=await fixture(t,async args=>{await writeFile(join(args.cwd,'file.txt'),'after');return result();});
  const cwd=(await f.state()).room.workspacePath;await mkdir(join(cwd,'node_modules'),{recursive:true});await writeFile(join(cwd,'file.txt'),'before');await writeFile(join(cwd,'.env'),'SECRET');await writeFile(join(cwd,'node_modules','ignore.txt'),'ignore');
  const {job}=await f.request(`/api/rooms/${f.room.id}/messages`,{content:'Edite',target:'codex',mode:'code'});await f.done(job.id);
  const versions=await(await fetch(`${f.url}/api/rooms/${f.room.id}/versions`)).json();const before=versions.versions.find(v=>v.phase==='before');
  assert.deepEqual(before.files.map(f=>f.path),['file.txt']);assert.equal(before.partial,true);
  const boot=await(await fetch(f.url+'/api/bootstrap')).json();
  const response=await fetch(`${f.url}/api/rooms/${f.room.id}/version-file`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':boot.csrfToken},body:JSON.stringify({snapshotId:before.id,path:'file.txt'})});assert.equal(await response.text(),'before');
  assert.equal((await f.request(`/api/rooms/${f.room.id}/version-file`,{snapshotId:'../../bad',path:'file.txt'})).status,400);
});
test('restart expires pending permissions and retains progress, memory and sessions',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mesa-v03-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let store=new Store(join(dir,'store.sqlite'));const room=store.createRoom('Persistir'),job=store.createJob(room.id,'auto','code',8);
  store.updateJob(job.id,{status:'running',step:3,progress:{completed:2,phase:'execute'}});store.saveSession(room.id,'codex','code','native-id','workspace');store.checkpoint(room.id,job.id,'codex',{summary:'Estado'});store.createApproval(room.id,job.id,'codex',{title:'Aprovar'});store.close();
  store=new Store(join(dir,'store.sqlite'));store.recoverInterruptedJobs();assert.equal(store.getJob(job.id).progress.completed,2);assert.equal(store.getJob(job.id).status,'interrupted');assert.equal(store.approvals(room.id)[0].status,'expired');assert.equal(store.sessions(room.id)[0].sessionId,'native-id');assert.equal(store.checkpoints(room.id)[0].content.summary,'Estado');store.close();
});
