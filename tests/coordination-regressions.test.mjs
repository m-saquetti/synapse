// Regressions for review items 7, 8, 10 and 11 (Claude review, Mesa v0.3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,mkdir,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { normalizeSettings } from '../lib/settings.mjs';
import { AgentError } from '../lib/agents.mjs';
import { projectPrompt,readOnlyRequested,narrowSettings,capacityRestored,TOOL_ECONOMY } from '../lib/coordinator.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let n=0;n<300;n++){const value=await fn();if(value)return value;await wait(20);}throw new Error('Test timed out');}
const connected=(usage={})=>Object.fromEntries(['codex','claude','gemini'].map(p=>[p,{available:true,authenticated:true,usage:usage[p]??null}]));
const reply=(status='continue',summary='Estado')=>({text:`${summary}\n<mesa_status>${JSON.stringify({status,summary,next:[],decisions:[],tests:[]})}</mesa_status>`});
async function fixture(t,runAgent,getStatus=async()=>connected(),settings={access:'project',internet:true}) {
  const dataDir=await mkdtemp(join(tmpdir(),'mesa-v03-reg-'));
  const app=await createApp({dataDir,runAgent,getAgentStatus:getStatus}),url=await app.listen(0);
  const boot=await(await fetch(url+'/api/bootstrap')).json(),room=boot.rooms[0];
  const request=async(path,body={},method='POST')=>{const response=await fetch(url+path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':boot.csrfToken},body:JSON.stringify(body)});return {status:response.status,...await response.json()};};
  const done=id=>until(()=>{const job=app.store.getJob(id);return !['queued','running'].includes(job.status)&&job;});
  const patch=s=>request(`/api/rooms/${room.id}`,{settings:s},'PATCH');
  const start=async(content='Construa',target='auto')=>(await request(`/api/rooms/${room.id}/messages`,{content,target,mode:'code'})).job;
  await patch(settings);
  t.after(async()=>{await app.close();assert.ok(dataDir.startsWith(join(tmpdir(),'mesa-v03-reg-')));await rm(dataDir,{recursive:true,force:true});});
  return {app,room,request,done,patch,start,dataDir};
}

// ---- 7: Continue respects revocation and never widens grants ----
test('narrowSettings takes the stricter grant and the current folder',()=>{
  const granted=normalizeSettings({access:'project',internet:true,githubEnabled:true,workspace:''});
  const pasta=process.platform==='win32'?'C:\\novo':'/novo';
  const now=normalizeSettings({access:'computer',internet:false,githubEnabled:false,workspace:pasta,codexModel:'gpt-x'});
  const s=narrowSettings(granted,now);
  assert.equal(s.access,'project','computer access granted later is not applied implicitly');
  assert.equal(s.internet,false);assert.equal(s.githubEnabled,false);
  assert.equal(s.workspace,pasta);assert.equal(s.codexModel,'gpt-x','non-permission preferences follow the room');
  assert.equal(narrowSettings(normalizeSettings({internet:false}),normalizeSettings({internet:true})).internet,false,'re-enabling internet does not widen a task');
});
test('Continue applies revoked internet/tools and does not widen access or internet',async t=>{
  const calls=[];
  const f=await fixture(t,async args=>{calls.push(args);return reply(calls.length===1?'blocked':'complete');},undefined,{access:'project',internet:true,githubEnabled:true,browserEnabled:true});
  const job=await f.start();
  assert.equal((await f.done(job.id)).status,'paused_input');
  await f.patch({access:'computer',internet:false,githubEnabled:false});
  assert.equal((await f.request(`/api/jobs/${job.id}/resume`,{content:'Pode seguir.'})).status,202);
  await f.done(job.id);
  const s=calls[1].settings;
  assert.equal(s.internet,false);assert.equal(s.githubEnabled,false);assert.equal(s.access,'project');
  assert.equal(f.app.store.getJob(job.id).settings.internet,false,'narrowed settings are persisted on the job');
  assert.ok(f.app.store.events(f.room.id).some(e=>e.activity.title==='Permissões atualizadas na retomada'));
});
test('granting internet after the task started does not widen it on Continue',async t=>{
  const calls=[];
  const f=await fixture(t,async args=>{calls.push(args);return reply(calls.length===1?'blocked':'complete');},undefined,{access:'project',internet:false});
  const job=await f.start();assert.equal((await f.done(job.id)).status,'paused_input');
  await f.patch({internet:true});
  await f.request(`/api/jobs/${job.id}/resume`);await f.done(job.id);
  assert.equal(calls[0].settings.internet,false);assert.equal(calls[1].settings.internet,false);
});
test('Continue is blocked with a clear message when Code access was revoked',async t=>{
  let count=0;
  const f=await fixture(t,async()=>{count++;return reply('blocked');});
  const job=await f.start();assert.equal((await f.done(job.id)).status,'paused_input');
  await f.patch({access:'chat'});
  const response=await f.request(`/api/jobs/${job.id}/resume`);
  assert.equal(response.status,409);assert.match(response.error || response.message || JSON.stringify(response),/revogado/);
  const after=f.app.store.getJob(job.id);
  assert.equal(after.status,'paused_input');assert.match(after.error,/revogado/);assert.equal(count,1,'nothing ran after revocation');
});
test('Continue follows a folder change made in the room',async t=>{
  const cwds=[];
  const f=await fixture(t,async args=>{cwds.push(args.cwd);return reply(cwds.length===1?'blocked':'complete');});
  const job=await f.start();await f.done(job.id);
  const folder=join(f.dataDir,'nova-pasta');await mkdir(folder);
  await f.patch({workspace:folder});
  await f.request(`/api/jobs/${job.id}/resume`);await f.done(job.id);
  assert.equal(cwds[1],await realpath(folder));assert.notEqual(cwds[0],cwds[1]);
});

// ---- 8: blocked keeps phase and implementer ----
test('blocked during execution resumes the same execution stage',async t=>{
  const calls=[];
  const f=await fixture(t,async args=>{calls.push(args);return reply(calls.length===1?'blocked':calls.length===2?'continue':'complete');});
  const job=await f.start();
  const paused=await f.done(job.id);
  assert.equal(paused.status,'paused_input');assert.equal(paused.progress.phase,'execute');assert.equal(paused.progress.implementer,undefined);
  await f.request(`/api/jobs/${job.id}/resume`,{content:'Use a opção A.'});
  assert.equal((await f.done(job.id)).status,'completed');
  assert.match(calls[1].prompt,/Modo Code, execução/);assert.doesNotMatch(calls[1].prompt,/Modo Code, revisão independente/);
  assert.match(calls[1].prompt,/Use a opção A\./);
  assert.match(calls[2].prompt,/Modo Code, revisão independente/);assert.notEqual(calls[2].agent,calls[1].agent,'review stays independent of the real implementer');
});
test('blocked during review keeps the implementer and resumes the review',async t=>{
  const calls=[];
  const f=await fixture(t,async args=>{calls.push(args);return reply(calls.length===1?'continue':calls.length===2?'blocked':'complete');});
  const job=await f.start();
  const paused=await f.done(job.id);
  assert.equal(paused.status,'paused_input');assert.equal(paused.progress.phase,'review');assert.equal(paused.progress.implementer,calls[0].agent);
  await f.request(`/api/jobs/${job.id}/resume`,{content:'Resposta do usuário.'});
  assert.equal((await f.done(job.id)).status,'completed');
  // A revisão bloqueada é refeita pelo mesmo revisor; depois o próximo colega revisa e a rodada fecha.
  assert.equal(calls.length,4);assert.equal(calls[2].agent,calls[1].agent);assert.match(calls[2].prompt,/Modo Code, revisão independente/);assert.notEqual(calls[2].agent,calls[0].agent);assert.notEqual(calls[3].agent,calls[0].agent);
});

// ---- 10: explicit user restrictions prevail in coordination text ----
test('coordination text honors read-only requests and always states user precedence',()=>{
  const room={id:'r',title:'Sala',brief:'',settings:normalizeSettings({access:'project'}),workspacePath:'C:\\p'};
  const msg=content=>[{role:'user',content,status:'completed'}];
  const ro=projectPrompt({room,messages:msg('Faça uma REVISÃO TÉCNICA SOMENTE LEITURA. Não altere arquivos.'),agent:'claude',lane:'code',phase:'execute',step:1,totalSteps:8,checkpoints:[]});
  assert.match(ro,/revisão somente leitura pedida pelo usuário/);assert.doesNotMatch(ro,/Implemente a próxima parte/);
  assert.match(ro,/prevalecem sobre estas instruções de coordenação/);
  const normal=projectPrompt({room,messages:msg('Implemente o contador.'),agent:'codex',lane:'code',phase:'execute',step:1,totalSteps:8,checkpoints:[]});
  assert.match(normal,/Implemente a próxima parte útil do pedido, dentro das restrições dele/);assert.match(normal,/prevalecem/);
  // Economia de ferramentas: em Code (execução, revisão e somente leitura), nunca no Chat.
  assert.ok(normal.includes(TOOL_ECONOMY)&&ro.includes(TOOL_ECONOMY));
  assert.ok(projectPrompt({room,messages:msg('Revise.'),agent:'gemini',lane:'code',phase:'review',step:2,totalSteps:8,checkpoints:[]}).includes(TOOL_ECONOMY));
  assert.ok(!projectPrompt({room,messages:msg('Explique.'),agent:'gemini',lane:'chat',phase:'execute',step:1,totalSteps:8,checkpoints:[]}).includes(TOOL_ECONOMY));
  assert.equal(readOnlyRequested(msg('Não altere arquivos fora dela.')),false);
  assert.equal(readOnlyRequested(msg('Não altere outros arquivos; implemente o item 7.')),false);
  assert.equal(readOnlyRequested(msg('Revisão read-only, por favor')),true);
  assert.equal(readOnlyRequested([...msg('Somente leitura.'),{role:'claude',content:'ok',status:'completed'},...msg('Agora implemente.')]),false,'only the latest user request counts');
});

// ---- 11: rate limits need reset time AND confirmed capacity; auth failures never loop ----
test('capacityRestored requires a passed reset and fresh known capacity',()=>{
  const now=Date.parse('2026-11-16T12:00:00Z'),past='2026-11-16T11:00:00Z',future='2026-11-16T13:00:00Z';
  const s=(usedPercent,extra={})=>({available:true,authenticated:true,usage:usedPercent===null?null:{windows:[{usedPercent}],observedAt:'2026-11-16T11:30:00Z',...extra}});
  assert.equal(capacityRestored({resetAt:future},s(10),undefined,now),false,'reset still in the future');
  assert.equal(capacityRestored({resetAt:null},s(10),undefined,now),false,'unknown reset');
  assert.equal(capacityRestored({resetAt:past},s(null),undefined,now),false,'clock alone, quota unknown');
  assert.equal(capacityRestored({resetAt:past},s(100),undefined,now),false,'still exhausted');
  assert.equal(capacityRestored({resetAt:past},s(10,{stale:true}),undefined,now),false,'stale telemetry');
  assert.equal(capacityRestored({resetAt:past},s(10,{observedAt:'2026-11-16T10:00:00Z'}),undefined,now),false,'observed before reset');
  assert.equal(capacityRestored({resetAt:past},s(10,{observedAt:undefined}),undefined,now),false,'no measurement time');
  assert.equal(capacityRestored({resetAt:past},{...s(10),authenticated:false},undefined,now),false);
  assert.equal(capacityRestored({resetAt:past},s(10),undefined,now),true);
});
test('a rate-limited agent stays out after its reset time when capacity is not confirmed',async t=>{
  const calls=[];
  const f=await fixture(t,async args=>{calls.push(args.agent);if(args.agent==='claude')throw Object.assign(new AgentError('Limite','RATE_LIMIT'),{resetAt:new Date(Date.now()-1000).toISOString()});return reply('continue');});
  await f.patch({maxSteps:4});
  const job=await f.start();
  const end=await f.done(job.id);
  assert.equal(end.status,'paused_budget');
  assert.deepEqual(calls,['claude','codex','gemini','codex','gemini']);
  assert.ok(end.progress.limits.claude,'limit is durable in job progress');
});
test('a rate-limited agent returns after reset once telemetry confirms capacity',async t=>{
  const calls=[];let limited=false;const resetAt=new Date(Date.now()+300).toISOString();
  const status=async()=>connected({claude:{windows:[{usedPercent:10}],observedAt:new Date().toISOString()}});
  const f=await fixture(t,async args=>{
    calls.push(args.agent);
    if(args.agent==='claude' && !limited){limited=true;throw Object.assign(new AgentError('Limite','RATE_LIMIT'),{resetAt});}
    if(args.agent==='codex')await wait(500);
    return reply('continue');
  },status);
  await f.patch({maxSteps:2});
  const job=await f.start();
  assert.equal((await f.done(job.id)).status,'paused_budget');
  assert.deepEqual(calls,['claude','codex','claude']);
  assert.ok(f.app.store.events(f.room.id).some(e=>e.activity.title==='Claude disponível novamente'));
});
test('auth failures are not retried in a loop; automatic resume keeps them, manual Continue retries',async t=>{
  const calls=[];
  const f=await fixture(t,async args=>{calls.push(args.agent);throw new AgentError('Entre novamente','AUTH_REQUIRED');});
  const job=await f.start();
  const waiting=await f.done(job.id);
  assert.equal(waiting.status,'waiting_capacity');assert.equal(calls.length,3,'each agent tried once, then stop without capacity');
  f.app.orchestrator.resume(job.id,{automatic:true});
  assert.equal((await f.done(job.id)).status,'waiting_capacity');assert.equal(calls.length,3,'automatic resume does not retry broken logins');
  await f.request(`/api/jobs/${job.id}/resume`);
  assert.equal((await f.done(job.id)).status,'waiting_capacity');assert.equal(calls.length,6,'manual Continue retries once per agent');
});
test('single auth failure excludes only that agent for the rest of the task',async t=>{
  const calls=[];
  const f=await fixture(t,async args=>{calls.push(args.agent);if(args.agent==='claude')throw new AgentError('Entre novamente','AUTH_REQUIRED');return reply('continue');});
  await f.patch({maxSteps:4});
  const job=await f.start();
  assert.equal((await f.done(job.id)).status,'paused_budget');
  assert.equal(calls.filter(a=>a==='claude').length,1);
});

test('a truncated response is saved as partial memory and is never reported complete',async t=>{
  const f=await fixture(t,async args=>{args.onDelta('A primeira parte foi escrita.');throw new AgentError('Output truncated','INCOMPLETE');});
  const job=await f.start('Construa','gemini');
  assert.equal((await f.done(job.id)).status,'failed');
  const partial=f.app.store.messages(f.room.id).find(m=>m.role==='gemini');
  assert.equal(partial.status,'interrupted');assert.equal(partial.content,'A primeira parte foi escrita.');
  assert.match(f.app.store.checkpoints(f.room.id)[0].content.summary,/Resposta parcial interrompida/);
});
