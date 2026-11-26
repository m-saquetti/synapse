// Synapse 1.1.1: o Gemini não fica preso fora das rodadas depois de um limite de uso.
// Reproduz o caso real de 21/11: 429 no AI Studio às 18:38, renovação às 18:39 e, em seguida, o Gemini
// ausente de todas as rodadas, inclusive com a ordem trocada para ele abrir e o modelo trocado para o Antigravity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { AgentError } from '../lib/agents.mjs';
import { limitApplies, absenceReason } from '../lib/coordinator.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Como no Windows real: o Gemini não informa telemetria de uso (usage null).
const connected = async () => Object.fromEntries(['codex', 'claude', 'gemini'].map((p) => [p, { available: true, authenticated: true, usage: null }]));
const reply = (status = 'complete') => ({ text: `Ok\n<mesa_status>${JSON.stringify({ status, summary: 'ok', next: [], decisions: [], tests: [] })}</mesa_status>` });

async function room(t, runAgent, settings = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'synapse-gemini-'));
  const app = await createApp({ dataDir, runAgent, getAgentStatus: connected });
  const url = await app.listen(0);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const boot = await (await fetch(url + '/api/bootstrap')).json(), id = boot.rooms[0].id;
  const call = async (path, body, method = 'POST') => {
    const response = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken }, body: JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
  };
  const patch = (s) => call(`/api/rooms/${id}`, { settings: s }, 'PATCH');
  const send = async (content) => (await call(`/api/rooms/${id}/messages`, { content, target: 'auto', mode: 'chat' })).job;
  const done = async (jobId) => { for (let n = 0; n < 400; n++) { const job = app.store.getJob(jobId); if (!['queued', 'running'].includes(job.status)) return job; await wait(15); } throw new Error('Tarefa não terminou'); };
  await patch({ access: 'project', geminiModel: 'api:gemini-4-hydrogen', ...settings });
  return { app, id, patch, send, done };
}
const geminiLimited = (resetAt) => Object.assign(new AgentError('Limite do AI Studio (HTTP 429)', 'RATE_LIMIT'), { resetAt });

test('limitApplies: um limite só vale para a configuração que o atingiu', () => {
  assert.equal(limitApplies({ model: 'api:gemini-4-hydrogen' }, 'api:gemini-4-hydrogen'), true);
  assert.equal(limitApplies({ model: 'api:gemini-4-hydrogen' }, 'gemini-3.8-flash'), false, 'trocou para o Antigravity');
  assert.equal(limitApplies({ model: 'api:gemini-4-hydrogen' }, 'auto'), false, 'trocou para automático');
  assert.equal(limitApplies({ model: '' }, ''), true, 'padrão da conta (Codex/Claude)');
  // Limites gravados antes da 1.1.1 (sem modelo): o do AI Studio só vale enquanto a rota passar por ele.
  assert.equal(limitApplies({ direct: true }, 'gemini-3.8-flash'), false);
  assert.equal(limitApplies({ direct: true }, 'api:gemini-2.5-pro'), true);
  assert.equal(limitApplies({ direct: false }, 'qualquer'), true);
  assert.equal(limitApplies(undefined, 'x'), false);
});

test('absenceReason explica por que alguém ficou fora', () => {
  const ok = { available: true, authenticated: true };
  assert.match(absenceReason({ status: ok, limit: { resetAt: new Date(Date.now() + 3600000).toISOString() } }), /^limite de uso até \d\d:\d\d$/);
  assert.equal(absenceReason({ status: ok, limit: { resetAt: null } }), 'limite de uso sem horário de renovação informado');
  assert.equal(absenceReason({ status: ok, failure: 'AUTH_REQUIRED' }), 'login necessário no cliente oficial');
  assert.equal(absenceReason({ status: { ...ok, authenticated: false } }), 'conta não conectada');
  assert.equal(absenceReason({ status: { ...ok, models: [{ id: 'm', label: 'Modelo M', availability: 'locked' }] }, model: 'm' }), 'modelo Modelo M bloqueado ou em pausa');
  assert.equal(absenceReason({ status: { ...ok, usage: { windows: [{ usedPercent: 100 }] } } }), 'limite de uso esgotado');
});

test('regressão 21/11: depois do horário de renovação, uma mensagem nova devolve o Gemini à rodada', async (t) => {
  const calls = [];let first = true;
  const f = await room(t, async (args) => {
    calls.push(args.agent);
    if (args.agent === 'gemini' && first) { first = false; throw geminiLimited(new Date(Date.now() + 150).toISOString()); }
    return reply();
  });
  const one = await f.send('Primeira rodada');
  assert.equal((await f.done(one.id)).status, 'completed');
  assert.deepEqual(calls, ['codex', 'claude', 'gemini', 'codex'], 'o 429 tira o Gemini só daquela rodada');
  await wait(250); // renovação informada pelo AI Studio já passou
  calls.length = 0;
  const two = await f.send('Gemini, pode falar?');
  assert.equal((await f.done(two.id)).status, 'completed');
  assert.deepEqual(calls, ['codex', 'claude', 'gemini', 'codex'], 'antes da correção: [codex, claude, codex], sem o Gemini');
  assert.deepEqual(f.app.store.getJob(two.id).progress.round.order, ['codex', 'claude', 'gemini']);
});

test('trocar o modelo do Gemini encerra a exclusão, e a ordem escolhida pelo usuário é respeitada', async (t) => {
  const calls = [];let first = true;
  const f = await room(t, async (args) => {
    calls.push(`${args.agent}:${args.settings.geminiModel}`);
    if (args.agent === 'gemini' && first) { first = false; throw geminiLimited(new Date(Date.now() + 3600000).toISOString()); }
    return reply();
  });
  const one = await f.send('Primeira rodada');
  await f.done(one.id);
  // O usuário troca para o Antigravity e coloca o Gemini para abrir só nesta rodada.
  assert.equal((await f.patch({ geminiModel: 'gemini-3.8-flash', chatPreference: ['gemini', 'codex', 'claude'] })).status, 200);
  calls.length = 0;
  const two = await f.send('Gemini, qual melhoria você priorizaria no Synapse e por quê?');
  assert.equal((await f.done(two.id)).status, 'completed');
  assert.equal(calls[0], 'gemini:gemini-3.8-flash', 'o Gemini abre a rodada');
  const job = f.app.store.getJob(two.id);
  assert.equal(job.progress.round.lead, 'gemini');
  assert.deepEqual(job.progress.round.absent, {});
  const events = f.app.store.events(f.id).filter((e) => e.jobId === two.id).map((e) => e.activity.title);
  assert.ok(events.includes('Ordem da rodada: Gemini → GPT → Claude'), events.join(' | '));
  await f.patch({ geminiModel: 'api:gemini-4-hydrogen' });
  calls.length = 0;
  const three = await f.send('Mesma cota original, ainda bloqueada');
  assert.equal((await f.done(three.id)).status, 'completed');
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => !call.startsWith('gemini:')));
});

test('com o mesmo modelo e renovação futura, o Gemini fica fora e o motivo aparece em Ações e no contexto', async (t) => {
  const prompts = {};let first = true;
  const f = await room(t, async (args) => {
    prompts[args.agent] = args.prompt;
    if (args.agent === 'gemini' && first) { first = false; throw geminiLimited(new Date(Date.now() + 3600000).toISOString()); }
    return reply();
  });
  await f.done((await f.send('Primeira rodada')).id);
  delete prompts.gemini;
  const two = await f.send('Segunda rodada');
  await f.done(two.id);
  assert.equal(prompts.gemini, undefined, 'não gasta outra chamada antes da renovação');
  const order = f.app.store.events(f.id).find((e) => e.jobId === two.id && e.activity.title.startsWith('Ordem da rodada'));
  assert.equal(order.activity.title, 'Ordem da rodada: GPT → Claude');
  assert.equal(order.activity.status, 'warning');
  assert.match(order.activity.detail, /^Fora desta rodada: Gemini: limite de uso até \d\d:\d\d\.$/);
  assert.match(prompts.codex, /Fora desta rodada, segundo a coordenação: Gemini \(limite de uso até \d\d:\d\d\)\. Não fale por quem está ausente\./);
});
