// Aba Análises (1.4.1): uso normalizado por fala nos três formatos de cliente e rota /api/analytics.
// Os números dos casos vêm de falas reais gravadas no banco em 22 e 23/11.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { normalizeUsage, usageRows } from '../lib/analytics.mjs';
import { codexTurnUsage } from '../lib/providers.mjs';

const connected = async () => Object.fromEntries(['codex', 'claude', 'gemini'].map((p) => [p, { available: true, authenticated: true, usage: null }]));

test('uso de cada cliente na mesma escala: novos, cache e saída', () => {
  const claude = normalizeUsage('claude', { input_tokens: 14, cache_creation_input_tokens: 17277, cache_read_input_tokens: 2502671, output_tokens: 9109,
    output_tokens_details: { thinking_tokens: 4721 }, iterations: [{ input_tokens: 2, cache_read_input_tokens: 364055, cache_creation_input_tokens: 1238 }] });
  assert.deepEqual(claude, { novos: 17291, cache: 2502671, saida: 9109, pensamento: 4721, contexto: 365295 });
  const flash = normalizeUsage('gemini', { inputTokens: 222103, outputTokens: 5237, cachedReadTokens: 2844046, thoughtTokens: 4060 });
  assert.deepEqual(flash, { novos: 222103, cache: 2844046, saida: 5237, pensamento: 4060, contexto: null });
  const hydrogen = normalizeUsage('gemini', { promptTokenCount: 30000, cachedContentTokenCount: 12000, candidatesTokenCount: 800, thoughtsTokenCount: 273, requests: 6 });
  assert.deepEqual(hydrogen, { novos: 18000, cache: 12000, saida: 1073, pensamento: 273, requisicoes: 6, contexto: null });
  assert.equal(normalizeUsage('claude', null), null);
});

test('Codex: fala medida na captura; registros antigos estimados pela diferença do total da conversa', () => {
  const total = { inputTokens: 3512214, cachedInputTokens: 3394688, outputTokens: 11513, reasoningOutputTokens: 1291 };
  const last = { inputTokens: 111649, cachedInputTokens: 111232, outputTokens: 802, reasoningOutputTokens: 0 };
  // Base = total antes da 1ª requisição da fala.
  const base = { inputTokens: 3000000, cachedInputTokens: 2900000, outputTokens: 10000, reasoningOutputTokens: 1000 };
  const medido = codexTurnUsage({ total, last }, base);
  assert.deepEqual(medido.turn, { inputTokens: 512214, cachedInputTokens: 494688, outputTokens: 1513, reasoningOutputTokens: 291 });
  assert.deepEqual(normalizeUsage('codex', medido), { novos: 17526, cache: 494688, saida: 1513, pensamento: 291, contexto: 111649 });
  assert.equal(codexTurnUsage({ total, last }, undefined).turn, undefined, 'sem base, o uso fica como veio');
  // Sem `turn`: mesma conversa (total cresceu) usa a diferença; conversa nova (total menor) usa o próprio total.
  const continua = normalizeUsage('codex', { total, last }, base);
  assert.equal(continua.novos, 17526); assert.equal(continua.estimado, true);
  const nova = normalizeUsage('codex', { total, last }, { inputTokens: 3619306, cachedInputTokens: 3512960 });
  assert.equal(nova.novos, 117526); assert.equal(nova.cache, 3394688);
  assert.equal(normalizeUsage('codex', { total, last }).estimado,true,'sem identidade da conversa, a medição histórica é estimada');
  const renewed=normalizeUsage('codex',{total:{inputTokens:110},last:{inputTokens:90}},{inputTokens:100});
  assert.equal(renewed.novos,110,'delta menor que a última requisição indica uma nova conversa');
});

test('usageRows: período, sala, esforço da rodada e diferença do Codex por sala e modo', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'synapse-analises-'));
  const store = new Store(join(dir, 'mesa.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const a = store.createRoom('Sala A', '', { claudeEffort: 'xhigh', codexEffort: 'ultra' }), b = store.createRoom('Sala B');
  const ja = store.createJob(a.id, 'auto', 'code', 4), jb = store.createJob(b.id, 'auto', 'code', 4);
  store.addMessage(a.id, 'codex', 'um', { jobId: ja.id, usage: { total: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50 }, last: { inputTokens: 600 } } });
  store.addMessage(b.id, 'codex', 'outra sala', { jobId: jb.id, usage: { total: { inputTokens: 5000, cachedInputTokens: 0, outputTokens: 10 } } });
  store.addMessage(a.id, 'codex', 'dois', { jobId: ja.id, usage: { total: { inputTokens: 1500, cachedInputTokens: 1100, outputTokens: 80 }, last: { inputTokens: 500 } } });
  store.addMessage(a.id, 'claude', 'três', { jobId: ja.id, model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 400, output_tokens: 20 } });
  store.addMessage(a.id, 'claude', 'sem uso', { jobId: ja.id });
  store.addMessage(a.id, 'gemini', 'interrompida', { jobId: ja.id, status: 'interrupted', usage: { inputTokens: 9 } });
  store.addMessage(a.id, 'user', 'pedido', { usage: { input_tokens: 1 } });
  const todas = usageRows(store.db);
  assert.equal(todas.length, 4, 'só falas concluídas dos participantes, com uso');
  const [primeira, , segunda, claude] = todas;
  assert.equal(primeira.novos, 200); assert.equal(primeira.effort, 'ultra'); assert.equal(primeira.sala, 'Sala A'); assert.equal(primeira.mode, 'code');
  assert.deepEqual([segunda.novos, segunda.cache, segunda.saida, segunda.estimado], [200, 300, 30, true], 'diferença só contra a mesma sala, sem misturar a Sala B');
  assert.deepEqual([claude.novos, claude.cache, claude.effort, claude.model], [100, 400, 'xhigh', 'claude-opus-5-5']);
  assert.equal(usageRows(store.db, { roomId: b.id }).length, 1);
  assert.equal(usageRows(store.db, { since: new Date(Date.now() + 60000).toISOString() }).length, 0);
  store.addMessage(a.id,'gemini','Interrompida',{jobId:ja.id,status:'interrupted',usage:{promptTokenCount:200,requests:3,partialUsage:true}});
  const partial=usageRows(store.db).at(-1);
  assert.equal(partial.interrompida,true);assert.equal(partial.novos,200);assert.equal(partial.requisicoes,3);
});

test('rota /api/analytics e script da aba servido localmente', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'synapse-analises-api-'));
  const app = await createApp({ dataDir, getAgentStatus: connected, runAgent: async () => ({ text: 'ok' }) });
  const url = await app.listen(0);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const resposta = await fetch(`${url}/api/analytics?since=${encodeURIComponent(new Date(Date.now() - 864e5).toISOString())}`);
  assert.equal(resposta.status, 200);
  const dados = await resposta.json();
  assert.deepEqual(dados.rows, []); assert.ok(Date.parse(dados.generatedAt));
  assert.equal((await fetch(`${url}/api/analytics?since=ontem`)).status, 400);
  const script = await fetch(`${url}/analises.js`);
  assert.equal(script.status, 200); assert.match(script.headers.get('content-type'), /javascript/);
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="\/analises\.js" defer><\/script>/);
  for (const id of ['vista-interface', 'vista-analises', 'analytics-view', 'av-tempo', 'av-horas', 'av-esforco', 'av-top', 'av-tabela'])
    assert.match(html, new RegExp(`id="${id}"`), id);
});
