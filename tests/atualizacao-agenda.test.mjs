// Synapse 1.1.2 (revisão do GPT): a confirmação vale para o pacote visto, o cancelamento invalida o pedido
// e só o servidor decide se a fila está vazia para encerrar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgendaDeAtualizacao, idDoPacote } from '../desktop/atualizacao.mjs';
import { createApp } from '../server.mjs';
import { stopMesa } from '../launch.mjs';

const pacote = (versao, extra = {}) => ({ versao, arquivo: `C:\\dist\\Synapse-Setup-${versao}.exe`, tamanho: 141e6, mtimeMs: 1000, ...extra });
const A = pacote('1.1.3'), B = pacote('1.1.4'), A2 = pacote('1.1.3', { mtimeMs: 2000 });
function montar({ achado = A, servidor = ['encerrado'], instalarFalha } = {}) {
  const log = [];
  const respostas = [...servidor];
  const agenda = new AgendaDeAtualizacao({
    procurar: async () => { log.push('procurar'); return typeof achado === 'function' ? achado() : achado; },
    encerrarServidor: async () => { log.push('encerrar'); return respostas.length > 1 ? respostas.shift() : respostas[0]; },
    instalar: async (arquivo) => { log.push(`instalar ${arquivo}`); if (instalarFalha) throw new Error(instalarFalha); },
    reabrir: async () => { log.push('reabrir'); },
  });
  agenda.oferecer(A);
  return { agenda, log };
}

test('identidade do pacote muda com versão, tamanho ou data (rebuild da mesma versão)', () => {
  assert.notEqual(idDoPacote(A), idDoPacote(A2));
  assert.equal(idDoPacote(null), null);
});

test('confirmação só vale para o pacote que o usuário viu', () => {
  const { agenda } = montar();
  assert.equal(agenda.confirmar(idDoPacote(B)), false);
  assert.equal(agenda.confirmar(undefined), false);
  assert.equal(agenda.confirmar(idDoPacote(A)), true);
  assert.equal(agenda.estado('1.1.2').aguardando, true);
});

test('com a fila ocupada, o pedido espera e depois instala exatamente o pacote confirmado', async () => {
  const { agenda, log } = montar({ servidor: ['ocupado', 'encerrado'] });
  agenda.confirmar(idDoPacote(A));
  assert.equal(await agenda.tentar(), 'aguardando');
  assert.equal(agenda.estado('1.1.2').aguardando, true);
  assert.equal(await agenda.tentar(), 'instalando');
  assert.deepEqual(log, ['procurar', 'encerrar', 'procurar', 'encerrar', `instalar ${A.arquivo}`]);
});

test('outra versão que chega durante a espera exige nova confirmação (aviso periódico)', async () => {
  const { agenda, log } = montar({ servidor: ['ocupado'] });
  agenda.confirmar(idDoPacote(A));
  await agenda.tentar();
  agenda.oferecer(B);
  assert.equal(agenda.estado('1.1.2').aguardando, false);
  assert.equal(await agenda.tentar(), 'sem-pedido');
  assert.ok(!log.some((l) => l.startsWith('instalar')));
});

test('outra versão encontrada na hora de aplicar exige nova confirmação, inclusive rebuild da mesma versão', async () => {
  for (const novo of [B, A2]) {
    const { agenda, log } = montar({ achado: novo });
    agenda.confirmar(idDoPacote(A));
    assert.equal(await agenda.tentar(), 'pacote-mudou');
    assert.equal(agenda.pedido, null);
    assert.equal(agenda.estado('1.1.2').id, idDoPacote(novo));
    assert.deepEqual(log, ['procurar'], 'nem chega a pedir o encerramento');
  }
});

test('cancelar durante a busca invalida o pedido antes de encerrar o servidor', async () => {
  let liberar;
  const { agenda, log } = montar({ achado: () => new Promise((ok) => { liberar = () => ok(A); }) });
  agenda.confirmar(idDoPacote(A));
  const tentativa = agenda.tentar();
  await new Promise((r) => setImmediate(r));
  agenda.cancelar();
  liberar();
  assert.equal(await tentativa, 'cancelado');
  assert.deepEqual(log, ['procurar']);
});

test('cancelar enquanto o servidor encerra reabre a Synapse sem instalar', async () => {
  let agenda;
  const montado = montar();
  agenda = montado.agenda;
  agenda.encerrarServidor = async () => { montado.log.push('encerrar'); agenda.cancelar(); return 'encerrado'; };
  agenda.confirmar(idDoPacote(A));
  assert.equal(await agenda.tentar(), 'reaberto');
  assert.deepEqual(montado.log, ['procurar', 'encerrar', 'reabrir']);
});

test('instalador que não inicia reabre a Synapse e desfaz o pedido', async () => {
  const { agenda, log } = montar({ instalarFalha: 'spawn EACCES' });
  agenda.confirmar(idDoPacote(A));
  assert.equal(await agenda.tentar(), 'falhou');
  assert.equal(agenda.pedido, null);
  assert.equal(agenda.erro.message, 'spawn EACCES');
  assert.deepEqual(log, ['procurar', 'encerrar', `instalar ${A.arquivo}`, 'reabrir']);
});

test('tentativas simultâneas viram uma só (o laço de 5 s não encerra o servidor duas vezes)', async () => {
  const { agenda, log } = montar({ servidor: ['ocupado'] });
  agenda.confirmar(idDoPacote(A));
  const [x, y] = await Promise.all([agenda.tentar(), agenda.tentar()]);
  assert.equal(x, 'aguardando');assert.equal(y, 'aguardando');
  assert.deepEqual(log, ['procurar', 'encerrar']);
});

// ---- servidor real: fila vazia confirmada por quem tem a fila
async function servidor(t, runAgent) {
  const dataDir = await mkdtemp(join(tmpdir(), 'synapse-encerrar-'));
  const app = await createApp({ dataDir, runAgent, getAgentStatus: async () => Object.fromEntries(['codex', 'claude', 'gemini'].map((p) => [p, { available: true, authenticated: true }])) });
  const url = await app.listen(0);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const boot = await (await fetch(url + '/api/bootstrap')).json();
  const enviar = (content) => fetch(`${url}/api/rooms/${boot.rooms[0].id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken }, body: JSON.stringify({ content, target: 'claude', mode: 'chat' }) });
  return { app, dataDir, enviar };
}

test('o servidor recusa encerrar para atualizar com tarefa em andamento e continua funcionando', async (t) => {
  let liberar;const rodando = new Promise((ok) => { liberar = ok; });
  const s = await servidor(t, async () => { await rodando; return { text: 'ok' }; });
  assert.equal((await s.enviar('Trabalhe')).status, 202);
  await assert.rejects(stopMesa(s.dataDir, { somenteSemTarefas: true }), { code: 'BUSY' });
  assert.equal(s.app.orchestrator.draining, undefined, 'recusa não bloqueia a sala');
  liberar();
  for (let i = 0; i < 200 && s.app.store.activeJobs().length; i++) await new Promise((r) => setTimeout(r, 10));
  let aceito = false;
  assert.equal(await stopMesa(s.dataDir, { somenteSemTarefas: true, aoAceitar: () => { aceito = true; } }), true);
  assert.equal(aceito, true);
});

test('depois de aceitar o encerramento, nenhuma tarefa nova entra (decisão síncrona)', async (t) => {
  const s = await servidor(t, async () => ({ text: 'ok' }));
  assert.equal(s.app.orchestrator.drain(), true);
  const resposta = await s.enviar('Chegou no meio do encerramento');
  assert.equal(resposta.status, 503);
  assert.match((await resposta.json()).error, /reiniciando para atualizar/);
  assert.equal(s.app.store.activeJobs().length, 0);
});
