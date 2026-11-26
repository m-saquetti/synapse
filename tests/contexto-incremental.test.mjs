// Synapse 1.3.1: contexto incremental.
// Medição real de 22/11: cada participante retomava a própria sessão (que já guarda os prompts anteriores) e
// a Synapse reenviava ~75 mil caracteres de histórico e memória a cada fala. O contexto de cada cliente
// crescia um prompt inteiro por fala. Agora uma sessão retomada recebe só o que mudou.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { promptFor } from '../lib/providers.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connected = async () => Object.fromEntries(['codex', 'claude', 'gemini'].map((p) => [p, { available: true, authenticated: true, usage: null }]));
const status = (summary) => `<mesa_status>${JSON.stringify({ status: 'complete', summary, next: [], decisions: [], tests: [] })}</mesa_status>`;

async function room(t, runAgent, settings = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'synapse-incremental-'));
  const app = await createApp({ dataDir, runAgent, getAgentStatus: connected });
  const url = await app.listen(0);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const boot = await (await fetch(url + '/api/bootstrap')).json(), id = boot.rooms[0].id;
  const call = async (path, body, method = 'POST') => {
    const response = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken }, body: JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
  };
  await call(`/api/rooms/${id}`, { settings: { access: 'project', ...settings } }, 'PATCH');
  const send = async (content, target) => (await call(`/api/rooms/${id}/messages`, { content, target, mode: 'chat' })).job;
  const done = async (jobId) => { for (let n = 0; n < 400; n++) { const job = app.store.getJob(jobId); if (!['queued', 'running'].includes(job.status)) return job; await wait(15); } throw new Error('Tarefa não terminou'); };
  return { app, id, send, done, call };
}

test('sessão retomada recebe só as mensagens novas; sessão nova recebe o histórico completo', async (t) => {
  const calls = [];
  const runAgent = async (args) => {
    calls.push(args);
    const n = calls.length;
    return { text: `Resposta ${n} do ${args.agent} sobre RESPOSTA_PROPRIA_${n}\n${status('fala ' + n)}`, sessionId: 'sessao-' + args.agent };
  };
  const { send, done } = await room(t, runAgent);
  assert.equal((await done((await send('PEDIDO_UM: comece', 'claude')).id)).status, 'completed');
  assert.equal(calls[0].sessionId, undefined);
  assert.equal(calls[0].resumePrompt, undefined, 'primeira fala: sem sessão, só o prompt completo');

  assert.equal((await done((await send('PEDIDO_DOIS: continue', 'claude')).id)).status, 'completed');
  const second = calls[1];
  assert.equal(second.sessionId, 'sessao-claude');
  assert.ok(second.resumePrompt, 'segunda fala: prompt incremental');
  assert.match(second.resumePrompt, /PEDIDO_DOIS/);
  assert.doesNotMatch(second.resumePrompt, /PEDIDO_UM/, 'o pedido antigo já está na sessão');
  assert.doesNotMatch(second.resumePrompt, /RESPOSTA_PROPRIA_1/, 'a própria resposta já está na sessão');
  assert.match(second.resumePrompt, /<mesa_status>/, 'regras do bloco de controle continuam em toda fala');
  assert.match(second.prompt, /PEDIDO_UM/, 'o prompt completo continua disponível para sessão recriada');
  assert.doesNotMatch(second.resumePrompt, /Briefing fornecido|Ações devem servir ao pedido/, 'regras fixas e briefing já estão na sessão');

  // Outro participante fala; na próxima vez do Claude, a fala do colega chega como novidade.
  assert.equal((await done((await send('PEDIDO_TRES para o GPT', 'codex')).id)).status, 'completed');
  assert.equal(calls[2].resumePrompt, undefined, 'primeira fala do GPT: sessão nova');
  assert.equal((await done((await send('PEDIDO_QUATRO', 'claude')).id)).status, 'completed');
  const fourth = calls[3];
  assert.match(fourth.resumePrompt, /PEDIDO_TRES/);
  assert.match(fourth.resumePrompt, /RESPOSTA_PROPRIA_3/, 'a resposta do GPT é nova para o Claude');
  assert.match(fourth.resumePrompt, /PEDIDO_QUATRO/);
  assert.doesNotMatch(fourth.resumePrompt, /PEDIDO_DOIS|RESPOSTA_PROPRIA_2/);
});

test('falha na fala não avança a marca: a próxima repete as novidades em vez de perdê-las', async (t) => {
  const calls = [];
  const runAgent = async (args) => {
    calls.push(args);
    if (calls.length === 2) throw new Error('falha simulada');
    return { text: `ok ${calls.length}\n${status('ok')}`, sessionId: 'sessao-claude' };
  };
  const { send, done } = await room(t, runAgent, { maxSteps: 2 });
  await done((await send('PRIMEIRO', 'claude')).id);
  await done((await send('SEGUNDO', 'claude')).id);
  await done((await send('TERCEIRO', 'claude')).id);
  const last = calls.at(-1);
  assert.match(last.resumePrompt, /SEGUNDO/, 'a mensagem da fala que falhou continua como novidade');
  assert.match(last.resumePrompt, /TERCEIRO/);
});

test('contexto incremental pode ser desligado na sala', async (t) => {
  const calls = [];
  const runAgent = async (args) => { calls.push(args); return { text: `ok\n${status('ok')}`, sessionId: 'sessao-claude' }; };
  const { send, done } = await room(t, runAgent, { incrementalContext: false });
  await done((await send('UM', 'claude')).id);
  await done((await send('DOIS', 'claude')).id);
  assert.equal(calls[1].sessionId, 'sessao-claude');
  assert.equal(calls[1].resumePrompt, undefined);
});

test('promptFor: só usa o incremental quando a sessão foi realmente retomada', () => {
  const args = { prompt: 'COMPLETO', resumePrompt: 'INCREMENTAL' };
  assert.equal(promptFor(args, true), 'INCREMENTAL');
  assert.equal(promptFor(args, false), 'COMPLETO', 'sessão recriada depois de "session not found"');
  assert.equal(promptFor({ prompt: 'COMPLETO' }, true), 'COMPLETO');
});

test('uma orientação enviada durante a fala chega na próxima retomada', async t => {
  const entered=Promise.withResolvers(), release=Promise.withResolvers(), calls=[];
  const f=await room(t,async args=>{
    calls.push(args);
    if(calls.length===1){entered.resolve();await release.promise;}
    const text=args.agent==='gemini'?'x'.repeat(57000):'ok';
    return {text:text+'\n'+status('ok'),sessionId:args.agent+'-1'};
  });
  const first=await f.send('Comece','auto');
  await entered.promise;
  try {
    const steer=await f.call('/api/jobs/'+first.id+'/steer',{content:'Use a versão revisada do contrato.'});
    assert.equal(steer.status,201);
  } finally { release.resolve(); }
  await f.done(first.id);
  const resumed=calls.find(c=>c.agent===calls[0].agent && c.resumePrompt);
  assert.ok(resumed);
  assert.match(resumed.resumePrompt,/Use a versão revisada do contrato/);
});

test('alterar o briefing inicia uma sessão com as instruções atualizadas', async t => {
  const calls=[];
  const f=await room(t,async args=>{
    calls.push(args);
    return {text:'ok\n'+status('ok'),sessionId:'claude-'+calls.length};
  });
  await f.done((await f.send('Comece','claude')).id);
  assert.equal((await f.call('/api/rooms/'+f.id,{brief:'Agora use a especificação B.'},'PATCH')).status,200);
  await f.done((await f.send('Continue','claude')).id);
  assert.equal(calls[1].sessionId,undefined);
  assert.match(calls[1].prompt,/Agora use a especificação B/);
});
