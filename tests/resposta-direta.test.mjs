// Synapse 1.5: resposta direta a uma mensagem. Pedido do usuário em 23/11: "se houver diversas respostas,
// gostaria de enfatizar exatamente onde está aquilo que estou respondendo".
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { pickHistory, replyContext } from '../lib/orchestrator.mjs';

const connected = async () => Object.fromEntries(['codex', 'claude'].map((agent) => [agent, { available: true, authenticated: true, label: agent, version: 'test', detail: 'test only' }]));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t, runAgent) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mesa-test-'));
  const app = await createApp({ dataDir, getAgentStatus: connected, runAgent });
  const url = await app.listen(0);
  const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
  const roomId = bootstrap.rooms[0].id;
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = async (path, body) => {
    const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': bootstrap.csrfToken }, body: JSON.stringify(body) });
    return { status: res.status, ...await res.json() };
  };
  const done = async (id) => { for (let n = 0; n < 150; n++) { const j = app.store.getJob(id); if (!['queued', 'running'].includes(j.status)) return j; await sleep(20); } throw new Error('Timed out'); };
  return { app, roomId, request, done };
}

test('a resposta guarda a mensagem e o trecho citados, e o agente recebe os dois no histórico', async (t) => {
  const prompts = [];
  const f = await fixture(t, async ({ prompt }) => { prompts.push(prompt); return { text: prompts.length === 1 ? 'Proposta ALFA com três passos. Passo BETA é o crítico.' : 'Certo.' }; });
  const first = await f.request(`/api/rooms/${f.roomId}/messages`, { content: 'Proponha um plano', target: 'codex' });
  await f.done(first.job.id);
  const answer = f.app.store.messages(f.roomId).find((m) => m.role === 'codex');

  const sent = await f.request(`/api/rooms/${f.roomId}/messages`, { content: 'Detalhe isso', target: 'codex', replyTo: { id: answer.id, quote: 'Passo BETA é o crítico.' } });
  assert.equal(sent.status, 202);
  assert.deepEqual(sent.message.reply, { id: answer.id, role: 'codex', quote: 'Passo BETA é o crítico.' });
  await f.done(sent.job.id);
  assert.match(prompts[1], /"respondendo_a":\{"autor":"GPT","trecho_selecionado":"Passo BETA é o crítico\."\}/);
  assert.match(prompts[1], /"respondendo_a" indica a mensagem e o trecho exatos/);
  // A primeira fala não tinha resposta: nem a chave nem a explicação entram (sem custo extra de tokens).
  assert.doesNotMatch(prompts[0], /respondendo_a/);
  assert.deepEqual(f.app.store.messages(f.roomId).find((m) => m.id === sent.message.id).reply, sent.message.reply);
});

test('resposta a mensagem inexistente ou malformada é recusada sem criar mensagem nem tarefa', async (t) => {
  const f = await fixture(t, async () => ({ text: 'não deveria rodar' }));
  const before = f.app.store.messages(f.roomId).length;
  assert.equal((await f.request(`/api/rooms/${f.roomId}/messages`, { content: 'Oi', target: 'codex', replyTo: { id: 'nao-existe' } })).status, 404);
  assert.equal((await f.request(`/api/rooms/${f.roomId}/messages`, { content: 'Oi', target: 'codex', replyTo: 'texto' })).status, 400);
  assert.equal((await f.request(`/api/rooms/${f.roomId}/messages`, { content: 'Oi', target: 'codex', replyTo: { id: 'x', quote: 'a'.repeat(1201) } })).status, 404);
  assert.equal(f.app.store.messages(f.roomId).length, before);
  assert.equal(f.app.store.jobs(f.roomId).length, 0);
});

test('sem trecho selecionado, o agente recebe o começo da mensagem respondida', () => {
  const longa = 'Primeira parte. ' + 'x'.repeat(400) + '<mesa_status>{"status":"complete"}</mesa_status>';
  const msgs = [
    { id: 'a', role: 'claude', content: longa },
    { id: 'b', role: 'user', content: 'Concordo', reply: { id: 'a', role: 'claude' } },
  ];
  const ctx = replyContext(msgs[1].reply, new Map(msgs.map((m) => [m.id, m])));
  assert.equal(ctx.autor, 'Claude');
  assert.ok(ctx.inicio.startsWith('Primeira parte.') && ctx.inicio.endsWith('…') && ctx.inicio.length === 301);
  // Mensagem citada fora do trecho do histórico (prompt incremental): o contexto vem da sala inteira.
  const { chosen } = pickHistory([msgs[1]], 56000, 60, true, msgs);
  assert.equal(chosen[0].respondendo_a.autor, 'Claude');
  assert.doesNotMatch(chosen[0].respondendo_a.inicio, /mesa_status/);
});
