import { stat,readFile } from 'node:fs/promises';
import { join,dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { StdioRpc } from './rpc.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const exists=async path=>(await stat(path).catch(()=>null))?.isFile();
export async function integrationCatalog() {
  const rea=join(process.env.APPDATA || '', 'npm','node_modules','rea-agents','scripts','rea.mjs');
  const browser=join(root,'node_modules','@playwright','mcp','cli.js');
  return [
    {id:'github',label:'GitHub público',available:true,detail:'Leitura de repositórios, árvores e arquivos públicos.',command:process.execPath,args:[join(root,'lib','shared-tools.mjs'),'--stdio']},
    {id:'rea',label:'REA',available:Boolean(await exists(rea)),detail:'Engenharia reversa; cada operação depende dos motores instalados.',command:process.execPath,args:[rea,'--mcp']},
    {id:'browser',label:'Navegador de projeto',available:Boolean(await exists(browser)),detail:'Navegador isolado para testes e navegação. Não herda seus logins pessoais.',command:process.execPath,args:[browser,'--headless','--isolated','--browser','chrome','--block-service-workers']},
  ];
}
export async function nativeIntegrations(settings) {
  if(settings.access==='chat')return [];
  return (await integrationCatalog()).filter(i=>i.available && settings[`${i.id}Enabled`] && (i.id==='rea' || settings.internet));
}
// Na integração total, o Claude Code também carrega os servidores MCP do usuário. Se o usuário já tem o mesmo
// programa configurado (ex.: rea), a cópia mesa_* duplicaria centenas de ferramentas em todo prompt.
// Considera só os escopos que carregam sem aprovação extra: usuário e local (~/.claude.json).
const scriptKey=path=>String(path||'').replace(/\//g,'\\').toLowerCase();
export async function claudeUserScripts(cwd,file=join(process.env.CLAUDE_CONFIG_DIR || homedir(),'.claude.json')) {
  const config=await readFile(file,'utf8').then(JSON.parse).catch(()=>null);
  if(!config || typeof config!=='object')return new Set();
  const local=Object.entries(config.projects || {}).find(([path])=>scriptKey(path)===scriptKey(cwd))?.[1];
  const servers=[...Object.values(config.mcpServers || {}),...Object.values(local?.mcpServers || {})];
  return new Set(servers.flatMap(s=>Array.isArray(s?.args)?s.args.map(scriptKey):[]));
}
export const withoutUserDuplicates=(integrations,scripts)=>integrations.filter(i=>!scripts.has(scriptKey(i.args?.[0])));
// Servidores MCP das configurações do próprio usuário (1.6). Na integração total, Claude Code e Codex carregam esses
// servidores em toda fala, e cada ferramenta entra no contexto relido a cada chamada (o REA tem 229). A sala escolhe
// quais carregar; um servidor que é a mesma ferramenta de uma integração desligada na sala (ex.: REA) também sai.
export const mcpToolPrefix=name=>'mcp__'+String(name).replace(/[^A-Za-z0-9_-]/g,'_');
export async function claudeUserServers(cwd,file=join(process.env.CLAUDE_CONFIG_DIR || homedir(),'.claude.json')) {
  const config=await readFile(file,'utf8').then(JSON.parse).catch(()=>null);
  if(!config || typeof config!=='object')return [];
  const local=cwd?Object.entries(config.projects || {}).find(([path])=>scriptKey(path)===scriptKey(cwd))?.[1]:null;
  const servers=new Map();
  for(const [name,server] of [...Object.entries(config.mcpServers || {}),...Object.entries(local?.mcpServers || {})])
    if(/^[A-Za-z0-9_.-]{1,64}$/.test(name))servers.set(name,{name,command:server?.command,args:Array.isArray(server?.args)?server.args.map(String):[]});
  return [...servers.values()];
}
// Leitura mínima do config.toml do Codex: só os nomes e o comando/argumentos de cada [mcp_servers.NOME].
export async function codexUserServers(file=join(process.env.CODEX_HOME || join(homedir(),'.codex'),'config.toml')) {
  const text=await readFile(file,'utf8').catch(()=>'');
  const out=[];
  const header=/^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_.-]+?))\]\s*$/gm;
  const marks=[...text.matchAll(header)];
  for(const [index,match] of marks.entries()) {
    const name=match[1] || match[2];
    if(!/^[A-Za-z0-9_.-]{1,64}$/.test(name) || /\.(env|tools|headers)$/.test(name))continue;
    const body=text.slice(match.index+match[0].length,marks[index+1]?.index ?? text.length).split(/^\s*\[/m)[0];
    const command=body.match(/^\s*command\s*=\s*"([^"]*)"/m)?.[1];
    const args=[...(body.match(/^\s*args\s*=\s*\[([\s\S]*?)\]/m)?.[1] || '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m=>m[1].replace(/\\\\/g,'\\'));
    const enabled=!/^\s*enabled\s*=\s*false/m.test(body);
    out.push({name,command,args,enabled});
  }
  return out;
}
// Integrações da Synapse desligadas nesta sala, para reconhecer a mesma ferramenta nas configurações do usuário.
export async function disabledIntegrations(settings) {
  return (await integrationCatalog()).filter(i=>i.available && settings[`${i.id}Enabled`]===false);
}
const sameScript=(integration,server)=>Array.isArray(server?.args) && scriptKey(server.args[0])===scriptKey(integration.args?.[0]);
// Nomes dos servidores do usuário que ficam fora desta sala.
export function excludedUserServers(settings,servers,disabled=[]) {
  const chosen=new Set(settings.mcpExclude || []);
  return servers.filter(server=>chosen.has(server.name) || disabled.some(i=>sameScript(i,server))).map(server=>server.name);
}
// Lista para a tela de configurações: nomes, em quais clientes aparecem e se correspondem a uma integração da Synapse.
export async function userMcpServers(cwd) {
  const [claude,codex,catalog]=await Promise.all([claudeUserServers(cwd),codexUserServers(),integrationCatalog()]);
  const merged=new Map();
  for(const [client,list] of [['claude',claude],['codex',codex.filter(s=>s.enabled)]])
    for(const server of list) {
      const row=merged.get(server.name) || {name:server.name,clients:[],integration:null};
      if(!row.clients.includes(client))row.clients.push(client);
      row.integration ||= catalog.find(i=>i.available && sameScript(i,server))?.id || null;
      merged.set(server.name,row);
    }
  return [...merged.values()].sort((a,b)=>a.name.localeCompare(b.name));
}
// A configuração efetiva do Codex inclui os MCP herdados da conta e do projeto.
// Preserve variantes com outros argumentos (por exemplo um browser com outro perfil).
export function codexHasIntegration(integration, servers) {
  const [script,...options] = integration.args;
  const optionKey = value => integration.id === 'rea' && value === '--mcp' ? 'mcp' : value;
  return Object.values(servers).some(server => {
    if (server.enabled === false || !Array.isArray(server.args)) return false;
    const [entry,...args] = server.args;
    return /(?:^|[\\/])node(?:\.exe)?$/i.test(server.command || '') &&
      scriptKey(entry) === scriptKey(script) && args.length === options.length &&
      args.every((value,index) => optionKey(value) === optionKey(options[index]));
  });
}
export async function inspectIntegrations(cwd) {
  const results=[];
  for(const item of await integrationCatalog()) {
    const {command,args,...publicInfo}=item;
    if(!item.available){results.push(publicInfo);continue;}
    const rpc=new StdioRpc(command,args,{cwd,jsonrpc:true});
    try {
      await rpc.call('initialize',{protocolVersion:'2024-11-05',clientInfo:{name:'mesa',version:'0.3.0'},capabilities:{}},20000);rpc.notify('notifications/initialized');
      const catalog=await rpc.call('tools/list',{},20000);
      results.push({...publicInfo,connected:true,toolCount:catalog.tools?.length||0});
    }catch(error){results.push({...publicInfo,connected:false,detail:error.message});}finally{rpc.close();}
  }
  return results;
}
