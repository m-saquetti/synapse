import { spawn } from 'node:child_process';
import { access, lstat, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { normalizeSettings } from './settings.mjs';

const LABELS = { codex: 'Codex', claude: 'Claude' };
const MAX_OUTPUT = 4 * 1024 * 1024;

export class AgentError extends Error {
  constructor(message, code = 'AGENT_FAILED') {
    super(message);
    this.name = 'AgentError';
    this.code = code;
  }
}

// Use native login storage. Never inherit API billing, cloud-provider credentials,
// app-internal IPC channels or a parent agent's execution privileges.
export function subscriptionEnvironment(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (/^(SYNAPSE_GEMINI_API_KEY$|OPENAI_|AZURE_OPENAI_|ANTHROPIC_|AWS_|GOOGLE_APPLICATION_CREDENTIALS$|GOOGLE_API_KEY$|GEMINI_API_KEY$|GOOGLE_GENAI_USE_|GOOGLE_CLOUD_PROJECT$|GOOGLE_CLOUD_LOCATION$|CLOUD_ML_REGION$)/i.test(key)) continue;
    if (/^CLAUDE/i.test(key)) continue;
    if (/^CODEX_/i.test(key) && key.toUpperCase() !== 'CODEX_HOME') continue;
    if (/^(NODE_OPTIONS|NODE_EXTRA_CA_CERTS)$/i.test(key)) continue;
    if (/^ELECTRON_/i.test(key)) continue;
    env[key] = value;
  }
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  return env;
}

export function safeDiagnostic(value,maxLength=900) {
  return String(value || '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\b(?:AQ\.[\w-]{20,}|AIza[\w-]{25,})/g, '[credencial ocultada]')
    .replace(/\b(?:sk-|sk-ant-)[A-Za-z0-9_-]{8,}\b/g, '[credencial ocultada]')
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, 'Bearer [oculto]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[e-mail ocultado]')
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|authorization)["'\s]*[:=]["'\s]*)[^\s,"'}]+/gi, '$1[oculto]')
    .trim().slice(0, maxLength);
}

export function classifyFailure(message, agent = '') {
  const detail = safeDiagnostic(message);
  const label = LABELS[agent] || (agent==='gemini'?'Gemini':'Agente');
  if (/resource_exhausted|\b429\b|rate.?limit|usage.?limit|limit.*reached|out of.*usage|quota|too many requests|exceeded.*limit|hit your[^\n.]{0,50}limit|resets? at/i.test(detail)) {
    return new AgentError(`${label}: limite de uso atingido. Aguarde a renovação do limite antes de tentar novamente. ${detail}`, 'RATE_LIMIT');
  }
  if (/can.?t use your Claude subscription|payment (?:is )?past due|pay or renew|subscription (?:has )?expired|subscription required|requires (?:a )?(?:pro|paid)|upgrade your plan|requires an active subscription/i.test(detail)) return new AgentError(label + ': o plano atual não inclui este cliente.', 'SUBSCRIPTION_REQUIRED');
  if (/model.*(?:not available|not found|not supported|not allowed)|unknown model/i.test(detail)) return new AgentError(label + ': modelo indisponível para esta conta.', 'MODEL_UNAVAILABLE');
  if (/\b401\b|not logged in|not authenticated|authentication|unauthorized|please.*log.?in|invalid.*token|expired.*token|login required/i.test(detail)) {
    return new AgentError(`${label}: o login precisa ser renovado no aplicativo ou terminal oficial.`, 'AUTH_REQUIRED');
  }
  return new AgentError(`${label}: ${detail || 'a execução terminou sem uma resposta válida.'}`);
}

export function stopProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // Only the process spawned for this run and its descendants are targeted.
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    killer.on('error', () => { try { child.kill(); } catch {} });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      }
    }, 1500);
    timer.unref();
  }
}

export function runLocalProcess(file, args, { cwd, input = '', signal, timeoutMs = 15000, onLine, limit = MAX_OUTPUT } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AgentError('Execução interrompida.', 'CANCELLED'));
    let stdout = '', stderr = '', pending = '', total = 0, stoppedError, settled = false;
    const child = spawn(file, args, {
      cwd, env: subscriptionEnvironment(), shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stop = error => {
      if (stoppedError || settled) return;
      stoppedError = error;
      stopProcessTree(child);
    };
    const abort = () => stop(new AgentError('Execução interrompida.', 'CANCELLED'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new AgentError('O agente excedeu o tempo desta rodada. Você pode iniciar outra tentativa.', 'TIMEOUT')), timeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(result);
    };
    child.on('error', error => finish(new AgentError(`Não foi possível iniciar o agente: ${safeDiagnostic(error.message)}`, 'UNAVAILABLE')));
    child.stdin.on('error', () => {}); // Early CLI exit can close the pipe before input is consumed.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => {
      total += Buffer.byteLength(data);
      if (total > limit) return stop(new AgentError('A saída do agente excedeu o limite desta rodada.', 'OUTPUT_LIMIT'));
      if (onLine) {
        pending += data;
        let index;
        while ((index = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, index).replace(/\r$/, '');
          pending = pending.slice(index + 1);
          try { onLine(line); } catch (error) { stop(error); break; }
        }
      } else stdout += data;
    });
    child.stderr.on('data', data => {
      total += Buffer.byteLength(data);
      stderr = (stderr + data).slice(-12000);
      if (total > limit) stop(new AgentError('A saída do agente excedeu o limite desta rodada.', 'OUTPUT_LIMIT'));
    });
    child.on('close', (code, exitSignal) => {
      if (pending && onLine && !stoppedError) {
        try { onLine(pending); } catch (error) { stoppedError = error; }
      }
      finish(stoppedError, { stdout, stderr, code, signal: exitSignal });
    });
    child.stdin.end(input, 'utf8');
  });
}

// The Windows desktop app supplies a versioned Codex directory to its own
// children. An app launched from Explorer only inherits user/system PATH.
export async function resolveWindowsExecutable(agent, env = process.env) {
  if (!Object.hasOwn(LABELS, agent)) throw new AgentError('Agente desconhecido.', 'INVALID_AGENT');
  const paths = (env.Path ?? env.PATH ?? '').split(';');
  for (const entry of paths) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!isAbsolute(directory)) continue;
    const executable = join(directory, `${agent}.exe`);
    if ((await stat(executable).catch(() => null))?.isFile()) return executable;
  }

  if (agent === 'claude') {
    if (!env.USERPROFILE || !isAbsolute(env.USERPROFILE)) return undefined;
    const executable = join(env.USERPROFILE, '.local', 'bin', 'claude.exe');
    return (await stat(executable).catch(() => null))?.isFile() ? executable : undefined;
  }

  if (!env.LOCALAPPDATA || !isAbsolute(env.LOCALAPPDATA)) return undefined;
  const installRoot = join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  const entries = await readdir(installRoot, { withFileTypes: true }).catch(() => []);
  let newest;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{12,64}$/i.test(entry.name)) continue;
    const executable = join(installRoot, entry.name, 'codex.exe');
    const metadata = await lstat(executable).catch(() => null);
    if (metadata?.isFile() && (!newest || metadata.mtimeMs > newest.mtimeMs)) {
      newest = { executable, mtimeMs: metadata.mtimeMs };
    }
  }
  return newest?.executable;
}

export async function resolveExecutable(agent) {
  if (!LABELS[agent]) throw new AgentError('Agente desconhecido.', 'INVALID_AGENT');
  const override = process.env[`MESA_${agent.toUpperCase()}_BIN`];
  let path;
  if (override) {
    if (!isAbsolute(override)) throw new AgentError(`MESA_${agent.toUpperCase()}_BIN deve ser um caminho absoluto.`, 'UNAVAILABLE');
    await access(override);
    path = override;
  } else if (process.platform === 'win32') {
    path = await resolveWindowsExecutable(agent);
  } else {
    const probe = await runLocalProcess('which', [agent], { limit: 16000 });
    const paths = probe.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    path = paths[0];
  }
  if (!path) throw new AgentError(`${LABELS[agent]} não foi encontrado. Instale o cliente oficial ou configure MESA_${agent.toUpperCase()}_BIN com seu executável.`, 'UNAVAILABLE');
  if (process.platform === 'win32' && !/\.exe$/i.test(path)) throw new AgentError('Use o executável nativo .exe do agente.', 'UNAVAILABLE');
  return path;
}

export async function authentication(agent, file, signal) {
  const args = agent === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'];
  const result = await runLocalProcess(file, args, { timeoutMs: 20000, signal, limit: 64000 });
  if (agent === 'codex') {
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.code === 0 && /logged in using ChatGPT/i.test(output)) return { authenticated: true, subscription: true };
    if (result.code === 0 && /logged in/i.test(output)) return { authenticated: true, subscription: false };
    return { authenticated: false, subscription: false };
  }
  try {
    const value = JSON.parse(result.stdout);
    const authenticated = result.code === 0 && value.loggedIn === true;
    return { authenticated, plan: typeof value.subscriptionType === "string" ? value.subscriptionType : null, subscription: authenticated && value.authMethod === 'claude.ai' && value.apiProvider === 'firstParty' };
  } catch {
    return { authenticated: false, subscription: false };
  }
}

export async function getAgentStatus() {
  const pairs = await Promise.all(Object.keys(LABELS).map(async agent => {
    try {
      const file = await resolveExecutable(agent);
      const [version, auth] = await Promise.all([
        runLocalProcess(file, ['--version'], { limit: 16000 }), authentication(agent, file),
      ]);
      return [agent, {
        available: true, authenticated: auth.authenticated && auth.subscription,
        label: LABELS[agent], version: safeDiagnostic(version.stdout),
        detail: auth.subscription ? 'Conectado pela assinatura' : auth.authenticated ? 'Login por API detectado. Entre com sua assinatura.' : 'Faça login no cliente oficial',
      }];
    } catch (error) {
      return [agent, { available: false, authenticated: false, label: LABELS[agent], version: '', detail: safeDiagnostic(error.message) }];
    }
  }));
  return Object.fromEntries(pairs);
}

export function buildArguments(agent, cwd, options = {}) {
  const settings = normalizeSettings(options);
  const working = settings.access !== 'chat';
  const model = settings[`${agent}Model`];
  if (agent === 'codex') {
    const disabled = ['apps', 'plugins', 'hooks', 'multi_agent', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'memories', 'workspace_dependencies', ...(!working?['shell_tool','view_image']:[]), ...(!working&&!settings.internet?['code_mode','code_mode_host']:[])];
    return [
      'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
      ...(working?['--approve-for-me']:['--sandbox','read-only']), '--json', '--color', 'never', '-C', cwd,
      ...(model?['--model',model]:[]),
      ...disabled.flatMap(feature => ['--disable', feature]),
      ...(working?['--enable','shell_tool','--enable','view_image']:[]),
      ...(working||settings.internet?['--enable','code_mode','--enable','code_mode_host']:[]),
      '--enable', 'skip_host_skill_discovery',
      '-c', `web_search="${settings.internet?'live':'disabled'}"`, '-c', 'agents.enabled=false',
      '-c', `sandbox_workspace_write.network_access=${settings.internet}`,
      '-c', 'skills.bundled.enabled=false', '-c', 'project_doc_max_bytes=0',
      '-c', `model_reasoning_effort="${settings.codexEffort || settings.effort}"`, '-c', 'forced_login_method="chatgpt"',
      '-',
    ];
  }
  if (agent === 'claude') {
    const fileTools = ['Read','Write','Edit','Glob','Grep'];
    const webTools = settings.internet?['WebSearch','WebFetch']:[];
    const toolNames=[...(working?[...fileTools,'Bash','PowerShell']:[]),...webTools];
    return [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--safe-mode', ...(settings.access==='computer'?['--setting-sources','']:['--restricted']),
    '--strict-mcp-config', '--tools', toolNames.join(','),
    '--permission-mode', working?'auto':'dontAsk',
    ...(webTools.length?['--allowedTools',webTools.join(',')]:[]),
    '--permission-prompts', 'none', '--no-session-persistence',
    '--disable-slash-commands', '--no-chrome', '--effort', settings.claudeEffort || settings.effort,
    ...(model?['--model',model]:[]),
    ];
  }
  throw new AgentError('Agente desconhecido.', 'INVALID_AGENT');
}

export function createEventCollector(agent, { onDelta = () => {}, onActivity = () => {} } = {}) {
  const parts = [], seen = new Set();
  let finalText, error, usage, sessionId, model, sawEvents = false, streamed = false;
  return {
    accept(line) {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      sawEvents = true;
      if (agent === 'codex') {
        if (event.type === 'thread.started') sessionId = event.thread_id;
        if (event.type === 'turn.started') onActivity('Preparando resposta');
        if (['item.started','item.completed'].includes(event.type) && event.item) {
          const item=event.item;
          const titles={command_execution:'Executando comando',file_change:'Alterando arquivos',web_search:'Pesquisando na web',mcp_tool_call:'Usando ferramenta'};
          if (titles[item.type]) onActivity({
            tool:item.type,title:titles[item.type],status:event.type==='item.started'?'running':item.status==='failed'||(item.exit_code!=null&&item.exit_code!==0)?'failed':'completed',
            detail:safeDiagnostic(item.command||item.query||item.changes?.map(c=>c.path).join(', ')||item.tool||''),
          });
        }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          const text = event.item.text;
          const id = event.item.id || text;
          if (typeof text === 'string' && !seen.has(id)) {
            seen.add(id); parts.push(text); onDelta((parts.length > 1 ? '\n\n' : '') + text);
          }
        }
        if (event.type === 'turn.completed') usage = event.usage;
        if (['turn.failed', 'response.failed', 'error'].includes(event.type)) error = event.error?.message || event.message || event.error || 'Falha na resposta do Codex.';
      } else {
        if (event.type === 'system' && event.subtype === 'init') {
          sessionId = event.session_id; model = event.model; onActivity('Preparando resposta');
        }
        if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') {
          streamed = true; onDelta(event.event.delta.text || '');
        }
        if (event.type === 'assistant' && event.message) {
          for (const block of event.message.content || []) if (block.type === 'tool_use' && !seen.has(`tool:${block.id}`)) {
            seen.add(`tool:${block.id}`);
            onActivity({tool:block.name,title:`Ferramenta · ${block.name}`,status:'running',detail:safeDiagnostic(block.input?.command||block.input?.file_path||block.input?.path||block.input?.query||block.input?.url||block.input?.pattern||'')});
          }
          const id = event.message.id || event.uuid;
          const text = (event.message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
          if (text && (!id || !seen.has(id))) {
            if (id) seen.add(id);
            parts.push(text);
            if (!streamed) onDelta(text);
          }
          model = event.message.model || model;
        }
        if (event.type === 'result') {
          sessionId = event.session_id || sessionId; usage = event.usage;
          if (event.is_error || (event.subtype && event.subtype !== 'success')) {
            error = event.errors?.join('\n') || event.result || event.subtype || 'Falha na resposta do Claude.';
          } else if (typeof event.result === 'string') finalText = event.result;
          if (event.permission_denials?.length) onActivity({tool:'permissions',title:'Ações bloqueadas pelo cliente',status:'failed',detail:safeDiagnostic(event.permission_denials.map(d=>d.tool_name).join(', '))});
        }
        if (event.type==='user') for (const block of event.message?.content||[]) if (block.type==='tool_result') onActivity({tool:'result',title:block.is_error?'A ferramenta informou um erro':'Ferramenta concluída',status:block.is_error?'failed':'completed',detail:''});
        if (event.type === 'error') error = event.error?.message || event.message || 'Falha na resposta do Claude.';
      }
    },
    result() {
      return { text: (finalText ?? parts.join('\n\n')).trim(), error, usage, sessionId, model, sawEvents };
    },
  };
}

export async function runAgent({ agent, prompt, cwd, signal, onDelta, onActivity, settings = {}, timeoutMs = 180000 }) {
  if (!LABELS[agent]) throw new AgentError('Agente desconhecido.', 'INVALID_AGENT');
  if (!isAbsolute(cwd || '')) throw new AgentError('Diretório de trabalho inválido.', 'INVALID_WORKSPACE');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100000) throw new AgentError('O contexto desta rodada está vazio ou é muito extenso.', 'INVALID_PROMPT');
  const file = await resolveExecutable(agent);
  const auth = await authentication(agent, file, signal);
  if (!auth.authenticated) throw new AgentError(`${LABELS[agent]} precisa de login no cliente oficial.`, 'AUTH_REQUIRED');
  if (!auth.subscription) throw new AgentError(`${LABELS[agent]} está autenticado por API. Esta central usa apenas sua assinatura; entre com sua conta no cliente oficial.`, 'SUBSCRIPTION_REQUIRED');
  const collector = createEventCollector(agent, { onDelta, onActivity });
  const normalized=normalizeSettings(settings);
  const result = await runLocalProcess(file, buildArguments(agent, cwd, normalized), {
    cwd, input: prompt, signal, timeoutMs: Math.max(1000, Math.min(timeoutMs, 3600000)), limit:32*1024*1024,onLine: line => collector.accept(line),
  });
  const collected = collector.result();
  if (collected.error) throw classifyFailure(collected.error, agent);
  if (result.code !== 0) throw classifyFailure(result.stderr || `Processo finalizado com código ${result.code}.`, agent);
  if (!collected.sawEvents || !collected.text) throw classifyFailure(result.stderr || 'A resposta veio vazia ou em um formato não reconhecido.', agent);
  return { text: collected.text, usage: collected.usage, sessionId: collected.sessionId, model: collected.model || normalized[`${agent}Model`] || null };
}
