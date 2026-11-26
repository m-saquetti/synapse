// Synapse 1.3: Integração total (recursos das interfaces oficiais) e canal com os clientes tolerante a mensagens grandes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings } from '../lib/settings.mjs';
import { codexHasIntegration } from '../lib/integrations.mjs';
import { CODEX_RECURSOS, claudeAccess, claudeLaunch, claudeToolPolicy, codexFeatureConfig, elicitacaoParaPedido, integracaoTotal, respostaElicitacao } from '../lib/providers.mjs';
import { googleLaunch } from '../lib/google-client.mjs';
import { StdioRpc } from '../lib/rpc.mjs';
import { narrowSettings } from '../lib/coordinator.mjs';

const sala = (extra) => normalizeSettings({ access: 'computer', internet: true, ...extra });

test('Codex reconhece só o MCP ativo com o mesmo script e modo', () => {
  const integration={id:'rea',args:['C:/rea/rea.mjs','--mcp']};
  const native={command:'node',args:['c:/rea/rea.mjs','mcp']};
  assert.equal(codexHasIntegration(integration,{rea:native}),true);
  assert.equal(codexHasIntegration(integration,{rea:{...native,enabled:false}}),false);
  assert.equal(codexHasIntegration(integration,{rea:{...native,args:[...native.args,'--custom']}}),false);
});

test('integração total vale só no Projeto e no Computador, e só se ligada', () => {
  assert.equal(integracaoTotal(sala({ fullIntegration: true })), true);
  assert.equal(integracaoTotal(sala({ fullIntegration: true, access: 'project' })), true);
  assert.equal(integracaoTotal(sala({ fullIntegration: true, access: 'chat' })), false, 'Chat nunca');
  assert.equal(integracaoTotal(sala({})), false, 'desligada por padrão');
  assert.throws(() => normalizeSettings({ fullIntegration: 'sim' }), /integração total/);
});

test('Claude: padrão em modo seguro; total com todas as ferramentas e as configurações do usuário', () => {
  const padrao = claudeLaunch(sala({}));
  assert.deepEqual(padrao.settingSources, []);
  assert.deepEqual(Object.keys(padrao.extraArgs).sort(), ['disable-slash-commands', 'no-chrome', 'safe-mode', 'strict-mcp-config']);
  const total = claudeLaunch(sala({ fullIntegration: true }));
  assert.deepEqual(total, { settingSources: ['user', 'project', 'local'], extraArgs: {} });
  assert.deepEqual(claudeAccess(sala({ fullIntegration: true })).tools, { type: 'preset', preset: 'claude_code' });
  assert.deepEqual(claudeAccess(sala({ fullIntegration: true, internet: false })).disallowedTools, ['WebSearch', 'WebFetch'], 'internet desligada continua valendo');
  assert.ok(Array.isArray(claudeAccess(sala({})).tools), 'padrão mantém a lista explícita');
});

test('Claude: na integração total, ler, planejar e delegar não interrompem; agir continua pedindo aprovação', () => {
  const total = sala({ fullIntegration: true });
  for (const ferramenta of ['Read', 'Grep', 'TodoWrite', 'Task', 'Skill']) assert.equal(claudeToolPolicy(ferramenta, total), 'allow', ferramenta);
  for (const ferramenta of ['Bash', 'Write', 'Edit', 'PowerShell', 'mcp__rea__run']) assert.equal(claudeToolPolicy(ferramenta, total), 'ask', ferramenta);
  assert.equal(claudeToolPolicy('Read', sala({})), 'ask', 'modo padrão inalterado');
  assert.equal(claudeToolPolicy('Read', sala({ fullIntegration: true, access: 'chat' })), 'deny');
});

test('Codex: padrão desliga os recursos da interface oficial; total devolve os padrões do Codex e respeita a internet', () => {
  const padrao = codexFeatureConfig(sala({}));
  for (const recurso of CODEX_RECURSOS) assert.equal(padrao[`features.${recurso}`], false, recurso);
  assert.equal(padrao.project_doc_max_bytes, 0);assert.equal(padrao['skills.bundled.enabled'], false);
  const total = codexFeatureConfig(sala({ fullIntegration: true }));
  for (const recurso of CODEX_RECURSOS) assert.equal(Object.hasOwn(total, `features.${recurso}`), false, `${recurso} fica no padrão do Codex`);
  for (const chave of ['project_doc_max_bytes', 'agents.enabled', 'skills.bundled.enabled']) assert.equal(Object.hasOwn(total, chave), false, chave);
  const semInternet = codexFeatureConfig(sala({ fullIntegration: true, internet: false }));
  assert.equal(semInternet['features.browser_use'], false);assert.equal(semInternet['features.apps'], false);
  assert.equal(Object.hasOwn(semInternet, 'features.computer_use'), false, 'uso do computador é local');
  assert.equal(semInternet.web_search, 'disabled');
});

test('Gemini: total usa o agente padrão do Antigravity num perfil separado, só com internet', () => {
  assert.deepEqual(googleLaunch(sala({ fullIntegration: true }), 'mesa-x-computer-web'), { total: true, profileName: 'mesa-x-computer-web-total', args: ['acp', '--disable-telemetry', '--app-data-dir', 'mesa-x-computer-web-total'] });
  const semInternet = googleLaunch(sala({ fullIntegration: true, internet: false }), 'mesa-x-computer-local');
  assert.equal(semInternet.total, false);assert.ok(semInternet.args.includes('--agent'));
  assert.ok(googleLaunch(sala({}), 'mesa-x').args.includes('--include-default-customizations=false'));
});

test('conectores do Codex: formulário vira perguntas e URL vira autorização; nunca pela Autonomia', () => {
  const form = { serverName: 'notion', mode: 'form', message: 'Escolha o espaço', requestedSchema: { properties: { espaco: { type: 'string', enum: ['Pessoal', 'Equipe'] }, publicar: { type: 'boolean' }, limite: { type: 'integer' }, tags: { type: 'array', items: { anyOf: [{ const: 'a' }, { const: 'b' }] } } }, required: ['espaco'] } };
  const pedido = elicitacaoParaPedido(form);
  assert.equal(pedido.kind, 'question');assert.equal(pedido.requiresUser, true);
  assert.deepEqual(pedido.questions.find((q) => q.id === 'espaco').options, ['Pessoal', 'Equipe']);
  assert.deepEqual(pedido.questions.find((q) => q.id === 'publicar').options, ['sim', 'não']);
  assert.deepEqual(respostaElicitacao(form, { decision: 'answer', answers: { espaco: 'Equipe', publicar: 'sim', limite: '12,0', tags: 'a, b' } }), { action: 'accept', content: { espaco: 'Equipe', publicar: true, limite: 12, tags: ['a', 'b'] } });
  assert.deepEqual(respostaElicitacao(form, { decision: 'answer', answers: { espaco: 'Pessoal', limite: '-' } }), { action: 'accept', content: { espaco: 'Pessoal' } });
  assert.deepEqual(respostaElicitacao(form, { decision: 'deny' }), { action: 'decline' });
  const url = { serverName: 'google-drive', mode: 'url', elicitationId: 'e1', message: 'Conecte sua conta', url: 'https://exemplo.test/oauth' };
  const autorizar = elicitacaoParaPedido(url);
  assert.equal(autorizar.kind, 'permission');assert.equal(autorizar.requiresUser, true);assert.match(autorizar.detail, /https:\/\/exemplo\.test\/oauth/);
  assert.deepEqual(respostaElicitacao(url, { decision: 'allow' }), { action: 'accept' });
  assert.deepEqual(respostaElicitacao(url, { decision: 'deny' }), { action: 'decline' });
});

test('Continuar não liga a integração total de uma tarefa que começou sem ela', () => {
  assert.equal(narrowSettings(sala({}), sala({ fullIntegration: true })).fullIntegration, false);
  assert.equal(narrowSettings(sala({ fullIntegration: true }), sala({ fullIntegration: true })).fullIntegration, true);
});

test('canal com o cliente: mensagem grande demais é descartada sem derrubar a conversa', async (t) => {
  const anterior = StdioRpc.LIMITE;StdioRpc.LIMITE = 4096;t.after(() => { StdioRpc.LIMITE = anterior; });
  // Cliente falso: notificação enorme, resposta enorme ao pedido 1, pedido enorme do cliente e resposta normal ao pedido 2.
  const cliente = `
    const rl=require('readline').createInterface({input:process.stdin});const enorme='x'.repeat(20000);
    rl.on('line',l=>{const m=JSON.parse(l);
      if(m.method==='primeiro'){process.stdout.write(JSON.stringify({method:'aviso',params:{dado:enorme}})+'\\n');process.stdout.write(JSON.stringify({id:m.id,result:{dado:enorme}})+'\\n');}
      if(m.method==='segundo'){process.stdout.write(JSON.stringify({id:77,method:'pergunta',params:{dado:enorme}})+'\\n');process.stdout.write(JSON.stringify({id:m.id,result:{ok:true}})+'\\n');}
      if(m.id===77 && m.error)process.stdout.write(JSON.stringify({method:'recusado',params:{codigo:m.error.code}})+'\\n');
    });`;
  const avisos = [];
  const rpc = new StdioRpc(process.execPath, ['-e', cliente], { onNotification: (m, p) => avisos.push([m, p]) });
  t.after(() => rpc.close());
  await assert.rejects(rpc.call('primeiro', {}, 5000), { code: 'OUTPUT_LIMIT' }, 'a resposta grande falha na hora, sem esperar o tempo');
  assert.deepEqual(await rpc.call('segundo', {}, 5000), { ok: true }, 'o canal continua aberto');
  for (let n = 0; n < 100 && !avisos.some(([m]) => m === 'recusado'); n++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(avisos.find(([m]) => m === 'recusado')?.[1], { codigo: -32603 }, 'o pedido grande do cliente recebeu erro');
  assert.equal(avisos.some(([m]) => m === 'aviso'), false, 'a notificação grande foi descartada');
  assert.equal(rpc.descartadas, 3);
  assert.equal(rpc.closed, false);
});
