// 1.7 — uso do Gemini no painel (tamanho da cota diária informado pelo Google), tela cheia pelo F11 e
// os novos gráficos da aba Análises.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { studioError } from '../lib/ai-studio.mjs';
import { Providers } from '../lib/providers.mjs';

const raiz = new URL('..', import.meta.url);
const ler = (rel) => readFile(new URL(rel, raiz), 'utf8');
const cota = (quotaId, quotaValue) => Response.json({ error: { code: 429, message: 'Quota exceeded', details: [
  { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId, quotaValue }] },
  { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3600s' }] } }, { status: 429 });

test('429 diário guarda o tamanho da cota informado pelo Google; o por minuto não', async () => {
  const diario = await studioError(cota('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '25'));
  assert.equal(diario.daily, true);
  assert.equal(diario.dailyLimit, 25);
  const minuto = await studioError(cota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '5'));
  assert.equal(minuto.daily, false);
  assert.equal(minuto.dailyLimit, undefined);
  const semValor = await studioError(cota('GenerateRequestsPerDayPerProjectPerModel-FreeTier'));
  assert.equal(semValor.dailyLimit, undefined);
});

test('a cota diária aprendida aparece nas origens do Gemini e sobrevive à pausa', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'synapse-v17-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const estados = new Map();
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE messages (role TEXT, status TEXT, model TEXT, usage TEXT, createdAt TEXT)');
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run('gemini', 'completed', 'gemini-4-hydrogen', JSON.stringify({ promptTokenCount: 1, requests: 7 }), new Date().toISOString());
  const p = new Providers({ dataDir: cwd, store: { db, providerState: (id) => estados.get(id) || {}, saveProviderState: (id, v) => estados.set(id, v) } });
  t.mock.method(globalThis, 'fetch', async () => cota('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '25'));
  await assert.rejects(p.runStudioRoute('api:gemini-4-hydrogen', 'k', { prompt: 'oi', cwd, settings: { access: 'chat' } }), { code: 'RATE_LIMIT' });
  assert.equal(estados.get('studio').limits['gemini-4-hydrogen'], 25);
  assert.ok(estados.get('studio').models['api:gemini-4-hydrogen'].until, 'a pausa continua gravada junto com o limite');
  const [studio] = p.geminiOrigins({ studio: true, native: false });
  assert.deepEqual(studio.items, [{ model: 'Gemini 4 Hydrogen', requests: 7, falas: 1, limit: 25 }]);
  const [comLista] = p.geminiOrigins({ studio: true, studioModels: ['Gemini 3.8 Flash', 'Gemini 3.8 Flash', 'Gemini 4 Hydrogen'] });
  assert.deepEqual(comLista.models, ['Gemini 3.8 Flash', 'Gemini 4 Hydrogen'], 'a lista de modelos gratuitos chega à interface sem repetição');
});

test('F11 alterna a tela cheia no aplicativo e a interface esconde a barra própria', async () => {
  const [main, preload, app, tema] = await Promise.all([ler('desktop/main.mjs'), ler('desktop/preload.cjs'), ler('public/app.js'), ler('public/tema.css')]);
  assert.match(main, /tecla\.key === 'F11'[^\n]*setFullScreen\(!janela\.isFullScreen\(\)\)/);
  assert.match(main, /'enter-full-screen', true\], \['leave-full-screen', false\]/);
  assert.match(preload, /ipcRenderer\.on\('synapse:tela-cheia'/);
  assert.match(app, /synapseApp\?\.telaCheia\?\.aoMudar/);
  assert.match(tema, /html\.tela-cheia \{ --barra: 0px; \}/);
});

test('Análises 1.7: novos gráficos, medida de raciocínio e legenda que esconde participantes', async () => {
  const [html, js] = await Promise.all([ler('public/index.html'), ler('public/analises.js')]);
  for (const id of ['av-falas', 'av-composicao', 'av-contexto']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /data-filtro="medida"[^\n]*data-v="pensamento"/);
  assert.equal((html.match(/av-legenda-papeis/g) || []).length, 3);
  assert.match(js, /filtro\.ocultos/);
  assert.match(js, /renderComposicao\(rows\)/);
});

// Revisão do Gemini (1.7): as duas rotas do Gemini são alternativas, e um modelo esgotado não esgota a rota.
test('rodapé do Gemini: rota esgotada só sem modelos livres e botão esgotado só sem rota ativa', async (t) => {
  const app = await ler('public/app.js');
  const trecho = app.slice(app.indexOf('function dockSlot('), app.indexOf('function dockSlots('));
  const { geminiSlots, dockEsgotado } = new Function('dateLabel', `${trecho}\nreturn { geminiSlots, dockEsgotado };`)(() => 'amanhã');
  const agora = Date.parse('2026-11-26T12:00:00Z'), amanha = '2026-11-27T08:00:00Z';
  const origens = (studio, native = { connected: true, paused: [{ model: 'Conta Google', until: amanha }] }) =>
    [{ id: 'studio', connected: true, ...studio }, { id: 'antigravity', ...native }];
  const hidrogenioFora = { models: ['Gemini 3.8 Flash', 'Gemini 4 Hydrogen'], paused: [{ model: 'Gemini 4 Hydrogen', until: amanha }],
    items: [{ model: 'Gemini 4 Hydrogen', requests: 25, limit: 25 }, { model: 'Gemini 3.8 Flash', requests: 40, limit: 250 }] };

  await t.test('Hydrogen esgotado com o Flash livre: o anel mostra a folga do Flash e o botão não fica esgotado', () => {
    const slots = geminiSlots(origens(hidrogenioFora), agora);
    assert.equal(slots[0].pct, 16);
    assert.equal(slots[0].texto, '16%');
    assert.match(slots[0].detalhe, /Gemini 4 Hydrogen 25\/25 req\. esgotado até amanhã/);
    assert.equal(slots[1].pct, 100);
    assert.equal(dockEsgotado('gemini', slots), false);
  });
  await t.test('Flash livre sem cota conhecida: contagem de requisições, sem 100%', () => {
    const slots = geminiSlots(origens({ ...hidrogenioFora, items: [{ model: 'Gemini 4 Hydrogen', requests: 25 }] }), agora);
    assert.equal(slots[0].pct, null);
    assert.equal(slots[0].texto, '25 req');
  });
  await t.test('todos os modelos gratuitos esgotados e a conta em pausa: botão esgotado', () => {
    const slots = geminiSlots(origens({ ...hidrogenioFora, paused: [...hidrogenioFora.paused, { model: 'Gemini 3.8 Flash', until: amanha }] }), agora);
    assert.equal(slots[0].pct, 100);
    assert.equal(dockEsgotado('gemini', slots), true);
  });
  await t.test('AI Studio sem chave e conta em pausa: a única rota ativa está esgotada', () => {
    const slots = geminiSlots([{ id: 'studio', connected: false }, { id: 'antigravity', connected: true, paused: [{ model: 'Conta Google', until: amanha }] }], agora);
    assert.equal(slots[0].ativo, false);
    assert.equal(dockEsgotado('gemini', slots), true);
  });
  await t.test('GPT e Claude continuam esgotados com qualquer janela em 100%', () => {
    assert.equal(dockEsgotado('claude', [{ pct: 31 }, { pct: 100 }]), true);
    assert.equal(dockEsgotado('codex', [{ pct: 96 }, { pct: null }]), false);
  });
});
