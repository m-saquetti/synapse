// 1.6 — Botão Conectar/Reconectar: login pelos clientes oficiais (Codex, Claude Code, Antigravity).
// Os clientes são simulados por scripts locais: nenhum login real, nenhuma rede.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts, loginUrl, validCode } from '../lib/accounts.mjs';
import { createApp } from '../server.mjs';

const unix = process.platform !== 'win32';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(15); }
  throw new Error('tempo esgotado');
}
// Codex app-server simulado: initialize, account/login/start e a notificação de conclusão.
const CODEX = `#!/usr/bin/env node
const mode = process.env.FAKE_CODEX_MODE || 'ok';
let buf = '';
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake' } });
    else if (m.method === 'account/login/start' && m.params.type === 'chatgpt') {
      if (mode === 'busy') send({ id: m.id, error: { code: -32000, message: 'Port 1455 is already in use' } });
      else if (mode === 'evil') send({ id: m.id, result: { type: 'chatgpt', loginId: 'L1', authUrl: 'http://evil.example/login' } });
      else { send({ id: m.id, result: { type: 'chatgpt', loginId: 'L1', authUrl: 'https://auth.openai.com/oauth/authorize?client_id=x' } });
        if (mode !== 'hold') setTimeout(() => send({ method: 'account/login/completed', params: { loginId: 'L1', success: mode !== 'denied', error: mode === 'denied' ? 'access_denied' : null } }), 80); }
    } else if (m.method === 'account/login/start' && m.params.type === 'chatgptDeviceCode') {
      send({ id: m.id, result: { type: 'chatgptDeviceCode', loginId: 'D1', userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device' } });
    } else if (m.method === 'account/login/cancel') { require('node:fs').appendFileSync(process.env.FAKE_LOG, 'cancel ' + m.params.loginId + '\\n'); send({ id: m.id, result: {} }); }
    else if (m.id !== undefined) send({ id: m.id, result: {} });
  }
});
`;
// Claude Code simulado: auth login imprime a página e espera o código; auth status confirma a assinatura.
const CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
const state = process.env.FAKE_STATE;
if (args === 'auth status --json') {
  const ok = fs.existsSync(state);
  process.stdout.write(JSON.stringify(ok ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', email: 'pessoa@exemplo.com' } : { loggedIn: false }));
  process.exit(ok ? 0 : 1);
}
if (args === 'auth login --claudeai') {
  fs.appendFileSync(process.env.FAKE_LOG, 'login\\n');
  process.stdout.write("Opening browser to sign in…\\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\\nPaste code here if prompted > ");
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', d => {
    buf += d; if (!buf.includes('\\n')) return;
    const code = buf.trim();
    fs.appendFileSync(process.env.FAKE_LOG, 'code-length ' + code.length + '\\n');
    if (code === 'BOM-CODIGO#estado') { fs.writeFileSync(state, 'ok'); process.stdout.write('Login successful.\\n'); process.exit(0); }
    process.stdout.write("Login failed: That code wasn't accepted. Sign in again to get a new code.\\n"); process.exit(1);
  });
  setInterval(() => {}, 1000);
} else process.exit(2);
`;
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'synapse-contas-'));
  const codex = join(dir, 'codex'), claude = join(dir, 'claude'), log = join(dir, 'log.txt');
  await writeFile(codex, CODEX); await writeFile(claude, CLAUDE); await writeFile(log, '');
  await chmod(codex, 0o755); await chmod(claude, 0o755);
  const env = { MESA_CODEX_BIN: codex, MESA_CLAUDE_BIN: claude, FAKE_LOG: log, FAKE_STATE: join(dir, 'claude-ok') };
  const before = Object.fromEntries(Object.keys({ ...env, FAKE_CODEX_MODE: 1 }).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  const events = [];
  const accounts = new Accounts({ dataDir: dir, notify: (event, data) => events.push([event, data]) });
  t.after(async () => {
    accounts.close();
    for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, log, accounts, events };
}

test('só páginas oficiais de login chegam à interface; o código colado não aceita espaços nem controle', () => {
  assert.equal(loginUrl('https://auth.openai.com/oauth/authorize?x=1'), 'https://auth.openai.com/oauth/authorize?x=1');
  assert.equal(loginUrl('https://claude.com/cai/oauth/authorize?code=true'), 'https://claude.com/cai/oauth/authorize?code=true');
  assert.equal(loginUrl('https://accounts.google.com/o/oauth2/auth'), 'https://accounts.google.com/o/oauth2/auth');
  for (const ruim of ['http://auth.openai.com/x', 'https://openai.com.evil.net/x', 'https://user:senha@claude.ai/', 'javascript:alert(1)', 'file:///c:/x', ''])
    assert.equal(loginUrl(ruim), null, ruim);
  assert.equal(validCode('  abcDEF123-_.~#estado \n'), 'abcDEF123-_.~#estado');
  for (const ruim of ['curto', 'tem espaço no meio', 'linha\nquebrada', 'x'.repeat(5000), '<script>'])
    assert.equal(validCode(ruim), null, ruim);
});

test('GPT: login ChatGPT pelo app-server do Codex, concluído pela notificação oficial', { skip: !unix }, async t => {
  const { accounts, events } = await fixture(t);
  const started = await accounts.start('codex');
  assert.equal(started.status, 'pending');
  assert.equal(started.url, 'https://auth.openai.com/oauth/authorize?client_id=x');
  assert.equal(started.method, 'browser');
  await until(() => accounts.get('codex').status === 'completed');
  assert.match(accounts.get('codex').message, /GPT conectado/);
  assert.ok(events.some(([e, d]) => e === 'update' && d.type === 'agent-connected' && d.agent === 'codex'));
  // Um segundo clique durante o login não abre outro; depois de concluído, abre um novo.
  process.env.FAKE_CODEX_MODE = 'hold';
  const a = await accounts.start('codex'); const b = await accounts.start('codex');
  assert.equal(a.startedAt, b.startedAt);
});

test('GPT: porta de retorno ocupada cai para o código de dispositivo; recusa e endereço estranho viram falha', { skip: !unix }, async t => {
  const { accounts } = await fixture(t);
  process.env.FAKE_CODEX_MODE = 'busy';
  const device = await accounts.start('codex');
  assert.equal(device.method, 'device');
  assert.equal(device.userCode, 'ABCD-1234');
  assert.equal(device.url, 'https://auth.openai.com/codex/device');
  accounts.cancel('codex');
  process.env.FAKE_CODEX_MODE = 'denied';
  await accounts.start('codex', { restart: true });
  await until(() => accounts.get('codex').status === 'failed');
  assert.match(accounts.get('codex').message, /não concluiu o login: access_denied/);
  process.env.FAKE_CODEX_MODE = 'evil';
  const evil = await accounts.start('codex', { restart: true });
  assert.equal(evil.status, 'failed');
  assert.equal(evil.url, null);
  assert.match(evil.message, /endereço de login inesperado/);
});

test('GPT: cancelar avisa o Codex (account/login/cancel) e libera um novo login', { skip: !unix }, async t => {
  const { accounts, log } = await fixture(t);
  process.env.FAKE_CODEX_MODE = 'hold';
  await accounts.start('codex');
  const cancelled = accounts.cancel('codex');
  assert.equal(cancelled.status, 'cancelled');
  const { readFile } = await import('node:fs/promises');
  await until(async () => (await readFile(log, 'utf8')).includes('cancel L1'));
  const again = await accounts.start('codex');
  assert.equal(again.status, 'pending');
});

test('Claude: o código colado vai ao Claude Code e o login só vale com a assinatura confirmada', { skip: !unix }, async t => {
  const { accounts, log, events } = await fixture(t);
  await accounts.start('claude');
  const waiting = await until(() => accounts.get('claude').url && accounts.get('claude'));
  assert.equal(waiting.url, 'https://claude.com/cai/oauth/authorize?code=true&state=abc');
  assert.equal(waiting.acceptsCode, true);
  assert.throws(() => accounts.submitCode('claude', 'com espaço'), { statusCode: 400 });
  assert.throws(() => accounts.submitCode('codex', 'BOM-CODIGO#estado'), { statusCode: 409 });
  const sent = accounts.submitCode('claude', ' BOM-CODIGO#estado ');
  assert.equal(sent.codeSent, true);
  await until(() => accounts.get('claude').status === 'completed');
  assert.match(accounts.get('claude').message, /assinatura Claude/);
  const { readFile } = await import('node:fs/promises');
  const registro = await readFile(log, 'utf8');
  assert.match(registro, /code-length 17/);
  // Nada do código nem do e-mail aparece no estado público ou nos avisos.
  const publico = JSON.stringify([accounts.list(), events]);
  assert.doesNotMatch(publico, /BOM-CODIGO|pessoa@exemplo/);
});

test('Claude: código recusado encerra com o motivo do cliente; cancelar encerra o processo', { skip: !unix }, async t => {
  const { accounts } = await fixture(t);
  await accounts.start('claude');
  await until(() => accounts.get('claude').acceptsCode);
  accounts.submitCode('claude', 'CODIGO-ERRADO#x');
  await until(() => accounts.get('claude').status === 'failed');
  assert.match(accounts.get('claude').message, /não concluiu o login: Login failed: That code wasn.t accepted/);
  await accounts.start('claude');
  await until(() => accounts.get('claude').acceptsCode);
  const child = accounts.sessions.get('claude').child;
  assert.equal(accounts.cancel('claude').status, 'cancelled');
  await until(() => child.exitCode !== null || child.signalCode !== null);
});

test('Gemini: o login do Google segue pelo Antigravity e informa a conclusão', async t => {
  let done, cancelled = 0;
  const providers = { connectGemini: async ({ onDone }) => { done = onDone; return { status: 'pending', message: 'Conclua no Google.' }; }, cancelGeminiLogin: () => cancelled++ };
  const accounts = new Accounts({ dataDir: tmpdir(), providers });
  t.after(() => accounts.close());
  const pending = await accounts.start('gemini');
  assert.equal(pending.status, 'pending'); assert.equal(pending.message, 'Conclua no Google.');
  done(true);
  assert.equal(accounts.get('gemini').status, 'completed');
  assert.equal(cancelled, 0, 'concluir não cancela o login do Antigravity');
  await accounts.start('gemini');
  accounts.cancel('gemini');
  assert.equal(cancelled, 1);
  await accounts.start('gemini');
  done(false, 'access_denied');
  assert.match(accounts.get('gemini').message, /não concluiu o login: access_denied/);
});

test('rotas de contas exigem a sessão da Synapse e validam participante, forma de login e código', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'synapse-contas-api-'));
  const calls = [];
  const fake = { list: () => ({ codex: { agent: 'codex', status: 'idle' } }), close: () => {},
    start: async (agent, opts) => { calls.push(['start', agent, opts]); return { agent, status: 'pending' }; },
    submitCode: (agent, code) => { calls.push(['code', agent, code.length]); return { agent, status: 'pending', codeSent: true }; },
    cancel: agent => { calls.push(['cancel', agent]); return { agent, status: 'cancelled' }; } };
  const app = await createApp({ dataDir, getAgentStatus: async () => ({}), accounts: fake });
  const url = await app.listen(0);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const boot = await (await fetch(`${url}/api/bootstrap`)).json();
  assert.deepEqual(boot.accounts, { codex: { agent: 'codex', status: 'idle' } });
  const post = (path, body, token = boot.csrfToken) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-CSRF-Token': token } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post('/api/accounts/claude/login', {}, null)).status, 403);
  assert.equal((await post('/api/accounts/outro/login', {})).status, 404);
  assert.equal((await post('/api/accounts/codex/login', { method: 'senha' })).status, 400);
  assert.equal((await post('/api/accounts/codex/login', { method: 'device', restart: true })).status, 202);
  assert.equal((await post('/api/accounts/claude/code', { code: 'X'.repeat(12) })).status, 200);
  assert.equal((await post('/api/accounts/gemini/cancel', {})).status, 200);
  assert.equal((await post('/api/agents/gemini/connect', {})).status, 202);
  assert.deepEqual(calls, [['start', 'codex', { method: 'device', restart: true }], ['code', 'claude', 12], ['cancel', 'gemini'], ['start', 'gemini', undefined]]);
});
