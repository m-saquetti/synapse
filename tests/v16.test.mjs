// Synapse 1.6: pendências registradas até a 1.5 e aplicadas agora.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { Providers } from '../lib/providers.mjs';
import { StdioRpc } from '../lib/rpc.mjs';
import { AgentError } from '../lib/agents.mjs';
import { normalizeUsage, pacificMidnight, studioRequests } from '../lib/analytics.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connected = async () => Object.fromEntries(['codex', 'claude', 'gemini'].map((p) => [p, { available: true, authenticated: true, usage: null }]));
const reply = (texto, status = 'complete') => ({ text: `${texto}\n<mesa_status>${JSON.stringify({ status, summary: 'ok', next: [], decisions: [], tests: [] })}</mesa_status>` });

async function sala(t, runAgent, { settings = {}, getAgentStatus = connected } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'synapse-v16-'));
  const app = await createApp({ dataDir, runAgent, getAgentStatus });
  const url = await app.listen(0);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const boot = await (await fetch(url + '/api/bootstrap')).json(), id = boot.rooms[0].id;
  const call = async (path, body, method = 'POST') => {
    const r = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken }, body: JSON.stringify(body) });
    return { status: r.status, ...(await r.json()) };
  };
  const patch = await call(`/api/rooms/${id}`, { settings: { access: 'project', ...settings } }, 'PATCH');
  assert.equal(patch.status, 200, patch.error);
  const enviar = async (content, mode = 'chat', target = 'auto') => call(`/api/rooms/${id}/messages`, { content, target, mode });
  const terminar = async (jobId) => { for (let n = 0; n < 500; n++) { const job = app.store.getJob(jobId); if (!['queued', 'running'].includes(job.status)) return job; await wait(10); } throw new Error('tarefa não terminou'); };
  const eventos = (jobId) => app.store.events(id).filter((e) => e.jobId === jobId).map((e) => e.activity.title);
  return { app, id, call, enviar, terminar, eventos, dataDir };
}

// ── @menção numa resposta individual ("Só X") ──────────────────────────────────────────────────────────────
test('Chat "Só Claude": a @menção na resposta chama o Gemini, que responde em seguida, e a tarefa termina sem síntese', async (t) => {
  const falas = [];
  const s = await sala(t, async (args) => {
    falas.push(args.agent);
    if (args.agent === 'claude') return reply('Minha proposta. @Gemini, você confirma o limite de requisições?');
    return reply('Confirmo: até 6 por fala.');
  });
  const { job } = await s.enviar('Qual o limite do AI Studio?', 'chat', 'claude');
  const fim = await s.terminar(job.id);
  assert.equal(fim.status, 'completed', fim.error);
  assert.deepEqual(falas, ['claude', 'gemini']);
  assert.ok(s.eventos(job.id).includes('Claude chamou Gemini'));
  const gemini = s.app.store.messages(s.id).find((m) => m.role === 'gemini');
  assert.equal(gemini.debate.stage, 'analise');
  assert.equal(gemini.debate.parentRole, 'claude');
});

test('Chat "Só GPT" sem @menção continua sendo uma resposta só; o prompt explica como chamar um colega', async (t) => {
  const prompts = [];
  const s = await sala(t, async (args) => { prompts.push(args); return reply('Resposta individual, citando Claude sem arroba.'); });
  const { job } = await s.enviar('Explique o plano', 'chat', 'codex');
  const fim = await s.terminar(job.id);
  assert.equal(fim.status, 'completed');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].prompt, /RESPOSTA INDIVIDUAL[\s\S]*@GPT, @Claude ou @Gemini/);
});

test('Code "Só Claude": o colega mencionado revisa o que o Claude fez e a rodada fecha com a aprovação dele', async (t) => {
  const falas = [];
  const s = await sala(t, async (args) => {
    falas.push(`${args.agent}`);
    if (args.agent === 'claude') return reply('Implementei a rota. @GPT, revise os testes de borda.');
    return reply('Revisei: aprovado.');
  });
  const { job } = await s.enviar('Implemente a rota de contas', 'code', 'claude');
  const fim = await s.terminar(job.id);
  assert.equal(fim.status, 'completed', fim.error);
  assert.deepEqual(falas, ['claude', 'codex']);
  const codex = s.app.store.messages(s.id).find((m) => m.role === 'codex');
  assert.equal(codex.debate.stage, 'revisao');
  assert.equal(codex.debate.lead, 'claude');
});

test('menção a si mesmo, a um colega acima do limite preventivo ou dentro de código não vira chamada', async (t) => {
  const status = async () => ({ ...(await connected()), gemini: { available: true, authenticated: true, usage: { observedAt: new Date().toISOString(), windows: [{ id: 'g', label: '5 horas', usedPercent: 97 }] } } });
  const falas = [];
  const s = await sala(t, async (args) => { falas.push(args.agent); return reply('Eu, @Claude, sugiro `@GPT` e chamo @Gemini.'); }, { getAgentStatus: status });
  const { job } = await s.enviar('Opine', 'chat', 'claude');
  const fim = await s.terminar(job.id);
  assert.equal(fim.status, 'completed');
  assert.deepEqual(falas, ['claude']);
  assert.ok(s.eventos(job.id).includes('Chamada para Gemini não atendida'));
});

// ── Gemini Automático no Code com o Antigravity fora ───────────────────────────────────────────────────────
const gemeas = () => {
  const rows = new Map(), store = { providerState: (id) => rows.get(id) || {}, saveProviderState: (id, v) => rows.set(id, v) };
  const p = new Providers({ dataDir: tmpdir(), store });
  p.studioAccess = async () => 'k';
  return { p, rows };
};
const limite = (msg, ms) => Object.assign(new AgentError(msg, 'RATE_LIMIT'), { resetAt: new Date(Date.now() + ms).toISOString() });
const catalogo = (ids) => async () => ids.map((id) => ({ id, label: id, tier: 'Free Tier', availability: 'listed' }));

test('Automático no Code: sem o Antigravity, o Flash do AI Studio vem antes do Hydrogen', async () => {
  const { p } = gemeas();
  p.directCatalog = catalogo(['api:gemini-4-hydrogen', 'api:gemini-3.8-flash', 'api:gemini-3.5-flash-lite']);
  p.runNativeGemini = async () => { throw limite('Antigravity: cota semanal', 3600000); };
  const tentativas = [], avisos = [];
  p.runStudioRoute = async (id, _key, args) => { tentativas.push([id, args.settings.geminiModel]); return { text: 'ok via ' + id }; };
  const r = await p.runGemini({ prompt: 'oi', settings: { access: 'project', geminiModel: 'auto' }, onActivity: (a) => avisos.push(a) });
  assert.equal(r.text, 'ok via api:gemini-3.8-flash');
  assert.deepEqual(tentativas, [['api:gemini-3.8-flash', 'api:gemini-3.8-flash']]);
  assert.match(avisos[0].title, /alternando para AI Studio \(gemini-3\.8-flash\)/);
});

test('Automático no Code: Flash do AI Studio esgotado ou em pausa passa para o Hydrogen; chave inválida não troca', async () => {
  const { p, rows } = gemeas();
  p.directCatalog = catalogo(['api:gemini-4-hydrogen', 'api:gemini-3.8-flash']);
  p.runNativeGemini = async () => { throw limite('Antigravity: cota', 3600000); };
  const tentativas = [];
  p.runStudioRoute = async (id) => { tentativas.push(id); if (id === 'api:gemini-3.8-flash') throw limite('Flash: cota diária', 7200000); return { text: 'hydrogen' }; };
  assert.equal((await p.runGemini({ prompt: 'oi', settings: { access: 'project', geminiModel: 'auto' } })).text, 'hydrogen');
  assert.deepEqual(tentativas, ['api:gemini-3.8-flash', 'api:gemini-4-hydrogen']);
  // Pausa gravada do Flash: nem tenta.
  tentativas.length = 0;
  rows.set('studio', { models: { 'api:gemini-3.8-flash': { until: new Date(Date.now() + 60000).toISOString(), code: 'RATE_LIMIT' } } });
  assert.equal((await p.runGemini({ prompt: 'oi', settings: { access: 'project', geminiModel: 'auto' } })).text, 'hydrogen');
  assert.deepEqual(tentativas, ['api:gemini-4-hydrogen']);
  // Chave recusada não é falha de cota: não tenta o Hydrogen (mesma chave). Como antes da 1.6, o erro mantém o
  // limite do Antigravity como motivo principal e cita a chave.
  rows.clear(); tentativas.length = 0;
  p.runStudioRoute = async (id) => { tentativas.push(id); throw new AgentError('chave recusada', 'AUTH_REQUIRED'); };
  await assert.rejects(p.runGemini({ prompt: 'oi', settings: { access: 'project', geminiModel: 'auto' } }), { code: 'RATE_LIMIT', message: /A outra rota também falhou: chave recusada/ });
  assert.deepEqual(tentativas, ['api:gemini-3.8-flash']);
});

test('Automático no Chat continua pelo Hydrogen; Flash escolhido no Antigravity mantém o Hydrogen como reserva', async () => {
  const { p } = gemeas();
  p.directCatalog = catalogo(['api:gemini-4-hydrogen', 'api:gemini-3.8-flash']);
  const tentativas = [];
  p.runStudioRoute = async (id) => { tentativas.push(id); return { text: id }; };
  assert.equal((await p.runGemini({ prompt: 'oi', settings: { access: 'chat', geminiModel: 'auto' } })).text, 'api:gemini-4-hydrogen');
  p.runNativeGemini = async () => { throw limite('Antigravity: cota', 3600000); };
  assert.equal((await p.runGemini({ prompt: 'oi', settings: { access: 'project', geminiModel: 'gemini-3.8-flash' } })).text, 'api:gemini-4-hydrogen');
});

// ── Uso do Gemini pela origem ──────────────────────────────────────────────────────────────────────────────
test('requisições do AI Studio contadas desde a meia-noite do Pacífico, por modelo; Antigravity não entra na conta', () => {
  assert.equal(pacificMidnight(Date.parse('2026-11-24T19:00:00Z')), '2026-11-24T08:00:00.000Z');
  assert.equal(pacificMidnight(Date.parse('2026-11-24T06:00:00Z')), '2026-11-23T08:00:00.000Z');
  assert.equal(pacificMidnight(Date.parse('2026-07-01T12:00:00Z')), '2026-07-01T07:00:00.000Z');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE messages (role TEXT, status TEXT, model TEXT, usage TEXT, createdAt TEXT)');
  const add = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)');
  add.run('gemini', 'completed', 'gemini-4-hydrogen', JSON.stringify({ promptTokenCount: 10, requests: 5 }), '2026-11-24T10:00:00Z');
  add.run('gemini', 'interrupted', 'gemini-4-hydrogen', JSON.stringify({ promptTokenCount: 10, requests: 2, partialUsage: true }), '2026-11-24T11:00:00Z');
  add.run('gemini', 'completed', 'api:gemini-3.8-flash', JSON.stringify({ promptTokenCount: 10 }), '2026-11-24T12:00:00Z');
  add.run('gemini', 'completed', 'gemini-3.8-flash', JSON.stringify({ inputTokens: 900 }), '2026-11-24T12:30:00Z'); // Antigravity
  add.run('gemini', 'completed', 'gemini-4-hydrogen', JSON.stringify({ promptTokenCount: 10, requests: 9 }), '2026-11-24T07:00:00Z'); // antes da renovação
  add.run('claude', 'completed', 'claude', JSON.stringify({ promptTokenCount: 1 }), '2026-11-24T12:00:00Z');
  assert.deepEqual(studioRequests(db, '2026-11-24T08:00:00.000Z'), [{ model: 'gemini-4-hydrogen', requests: 7, falas: 2 }, { model: 'gemini-3.8-flash', requests: 1, falas: 1 }]);
  const semTokens={partialUsage:true,studioRequestsByModel:{'gemini-3.8-flash':2,'gemini-4-hydrogen':1}};
  add.run('gemini','interrupted',null,JSON.stringify(semTokens),'2026-11-24T13:00:00Z');
  assert.equal(normalizeUsage('gemini',semTokens),null);
  assert.deepEqual(studioRequests(db,'2026-11-24T08:00:00.000Z'),[{model:'gemini-4-hydrogen',requests:8,falas:3},{model:'gemini-3.8-flash',requests:3,falas:2}]);
});

test('status do Gemini traz as origens: requisições de hoje, pausas do AI Studio e do Antigravity', () => {
  const rows = new Map([['studio', { models: { 'api:gemini-4-hydrogen': { until: new Date(Date.now() + 3600000).toISOString(), code: 'RATE_LIMIT' } } }], ['antigravity', { until: new Date(Date.now() + 7200000).toISOString() }]]);
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE messages (role TEXT, status TEXT, model TEXT, usage TEXT, createdAt TEXT)');
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run('gemini', 'completed', 'gemini-4-hydrogen', JSON.stringify({ promptTokenCount: 1, requests: 4 }), new Date().toISOString());
  const p = new Providers({ dataDir: tmpdir(), store: { db, providerState: (id) => rows.get(id) || {}, saveProviderState: () => {} } });
  const [studio, native] = p.geminiOrigins({ studio: true, native: true });
  assert.deepEqual(studio.items, [{ model: 'Gemini 4 Hydrogen', requests: 4, falas: 1 }]);
  assert.equal(studio.paused[0].model, 'Gemini 4 Hydrogen');
  assert.equal(native.paused.length, 1);
  assert.equal(native.connected, true);
});

// ── Teto de ferramentas com resposta final (Claude e GPT) ─────────────────────────────────────────────────
import { chmod, mkdir, writeFile, readFile } from 'node:fs/promises';
import { normalizeSettings } from '../lib/settings.mjs';
import { claudeOptions, codexConfig, toolCapFor } from '../lib/providers.mjs';
import { codexUserServers, excludedUserServers, userMcpServers } from '../lib/integrations.mjs';

// Como o Agent SDK real (0.3.325, sonda em ../../work/sonda-teto-claude.mjs): depois do result error_max_turns, o
// iterador lança "Claude Code returned an error result: Reached maximum number of turns (N)".
const consulta = (eventos) => { const it = (async function* () {
  for (const e of eventos) yield e;
  if (eventos.at(-1)?.subtype === 'error_max_turns') throw new Error('Claude Code returned an error result: Reached maximum number of turns (2)');
})(); it.close = () => {}; return it; };

test('Claude: outro erro do SDK continua derrubando a fala; só o do teto é absorvido', async () => {
  const p = new Providers({ dataDir: tmpdir(), store: { providerState: () => ({}), saveProviderState: () => {} } });
  p.claudeOptions = async (_c, _s, extra) => ({ ...extra });
  p.claudeQuery = () => { const it = (async function* () { yield { type: 'assistant', session_id: 'S', message: { id: 'a', content: [{ type: 'text', text: 'x' }] } }; throw new Error('Claude Code process exited with code 1'); })(); it.close = () => {}; return it; };
  await assert.rejects(p.runClaude({ cwd: tmpdir(), prompt: 'x', settings: normalizeSettings({ access: 'project', toolCallLimit: 10 }), controller: new AbortController() }), /exited with code 1/);
});

test('Claude: uma falha de transporte depois do aviso de teto preserva o erro original', async () => {
  const p = new Providers({ dataDir: tmpdir(), store: { providerState: () => ({}), saveProviderState: () => {} } });
  p.claudeOptions = async (_cwd, _settings, extra) => ({ ...extra });
  const failure = new Error('SDK transport disconnected');
  let queries = 0;
  p.claudeQuery = () => {
    queries++;
    const events = (async function* () {
      yield { type: 'result', subtype: 'error_max_turns', session_id: 'S' };
      throw failure;
    })();
    events.close = () => {};
    return events;
  };
  await assert.rejects(p.runClaude({ cwd: tmpdir(), prompt: 'x', settings: normalizeSettings({ access: 'project', toolCallLimit: 10 }), controller: new AbortController() }), error => error === failure);
  assert.equal(queries, 1);
});

test('Claude no teto: a mesma sessão fecha a fala sem ferramentas, com o uso somado das duas consultas', async () => {
  const p = new Providers({ dataDir: tmpdir(), store: { providerState: () => ({}), saveProviderState: () => {} } });
  const chamadas = [];
  p.claudeOptions = async (_cwd, _settings, extra) => ({ disallowedTools: ['WebFetch'], tools: ['Read', 'Bash'], ...extra });
  p.claudeQuery = ({ prompt, options }) => {
    chamadas.push({ prompt, options });
    if (chamadas.length === 1) return consulta([
      { type: 'assistant', session_id: 'S1', message: { id: 'a1', content: [{ type: 'text', text: 'Lendo os arquivos…' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.mjs' } }] } },
      { type: 'result', subtype: 'error_max_turns', session_id: 'S1', usage: { input_tokens: 10, cache_read_input_tokens: 900, output_tokens: 20 } },
    ]);
    return consulta([
      { type: 'assistant', session_id: 'S1', message: { id: 'a2', content: [{ type: 'text', text: 'Fechamento com o que verifiquei.' }] } },
      { type: 'result', subtype: 'success', session_id: 'S1', result: 'Fechamento com o que verifiquei.', usage: { input_tokens: 4, cache_read_input_tokens: 950, output_tokens: 60, output_tokens_details: { thinking_tokens: 7 } } },
    ]);
  };
  const avisos = [];
  const r = await p.runClaude({ cwd: tmpdir(), prompt: 'Implemente', settings: normalizeSettings({ access: 'project', toolCallLimit: 25 }), onActivity: (a) => avisos.push(a), controller: new AbortController() });
  assert.equal(chamadas[0].options.maxTurns, 25);
  assert.equal(chamadas[1].options.resume, 'S1');
  assert.equal(chamadas[1].options.maxTurns, 1);
  assert.deepEqual(chamadas[1].options.tools, []);
  assert.deepEqual(chamadas[1].options.disallowedTools, ['WebFetch', 'mcp__*']);
  assert.deepEqual(await chamadas[1].options.canUseTool('Bash', {}), { behavior: 'deny', message: 'O teto de ferramentas desta fala foi atingido. Responda sem ferramentas.' });
  assert.match(chamadas[1].prompt, /teto de 25 chamadas de ferramenta[\s\S]*<mesa_status>/);
  assert.equal(r.text, 'Fechamento com o que verifiquei.');
  assert.equal(r.toolCap, 25);
  assert.deepEqual({ ...r.usage }, { input_tokens: 14, cache_read_input_tokens: 1850, output_tokens: 80, output_tokens_details: { thinking_tokens: 7 } });
  assert.ok(avisos.some((a) => a.title === 'Teto de ferramentas · Claude fecha a fala'));
});

test('teto desligado com 0 e nunca aplicado no Chat; configuração aceita 0 ou de 10 a 300', async () => {
  assert.equal(toolCapFor(normalizeSettings({ access: 'chat', toolCallLimit: 40 })), 0);
  assert.equal(toolCapFor(normalizeSettings({ access: 'project', toolCallLimit: 0 })), 0);
  assert.equal(toolCapFor(normalizeSettings({ access: 'computer' })), 80);
  for (const ruim of [5, 301, 12.5, '40']) assert.throws(() => normalizeSettings({ toolCallLimit: ruim }), /chamadas de ferramenta/);
  const p = new Providers({ dataDir: tmpdir(), store: { providerState: () => ({}), saveProviderState: () => {} } });
  const opcoes = [];
  p.claudeOptions = async (_c, _s, extra) => ({ ...extra });
  p.claudeQuery = ({ options }) => { opcoes.push(options); return consulta([{ type: 'result', subtype: 'success', session_id: 'S', result: 'ok' }]); };
  await p.runClaude({ cwd: tmpdir(), prompt: 'oi', settings: normalizeSettings({ access: 'chat' }), controller: new AbortController() });
  assert.equal(opcoes[0].maxTurns, undefined);
});

// Codex app-server simulado: após dez comandos, só o pedido de interrupção libera o fechamento.
const CODEX_TETO = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'login') { process.stdout.write('Logged in using ChatGPT\\n'); process.exit(0); }
let buf = '', turnos = 0;
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    const m = JSON.parse(line);
    fs.appendFileSync(process.env.FAKE_LOG, m.method + (m.method === 'turn/start' ? ' ' + JSON.stringify(m.params.input[0].text) : '') + '\\n');
    if (m.method === 'initialize') send({ id: m.id, result: {} });
    else if (m.method === 'config/read') send({ id: m.id, result: { config: {} } });
    else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'T1' }, model: 'gpt-teste' } });
    else if (m.method === 'turn/start') {
      turnos++;
      const id = 'U' + turnos;
      send({ id: m.id, result: { turn: { id } } });
      send({ method: 'turn/started', params: { threadId: 'T1', turn: { id } } });
      if (turnos === 1) for (let n = 0; n < 10; n++) {
        const params = { threadId: 'T1', turnId: id, item: { type: 'commandExecution', id: 'c' + n, command: 'cat f' + n } };
        send({ method: 'item/started', params }); send({ method: 'item/completed', params });
      }
      else { send({ method: 'item/completed', params: { threadId: 'T1', item: { type: 'agentMessage', id: 'm2', phase: 'final_answer', text: 'Fechei a fala no teto.' } } });
        send({ method: 'turn/completed', params: { threadId: 'T1', turn: { id, status: 'completed' } } }); }
    } else if (m.method === 'turn/interrupt') { send({ id: m.id, result: {} }); send({ method: 'turn/completed', params: { threadId: 'T1', turn: { id: m.params.turnId, status: 'interrupted' } } }); }
    else if (m.id !== undefined) send({ id: m.id, result: {} });
  }
});
`;
test('GPT no teto: interrompe a fala e um turno de fechamento na mesma conversa responde', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'synapse-teto-'));
  const bin = join(dir, 'codex.cjs'), log = join(dir, 'log.txt');
  await writeFile(bin, CODEX_TETO); await writeFile(log, '');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const p = new Providers({ dataDir: dir, store: { providerState: () => ({}), saveProviderState: () => {} } });
  const avisos = [];
  p.openCodex = options => new StdioRpc(process.execPath, [bin], { ...options, cwd: tmpdir(), env: { ...process.env, FAKE_LOG: log } });
  const r = await p.runCodex({ cwd: dir, prompt: 'Implemente', settings: normalizeSettings({ access: 'project', toolCallLimit: 10, reaEnabled: false, browserEnabled: false, githubEnabled: false }), signal: AbortSignal.timeout(10000), onActivity: (a) => avisos.push(a) });
  assert.equal(r.text, 'Fechei a fala no teto.');
  assert.equal(r.toolCap, 10);
  assert.equal(r.sessionId, 'T1');
  const registro = await readFile(log, 'utf8');
  assert.match(registro, /turn\/interrupt/);
  assert.match(registro, /turn\/start "\[Synapse\] Esta fala atingiu o teto de 10/);
  assert.match(registro, /10 chamadas iniciadas e 10 encerradas/);
  assert.ok(avisos.some((a) => a.title === 'Teto de ferramentas · GPT fecha a fala'));
});

// ── Servidores MCP do usuário por sala ─────────────────────────────────────────────────────────────────────
async function mcpFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'synapse-mcp-'));
  const appdata = join(dir, 'appdata'), reaPath = join(appdata, 'npm', 'node_modules', 'rea-agents', 'scripts', 'rea.mjs');
  await mkdir(join(reaPath, '..'), { recursive: true }); await writeFile(reaPath, '');
  const claudeDir = join(dir, 'claude'), codexDir = join(dir, 'codex-home'); await mkdir(claudeDir); await mkdir(codexDir);
  await writeFile(join(claudeDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'pessoa@exemplo.com' }, mcpServers: { rea: { command: 'node', args: [reaPath, '--mcp'] }, notion: { command: 'npx', args: ['@notionhq/mcp'], env: { NOTION_TOKEN: 'segredo' } } } }));
  await writeFile(join(codexDir, 'config.toml'), `[mcp_servers.rea]\ncommand = "node"\nargs = ["${reaPath.replaceAll('\\', '\\\\')}", "--mcp"]\n\n[mcp_servers.linear]\ncommand = "npx"\nargs = ["linear-mcp"]\n[mcp_servers.linear.env]\nLINEAR_KEY = "segredo"\n`);
  const antes = { APPDATA: process.env.APPDATA, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  Object.assign(process.env, { APPDATA: appdata, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir });
  t.after(async () => { for (const [k, v] of Object.entries(antes)) if (v === undefined) delete process.env[k]; else process.env[k] = v; await rm(dir, { recursive: true, force: true }); });
  return { dir, reaPath };
}

test('lista de servidores MCP do usuário: só nomes, clientes e a integração equivalente — sem comandos nem segredos', async (t) => {
  await mcpFixture(t);
  const lista = await userMcpServers();
  assert.deepEqual(lista, [
    { name: 'linear', clients: ['codex'], integration: null },
    { name: 'notion', clients: ['claude'], integration: null },
    { name: 'rea', clients: ['claude', 'codex'], integration: 'rea' },
  ]);
  assert.doesNotMatch(JSON.stringify(lista), /segredo|pessoa@|npx|node/);
  assert.equal((await codexUserServers()).length, 2, 'a subtabela .env não vira servidor');
});

test('REA desligado na sala tira também o REA do usuário; a lista da sala tira os escolhidos (Codex e Claude)', async (t) => {
  const { reaPath } = await mcpFixture(t);
  const servers = [{ name: 'rea', args: [reaPath, '--mcp'] }, { name: 'notion', args: ['@notionhq/mcp'] }];
  const catalogoRea = [{ id: 'rea', args: [reaPath, '--mcp'] }];
  assert.deepEqual(excludedUserServers(normalizeSettings({ mcpExclude: ['notion'] }), servers, []), ['notion']);
  assert.deepEqual(excludedUserServers(normalizeSettings({}), servers, catalogoRea), ['rea']);
  // Codex: config/read devolve os servidores herdados; os excluídos vão com enabled:false.
  const rpc = { call: async () => ({ config: { mcp_servers: { rea: { command: 'node', args: [reaPath, '--mcp'] }, linear: { command: 'npx', args: ['linear-mcp'] } } } }) };
  const total = { access: 'project', internet: false, fullIntegration: true };
  const semRea = await codexConfig(normalizeSettings({ ...total, reaEnabled: false }), rpc, tmpdir());
  assert.deepEqual(semRea.mcp_servers, { rea: { enabled: false } });
  const escolhidos = await codexConfig(normalizeSettings({ ...total, reaEnabled: true, mcpExclude: ['linear'] }), rpc, tmpdir());
  assert.deepEqual(escolhidos.mcp_servers, { linear: { enabled: false } }, 'o REA do usuário segue e a cópia mesa_rea não duplica');
  assert.throws(() => normalizeSettings({ mcpExclude: ['nome com espaço'] }), /servidores MCP/);
  assert.deepEqual(normalizeSettings({ mcpExclude: ['b', 'a', 'b'] }).mcpExclude, ['a', 'b']);
});

test('Claude Code na integração total: servidores fora da sala saem do contexto (disallowedTools mcp__nome)', { skip: process.platform === 'win32' }, async (t) => {
  const { dir } = await mcpFixture(t);
  const bin = join(dir, 'claude-bin');
  await writeFile(bin, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'}));\n`);
  await chmod(bin, 0o755);
  const antes = process.env.MESA_CLAUDE_BIN; process.env.MESA_CLAUDE_BIN = bin;
  t.after(() => { if (antes === undefined) delete process.env.MESA_CLAUDE_BIN; else process.env.MESA_CLAUDE_BIN = antes; });
  const total = { access: 'project', internet: false, fullIntegration: true };
  const semRea = await claudeOptions(tmpdir(), normalizeSettings({ ...total, reaEnabled: false, mcpExclude: ['notion'] }));
  assert.deepEqual(semRea.disallowedTools, ['WebSearch', 'WebFetch', 'mcp__rea', 'mcp__notion']);
  assert.deepEqual(semRea.mcpServers, {});
  const comRea = await claudeOptions(tmpdir(), normalizeSettings({ ...total, reaEnabled: true }));
  assert.deepEqual(comRea.disallowedTools, ['WebSearch', 'WebFetch']);
  assert.deepEqual(comRea.mcpServers, {}, 'o REA do usuário já carrega; a cópia mesa_rea não duplica');
  const padrao = await claudeOptions(tmpdir(), normalizeSettings({ access: 'project', reaEnabled: false, mcpExclude: ['notion'] }));
  assert.equal(padrao.disallowedTools, undefined, 'fora da integração total o Claude Code já roda sem os MCP do usuário');
});

test('teto sem resumo do participante: a fala fecha com o aviso da Synapse e o que já tinha sido escrito', async () => {
  const p = new Providers({ dataDir: tmpdir(), store: { providerState: () => ({}), saveProviderState: () => {} } });
  let n = 0;
  p.claudeOptions = async (_c, _s, extra) => ({ ...extra });
  p.claudeQuery = () => (++n === 1
    ? consulta([{ type: 'assistant', session_id: 'S', message: { id: 'a', content: [{ type: 'text', text: 'Alterei a.mjs.' }] } }, { type: 'result', subtype: 'error_max_turns', session_id: 'S' }])
    : consulta([{ type: 'result', subtype: 'error_max_turns', session_id: 'S' }]));
  const r = await p.runClaude({ cwd: tmpdir(), prompt: 'x', settings: normalizeSettings({ access: 'project', toolCallLimit: 10 }), controller: new AbortController() });
  assert.match(r.text, /^Alterei a\.mjs\.\n\n\[Synapse\] Esta fala atingiu o teto de 10 chamadas/);
  assert.equal(r.toolCap, 10);
});
