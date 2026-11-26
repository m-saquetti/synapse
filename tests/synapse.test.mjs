import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { readEvents, runStudio, studioError } from '../lib/ai-studio.mjs';
import { safeDiagnostic, subscriptionEnvironment } from '../lib/agents.mjs';
import { Providers } from '../lib/providers.mjs';

async function fixture(t,runAgent,status) {
  const dataDir=await mkdtemp(join(tmpdir(),'synapse-test-'));
  const app=await createApp({dataDir,runAgent,getAgentStatus:async()=>status});
  const url=await app.listen(0);
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const room=app.store.listRooms()[0];
  const job=app.orchestrator.enqueue(room.id,'Desenhe uma fila de tarefas.','auto','chat').job;
  return {app,job,room,url};
}
const connected=Object.fromEntries(['codex','claude','gemini'].map(id=>[id,{available:true,authenticated:true}]));
async function eventually(fn){
  for(let i=0;i<250;i++){if(fn())return;await new Promise(r=>setTimeout(r,15));}
  assert.fail('Expected condition timed out');
}
test('group round: GPT opens Chat, colleagues answer one at a time and the lead closes with mid-round guidance',async t=>{
  const gate=Promise.withResolvers(),claudeStarted=Promise.withResolvers(),calls=[];
  let running=0,maxRunning=0;
  const {app,job,room,url}=await fixture(t,async args=>{
    running++;maxRunning=Math.max(maxRunning,running);calls.push(args);
    try {
      if(args.agent==='claude' && calls.length===2){claudeStarted.resolve();await gate.promise;}
      return {text:'Contribution '+args.agent+' '+calls.length};
    } finally {running--;}
  },connected);
  await claudeStarted.promise;
  const {csrfToken}=await (await fetch(url+'/api/bootstrap')).json();
  const routed=await fetch(url+'/api/jobs/'+job.id+'/steer',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({content:'Inclua prazo no resumo.'})});
  assert.equal(routed.status,201);
  gate.resolve();
  await eventually(()=>app.store.getJob(job.id).status==='completed');
  assert.equal(maxRunning,1,'ninguém fala por cima de ninguém');
  assert.deepEqual(calls.map(c=>c.agent),['codex','claude','gemini','codex']);
  assert.match(calls[1].prompt,/Contribution codex 1/);
  assert.match(calls[2].prompt,/Contribution codex 1/);assert.match(calls[2].prompt,/Contribution claude 2/);assert.match(calls[2].prompt,/Inclua prazo/);
  assert.match(calls[3].prompt,/Síntese/);assert.match(calls[3].prompt,/Contribution gemini 3/);
  const rows=app.store.messages(room.id).filter(m=>m.debate);
  assert.deepEqual(rows.map(m=>m.debate.stage),['abertura','analise','analise','sintese']);
  assert.deepEqual(rows.map(m=>m.debate.parentRole),[null,'codex','claude','gemini']);
  assert.equal(new Set(rows.map(m=>m.debate.turnId)).size,4);
});
test('Code mode puts Claude in the lead and the round only ends after the reviewers approve',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'synapse-test-'));
  const calls=[];
  const app=await createApp({dataDir,runAgent:async args=>{calls.push(args.agent);return {text:'ok\n<mesa_status>{"status":"complete","summary":"ok"}</mesa_status>'};},getAgentStatus:async()=>connected});
  await app.listen(0);
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const room=app.store.listRooms()[0];
  app.store.updateRoom(room.id,{settings:{access:'project'}});
  const job=app.orchestrator.enqueue(room.id,'Implemente um contador.','auto','code').job;
  await eventually(()=>app.store.getJob(job.id).status==='completed');
  assert.deepEqual(calls,['claude','codex','gemini']);
  assert.deepEqual(app.store.messages(room.id).filter(m=>m.debate).map(m=>m.debate.stage),['implementacao','revisao','revisao']);
});
test('a free Claude account and unavailable Codex leave a single useful Google contribution',async t=>{
  const calls=[];
  const {app,job}=await fixture(t,async a=>{calls.push(a.agent);return {text:'Proposta única'};},
    {...connected,codex:{available:false},claude:{available:true,authenticated:false,blocked:true}});
  await eventually(()=>app.store.getJob(job.id).status==='completed');
  assert.deepEqual(calls,['gemini']);
});
test('Studio handles fragmented UTF-8 SSE and ignores private thought parts',async t=>{
  const payload='data: '+JSON.stringify({candidates:[{content:{parts:[{thought:true,text:'internal'},{text:'Olá'}]},finishReason:'STOP'}]})+'\r\n\r\n';
  const encoded=new TextEncoder().encode(payload);
  const events=[];for await(const e of readEvents([encoded.slice(0,-17),encoded.slice(-17)]))events.push(e);
  assert.equal(events.length,1);
  t.mock.method(globalThis,'fetch',async (_url,init)=>{assert.equal(init.headers['x-goog-api-key'],'mock');return new Response(encoded);});
  const deltas=[];const r=await runStudio('gemini-4-hydrogen','mock',{settings:{access:'chat'},prompt:'hi',onDelta:text=>deltas.push(text)});
  assert.equal(r.text,'Olá');assert.deepEqual(deltas,['Olá']);
});
test('AI Studio writes only after approval and echoes the original function-call signature',async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'synapse-tool-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const call={functionCall:{id:'abc',name:'write_file',args:{path:'hello.txt',content:'hello'}},thoughtSignature:'signature'};
  let count=0;
  t.mock.method(globalThis,'fetch',async (_url,init)=>{
    const body=JSON.parse(init.body);
    if(count++%2===1)assert.deepEqual(body.contents[1].parts,[call]);
    return new Response('data: '+JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:count%2?[call]:[{text:'done'}]}}]})+'\n\n');
  });
  const args={cwd,prompt:'write',settings:{access:'project',internet:false,reaEnabled:false},signal:new AbortController().signal};
  await runStudio('gemini-4-hydrogen','mock',{...args,requestApproval:async()=>({decision:'deny'})});
  await assert.rejects(readFile(join(cwd,'hello.txt')),{code:'ENOENT'});
  await runStudio('gemini-4-hydrogen','mock',{...args,requestApproval:async()=>({decision:'allow'})});
  assert.equal(await readFile(join(cwd,'hello.txt'),'utf8'),'hello');
});
test('429 cooldown survives provider restarts; auto hands off once and explicit selection respects the timer',async t=>{
  const rows=new Map(),store={providerState:id=>rows.get(id)||{},saveProviderState:(id,v)=>rows.set(id,v)};
  const provider=()=>{const p=new Providers({dataDir:tmpdir(),store});p.studioAccess=async()=>'mock';p.geminiCatalog=async()=>({models:[{id:'flash'}]});p.runNativeGemini=async()=>({text:'native'});return p;};
  let requests=0;
  t.mock.method(globalThis,'fetch',async()=>{requests++;return Response.json({error:{details:[{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'45s'}]}},{status:429});});
  const args={prompt:'hi',settings:{geminiModel:'auto',access:'chat'}};
  assert.equal((await provider().runGemini(args)).text,'native');
  assert.equal((await provider().runGemini(args)).text,'native');
  const avisos=[];
  assert.equal((await provider().runGemini({...args,onActivity:a=>avisos.push(a),settings:{...args.settings,geminiModel:'api:gemini-4-hydrogen'}})).text,'native');
  assert.equal(avisos[0].status,'warning');assert.match(avisos[0].title,/gemini-4-hydrogen em pausa, alternando para Antigravity/);
  const semNative=provider();semNative.geminiCatalog=async()=>({models:[]});
  await assert.rejects(semNative.runGemini({...args,settings:{...args.settings,geminiModel:'api:gemini-4-hydrogen'}}), {code:'RATE_LIMIT'});
  assert.equal(requests,1);assert.ok(Date.parse(rows.get('studio').models['api:gemini-4-hydrogen'].until)>Date.now()+40000);
  const error=await studioError(Response.json({}, {status:503,headers:{'retry-after':'7'}}));
  assert.equal(error.code,'UNAVAILABLE');assert.ok(Date.parse(error.resetAt)>Date.now()+6000);
});
test('Google credentials are redacted, excluded from child processes, and paid model generation is rejected locally',async()=>{
  const dummy='AQ.'+'x'.repeat(39);
  assert.ok(!safeDiagnostic('credential '+dummy).includes(dummy));
  await assert.rejects(runStudio('gemini-4-hydrogen',undefined,{}),{code:'AUTH_REQUIRED'});
  assert.deepEqual(subscriptionEnvironment({SYNAPSE_GEMINI_API_KEY:dummy,PATH:'test'}),{PATH:'test',NO_COLOR:'1',FORCE_COLOR:'0'});
  await assert.rejects(runStudio('gemini-4-carbon','mock',{}),{code:'MODEL_UNAVAILABLE'});
});


test('a billing rejection overrides stale Pro metadata and pauses Claude without using an API key',async()=>{
  const state=new Map(),store={providerState:id=>state.get(id)||{},saveProviderState:(id,v)=>state.set(id,v)};
  const p=new Providers({dataDir:tmpdir(),store});
  p.runClaude=async()=>{throw new Error("Claude Code can't use your Claude subscription, usually because a payment is past due");};
  await assert.rejects(p.run({agent:'claude'}),{code:'SUBSCRIPTION_REQUIRED'});
  assert.ok(store.providerState('claude').planDenial);
});
