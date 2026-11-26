// Synapse 1.5: economia de requisições e falas.
// Caso real de 23/11, 20:56: o Gemini trocou do Antigravity (sem cota) para o Hydrogen, leu 10 arquivos e,
// depois da última leitura, a requisição seguinte ficou 120 s sem resposta. A fala inteira se perdeu.
process.env.SYNAPSE_STUDIO_FIRST_EVENT_MS = '150';
process.env.SYNAPSE_STUDIO_FOLLOW_EVENT_MS = '150';
process.env.SYNAPSE_STUDIO_IDLE_MS = '150';
process.env.SYNAPSE_STUDIO_RETRY_MS = '10,10';
process.env.SYNAPSE_STUDIO_LIMIT_PAD_MS = '0';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runStudio, readSlice } = await import('../lib/ai-studio.mjs');
const { startRound, planNext, recordTurn } = await import('../lib/rounds.mjs');
const { Versions } = await import('../lib/versions.mjs');
const { normalizeSettings, DEFAULT_SETTINGS } = await import('../lib/settings.mjs');

const sse = (events, { signal, hang = false } = {}) => new Response(new ReadableStream({
  start(controller) {
    signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    if (hang) return;
    for (const event of events) controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'));
    controller.close();
  },
}), { headers: { 'content-type': 'text/event-stream' } });
const call = (name, args) => ({ candidates: [{ content: { parts: [{ functionCall: { name, args } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100 } });
const answer = { candidates: [{ content: { parts: [{ text: 'Revisão concluída.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 5 } };

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'synapse-15-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'a.txt'), 'linha\n'.repeat(10));
  return dir;
}
const projectArgs = (cwd, extra = {}) => ({ prompt: 'revise', cwd, signal: new AbortController().signal,
  requestApproval: async () => ({ decision: 'allow' }), ...extra, settings: { access: 'project', internet: false, ...(extra.settings || {}) } });

test('read_file devolve arquivos longos em partes, com a próxima linha para continuar', () => {
  const text = Array.from({ length: 100 }, (_, i) => 'linha ' + (i + 1)).join('\n');
  assert.deepEqual(readSlice('curto\n'), { content: 'curto\n' });
  const first = readSlice(text, {}, 200);
  assert.equal(first.truncated, true);
  assert.ok(first.content.length <= 200);
  assert.match(first.lines, /^1-\d+ de 100$/);
  const next = readSlice(text, { startLine: first.nextStartLine }, 200);
  assert.ok(next.content.startsWith('linha ' + first.nextStartLine + '\n'));
  const range = readSlice(text, { startLine: 10, endLine: 12 });
  assert.deepEqual(range, { content: 'linha 10\nlinha 11\nlinha 12\n', lines: '10-12 de 100' });
});

test('teto de requisições: a última rodada desliga as ferramentas e a fala termina com resposta', async (t) => {
  const cwd = await workspace(t);
  const bodies = [], activities = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    return sse([body.toolConfig ? answer : call('read_file', { path: 'a.txt' })], { signal: init.signal });
  });
  const result = await runStudio('gemini-4-hydrogen', 'k', projectArgs(cwd, { settings: { studioToolRounds: 3 }, onActivity: (a) => activities.push(a) }));
  assert.equal(result.text, 'Revisão concluída.');
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].toolConfig, undefined);
  assert.deepEqual(bodies[2].toolConfig, { functionCallingConfig: { mode: 'NONE' } });
  assert.equal(result.usage.requests, 3);
  assert.ok(activities.some((a) => /última rodada/.test(a.title)));
});

test('silêncio depois de ferramentas: repete só a requisição, uma vez, sem refazer a leitura', async (t) => {
  const cwd = await workspace(t);
  let requests = 0, approvals = 0;
  const activities = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests++;
    if (requests === 1) return sse([call('read_file', { path: 'a.txt' })], { signal: init.signal });
    if (requests === 2) return sse([], { signal: init.signal, hang: true });
    return sse([answer], { signal: init.signal });
  });
  const result = await runStudio('gemini-4-hydrogen', 'k', projectArgs(cwd, { requestApproval: async () => { approvals++; return { decision: 'allow' }; }, onActivity: (a) => activities.push(a) }));
  assert.equal(result.text, 'Revisão concluída.');
  assert.equal(requests, 3);
  assert.equal(approvals, 1);
  assert.ok(activities.some((a) => /sem resposta, nova tentativa/.test(a.title)));
});

test('silêncio na primeira requisição não é repetido aqui: a troca de rota continua com o coordenador', async (t) => {
  const cwd = await workspace(t);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => { requests++; return sse([], { signal: init.signal, hang: true }); });
  await assert.rejects(runStudio('gemini-4-hydrogen', 'k', projectArgs(cwd)), (error) => error.code === 'UNAVAILABLE' && error.silent === true && !error.toolExecuted);
  assert.equal(requests, 1);
});

test('revisão que só mexe em documentação conta como aprovação, sem nova verificação', () => {
  const round = startRound('code', ['claude', 'codex', 'gemini']);
  recordTurn(round, { agent: 'claude', stage: 'implementacao', control: { status: 'continue' }, changed: true, step: 1 });
  recordTurn(round, { agent: 'gemini', stage: 'revisao', control: { status: 'complete' }, changed: false, step: 2 });
  recordTurn(round, { agent: 'codex', stage: 'revisao', control: { status: 'complete' }, changed: true, docsOnly: true, step: 3 });
  assert.equal(round.lastChange.agent, 'claude');
  assert.deepEqual(planNext(round, ['claude', 'codex', 'gemini']), { done: true });
  // Sem docsOnly, a mesma sequência exige uma fala de verificação da mudança do GPT.
  const old = startRound('code', ['claude', 'codex', 'gemini']);
  recordTurn(old, { agent: 'claude', stage: 'implementacao', control: {}, changed: true, step: 1 });
  recordTurn(old, { agent: 'gemini', stage: 'revisao', control: { status: 'complete' }, changed: false, step: 2 });
  recordTurn(old, { agent: 'codex', stage: 'revisao', control: { status: 'complete' }, changed: true, step: 3 });
  assert.equal(planNext(old, ['claude', 'codex', 'gemini']).stage, 'verificacao');
});

test('refino sem mudança de código, feito por quem não escreveu a última alteração, encerra a rodada', () => {
  const round = startRound('code', ['claude', 'codex', 'gemini']);
  recordTurn(round, { agent: 'claude', stage: 'implementacao', control: {}, changed: true, step: 1 });
  recordTurn(round, { agent: 'codex', stage: 'revisao', control: { status: 'continue' }, changed: true, step: 2 });
  recordTurn(round, { agent: 'gemini', stage: 'revisao', control: { status: 'complete' }, changed: false, step: 3 });
  assert.equal(planNext(round, ['claude', 'codex', 'gemini']).stage, 'refino');
  recordTurn(round, { agent: 'claude', stage: 'refino', control: { status: 'complete' }, changed: true, docsOnly: true, step: 4 });
  assert.deepEqual(planNext(round, ['claude', 'codex', 'gemini']), { done: true });
  // Autor da última alteração recusando as críticas sem mudar nada: a revisão independente continua.
  const own = startRound('code', ['claude', 'codex', 'gemini']);
  recordTurn(own, { agent: 'claude', stage: 'implementacao', control: {}, changed: true, step: 1 });
  recordTurn(own, { agent: 'codex', stage: 'revisao', control: { status: 'continue' }, changed: false, step: 2 });
  recordTurn(own, { agent: 'gemini', stage: 'revisao', control: { status: 'continue' }, changed: false, step: 3 });
  recordTurn(own, { agent: 'claude', stage: 'refino', control: { status: 'complete' }, changed: false, step: 4 });
  assert.equal(planNext(own, ['claude', 'codex', 'gemini']).stage, 'revisao');
});

test('Versions.docsOnly: textos e número de versão sim; código ou dependência não', async (t) => {
  const data = await mkdtemp(join(tmpdir(), 'synapse-15-dados-'));
  const dir = await mkdtemp(join(tmpdir(), 'synapse-15-ws-'));
  t.after(() => Promise.all([rm(data, { recursive: true, force: true }), rm(dir, { recursive: true, force: true })]));
  const versions = new Versions(data);
  const pkg = (version, extra = {}) => JSON.stringify({ name: 'x', version, dependencies: { a: '1' }, ...extra }, null, 2);
  await writeFile(join(dir, 'app.mjs'), 'export const a = 1;\n');
  await writeFile(join(dir, 'README.md'), '# x\n');
  await writeFile(join(dir, 'package.json'), pkg('1.4.1'));
  const s0 = await versions.capture('sala', dir);
  await writeFile(join(dir, 'README.md'), '# x\nnovo\n');
  await writeFile(join(dir, 'package.json'), pkg('1.5.0'));
  const s1 = await versions.capture('sala', dir);
  assert.equal(await versions.docsOnly('sala', s0, s1), true);
  await writeFile(join(dir, 'package.json'), pkg('1.5.0', { dependencies: { a: '2' } }));
  const s2 = await versions.capture('sala', dir);
  assert.equal(await versions.docsOnly('sala', s1, s2), false);
  await writeFile(join(dir, 'app.mjs'), 'export const a = 2;\n');
  const s3 = await versions.capture('sala', dir);
  assert.equal(await versions.docsOnly('sala', s2, s3), false);
  assert.equal(await versions.docsOnly('sala', s3, s3), false);
});

test('studioToolRounds: padrão 6, de 2 a 20', () => {
  assert.equal(DEFAULT_SETTINGS.studioToolRounds, 6);
  assert.equal(normalizeSettings({ studioToolRounds: 10 }).studioToolRounds, 10);
  assert.throws(() => normalizeSettings({ studioToolRounds: 1 }), /2 a 20/);
  assert.throws(() => normalizeSettings({ studioToolRounds: 21 }), /2 a 20/);
});

test('uma linha longa permite retomar da coluna seguinte sem perder texto', () => {
  const text='abcdefghijklmnop\nsegunda';
  let joined='',page=readSlice(text,{},6);
  while(page.truncated){
    joined+=page.content;
    page=readSlice(text,{startLine:page.nextStartLine,startColumn:page.nextStartColumn},6);
  }
  assert.equal(joined+page.content,text);
});

test('uma retentativa HTTP conta no uso mas não tira rodada do Gemini; a última rodada fecha sem funções', async t=>{
  const cwd=await workspace(t),bodies=[];
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    const body=JSON.parse(init.body);bodies.push(body);
    if(bodies.length===1)return Response.json({}, {status:503});
    return sse([body.toolConfig?answer:call('read_file',{path:'a.txt'})],{signal:init.signal});
  });
  const r=await runStudio('gemini-4-hydrogen','k',projectArgs(cwd,{settings:{studioToolRounds:3}}));
  assert.equal(r.usage.requests,4);assert.equal(bodies.length,4);
  assert.equal(bodies[2].toolConfig,undefined);assert.equal(bodies[3].toolConfig.functionCallingConfig.mode,'NONE');
});

test('caso real de 25/11: 3 rodadas, 503 na primeira e silêncio na última; a fala termina com a resposta', async t=>{
  const cwd=await workspace(t),bodies=[];
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    const body=JSON.parse(init.body);bodies.push(body);
    if(bodies.length===1)return Response.json({}, {status:503});
    if(bodies.length===4)return sse([],{signal:init.signal,hang:true}); // última rodada: nada chega
    return sse([body.toolConfig?answer:call('read_file',{path:'a.txt'})],{signal:init.signal});
  });
  const activities=[];
  const r=await runStudio('gemini-3.8-flash','k',projectArgs(cwd,{settings:{studioToolRounds:3},onActivity:a=>activities.push(a)}));
  assert.equal(r.text,'Revisão concluída.');assert.equal(r.usage.requests,5);
  assert.equal(bodies[4].toolConfig.functionCallingConfig.mode,'NONE');
  assert.ok(activities.some(a=>a.title==='Gemini · AI Studio sem resposta, nova tentativa'));
});

test('a reserva de recuperação tem limite: falhas seguidas não passam de rodadas + 2 requisições', async t=>{
  const cwd=await workspace(t);let calls=0;
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    if(++calls===1)return sse([call('read_file',{path:'a.txt'})],{signal:init.signal});
    return Response.json({}, {status:503});
  });
  await assert.rejects(runStudio('gemini-3.8-flash','k',projectArgs(cwd,{settings:{studioToolRounds:2}})),/503|requisições/);
  assert.ok(calls<=4,'2 rodadas + 2 de recuperação; chamadas: '+calls);
});

test('silêncio depois do primeiro trecho mantém texto e uso conhecidos sem repetir', async t=>{
  const cwd=await workspace(t);let calls=0,delta='';
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    if(++calls===1)return sse([call('read_file',{path:'a.txt'})],{signal:init.signal});
    return new Response(new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(answer)+'\n\n'));
      init.signal.addEventListener('abort',()=>controller.error(init.signal.reason),{once:true});
    }}));
  });
  const args=projectArgs(cwd,{onDelta:s=>{delta+=s;}});
  await assert.rejects(runStudio('gemini-4-hydrogen','k',args),e=>e.usage?.promptTokenCount===300 && e.usage.requests===2 && e.toolExecuted && e.partialText==='Revisão concluída.');
  assert.equal(calls,2);assert.equal(delta,'Revisão concluída.');
});

test('lockfile só dispensa verificação para versão da raiz; ativos de produto exigem revisão',async t=>{
  const dir=await workspace(t),data=await mkdtemp(join(tmpdir(),'synapse-lock-review-'));
  t.after(()=>rm(data,{recursive:true,force:true}));
  const versions=new Versions(data);
  const capture=()=>versions.capture('sala',dir);
  const lock=(version,dep)=>writeFile(join(dir,'package-lock.json'),JSON.stringify({version,packages:{'':{version},'node_modules/x':{version:dep}}}));
  await lock('1.4.0','3');const old=await capture();
  await lock('1.5.0','3');const bump=await capture();
  assert.equal(await versions.docsOnly('sala',old,bump),true);
  await lock('1.5.0','4');const dependency=await capture();
  assert.equal(await versions.docsOnly('sala',bump,dependency),false);
  await writeFile(join(dir,'icone.png'),'changed');const image=await capture();
  assert.equal(await versions.docsOnly('sala',dependency,image),false);
});

// Caso real de 23/11, 21:18: o Hydrogen leu 17 arquivos em 5 rodadas e recebeu 429 com volta em 1 s; a fala se perdeu.
const limited = (quotaId, retryDelay) => Response.json({ error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED', details: [
  { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
  { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay } ] } }, { status: 429 });
const PER_MINUTE = 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', PER_DAY = 'GenerateRequestsPerDayPerProjectPerModel-FreeTier';
test('dois 503 na abertura esgotam a reserva e o 429 posterior preserva o erro sem repetir', async t=>{
  const cwd=await workspace(t);
  let calls=0;
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    calls++;
    if(calls<=2)return Response.json({}, {status:503});
    if(calls===3)return sse([call('read_file',{path:'a.txt'})],{signal:init.signal});
    if(calls===4)return limited(PER_MINUTE,'0.01s');
    return sse([answer],{signal:init.signal});
  });
  await assert.rejects(runStudio('gemini-3.8-flash','k',projectArgs(cwd,{settings:{studioToolRounds:3}})),{code:'RATE_LIMIT'});
  assert.equal(calls,4);
});

test('a troca de modelo reserva a última rodada para fechar e distribui as requisições por modelo', async t=>{
  const {Providers}=await import('../lib/providers.mjs');
  const cwd=await workspace(t),requests=[];
  const p=new Providers({dataDir:cwd,store:{providerState:()=>({}),saveProviderState:()=>{}}});
  p.runNativeRoute=async()=>{throw Object.assign(new Error('pausa'),{code:'RATE_LIMIT'});};
  p.studioCodeOrder=async()=>['api:gemini-3.8-flash','api:gemini-4-hydrogen'];
  p.studioAccess=async()=>'k';
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    const body=JSON.parse(init.body);
    requests.push(body);
    if(String(url).includes('flash'))return limited(PER_DAY,'3600s');
    return sse([body.toolConfig?answer:call('read_file',{path:'a.txt'})],{signal:init.signal});
  });
  const r=await p.runGemini(projectArgs(cwd,{settings:{studioToolRounds:3}}));
  // O 429 do Flash não produziu trabalho: vira recuperação, e o Hydrogen fica com as três rodadas (duas de ferramentas).
  assert.equal(requests.length,4);
  assert.equal(requests.at(-1).toolConfig.functionCallingConfig.mode,'NONE');
  assert.equal(requests.filter(b=>b.toolConfig).length,1);
  assert.deepEqual(r.usage.studioRequestsByModel,{'gemini-3.8-flash':1,'gemini-4-hydrogen':3});
  t.mock.restoreAll();
  t.mock.method(globalThis,'fetch',async()=>limited(PER_DAY,'3600s'));
  await assert.rejects(p.runGemini(projectArgs(cwd)), error=>{
    assert.deepEqual(error.usage.studioRequestsByModel,{'gemini-3.8-flash':1,'gemini-4-hydrogen':1});
    assert.equal(error.usage.partialUsage,true);
    return error.code==='RATE_LIMIT';
  });
});

test('falhas do Flash antes da troca: o Hydrogen só perde rodadas quando a reserva acaba, e o teto rodadas + 2 se mantém', async t=>{
  const {Providers}=await import('../lib/providers.mjs');
  for(const [flash,hydrogenRounds] of [[['503','day'],3],[['503','503','503'],2]]){
    const cwd=await workspace(t),requests=[];let f=0;
    const p=new Providers({dataDir:cwd,store:{providerState:()=>({}),saveProviderState:()=>{}}});
    p.runNativeRoute=async()=>{throw Object.assign(new Error('pausa'),{code:'RATE_LIMIT'});};
    p.studioCodeOrder=async()=>['api:gemini-3.8-flash','api:gemini-4-hydrogen'];
    p.studioAccess=async()=>'k';
    t.mock.method(globalThis,'fetch',async(url,init)=>{
      const body=JSON.parse(init.body);
      requests.push(body);
      if(String(url).includes('flash'))return flash[f++]==='day'?limited(PER_DAY,'3600s'):Response.json({},{status:503});
      return sse([body.toolConfig?answer:call('read_file',{path:'a.txt'})],{signal:init.signal});
    });
    const r=await p.runGemini(projectArgs(cwd,{settings:{studioToolRounds:3}}));
    assert.equal(r.text.length>0,true);
    assert.ok(requests.length<=5,'teto de rodadas + 2: '+requests.length);
    assert.deepEqual(r.usage.studioRequestsByModel,{'gemini-3.8-flash':flash.length,'gemini-4-hydrogen':hydrogenRounds});
    assert.equal(requests.at(-1).toolConfig.functionCallingConfig.mode,'NONE');
    t.mock.restoreAll();
  }
});
test('429 por minuto depois de ferramentas: espera o tempo indicado e conclui a fala', async (t) => {
  const cwd = await workspace(t);
  let n = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => (++n === 1 ? sse([call('read_file', { path: 'a.txt' })], { signal: init.signal }) : n === 2 ? limited(PER_MINUTE, '0.02s') : sse([answer], { signal: init.signal })));
  const activities = [];
  const r = await runStudio('gemini-4-hydrogen', 'k', projectArgs(cwd, { onActivity: (a) => activities.push(a) }));
  assert.equal(r.text, 'Revisão concluída.');
  assert.equal(n, 3);
  assert.equal(activities.filter((a) => /limite por minuto/.test(a.title)).length, 1);
});
test('429 antes de qualquer ferramenta segue direto para a troca de rota; diário, distante ou repetido não espera mais', async (t) => {
  const cwd = await workspace(t);
  let n = 0;
  t.mock.method(globalThis, 'fetch', async () => { n++; return limited(PER_MINUTE, '0.02s'); });
  await assert.rejects(runStudio('gemini-4-hydrogen', 'k', projectArgs(cwd)), { code: 'RATE_LIMIT' });
  assert.equal(n, 1);
  t.mock.restoreAll();
  for (const [quota, delay, expected] of [[PER_DAY, '0.02s', 2], [PER_MINUTE, '300s', 2], [PER_MINUTE, '0.01s', 4]]) {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init) => (++calls === 1 ? sse([call('read_file', { path: 'a.txt' })], { signal: init.signal }) : limited(quota, delay)));
    await assert.rejects(runStudio('gemini-4-hydrogen', 'k', projectArgs(cwd)), { code: 'RATE_LIMIT' });
    assert.equal(calls, expected, quota + ' ' + delay);
    t.mock.restoreAll();
  }
});
