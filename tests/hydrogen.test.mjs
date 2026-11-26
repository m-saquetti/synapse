// Synapse 1.3.1: rota do Gemini 4 Hydrogen no AI Studio.
// Caso real de 22/11: às 16:03 a fala parou com "45 segundos sem transmitir dados" (raciocínio alto sem
// resumos no stream) e, às 21:44, três chamadas seguidas receberam HTTP 503 "high demand".
process.env.SYNAPSE_STUDIO_FIRST_EVENT_MS = '150';
process.env.SYNAPSE_STUDIO_IDLE_MS = '150';
process.env.SYNAPSE_STUDIO_RETRY_MS = '10,10';
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';

const { runStudio } = await import('../lib/ai-studio.mjs');
const { Providers } = await import('../lib/providers.mjs');
const { AgentError } = await import('../lib/agents.mjs');

// Como o fetch real, o corpo falha quando o sinal da requisição é abortado.
const sse = (events, { delayMs = 0, signal } = {}) => new Response(new ReadableStream({
  async start(controller) {
    let aborted = false;
    signal?.addEventListener('abort', () => { aborted = true; controller.error(signal.reason); }, { once: true });
    for (const event of events) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (aborted) return;
      controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'));
    }
    controller.close();
  },
}), { headers: { 'content-type': 'text/event-stream' } });
const busy = () => Response.json({ error: { code: 503, message: 'This model is currently experiencing high demand.', status: 'UNAVAILABLE' } }, { status: 503 });
const args = (extra = {}) => ({ prompt: 'oi', settings: { access: 'chat', internet: false }, signal: new AbortController().signal, ...extra });
const thought = { candidates: [{ content: { parts: [{ text: 'Pensando no problema…', thought: true }] } }] };
const answer = { candidates: [{ content: { parts: [{ text: 'Resposta final.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 40, candidatesTokenCount: 5 }, modelVersion: 'gemini-4-hydrogen' };

test('pede resumos de raciocínio com o nível da sala e não mistura pensamento com a resposta', async (t) => {
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { bodies.push(JSON.parse(init.body)); return sse([thought, {...answer,modelVersion:'versao-retornada-pelo-servidor'}]); });
  const deltas = [], activities = [];
  const result = await runStudio('gemini-4-hydrogen', 'k', args({ effort: 'low', onDelta: (d) => deltas.push(d), onActivity: (a) => activities.push(a) }));
  assert.deepEqual(bodies[0].generationConfig, { thinkingConfig: { includeThoughts: true, thinkingLevel: 'LOW' } });
  assert.equal(result.text, 'Resposta final.');
  assert.equal(result.model, 'versao-retornada-pelo-servidor');
  assert.deepEqual(deltas, ['Resposta final.']);
  assert.equal(activities.filter((a) => a.tool === 'thinking').length, 1);
});

test('sem nível escolhido, ainda pede os resumos; se o modelo recusar (400), segue sem configuração', async (t) => {
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1 ? Response.json({ error: { code: 400, message: 'bad thinking config' } }, { status: 400 }) : sse([answer]);
  });
  const result = await runStudio('gemini-4-hydrogen', 'k', args());
  assert.deepEqual(bodies[0].generationConfig, { thinkingConfig: { includeThoughts: true } });
  assert.equal(bodies[1].generationConfig, undefined);
  assert.equal(result.text, 'Resposta final.');
});

test('HTTP 503 por pico de demanda: tenta de novo antes de desistir', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => (++calls <= 2 ? busy() : sse([answer])));
  const activities = [];
  const result = await runStudio('gemini-4-hydrogen', 'k', args({ onActivity: (a) => activities.push(a) }));
  assert.equal(calls, 3);
  assert.equal(result.text, 'Resposta final.');
  assert.equal(activities.filter((a) => /nova tentativa/.test(a.title)).length, 2);
});

test('503 persistente: desiste depois das novas tentativas com UNAVAILABLE', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return busy(); });
  await assert.rejects(runStudio('gemini-4-hydrogen', 'k', args()), { code: 'UNAVAILABLE' });
  assert.equal(calls, 3);
});

test('resumos de raciocínio mantêm a conexão viva; silêncio real ainda é detectado', async (t) => {
  // Cada evento chega a 100 ms do anterior (abaixo do limite de 150 ms): a fala termina.
  t.mock.method(globalThis, 'fetch', async (_url, init) => sse([thought, thought, thought, answer], { delayMs: 100, signal: init.signal }));
  assert.equal((await runStudio('gemini-4-hydrogen', 'k', args())).text, 'Resposta final.');
  t.mock.restoreAll();
  // Um único evento depois de 400 ms de silêncio: a fala falha com o tempo real de espera na mensagem.
  t.mock.method(globalThis, 'fetch', async (_url, init) => sse([answer], { delayMs: 400, signal: init.signal }));
  await assert.rejects(runStudio('gemini-4-hydrogen', 'k', args()), (error) => error.code === 'UNAVAILABLE' && /0 segundos sem transmitir/.test(error.message));
});

test('Hydrogen esgotado ou em pausa: alterna para o Antigravity (Flash) com aviso em Ações', async () => {
  const rows = new Map(), store = { providerState: (id) => rows.get(id) || {}, saveProviderState: (id, v) => rows.set(id, v) };
  const p = new Providers({ dataDir: tmpdir(), store });
  p.studioAccess = async () => 'k';
  p.geminiCatalog = async () => ({ models: [{ id: 'gemini-3.8-flash' }] });
  let nativeArgs;
  p.runNativeGemini = async (a) => { nativeArgs = a; return { text: 'native', model: 'gemini-3.8-flash' }; };
  const avisos = [];
  const base = { prompt: 'oi', modelId: 'api:gemini-4-hydrogen', onActivity: (a) => avisos.push(a), settings: { access: 'chat', geminiModel: 'api:gemini-4-hydrogen' } };
  // Simula o AI Studio já marcado como ocupado (pausa gravada pela falha anterior).
  rows.set('studio', { models: { 'api:gemini-4-hydrogen': { until: new Date(Date.now() + 30000).toISOString(), code: 'UNAVAILABLE' } } });
  const result = await p.runGemini(base);
  assert.equal(result.model, 'gemini-3.8-flash');
  assert.equal(avisos[0].status, 'warning');
  assert.match(avisos[0].title, /alternando para Antigravity/);
  assert.ok(nativeArgs);
  // Falhas que exigem ação sua (chave inválida) continuam aparecendo como erro, sem troca silenciosa.
  rows.set('studio', { models: { 'api:gemini-4-hydrogen': { until: new Date(Date.now() + 30000).toISOString(), code: 'AUTH_REQUIRED' } } });
  await assert.rejects(p.runGemini(base), { code: 'AUTH_REQUIRED' });
});

test('Antigravity esgotado ou indisponível: alterna para o AI Studio (Hydrogen) com aviso em Ações', async (t) => {
  const rows = new Map(), store = { providerState: (id) => rows.get(id) || {}, saveProviderState: (id, v) => rows.set(id, v) };
  const p = new Providers({ dataDir: tmpdir(), store });
  p.studioAccess = async () => 'k';
  p.runNativeGemini = async () => { throw Object.assign(new AgentError('Antigravity: limite de uso atingido', 'RATE_LIMIT'), { resetAt: new Date(Date.now() + 3600000).toISOString() }); };
  const avisos = [];
  const base = { prompt: 'oi', onActivity: (a) => avisos.push(a), settings: { access: 'chat', geminiModel: 'gemini-3.8-flash' } };
  t.mock.method(globalThis, 'fetch', async () => sse([answer]));
  const result = await p.runGemini(base);
  assert.equal(result.text, 'Resposta final.');
  assert.equal(avisos[0].status, 'warning');
  assert.match(avisos[0].title, /Antigravity indisponível, alternando para AI Studio/);
});

// Refino (Claude) da alternância Hydrogen ↔ Flash.
test('AI Studio indisponível sem Antigravity tenta só um modelo alternativo', async () => {
  const p=new Providers({store:{providerState:()=>({})}});
  p.studioAccess=async ()=>'k';
  p.geminiCatalog=async ()=>({models:[]});
  const ids=['api:gemini-4-hydrogen','api:gemini-3.8-flash'];
  p.directCatalog=async ()=>ids.map(id=>({id,label:id,tier:'Free Tier',availability:'listed'}));
  const attempts=[];
  p.runStudioRoute=async id=>{
    attempts.push(id);
    assert.ok(attempts.length<=2);
    throw new AgentError('temporariamente indisponível','UNAVAILABLE');
  };
  await assert.rejects(p.runGemini({settings:{access:'chat',geminiModel:ids[0]}}),{code:'UNAVAILABLE'});
  assert.deepEqual(attempts,ids);
});
const gemeas = () => {
  const rows = new Map(), store = { providerState: (id) => rows.get(id) || {}, saveProviderState: (id, v) => rows.set(id, v) };
  const p = new Providers({ dataDir: tmpdir(), store });
  p.studioAccess = async () => 'k';
  p.geminiCatalog = async () => ({ models: [{ id: 'gemini-3.8-flash' }] });
  return { p, rows };
};
const hydrogen = { prompt: 'oi', settings: { access: 'chat', geminiModel: 'api:gemini-4-hydrogen' } };
const flash = { prompt: 'oi', settings: { access: 'chat', geminiModel: 'gemini-3.8-flash' } };
const limite = (msg, ms) => Object.assign(new AgentError(msg, 'RATE_LIMIT'), { resetAt: new Date(Date.now() + ms).toISOString() });

test('falha do Antigravity não grava pausa no Hydrogen; as duas rotas esgotadas devolvem a volta mais próxima', async () => {
  const { p, rows } = gemeas();
  const pausa = new Date(Date.now() + 30000).toISOString();
  rows.set('studio', { models: { 'api:gemini-4-hydrogen': { until: pausa, code: 'RATE_LIMIT' } } });
  p.runNativeGemini = async () => { throw limite('Antigravity: limite de 5 horas', 5 * 3600000); };
  const erro = await p.runGemini(hydrogen).catch((e) => e);
  assert.equal(erro.code, 'RATE_LIMIT');
  assert.equal(erro.resetAt, pausa);
  assert.match(erro.message, /A outra rota também falhou/);
  // Antes, a pausa de 5 h do Antigravity substituía a de 30 s do Hydrogen.
  assert.equal(rows.get('studio').models['api:gemini-4-hydrogen'].until, pausa);
});

test('Flash esgotado e Hydrogen em pausa: não chama o AI Studio e devolve a volta mais próxima', async (t) => {
  const { p, rows } = gemeas();
  const pausa = new Date(Date.now() + 60000).toISOString();
  rows.set('studio', { models: { 'api:gemini-4-hydrogen': { until: pausa, code: 'RATE_LIMIT' } } });
  p.runNativeGemini = async () => { throw limite('Antigravity: limite', 3600000); };
  let chamadas = 0;
  t.mock.method(globalThis, 'fetch', async () => { chamadas++; return sse([answer]); });
  const erro = await p.runGemini(flash).catch((e) => e);
  assert.equal(chamadas, 0);
  assert.equal(erro.resetAt, pausa);
});

test('Hydrogen esgotado no meio da troca grava a pausa dele para a próxima fala', async (t) => {
  const { p, rows } = gemeas();
  p.runNativeGemini = async () => { throw limite('Antigravity: limite', 3600000); };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } }, { status: 429, headers: { 'retry-after': '120' } }));
  const erro = await p.runGemini(flash).catch((e) => e);
  assert.equal(erro.code, 'RATE_LIMIT');
  assert.ok(Date.parse(rows.get('studio').models['api:gemini-4-hydrogen'].until) > Date.now() + 100000);
  assert.ok(Date.parse(erro.resetAt) < Date.now() + 200000);
});

test('Antigravity que já executou ferramentas não é refeito pelo AI Studio', async (t) => {
  const { p } = gemeas();
  p.runNativeGemini = async () => { throw Object.assign(limite('Antigravity: limite', 3600000), { toolExecuted: true }); };
  let chamadas = 0;
  t.mock.method(globalThis, 'fetch', async () => { chamadas++; return sse([answer]); });
  await assert.rejects(p.runGemini(flash), { code: 'RATE_LIMIT' });
  assert.equal(chamadas, 0);
});

test('automático com chave recusada segue pelo Antigravity; Hydrogen escolhido mostra o erro', async (t) => {
  const { p } = gemeas();
  p.runNativeGemini = async () => ({ text: 'native', model: 'gemini-3.8-flash' });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: 403, message: 'API key not valid', status: 'PERMISSION_DENIED' } }, { status: 403 }));
  assert.equal((await p.runGemini({ prompt: 'oi', settings: { access: 'chat', geminiModel: 'auto' } })).text, 'native');
  await assert.rejects(p.runGemini(hydrogen), (e) => e.code !== 'RATE_LIMIT' && !/native/.test(e.message));
});

// Economia provisória (Claude, 22/11 noite): o automático escolhe a rota pelo tipo de trabalho.
test('automático: Chat começa pelo Hydrogen; Projeto começa pelo Antigravity e só usa o Hydrogen se ele esgotar', async (t) => {
  const { p } = gemeas();
  p.directCatalog = async () => []; // chave sem Flash no catálogo: a reserva é o Hydrogen (1.6: ver tests/v16.test.mjs)
  const rotas = [];
  p.runNativeGemini = async () => { rotas.push('antigravity'); return { text: 'native', model: 'gemini-3.8-flash' }; };
  t.mock.method(globalThis, 'fetch', async () => { rotas.push('studio'); return sse([answer]); });
  assert.equal((await p.runGemini({ prompt: 'oi', settings: { access: 'chat', geminiModel: 'auto' } })).text, 'Resposta final.');
  assert.equal((await p.runGemini({ prompt: 'oi', settings: { access: 'project', geminiModel: 'auto' } })).text, 'native');
  assert.deepEqual(rotas, ['studio', 'antigravity']);
  p.runNativeGemini = async () => { rotas.push('antigravity'); throw limite('Antigravity: limite semanal', 3600000); };
  assert.equal((await p.runGemini({ prompt: 'oi', settings: { access: 'project', geminiModel: 'auto' } })).text, 'Resposta final.');
  assert.deepEqual(rotas.slice(2), ['antigravity', 'studio']);
});

test('Ações recebe um registro por mudança de estado de cada ferramenta do Antigravity', async () => {
  const { geminiToolActivity } = await import('../lib/providers.mjs');
  const calls = new Map(), entrada = { CommandLine: 'npm test' };
  const avisos = [
    { sessionUpdate: 'tool_call', toolCallId: 'a', kind: 'execute', title: 'npm test', status: 'pending', rawInput: entrada },
    { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'pending' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'in_progress' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed' },
  ].map((u) => geminiToolActivity(calls, u)).filter(Boolean);
  assert.deepEqual(avisos.map((a) => [a.status, a.title, a.tool]), [['running', 'npm test', 'execute'], ['completed', 'npm test', 'execute']]);
  assert.match(avisos[1].detail, /npm test/);
});

test('uso da fala no AI Studio soma todas as rodadas de ferramentas', async (t) => {
  const chamada = { candidates: [{ content: { parts: [{ functionCall: { name: 'list_files', args: { path: '.' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 60, candidatesTokenCount: 3, totalTokenCount: 103 } };
  let n = 0;
  t.mock.method(globalThis, 'fetch', async () => sse([n++ === 0 ? chamada : answer]));
  const r = await runStudio('gemini-4-hydrogen', 'k', args({ cwd: tmpdir(), settings: { access: 'project', internet: false }, requestApproval: async () => ({ decision: 'allow' }) }));
  assert.equal(r.usage.requests, 2);
  assert.equal(r.usage.promptTokenCount, 110);
  assert.equal(r.usage.cachedContentTokenCount, 60);
  assert.equal(r.usage.thoughtsTokenCount, 40);
});

// Caso real de 23/11: o Antigravity respondeu com o aviso de cota como texto, e a Synapse gravou como fala.
test('aviso de cota do Antigravity vira limite com horário de volta, não fala', async () => {
  const { antigravityQuota, possibleQuotaNotice } = await import('../lib/providers.mjs');
  const agora = Date.parse('2026-11-23T17:11:12Z');
  const cota = antigravityQuota('⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 117h16m41s.', agora);
  assert.equal(cota.resetAt, new Date(agora + (117 * 3600 + 16 * 60 + 41) * 1000).toISOString());
  assert.equal(antigravityQuota('Revisão: o limite de quota reached no teste foi tratado.\n'.repeat(20)), null, 'texto longo é resposta, não aviso');
  assert.equal(antigravityQuota('Tudo certo com a revisão.'), null);
  assert.equal(antigravityQuota('Reproduzi o aviso quota reached. Resets in 5h. Pode seguir.'),null);
  assert.equal(antigravityQuota('Individual quota reached. Resets in 5h. Foi o erro de ontem.'),null);
  const banner='⚠️ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 117h16m41s.';
  for(let i=1;i<=banner.length;i++)assert.equal(possibleQuotaNotice(banner.slice(0,i)),true);
  assert.equal(possibleQuotaNotice('Implementei a correção'),false);
});

test('Antigravity em pausa: o Gemini vai direto ao AI Studio sem abrir o Antigravity', async (t) => {
  const { p, rows } = gemeas();
  let aberturas = 0;
  p.runNativeGemini = async () => { aberturas++; throw Object.assign(new AgentError('Antigravity: cota da conta Google esgotada.', 'RATE_LIMIT'), { resetAt: new Date(Date.now() + 5 * 86400e3).toISOString() }); };
  t.mock.method(globalThis, 'fetch', async () => sse([answer]));
  const projeto = { prompt: 'oi', settings: { access: 'project', geminiModel: 'auto' } };
  assert.equal((await p.runGemini(projeto)).text, 'Resposta final.');
  assert.ok(Date.parse(rows.get('antigravity').until) > Date.now() + 4 * 86400e3, 'pausa gravada');
  assert.equal((await p.runGemini(projeto)).text, 'Resposta final.');
  assert.equal(aberturas, 1, 'na segunda fala o Antigravity não é aberto');
  p.probeGemini=async()=>assert.fail('a atualização do catálogo abriu a conta em pausa');
  rows.set('gemini',{catalog:[{id:'gemini-3.8-flash',source:'Antigravity'}]});
  assert.equal((await Providers.prototype.geminiCatalog.call(p,true)).models[0].id,'gemini-3.8-flash');
});

test('nome do esforço é o que o cliente oficial mostra', async () => {
  const { effortLabel } = await import('../lib/models.mjs');
  assert.equal(effortLabel('claude', 'xhigh'), 'Extra', 'Claude Code chama xhigh de Extra');
  assert.equal(effortLabel('claude', 'max'), 'Max');
  assert.equal(effortLabel('codex', 'ultra'), 'Ultra');
  assert.equal(effortLabel('codex', 'xhigh'), 'Extra high');
});
