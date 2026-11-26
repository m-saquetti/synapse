import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { googleModels,googleTools,configureGoogleSession } from '../lib/google-client.mjs';
import { Providers } from '../lib/providers.mjs';
import { Approvals } from '../lib/approvals.mjs';
import { createToolGateway } from '../lib/tool-gateway.mjs';

const session={configOptions:[{id:'model',category:'model',currentValue:'gemini-flash',options:[{name:'Google',options:[{value:'gemini-flash',name:'Flash'}]},{value:'claude-legacy',name:'Claude'}]}],modes:{availableModes:[{id:'default'}]}};
test('Google catalog exposes only Google models and confirms grouped model selection',async()=>{
  assert.deepEqual(googleModels(session),[{id:'gemini-flash',label:'Flash'}]);
  const calls=[],rpc={call:async(method,p)=>{calls.push({method,p});return {configOptions:[{id:'model',currentValue:p.value}]};}};
  assert.equal(await configureGoogleSession(rpc,session,'s',{geminiModel:'gemini-flash'}),'gemini-flash');
  assert.equal(calls[0].method,'session/set_config_option');assert.equal(calls[1].p.modeId,'default');
  await assert.rejects(configureGoogleSession(rpc,session,'s',{geminiModel:'gemini-hydrogen-unavailable'}),{code:'MODEL_UNAVAILABLE'});
  await assert.rejects(configureGoogleSession({call:async()=>({configOptions:[]})},session,'s',{geminiModel:'gemini-flash'}),{code:'MODEL_UNAVAILABLE'});
});
test('Google Chat has no file or shell tools; web tools follow the room setting',()=>{
  assert.deepEqual(googleTools({access:'chat',internet:false}),[]);
  assert.deepEqual(googleTools({access:'chat',internet:true}),['search_web']);
  assert.ok(googleTools({access:'project',internet:false}).includes('run_command'));
  assert.ok(!googleTools({access:'project',internet:false}).includes('search_web'));
});
test('missing native session retries once with preserved prompt; ordinary failures never retry',async()=>{
  const p=new Providers({dataDir:tmpdir(),store:{}}),calls=[],activities=[];
  p.runGemini=async args=>{calls.push(args);if(args.sessionId)throw new Error('Session not found');return {text:'recovered'};};
  const args={agent:'gemini',sessionId:'old',prompt:'Preserved context',onActivity:a=>activities.push(a)};
  assert.equal((await p.run(args)).text,'recovered');assert.equal(calls.length,2);
  assert.equal(calls[1].sessionId,undefined);assert.equal(calls[1].prompt,args.prompt);assert.equal(activities.length,1);
  let attempts=0;p.runGemini=async()=>{attempts++;throw new Error('Network unavailable');};
  await assert.rejects(p.run(args));assert.equal(attempts,1);
  attempts=0;p.runGemini=async()=>{attempts++;throw new Error('Session not found');};
  await assert.rejects(p.run(args));assert.equal(attempts,2);
});
test('permission review preserves the command tail and rejects oversized requests before persistence',async()=>{
  const rows=[],a=new Approvals({createApproval:(_r,_j,_a,request)=>{rows.push(request);return {id:'a'};},resolveApproval:()=>{}},()=>{});
  const detail='x'.repeat(2000)+' IMPORTANT_COMMAND_TAIL';
  const pending=a.request({roomId:'r',jobId:'j',agent:'gemini',request:{detail}});
  assert.ok(rows[0].detail.endsWith('IMPORTANT_COMMAND_TAIL'));a.answer('a',{decision:'deny'});await pending;
  assert.equal((await a.request({request:{detail:'x'.repeat(48001)}})).decision,'deny');assert.equal(rows.length,1);
});
async function gatewayFixture(t,approval) {
  const dir=await mkdtemp(join(tmpdir(),'mesa-gateway-test-')),marker=join(dir,'calls.txt');
  const gateway=await createToolGateway([{id:'test',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/gateway-server.mjs',import.meta.url)),marker]}],approval);
  t.after(async()=>{gateway.close();assert.ok(dir.startsWith(join(tmpdir(),'mesa-gateway-test-')));await rm(dir,{recursive:true,force:true});});
  const call=(body,headers={})=>fetch(gateway.environment.MESA_TOOL_GATEWAY_URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+gateway.environment.MESA_TOOL_GATEWAY_TOKEN,...headers},body:JSON.stringify(body)});
  return {gateway,marker,call};
}
test('shared tool gateway refuses bad authorization, browser origins and disabled integrations',async t=>{
  let approvals=0;const {call}=await gatewayFixture(t,async()=>{approvals++;return {decision:'allow'};});
  for(const headers of [{Authorization:'Bearer bad'},{Origin:'http://127.0.0.1:4317'}])assert.equal((await call({integration:'test',method:'tools/call'},headers)).status,403);
  assert.equal((await call({integration:'disabled',method:'tools/call'})).status,400);assert.equal(approvals,0);
});
test('a denied shared tool is never forwarded to its process',async t=>{
  const {call,marker}=await gatewayFixture(t,async()=>({decision:'deny'}));
  const r=await call({integration:'test',method:'tools/call',params:{name:'write',arguments:{value:1}}});
  assert.equal((await r.json()).isError,true);await assert.rejects(readFile(marker),{code:'ENOENT'});
});
test('the shared tool waits for approval and forwards the exact reviewed arguments',async t=>{
  let release,seen;const approved=new Promise(r=>release=r),{call,marker}=await gatewayFixture(t,request=>{seen=request;return approved;});
  const pending=call({integration:'test',method:'tools/call',params:{name:'echo',arguments:{value:'quoted "text"'}}});
  for(let i=0;i<100&&!seen;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(JSON.parse(seen.detail).value,'quoted "text"');await assert.rejects(readFile(marker),{code:'ENOENT'});
  release({decision:'allow'});assert.equal((await (await pending).json()).content[0].text,'quoted "text"');
  assert.equal(JSON.parse(await readFile(marker,'utf8')).arguments.value,'quoted "text"');
});
test('command bridge preserves UTF-8 JSON through base64 without shell quoting',async t=>{
  const {gateway}=await gatewayFixture(t,async()=>({decision:'allow'}));
  const input={value:'Olá "Mesa" — ação'};
  const {stdout}=await promisify(execFile)(process.execPath,[gateway.command,'test','echo','--json-base64',Buffer.from(JSON.stringify(input)).toString('base64')],{env:{...process.env,...gateway.environment},windowsHide:true});
  assert.equal(JSON.parse(stdout).content[0].text,input.value);
});

// ---- Claude: a pesquisa web não fica pré-aprovada no SDK; a Mesa decide em cada chamada ----
test('Claude web tools are decided by Mesa: search allowed with internet, page reads ask, nothing pre-approved',async()=>{
  const {claudeAccess,claudeToolPolicy}=await import('../lib/providers.mjs');
  const chat=claudeAccess({access:'chat',internet:false});
  assert.deepEqual(chat.tools,[]);assert.deepEqual(chat.allowedTools,[]);assert.equal(chat.permissionMode,'default');
  const chatWeb=claudeAccess({access:'chat',internet:true});
  assert.deepEqual(chatWeb.tools,['WebSearch','WebFetch']);assert.deepEqual(chatWeb.allowedTools,[],'bare allowedTools would bypass canUseTool');
  assert.notEqual(chatWeb.permissionMode,'dontAsk','dontAsk would refuse every tool that is not pre-approved');
  assert.equal(claudeAccess({access:'project',internet:true}).permissionMode,'acceptEdits');
  assert.equal(claudeToolPolicy('WebSearch',{internet:true}),'allow');
  assert.equal(claudeToolPolicy('WebFetch',{internet:true}),'ask');
  assert.equal(claudeToolPolicy('WebSearch',{internet:false}),'deny');
  assert.equal(claudeToolPolicy('WebFetch',{internet:false}),'deny');
  assert.equal(claudeToolPolicy('Bash',{access:'chat'}),'deny');
  assert.equal(claudeToolPolicy('Bash',{access:'project'}),'ask');
});

// ---- Gemini: o catálogo não abre uma sessão do Antigravity a cada etapa ----
test('Gemini catalog is reused between steps, refreshed on demand and after it expires',async()=>{
  const {GEMINI_CATALOG_TTL}=await import('../lib/providers.mjs');
  const p=new Providers({dataDir:tmpdir(),store:{}});let probes=0;
  p.probeGemini=async()=>{probes++;return [{id:'gemini-3.8-flash',label:'Flash'}];};
  const first=await p.geminiCatalog();assert.equal(first.cached,false);assert.equal(probes,1);
  const second=await p.geminiCatalog();assert.equal(second.cached,true);assert.equal(probes,1,'a coordination step must not open a new Google session');
  await p.geminiCatalog(true);assert.equal(probes,2,'Atualizar uso asks for a fresh catalog');
  p.geminiCache.at=Date.now()-GEMINI_CATALOG_TTL-1;
  await p.geminiCatalog();assert.equal(probes,3,'an expired catalog is read again');
  p.probeGemini=async()=>{throw new Error('offline');};
  p.geminiCache.at=Date.now()-GEMINI_CATALOG_TTL-1;
  await assert.rejects(p.geminiCatalog(),/offline/,'a failed probe surfaces instead of serving an expired catalog as current');
});
