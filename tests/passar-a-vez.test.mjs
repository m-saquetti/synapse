// Limite preventivo ("Passar a vez a partir de X% de uso"). Caso real de 22/11: com o limite em 90%, o GPT
// continuou recebendo a vez de revisar, esgotou a janela de 5 horas no meio da fala e deixou uma resposta parcial.
// Usa só a API pública (createApp), para também rodar contra versões anteriores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const reply = (texto = 'ok', status = 'complete') => ({ text: `${texto}\n<mesa_status>${JSON.stringify({ status, summary: 'ok', next: [], decisions: [], tests: [] })}</mesa_status>` });
// Uso medido agora, como o Codex informa (janela de 5 horas).
const uso = (pct) => (pct === null ? null : { source: 'teste', observedAt: new Date().toISOString(), windows: [{ id: 'codex:primary', label: '5 horas', usedPercent: pct }] });

async function sala(t, runAgent, usoPorAgente, settings = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'synapse-vez-'));
  const getAgentStatus = async () => Object.fromEntries(['codex', 'claude', 'gemini'].map((p) => [p, { available: true, authenticated: true, usage: uso(usoPorAgente()[p] ?? null) }]));
  const app = await createApp({ dataDir, runAgent, getAgentStatus });
  const url = await app.listen(0);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const boot = await (await fetch(url + '/api/bootstrap')).json(), id = boot.rooms[0].id;
  const call = async (path, body, method = 'POST') => {
    const r = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken }, body: JSON.stringify(body) });
    return { status: r.status, ...(await r.json()) };
  };
  assert.equal((await call(`/api/rooms/${id}`, { settings: { access: 'project', handoffPercent: 90, maxSteps: 6, ...settings } }, 'PATCH')).status, 200);
  const enviar = (content, mode) => call(`/api/rooms/${id}/messages`, { content, target: 'auto', mode });
  const terminar = async (jobId) => { for (let n = 0; n < 500; n++) { const job = app.store.getJob(jobId); if (!['queued', 'running'].includes(job.status)) return job; await wait(10); } throw new Error('tarefa não terminou'); };
  const eventos = (jobId) => app.store.events(id).filter((e) => e.jobId === jobId).map((e) => e.activity);
  return { app, id, call, enviar, terminar, eventos };
}

test('Code: o GPT passa de 90% depois da implementação e não recebe a revisão; o Gemini revisa', async (t) => {
  const vez = [];let gpt = 60;
  const s = await sala(t, async (args) => {
    vez.push(args.agent);
    if (args.agent === 'claude') gpt = 96; // a fala anterior consumiu a janela do GPT
    return reply('pronto');
  }, () => ({ codex: gpt, claude: 20, gemini: null }));
  const { job } = await s.enviar('Implemente a melhoria', 'code');
  assert.equal((await s.terminar(job.id)).status, 'completed');
  assert.deepEqual(vez, ['claude', 'gemini'], 'antes da correção: claude, codex (esgota no meio), ...');
  const passou = s.eventos(job.id).find((e) => e.title === 'GPT passou a vez');
  assert.ok(passou, 'o motivo aparece em Ações');
  assert.match(passou.detail, /Uso em 96%, acima do limite preventivo de 90%/);
});

test('Chat: líder acima do limite não abre nem sintetiza; quem está abaixo assume', async (t) => {
  const vez = [], prompts = [];
  const s = await sala(t, async (args) => { vez.push(args.agent); prompts.push(args.prompt); return reply(); }, () => ({ codex: 93, claude: 10, gemini: 40 }));
  const { job } = await s.enviar('Vamos planejar a próxima fase', 'chat');
  await s.terminar(job.id);
  assert.deepEqual(vez, ['claude', 'gemini', 'claude']);
  assert.match(prompts.at(-1), /GPT \(passou a vez: uso em 93%/, 'os colegas sabem por que o GPT não fala');
});

test('cada fala registra o uso informado no início, para explicar depois um limite atingido', async (t) => {
  const s = await sala(t, async () => reply(), () => ({ codex: 40, claude: 55, gemini: null }));
  const { job } = await s.enviar('Planeje', 'chat');
  await s.terminar(job.id);
  const inicio = s.eventos(job.id).filter((e) => e.tool === 'routing' && /·/.test(e.title)).map((e) => e.detail);
  assert.ok(inicio.some((d) => /Uso: 40%; limite preventivo 90%\./.test(d)), inicio.join(' | '));
  assert.ok(inicio.some((d) => /Uso: não informado pelo cliente\./.test(d)), 'Gemini sem telemetria');
});

test('todos acima do limite: a rodada segue com eles (último recurso) em vez de travar', async (t) => {
  const vez = [];
  const s = await sala(t, async (args) => { vez.push(args.agent); return reply(); }, () => ({ codex: 95, claude: 92, gemini: 91 }));
  const { job } = await s.enviar('Planeje', 'chat');
  assert.equal((await s.terminar(job.id)).status, 'completed');
  assert.equal(vez.length, 4);
});

test('@menção sua alcança quem passou a vez; a de um colega não', async (t) => {
  // Segura a primeira fala de cada rodada até o teste liberar.
  const vez = [];const travas = [];let rodada = 0;
  const novaTrava = () => { let liberar;const p = new Promise((r) => { liberar = r; });travas.push({ p, liberar }); };
  novaTrava();novaTrava();
  const s = await sala(t, async (args) => {
    vez.push(args.agent);
    if (vez.length === 1) { await travas[rodada++].p; return reply(rodada === 1 ? 'Abertura. @GPT, confirma?' : 'Abertura.'); }
    return reply();
  }, () => ({ codex: 95, claude: 10, gemini: 10 }));
  const { job } = await s.enviar('Planeje', 'chat');
  for (let n = 0; n < 200 && !vez.length; n++) await wait(10);
  travas[0].liberar();
  await s.terminar(job.id);
  assert.ok(!vez.includes('codex'), `colega não chama quem passou a vez: ${vez}`);
  assert.ok(s.eventos(job.id).some((e) => e.title === 'Chamada para GPT não atendida' && /perto do limite/.test(e.detail)));
  vez.length = 0;
  const segunda = await s.enviar('Planeje de novo', 'chat');
  for (let n = 0; n < 200 && !vez.length; n++) await wait(10);
  assert.equal((await s.call(`/api/jobs/${segunda.job.id}/steer`, { content: '@GPT, mesmo perto do limite, responda' })).status, 201);
  travas[1].liberar();
  await s.terminar(segunda.job.id);
  assert.ok(vez.includes('codex'), `o usuário escolheu chamar o GPT: ${vez}`);
});
