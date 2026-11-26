// Conversa renovada por tamanho (23/11). Medição real de 22/11: cada fala do Gemini pelo Antigravity pagava
// ~170 mil tokens de entrada sem cache, e cada chamada de ferramenta do Claude relia 190-240 mil tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { contextTokens } from '../lib/routing.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connected = async () => Object.fromEntries(['codex', 'claude', 'gemini'].map((p) => [p, { available: true, authenticated: true, usage: null }]));
const status = `<mesa_status>${JSON.stringify({ status: 'complete', summary: 'ok', next: [], decisions: [], tests: [] })}</mesa_status>`;

test('tamanho do contexto pelo uso real de cada cliente', () => {
  assert.equal(contextTokens('claude', { input_tokens: 30, cache_read_input_tokens: 3456650, iterations: [{ input_tokens: 2, cache_read_input_tokens: 241729, cache_creation_input_tokens: 651 }] }), 242382);
  assert.equal(contextTokens('claude', { input_tokens: 30, cache_read_input_tokens: 3456650 }), null, 'sem iterations o total do turno não serve');
  assert.equal(contextTokens('codex', { total: { inputTokens: 3619306 }, last: { inputTokens: 99300 } }), 99300);
  assert.equal(contextTokens('codex', { total: { totalTokens: 3619306 }, last: { inputTokens: 136000, totalTokens: 146000, cachedInputTokens: 120000 } }), 146000);
  assert.equal(contextTokens('gemini', { inputTokens: 171000, cachedReadTokens: 0 }), 171000);
  assert.equal(contextTokens('gemini', { promptTokenCount: 65592 }), null, 'AI Studio não tem conversa a retomar');
  assert.equal(contextTokens('claude', null), null);
});

test('conversa acima do limite começa de novo, com aviso em Ações; abaixo do limite continua', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'synapse-renovada-'));
  const calls = [];
  let contexto = 50000;
  const runAgent = async (args) => {
    calls.push(args);
    return { text: `Resposta ${calls.length}\n${status}`, sessionId: 'sessao-' + calls.length, usage: { total: { inputTokens: contexto * 3 }, last: { inputTokens: contexto } } };
  };
  const app = await createApp({ dataDir, runAgent, getAgentStatus: connected });
  const url = await app.listen(0);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const boot = await (await fetch(url + '/api/bootstrap')).json(), id = boot.rooms[0].id;
  const call = async (path, body, method = 'POST') => (await fetch(url + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken }, body: JSON.stringify(body) })).json();
  await call(`/api/rooms/${id}`, { settings: { access: 'project', sessionMaxTokens: 140000 } }, 'PATCH');
  const run = async (content) => {
    const job = (await call(`/api/rooms/${id}/messages`, { content, target: 'codex', mode: 'chat' })).job;
    for (let n = 0; n < 400; n++) { const j = app.store.getJob(job.id); if (!['queued', 'running'].includes(j.status)) return j; await wait(15); }
    throw new Error('Tarefa não terminou');
  };
  await run('primeira');
  await run('segunda');
  assert.equal(calls[1].sessionId, 'sessao-1', '50 mil tokens: retoma a conversa');
  contexto = 180000;
  await run('terceira');
  assert.equal(calls[2].sessionId, 'sessao-2');
  await run('quarta');
  assert.equal(calls[3].sessionId, undefined, '180 mil tokens: conversa nova');
  assert.equal(calls[3].resumePrompt, undefined, 'conversa nova recebe o prompt completo');
  const avisos = app.store.db.prepare("SELECT activity FROM events WHERE activity LIKE '%conversa renovada%'").all();
  assert.equal(avisos.length, 1);
  assert.match(JSON.parse(avisos[0].activity).detail, /180 mil tokens/);
});
