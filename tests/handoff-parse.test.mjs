import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHandoff } from '../lib/routing.mjs';
import { claudeUserScripts,withoutUserDuplicates } from '../lib/integrations.mjs';

const bloco=v=>`<mesa_status>${JSON.stringify(v)}</mesa_status>`;

// Caso real de 22/11 (Gemini 4 Hydrogen): a fala citava a tag no meio do texto e tudo
// depois da citação sumia, inclusive o bloco de controle.
test('citar a tag no texto não apaga o resto da fala nem o bloco de controle', () => {
  const corpo='- `resumePrompt` preserva memória nova e regras de `<mesa_status>` entre falas.\n\n### 2. Conclusão\nAprovado com 149 testes.';
  const {text,control}=parseHandoff(corpo+'\n'+bloco({status:'complete',summary:'Revisão ok',decisions:['d'],next:[],tests:['t']}));
  assert.equal(text,corpo);
  assert.equal(control.status,'complete');
  assert.equal(control.summary,'Revisão ok');
  assert.deepEqual(control.tests,['t']);
});

test('citação com abertura e fechamento no texto fica intacta e vale o último bloco válido', () => {
  const corpo='O bloco `<mesa_status>`…`</mesa_status>` fecha cada fala.';
  const {text,control}=parseHandoff(corpo+'\n'+bloco({status:'blocked',summary:'Preciso de decisão'}));
  assert.equal(text,corpo);
  assert.equal(control.status,'blocked');
});

test('bloco final com JSON inválido continua oculto e não vira controle', () => {
  const {text,control}=parseHandoff('Resposta pronta.\n<mesa_status>{status: complete}</mesa_status>');
  assert.equal(text,'Resposta pronta.');
  assert.equal(control.status,'continue');
  assert.equal(control.summary,'');
});

test('formato comum continua igual', () => {
  const {text,control}=parseHandoff('Feito.\n'+bloco({status:'complete',summary:'ok'}));
  assert.equal(text,'Feito.');
  assert.equal(control.status,'complete');
});

// Duplicidade rea/mesa_rea observada na sessão do Claude com Integração total (22/11).
test('integração total não duplica um servidor MCP que o usuário já configurou no Claude', async () => {
  const dir=await mkdtemp(join(tmpdir(),'synapse-mcp-'));const file=join(dir,'.claude.json');
  await writeFile(file,JSON.stringify({
    mcpServers:{rea:{command:'node',args:['C:/Users/x/AppData/Roaming/npm/node_modules/rea-agents/scripts/rea.mjs','mcp']}},
    projects:{'C:/proj':{mcpServers:{pw:{command:'node',args:['C:/proj/node_modules/@playwright/mcp/cli.js']}}},
      'C:/outro':{mcpServers:{gh:{args:['C:/gh.mjs']}}}}}));
  const catalogo=[{id:'rea',args:['c:/users/x/appdata/roaming/npm/node_modules/rea-agents/scripts/rea.mjs','--mcp']},
    {id:'browser',args:['C:/proj/node_modules/@playwright/mcp/cli.js']},{id:'github',args:['C:/gh.mjs','--stdio']}];
  // Escopo local só vale para a pasta do projeto; o servidor de outra pasta não remove o github.
  assert.deepEqual(withoutUserDuplicates(catalogo,await claudeUserScripts('C:/proj',file)).map(i=>i.id),['github']);
  assert.deepEqual(withoutUserDuplicates(catalogo,await claudeUserScripts('C:/novo',file)).map(i=>i.id),['browser','github']);
  assert.equal((await claudeUserScripts('C:/proj',join(dir,'inexistente.json'))).size,0);
});
