// Synapse 1.2: @menções (usuário e participantes), réplicas ao vivo na rodada e Autonomia.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { parseMentions } from '../lib/mentions.mjs';
import { MAX_CHAMADAS, planNext, queueCalls, recordTurn, startRound, upcoming } from '../lib/rounds.mjs';
import { motivoParaPerguntar } from '../lib/approvals.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connected = async () => Object.fromEntries(['codex', 'claude', 'gemini'].map((p) => [p, { available: true, authenticated: true, usage: null }]));
const reply = (texto, status = 'complete') => ({ text: `${texto}\n<mesa_status>${JSON.stringify({ status, summary: 'ok', next: [], decisions: [], tests: [] })}</mesa_status>` });

async function sala(t, runAgent, settings = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'synapse-mencoes-'));
  const app = await createApp({ dataDir, runAgent, getAgentStatus: connected });
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
  return { app, id, call, enviar, terminar, eventos };
}

test('orientação sem menção durante a última revisão é entregue antes de encerrar',async t=>{
  const prompts=[];let liberar;
  const gate=new Promise(resolve=>{liberar=resolve;});
  const s=await sala(t,async args=>{
    prompts.push(args.prompt);
    if(prompts.length===3)await gate;
    return reply('ok');
  });
  const {job}=await s.enviar('Revise o projeto','code');
  for(let i=0;i<200 && prompts.length<3;i++)await wait(10);
  try{
    assert.equal(prompts.length,3);
    assert.equal((await s.call('/api/jobs/'+job.id+'/steer',{content:'Também confira o requisito 93-Z.'})).status,201);
  }finally{liberar();}
  assert.equal((await s.terminar(job.id)).status,'completed');
  assert.match(prompts[3],/93-Z/);
});

test('menções: aliases, ordem, sem repetir, ignorando código, e-mails e caminhos', () => {
  assert.deepEqual(parseMentions('@Gemini e @gpt, depois @Claude e de novo @GEMINI'), ['gemini', 'codex', 'claude']);
  assert.deepEqual(parseMentions('@Codex, veja'), ['codex']);
  assert.deepEqual(parseMentions('use `@claude` e ```\n@gemini\n``` ou npm i @types/node, a@gemini.dev, docs/@gpt'), []);
  assert.deepEqual(parseMentions('Concordo, @GPT. Já @Claude...', { exclude: 'claude' }), ['codex']);
  assert.deepEqual(parseMentions('Gemini e Claude sem arroba'), []);
  assert.deepEqual(parseMentions('Fim de frase com @Gemini. E pergunta @Claude? E exclamação @GPT!'), ['gemini', 'claude', 'codex']);
});

test('interface e servidor reconhecem as mesmas menções', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const servidor = await readFile(new URL('../lib/mentions.mjs', import.meta.url), 'utf8');
  const regra = (fonte, nome) => fonte.match(new RegExp(`const ${nome}\\s*=\\s*(/.+/gi);`))[1];
  assert.equal(regra(app, 'MENCAO'), regra(servidor, 'MENTION'));
});

test('rodada: chamada vira análise de quem ainda não falou e réplica de quem já falou; limite por rodada', () => {
  const round = startRound('chat', ['codex', 'claude', 'gemini']);
  const todos = ['codex', 'claude', 'gemini'];
  assert.equal(planNext(round, todos).agent, 'codex');
  recordTurn(round, { agent: 'codex', stage: 'abertura' });
  queueCalls(round, ['gemini'], 'codex');
  assert.deepEqual(planNext(round, todos), { agent: 'gemini', stage: 'analise', parentRole: 'codex', call: true });
  recordTurn(round, { agent: 'gemini', stage: 'analise' });
  queueCalls(round, ['codex'], 'gemini');
  assert.deepEqual(planNext(round, todos), { agent: 'codex', stage: 'replica', parentRole: 'gemini', call: true });
  recordTurn(round, { agent: 'codex', stage: 'replica' });
  assert.equal(planNext(round, todos).agent, 'claude', 'depois das chamadas, a fila normal continua');
  const { accepted, dropped } = queueCalls(round, ['claude', 'gemini'], 'codex');
  assert.deepEqual(accepted, ['claude']);
  assert.match(dropped[0].reason, new RegExp(`limite de ${MAX_CHAMADAS}`));
  assert.deepEqual(queueCalls(round, ['codex'], 'codex').accepted, [], 'ninguém chama a si mesmo');
});

test('rodada rápida (várias menções do usuário) termina sem síntese; no Code a chamada vira o próximo revisor', () => {
  const rapida = startRound('chat', ['gemini', 'codex'], { quick: true });
  assert.deepEqual(upcoming(rapida, rapida.order, planNext(rapida, rapida.order)),['codex']);
  recordTurn(rapida, { agent: 'gemini', stage: planNext(rapida, ['gemini', 'codex']).stage });
  recordTurn(rapida, { agent: 'codex', stage: planNext(rapida, ['gemini', 'codex']).stage });
  assert.deepEqual(planNext(rapida, ['gemini', 'codex']), { done: true });
  const code = startRound('code', ['claude', 'codex', 'gemini']);
  recordTurn(code, { agent: 'claude', stage: 'implementacao', changed: true });
  queueCalls(code, ['gemini'], 'user');
  assert.deepEqual(planNext(code, ['claude', 'codex', 'gemini']), {agent:'gemini',stage:'revisao',parentRole:'user',call:true});
  assert.equal(queueCalls(code,['claude'],'user').dropped.length,1);
});

test('usuário: "@Gemini" no envio faz só o Gemini responder; várias menções respondem só elas, na ordem citada', async (t) => {
  const vez = [];
  const s = await sala(t, async (args) => { vez.push(args.agent); return reply(`Resposta de ${args.agent}`); });
  const um = await s.enviar('@Gemini, qual melhoria você priorizaria?');
  assert.equal(um.job.target, 'gemini');
  await s.terminar(um.job.id);
  assert.deepEqual(vez, ['gemini']);
  vez.length = 0;
  const dois = await s.enviar('@GPT e @Gemini, comparem as duas opções');
  const fim = await s.terminar(dois.job.id);
  assert.equal(fim.status, 'completed');
  assert.deepEqual(vez, ['codex', 'gemini'], 'sem Claude e sem síntese');
  assert.ok(s.eventos(dois.job.id).includes('Ordem da rodada: GPT → Gemini'));
  vez.length = 0;
  const explicito = await s.enviar('@Gemini isto vai para o Claude', 'chat', 'claude');
  await s.terminar(explicito.job.id);
  assert.deepEqual(vez, ['claude'], 'o destinatário escolhido no seletor prevalece');
});

test('participante: @menção na fala chama o colega em seguida, com réplica e motivo no contexto', async (t) => {
  const vez = [], prompts = [];
  const s = await sala(t, async (args) => {
    vez.push(args.agent); prompts.push(args.prompt);
    if (args.agent === 'claude') return reply('Discordo da abertura. @GPT, por que não usar SQLite aqui?');
    return reply(`Fala de ${args.agent}`);
  });
  const { job } = await s.enviar('Vamos planejar o armazenamento');
  assert.equal((await s.terminar(job.id)).status, 'completed');
  assert.deepEqual(vez, ['codex', 'claude', 'codex', 'gemini', 'codex'], 'abertura, análise, réplica do GPT, análise, síntese');
  assert.match(prompts[2], /SEU PAPEL \(Réplica\)/);
  assert.match(prompts[2], /chamado de novo com @ por Claude/);
  assert.ok(s.eventos(job.id).includes('Claude chamou GPT'));
  const replica = s.app.store.messages(s.id).filter((m) => m.role === 'codex')[1];
  assert.equal(replica.debate.stage, 'replica');
  assert.equal(replica.debate.parentRole, 'claude');
});

test('participantes que se chamam sem parar param no limite da rodada', async (t) => {
  const vez = [];
  const s = await sala(t, async (args) => {
    vez.push(args.agent);
    const outro = { codex: '@Claude', claude: '@Gemini', gemini: '@GPT' }[args.agent];
    return reply(`Minha vez. ${outro}, sua opinião?`);
  });
  const { job } = await s.enviar('Debate livre');
  assert.equal((await s.terminar(job.id)).status, 'completed');
  assert.ok(vez.length <= 4 + MAX_CHAMADAS, `falas: ${vez.join(',')}`);
  assert.ok(s.eventos(job.id).some((e) => /não atendida/.test(e)), 'a chamada além do limite aparece em Ações');
});

test('usuário: @menção enviada durante a rodada passa a pessoa chamada na frente da fila', async (t) => {
  let liberar;const segura = new Promise((r) => { liberar = r; });
  const vez = [], prompts = {};
  const s = await sala(t, async (args) => {
    vez.push(args.agent); prompts[args.agent] ??= args.prompt;
    if (vez.length === 1) await segura;
    return reply(`Fala de ${args.agent}`);
  });
  const { job } = await s.enviar('Abra a discussão');
  for (let n = 0; n < 200 && !vez.length; n++) await wait(10);
  const orientacao = await s.call(`/api/jobs/${job.id}/steer`, { content: '@Gemini, responda antes do Claude, por favor' });
  assert.equal(orientacao.status, 201);
  liberar();
  await s.terminar(job.id);
  assert.deepEqual(vez, ['codex', 'gemini', 'claude', 'codex']);
  assert.match(prompts.gemini, /chamado com @ pelo usuário/);
  assert.ok(s.eventos(job.id).includes('Você chamou Gemini'));
});

test('Autonomia: aprova sozinha e registra em Ações; ações irreversíveis e perguntas continuam esperando você', async (t) => {
  const decisoes = [];
  let pendente;
  const s = await sala(t, async (args) => {
    decisoes.push(await args.requestApproval({ kind: 'permission', title: 'Claude · Bash', detail: '{"command":"npm test"}' }));
    pendente = args.requestApproval({ kind: 'permission', title: 'Claude · Bash', detail: '{"command":"git push origin main"}' });
    decisoes.push(await pendente);
    return reply('Feito');
  }, { autoApprove: true });
  const { job } = await s.enviar('Rode os testes e publique', 'code', 'claude');
  for (let n = 0; n < 300 && !s.app.store.approvals(s.id).some((a) => a.status === 'pending'); n++) await wait(10);
  assert.deepEqual(decisoes[0], { decision: 'allow', auto: true });
  const esperando = s.app.store.approvals(s.id).find((a) => a.status === 'pending');
  assert.match(esperando.request.detail, /git push/, 'git push espera a sua decisão');
  assert.equal((await s.call(`/api/approvals/${esperando.id}`, { decision: 'deny' })).status, 200);
  await s.terminar(job.id);
  assert.equal(decisoes[1].decision, 'deny');
  assert.ok(s.eventos(job.id).includes('Aprovado pela Autonomia · Claude · Bash'));
});

test('Autonomia desligada continua pedindo cada ação; a opção precisa ser booleana', async (t) => {
  let pedido;
  const s = await sala(t, async (args) => { pedido = args.requestApproval({ kind: 'permission', title: 'GPT · comando', detail: 'npm test' }); await pedido; return reply('ok'); });
  const { job } = await s.enviar('Rode os testes', 'code', 'codex');
  let aprovacao;
  for (let n = 0; n < 300 && !aprovacao; n++) { aprovacao = s.app.store.approvals(s.id).find((a) => a.status === 'pending'); await wait(10); }
  assert.ok(aprovacao, 'sem Autonomia, a ação espera o clique');
  await s.call(`/api/approvals/${aprovacao.id}`, { decision: 'allow' });
  await s.terminar(job.id);
  assert.equal((await s.call(`/api/rooms/${s.id}`, { settings: { autoApprove: 'sim' } }, 'PATCH')).status, 400);
});

test('lista do que sempre pede confirmação: pega o que é irreversível e deixa passar o trabalho comum', () => {
  for (const comando of ['git push origin main', 'git reset --hard HEAD~1', 'git clean -fd', 'npm publish', 'rm -rf build', 'Remove-Item dist -Recurse -Force', 'rd /s /q out', 'format D:', 'shutdown /s /t 0', 'reg delete HKCU\\Software\\X', 'gh pr merge 12']) {
    assert.ok(motivoParaPerguntar({ title: 'Bash', detail: comando }), comando);
  }
  for (const comando of ['npm test', 'git status', 'git commit -m "x"', 'node --test tests', 'Remove-Item arquivo.tmp', 'npm run dist', 'mkdir pasta']) {
    assert.equal(motivoParaPerguntar({ title: 'Bash', detail: comando }), null, comando);
  }
});

test('orientação antes da abertura passa à frente da chamada do participante, uma única vez', async t => {
  const ordem = [];
  const s = await sala(t, async ({agent}) => {
    ordem.push(agent);
    return reply(ordem.length === 1 ? '@Claude, avalie minha ideia.' : 'Concluído.');
  });
  let liberar;
  const pronto = new Promise(resolve => { liberar = resolve; });
  s.app.orchestrator.getAgentStatus = async () => { await pronto; return connected(); };
  const {job} = await s.enviar('Vamos conversar.');
  try {
    const guia = await s.call(`/api/jobs/${job.id}/steer`, {content:'@Gemini, você primeiro.'});
    assert.equal(guia.status, 201);
  } finally { liberar(); }
  assert.equal((await s.terminar(job.id)).status, 'completed');
  assert.deepEqual(ordem, ['codex','gemini','claude','codex']);
  assert.equal(s.eventos(job.id).filter(title => title === 'Você chamou Gemini').length, 1);
});

test('uma menção do usuário promove a chamada pendente sem gastar de novo o limite', () => {
  const round = startRound('chat', ['codex','claude','gemini']);
  queueCalls(round,['claude','gemini'],'codex');
  queueCalls(round,['gemini'],'user');
  assert.deepEqual(round.calls,[{agent:'gemini',from:'user'},{agent:'claude',from:'codex'}]);
  assert.equal(round.callsUsed,2);
});

test('ampliação de permissões do turno exige decisão explícita mesmo com Autonomia', async t => {
  let decisao;
  const s = await sala(t,async args => {
    decisao = await args.requestApproval({kind:'permission',requiresUser:true,title:'Ampliar acesso do turno',detail:'Acesso adicional solicitado.'});
    return reply('Fim.');
  }, {autoApprove:true});
  const {job} = await s.enviar('Verifique o projeto','code','codex');
  let pendente;
  for(let i=0;i<200 && !pendente;i++) {
    pendente=s.app.store.approvals(s.id).find(a=>a.status==='pending');
    if(!pendente) await wait(10);
  }
  assert.ok(pendente);
  await s.call(`/api/approvals/${pendente.id}`,{decision:'deny'});
  await s.terminar(job.id);
  assert.equal(decisao.decision,'deny');
});

