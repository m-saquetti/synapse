// Conexão das contas oficiais (1.6). Cada login roda pelo próprio cliente oficial:
//   GPT    → Codex app-server, account/login/start (login ChatGPT; código de dispositivo como alternativa)
//   Claude → claude auth login --claudeai (assinatura Claude; aceita o código colado se a página pedir)
//   Gemini → Antigravity ACP, authenticate oauth-personal (conta Google)
// A Synapse nunca vê senha nem token: ela abre a página oficial de login, repassa ao cliente o código que você
// colar (só no Claude) e acompanha o resultado. Nada do login é gravado no banco nem nos registros.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentError, authentication, resolveExecutable, safeDiagnostic, stopProcessTree, subscriptionEnvironment } from './agents.mjs';
import { StdioRpc } from './rpc.mjs';

export const ACCOUNT_AGENTS = ['codex', 'claude', 'gemini'];
const NAMES = { codex: 'GPT', claude: 'Claude', gemini: 'Gemini' };
const LOGIN_TIMEOUT_MS = Number(process.env.SYNAPSE_LOGIN_TIMEOUT_MS) || 15 * 60000;
// Só páginas de login dos próprios fornecedores são devolvidas à interface para abrir no navegador.
const LOGIN_HOSTS = /^(?:[a-z0-9-]+\.)*(?:openai\.com|chatgpt\.com|claude\.com|claude\.ai|anthropic\.com|google\.com)$/i;
export function loginUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' && LOGIN_HOSTS.test(url.hostname) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
// Código de autorização colado pelo usuário (formato do Claude Code: "código#estado"). Sem espaços nem controle.
export function validCode(value) {
  const code = String(value ?? '').trim();
  return /^[A-Za-z0-9._~#\-]{8,4096}$/.test(code) ? code : null;
}
// Última linha útil da saída do cliente, sem credenciais nem e-mail, para explicar uma falha.
function lastLine(output) {
  const lines = safeDiagnostic(output, 4000).split(/\r?\n/).map(l => l.replace(/^[\s>]*Paste code here if prompted\s*>\s*/i, '').trim()).filter(Boolean);
  return lines.filter(l => !/^https?:\/\//i.test(l) && !/^If the browser didn.t open/i.test(l) && !/^Opening browser/i.test(l)).at(-1) || '';
}
const publicState = s => ({
  agent: s.agent, status: s.status, method: s.method || null, url: s.url || null, userCode: s.userCode || null,
  acceptsCode: Boolean(s.acceptsCode), codeSent: Boolean(s.codeSent), message: s.message || '', startedAt: s.startedAt || null, finishedAt: s.finishedAt || null,
});

export class Accounts {
  constructor({ dataDir, providers, notify = () => {}, version = '1.6.0' }) {
    Object.assign(this, { dataDir, providers, notify, version });
    this.sessions = new Map();
  }
  get(agent) {
    const s = this.sessions.get(agent);
    return s ? publicState(s) : { agent, status: 'idle', method: null, url: null, userCode: null, acceptsCode: false, codeSent: false, message: '', startedAt: null, finishedAt: null };
  }
  list() { return Object.fromEntries(ACCOUNT_AGENTS.map(agent => [agent, this.get(agent)])); }
  pending(agent) { return this.sessions.get(agent)?.status === 'pending'; }
  emit(agent) { this.notify('account', this.get(agent)); }
  update(session, patch) {
    if (this.sessions.get(session.agent) !== session) return;
    Object.assign(session, patch);
    this.emit(session.agent);
  }
  // Encerra o login com sucesso ou falha. O status das contas é relido pelo servidor (notify → cache invalidado).
  finish(session, ok, message) {
    if (this.sessions.get(session.agent) !== session || session.status !== 'pending') return;
    clearTimeout(session.timer);
    session.status = ok ? 'completed' : 'failed';
    session.message = message || (ok ? `${NAMES[session.agent]} conectado.` : 'O login não foi concluído.');
    session.finishedAt = new Date().toISOString();
    try { (session.close || session.stop)?.(); } catch {}
    this.emit(session.agent);
    if (ok) this.notify('update', { type: 'agent-connected', agent: session.agent });
  }
  async start(agent, { method = 'browser', restart = false } = {}) {
    if (!ACCOUNT_AGENTS.includes(agent)) throw Object.assign(new Error('Participante inválido.'), { statusCode: 400 });
    if (!['browser', 'device'].includes(method)) throw Object.assign(new Error('Forma de login inválida.'), { statusCode: 400 });
    const current = this.sessions.get(agent);
    if (current?.status === 'pending' && !restart) return this.get(agent);
    if (current?.status === 'pending') this.cancel(agent, 'Login reiniciado.');
    const session = { agent, status: 'pending', method, startedAt: new Date().toISOString(), message: 'Abrindo o login oficial…' };
    this.sessions.set(agent, session);
    session.timer = setTimeout(() => this.finish(session, false, 'O tempo para concluir o login acabou. Tente de novo.'), LOGIN_TIMEOUT_MS);
    session.timer.unref?.();
    this.emit(agent);
    try {
      if (agent === 'codex') await this.startCodex(session);
      else if (agent === 'claude') await this.startClaude(session);
      else await this.startGemini(session);
    } catch (error) {
      this.finish(session, false, safeDiagnostic(error.message) || 'Não foi possível abrir o login oficial.');
    }
    return this.get(agent);
  }
  // GPT: o app-server do Codex abre um servidor local para o retorno do login e devolve a página oficial.
  // Se a porta estiver ocupada (outro login aberto), cai para o código de dispositivo.
  async startCodex(session) {
    const file = await resolveExecutable('codex');
    const cwd = join(this.dataDir, 'client-probe'); await mkdir(cwd, { recursive: true });
    let loginId = null;
    const rpc = new StdioRpc(file, ['app-server'], { cwd, onNotification: (method, p) => {
      if (method !== 'account/login/completed') return;
      if (loginId && p?.loginId && p.loginId !== loginId) return;
      this.finish(session, Boolean(p?.success), p?.success ? 'GPT conectado pela conta ChatGPT.' : `O Codex não concluiu o login: ${safeDiagnostic(p?.error) || 'motivo não informado'}.`);
    } });
    session.stop = () => { if (loginId && !rpc.closed) rpc.call('account/login/cancel', { loginId }, 3000).catch(() => {}).finally(() => rpc.close()); else rpc.close(); };
    session.close = () => rpc.close();
    rpc.onClose = () => { if (session.status === 'pending') this.finish(session, false, 'O Codex foi encerrado antes de concluir o login.'); };
    await rpc.call('initialize', { clientInfo: { name: 'mesa_local', title: 'Synapse', version: this.version }, capabilities: { experimentalApi: true } });
    rpc.notify('initialized');
    let result;
    if (session.method === 'device') result = await rpc.call('account/login/start', { type: 'chatgptDeviceCode' });
    else {
      try { result = await rpc.call('account/login/start', { type: 'chatgpt' }); }
      catch (error) {
        result = await rpc.call('account/login/start', { type: 'chatgptDeviceCode' }).catch(() => { throw error; });
        session.method = 'device';
      }
    }
    loginId = result?.loginId || null;
    if (session.status !== 'pending') return;
    if (result?.type === 'chatgptDeviceCode' || result?.userCode) {
      const url = loginUrl(result.verificationUrl);
      if (!url) throw new AgentError('O Codex devolveu um endereço de login inesperado.', 'UNAVAILABLE');
      this.update(session, { method: 'device', url, userCode: String(result.userCode || '').slice(0, 64), message: 'Abra a página do ChatGPT, entre na sua conta e digite o código mostrado aqui.' });
    } else {
      const url = loginUrl(result?.authUrl);
      if (!url) throw new AgentError('O Codex devolveu um endereço de login inesperado.', 'UNAVAILABLE');
      this.update(session, { url, message: 'Entre na sua conta ChatGPT na página aberta no navegador. A Synapse percebe sozinha quando terminar.' });
    }
  }
  // Claude: o próprio Claude Code abre o navegador. Se a página mostrar um código, ele é colado na Synapse e
  // repassado ao cliente, que conclui o login.
  async startClaude(session) {
    const file = await resolveExecutable('claude');
    let output = '';
    const child = spawn(file, ['auth', 'login', '--claudeai'], {
      env: subscriptionEnvironment(), shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    session.child = child;
    session.stop = () => { try { child.stdin.end(); } catch {} stopProcessTree(child); };
    child.stdin.on('error', () => {});
    const read = data => {
      output = (output + data).slice(-16000);
      if (session.status !== 'pending') return;
      const url = !session.url && loginUrl(output.match(/https:\/\/[^\s"'<>]+/)?.[0]);
      if (url) this.update(session, { url, acceptsCode: true, message: 'O Claude Code abriu o login no navegador. Se a página mostrar um código, cole aqui.' });
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.on('error', error => this.finish(session, false, `Não foi possível abrir o Claude Code: ${safeDiagnostic(error.message)}`));
    child.on('close', async code => {
      if (session.status !== 'pending') return;
      if (code !== 0) return this.finish(session, false, `O Claude Code não concluiu o login${lastLine(output) ? `: ${lastLine(output)}` : '.'}`);
      // Confirma pelo próprio cliente que o login é da assinatura (e não da cobrança por API).
      const auth = await authentication('claude', file).catch(() => ({ authenticated: false }));
      if (auth.subscription) this.finish(session, true, 'Claude conectado pela assinatura Claude.');
      else this.finish(session, false, auth.authenticated ? 'O login foi feito, mas não pela assinatura Claude. Entre com a conta do seu plano.' : 'O Claude Code terminou sem confirmar o login.');
    });
  }
  submitCode(agent, value) {
    const session = this.sessions.get(agent);
    if (!session || session.status !== 'pending' || agent !== 'claude' || !session.child) throw Object.assign(new Error('Não há um login do Claude aguardando código.'), { statusCode: 409 });
    const code = validCode(value);
    if (!code) throw Object.assign(new Error('Código inválido. Copie o código inteiro mostrado na página do Claude.'), { statusCode: 400 });
    session.child.stdin.write(code + '\n');
    this.update(session, { codeSent: true, message: 'Código enviado ao Claude Code. Conferindo…' });
    return this.get(agent);
  }
  // Gemini: o Antigravity abre a página do Google. O login vale para os perfis que a Synapse usa.
  async startGemini(session) {
    if (!this.providers?.connectGemini) throw new AgentError('Login do Google indisponível nesta instalação.', 'UNAVAILABLE');
    session.stop = () => this.providers.cancelGeminiLogin?.();
    session.close = () => {};
    const result = await this.providers.connectGemini({
      onDone: (ok, message) => this.finish(session, ok, ok ? 'Gemini conectado pela conta Google (Antigravity).' : `O Antigravity não concluiu o login${message ? `: ${message}` : '.'}`),
    });
    if (session.status === 'pending') this.update(session, { message: result?.message || 'Conclua o login na página do Google aberta pelo Antigravity.' });
  }
  cancel(agent, message = 'Login cancelado.') {
    const session = this.sessions.get(agent);
    if (!session || session.status !== 'pending') return this.get(agent);
    clearTimeout(session.timer);
    session.status = 'cancelled'; session.message = message; session.finishedAt = new Date().toISOString();
    try { session.stop?.(); } catch {}
    this.emit(agent);
    return this.get(agent);
  }
  close() { for (const agent of ACCOUNT_AGENTS) this.cancel(agent, 'A Synapse foi encerrada.'); }
}
