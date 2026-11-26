// Synapse 1.1: nomes oficiais de modelos, esforço por participante, sala única e ciclo de vida das salas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { normalizeSettings } from '../lib/settings.mjs';
import { normalizeCatalog, resolveEffort, displayModel, geminiVariant, findModel } from '../lib/models.mjs';
import { Providers } from '../lib/providers.mjs';

const connected = Object.fromEntries(['codex', 'claude', 'gemini'].map((id) => [id, { available: true, authenticated: true }]));
async function eventually(fn) {
  for (let i = 0; i < 300; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 15)); }
  assert.fail('Expected condition timed out');
}
async function server(t, runAgent = async () => ({ text: 'ok' })) {
  const dataDir = await mkdtemp(join(tmpdir(), 'synapse-v11-'));
  const app = await createApp({ dataDir, runAgent, getAgentStatus: async () => connected });
  const url = await app.listen(0);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const boot = await (await fetch(url + '/api/bootstrap')).json();
  const call = async (path, body, method = 'POST') => {
    const response = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
  };
  return { app, url, dataDir, call, room: boot.rooms[0] };
}

test('model names follow the official platforms and hide local identifiers', () => {
  const claude = normalizeCatalog('claude', [
    { id: 'claude-opus-5-5', label: 'Default (recommended)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-sonnet-5-5[1m]', label: 'Sonnet (1M context)' },
  ]);
  assert.deepEqual(claude.map((m) => m.label), ['Claude Opus 5.5', 'Claude Sonnet 5.5 · 1M de contexto']);
  const codex = normalizeCatalog('codex', [{ id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' }, { id: 'gpt-6-astra', label: 'GPT-6 Astra' }]);
  assert.deepEqual(codex.map((m) => m.label), ['GPT-6.1 Sol', 'GPT-6 Astra']);
  const gemini = normalizeCatalog('gemini', [
    { id: 'gemini-4-hydrogen-low' }, { id: 'gemini-4-hydrogen-xhigh' }, { id: 'api:gemini-3-flash-preview', label: 'gemini-3-flash-preview' },
  ]);
  assert.deepEqual(gemini.map((m) => [m.id, m.label, m.efforts]), [
    ['gemini-4-hydrogen', 'Gemini 4 Hydrogen', ['low', 'xhigh']],
    ['api:gemini-3-flash-preview', 'Gemini 3 Flash (prévia)', ['minimal', 'low', 'medium', 'high']],
  ]);
  // Salas antigas guardavam a variante no ID do modelo.
  assert.equal(findModel('gemini', gemini, 'gemini-4-hydrogen-xhigh').label, 'Gemini 4 Hydrogen');
  assert.equal(geminiVariant(gemini[0], 'gemini-4-hydrogen-xhigh', ''), 'gemini-4-hydrogen-xhigh');
  assert.equal(geminiVariant(gemini[0], 'gemini-4-hydrogen', 'low'), 'gemini-4-hydrogen-low');
  assert.equal(displayModel('gemini', [], 'gemini-4-hydrogen-xhigh'), 'Gemini 4 Hydrogen');
});

test('os níveis do cliente sobrevivem à gravação e releitura do catálogo', () => {
  const gemini=normalizeCatalog('gemini', [
    {id:'api:gemini-4-hydrogen'}, {id:'gemini-4-hydrogen-low'}, {id:'gemini-4-hydrogen-xhigh'},
  ]);
  assert.deepEqual(gemini[0].efforts,['low','medium','high','xhigh']);
  assert.deepEqual(normalizeCatalog('gemini',gemini),gemini);
  const codex=normalizeCatalog('codex', [
    {id:'gpt-6.2-sol',isDefault:true,efforts:['low','medium','high','xhigh','max','ultra']},
    {id:'gpt-reserve',efforts:['high','xhigh','max']},
  ]);
  const providers=new Providers({store:{providerState:()=>({catalog:codex})}});
  const effortFor=id=>providers.withEffort({agent:'codex',settings:normalizeSettings({codexModel:id,codexEffort:'ultra'})}).effort;
  assert.equal(effortFor(''),'ultra');
  assert.equal(effortFor('gpt-reserve'),'max');
  assert.throws(()=>normalizeSettings({claudeEffort:'ultra'}),/esforço/);
  assert.equal(resolveEffort('high',{supportsEffort:false}).effort,undefined);
});

test('each participant keeps its own effort, adjusted to what the chosen model supports', () => {
  assert.deepEqual(resolveEffort('max', { efforts: ['low', 'medium', 'high'] }), { effort: 'high', adjusted: true, requested: 'max' });
  assert.deepEqual(resolveEffort('', { efforts: ['low'] }), { effort: undefined, adjusted: false });
  const state = new Map([
    ['codex', { catalog: [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['low', 'medium', 'high'] }] }],
    ['gemini', { catalog: [{ id: 'gemini-4-hydrogen-low' }, { id: 'gemini-4-hydrogen-xhigh' }] }],
  ]);
  const providers = new Providers({ dataDir: tmpdir(), store: { providerState: (id) => state.get(id) || {} } });
  const activity = [];
  const codex = providers.withEffort({ agent: 'codex', settings: normalizeSettings({ codexModel: 'gpt-6-astra', codexEffort: 'xhigh' }), onActivity: (a) => activity.push(a) });
  assert.equal(codex.effort, 'high');
  assert.equal(activity[0].tool, 'effort');
  const gemini = providers.withEffort({ agent: 'gemini', settings: normalizeSettings({ geminiModel: 'gemini-4-hydrogen', geminiEffort: 'xhigh' }) });
  assert.equal(gemini.modelId, 'gemini-4-hydrogen-xhigh');
  const claude = providers.withEffort({ agent: 'claude', settings: normalizeSettings({ claudeEffort: '' }) });
  assert.equal(claude.effort, undefined, 'vazio usa o padrão do modelo');
  assert.throws(() => normalizeSettings({ codexEffort: 'turbo' }), /esforço/);
  assert.throws(() => normalizeSettings({ mode: 'debate' }), /Modo/);
});

test('rooms can be archived, restored and deleted without touching folders chosen by the user', async (t) => {
  const { call, dataDir, app, room } = await server(t);
  const workspace = join(dataDir, 'workspaces', room.id);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'nota.txt'), 'gerado na sala');
  assert.equal((await call(`/api/rooms/${room.id}/archive`, { archived: true })).room.archivedAt !== null, true);
  assert.equal((await call(`/api/rooms/${room.id}/messages`, { content: 'oi', mode: 'chat' })).status, 409);
  assert.equal((await call(`/api/rooms/${room.id}/archive`, { archived: false })).room.archivedAt, null);
  app.store.addMessage(room.id, 'user', 'histórico');
  const removed = await call(`/api/rooms/${room.id}`, undefined, 'DELETE');
  assert.equal(removed.deleted, true);
  assert.equal((await call(`/api/rooms/${room.id}/archive`, { archived: true })).status, 404);
  assert.equal(app.store.getRoom(room.id), undefined);
  assert.equal(app.store.messages(room.id).length, 0);
  const trash = await readdir(join(dataDir, 'lixeira'));
  assert.equal(trash.length, 1);
  assert.ok((await stat(join(dataDir, 'lixeira', trash[0], 'arquivos', 'nota.txt'))).isFile());

  const external = await mkdtemp(join(tmpdir(), 'synapse-externa-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  const other = (await call('/api/rooms', { title: 'Externa', settings: { access: 'project', workspace: external } })).room;
  await writeFile(join(external, 'meu.txt'), 'do usuário');
  await call(`/api/rooms/${other.id}`, undefined, 'DELETE');
  assert.ok((await stat(join(external, 'meu.txt'))).isFile(), 'pasta escolhida pelo usuário continua intacta');
});

test('a room with a round in progress cannot be archived or deleted', async (t) => {
  const gate = Promise.withResolvers();
  const { call, app, room } = await server(t, async () => { await gate.promise; return { text: 'ok' }; });
  const job = app.orchestrator.enqueue(room.id, 'Ideia', 'auto', 'chat').job;
  await eventually(() => app.store.getJob(job.id).status === 'running');
  assert.equal((await call(`/api/rooms/${room.id}`, undefined, 'DELETE')).status, 409);
  assert.equal((await call(`/api/rooms/${room.id}/archive`, { archived: true })).status, 409);
  gate.resolve();
  await eventually(() => app.store.getJob(job.id).status === 'completed');
});
