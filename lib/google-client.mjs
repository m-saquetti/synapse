import { access,mkdir,writeFile } from 'node:fs/promises';
import { join,isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { StdioRpc } from './rpc.mjs';
import { AgentError,subscriptionEnvironment,runLocalProcess } from './agents.mjs';
import { normalizeSettings } from './settings.mjs';

export async function googleExecutable() {
  const override=process.env.MESA_GEMINI_BIN;
  if(override && !isAbsolute(override))throw new AgentError('MESA_GEMINI_BIN deve apontar para o Antigravity CLI.','UNAVAILABLE');
  const file=override || (process.platform==='win32'?join(process.env.LOCALAPPDATA||'','agy','bin','agy.exe'):(await runLocalProcess('which',['agy'])).stdout.trim());
  if(!file || !await access(file).then(()=>true,()=>false))throw new AgentError('Instale o Antigravity CLI oficial para conectar sua conta Google.','UNAVAILABLE');
  return file;
}
export function googleTools(settings) {
  return [...(settings.access==='chat'?[]:['read_file','edit_file','write_file','run_command']),...(settings.internet?['search_web']:[])];
}
// Integração total do Gemini: agente padrão do Antigravity (subagentes, research, image-generator, run_workflow,
// swarm, /browser…) com as personalizações do usuário, num perfil separado. Só com internet ligada: o agente padrão
// pesquisa na web, e sem internet a sala continua no perfil restrito, sem search_web.
export function googleLaunch(settings,profileName) {
  const s=normalizeSettings(settings);
  if(s.access!=='chat' && s.fullIntegration===true && s.internet) return {total:true,profileName:`${profileName}-total`,args:['acp','--disable-telemetry','--app-data-dir',`${profileName}-total`]};
  const agentName=`${profileName}-v2`;
  return {total:false,profileName,agentName,args:['acp','--agent',agentName,'--disable-telemetry','--include-default-customizations=false','--app-data-dir',profileName]};
}
export async function openGoogle({cwd,dataDir,settings=normalizeSettings(),signal,onNotification,onRequest,toolEnvironment={}}) {
  const profileName=`mesa-${createHash('sha256').update(dataDir).digest('hex').slice(0,12)}-${settings.access}-${settings.internet?'web':'local'}`;
  const launch=googleLaunch(settings,profileName);
  if(launch.total) {
    await mkdir(join(homedir(),'.gemini',launch.profileName),{recursive:true});
    const env=subscriptionEnvironment();
    for(const key of Object.keys(env))if(/^GEMINI_|^GOOGLE_GEMINI_|^GOOGLE_GENAI_|^ANTIGRAVITY_/i.test(key))delete env[key];
    Object.assign(env,toolEnvironment);
    const rpc=new StdioRpc(await googleExecutable(),launch.args,{cwd,signal,env,jsonrpc:true,onNotification,onRequest});
    try{rpc.info=await rpc.call('initialize',{protocolVersion:1,clientInfo:{name:'mesa',version:'1.0.0'},clientCapabilities:{}},45000);rpc.integracaoTotal=true;return rpc;}catch(error){rpc.close();throw error;}
  }
  const profile=join(homedir(),'.gemini',profileName);
  await mkdir(profile,{recursive:true});
  // ACP 1.5.9 does not enforce the CLI permissions file. Limit the main agent's
  // actual tools and disable inherited customizations instead of claiming it does.
  const agentName=`${profileName}-v2`,agentDir=join(homedir(),'.gemini','config','agents');
  await mkdir(agentDir,{recursive:true});
  await writeFile(join(agentDir,`${agentName}.md`),`---\nname: ${agentName}\ndescription: Participante Gemini da Synapse, com ferramentas explícitas por aba.\ntools: ${JSON.stringify(googleTools(settings))}\nmainAgent: true\nsubagent: false\ninheritCustomizations: false\n---\nVocê é Gemini na Mesa. Respeite as restrições explícitas do usuário. Nunca simule ferramentas ou resultados. Não altere a própria configuração, não ative subagentes ou novas integrações. ${settings.access==='chat'?'Chat: somente discussão e pesquisa autorizada; não acesse arquivos nem execute comandos.':'Code: trabalhe nos arquivos do projeto e solicite aprovação quando o cliente exigir.'} ${settings.internet?'Internet autorizada para esta tarefa.':'Não acesse a rede por ferramentas nem comandos.'}\n`);
  const env=subscriptionEnvironment();
  for(const key of Object.keys(env))if(/^GEMINI_|^GOOGLE_GEMINI_|^GOOGLE_GENAI_|^ANTIGRAVITY_/i.test(key))delete env[key];
  Object.assign(env,toolEnvironment);
  const rpc=new StdioRpc(await googleExecutable(),launch.args,{cwd,signal,env,jsonrpc:true,onNotification,onRequest});
  try{rpc.info=await rpc.call('initialize',{protocolVersion:1,clientInfo:{name:'mesa',version:'1.0.0'},clientCapabilities:{}},45000);return rpc;}catch(error){rpc.close();throw error;}
}
export function googleModels(session) {
  const option=session.configOptions?.find(o=>o.category==='model' || o.id==='model');
  const choices=option?.options?.flatMap(o=>o.options || [o]);
  return (choices?.map(m=>({id:m.value,label:m.name || m.value})) || (session.models?.availableModels||[]).map(m=>({id:m.modelId,label:m.name||m.modelId}))).filter(m=>/^gemini-/i.test(m.id));
}
export async function configureGoogleSession(rpc,session,sessionId,settings,effort) {
  const model= settings.geminiModel;
  const option=session.configOptions?.find(o=>o.category==='model'||o.id==='model');
  let actual=option?.currentValue || session.models?.currentModelId;
  if(model && model!=='auto') {
    if(!googleModels(session).some(m=>m.id===model) && !session.models?.availableModels?.some(m=>m.modelId===model && /^gemini-/i.test(m.modelId)))throw new AgentError(`O modelo ${model} não foi disponibilizado pelo Antigravity nesta conta. Escolha um modelo do catálogo.`, 'MODEL_UNAVAILABLE');
    if(option && option.options?.flatMap(o=>o.options || [o]).some(o=>o.value===model)) {
      const result=await rpc.call('session/set_config_option',{sessionId,configId:option.id,value:model});
      actual=result.configOptions?.find(o=>o.id===option.id)?.currentValue;
      if(actual!==model)throw new AgentError('O cliente não confirmou o modelo escolhido.','MODEL_UNAVAILABLE');
    } else {await rpc.call('session/set_model',{sessionId,modelId:model});actual=model;}
  }
  const effortOption=session.configOptions?.find(o=>o.category==='thought_level'||/thinking|effort/i.test(o.id));
  // Nível de raciocínio pedido na sala, quando o cliente oferece essa opção na sessão.
  const level=String(effort||'').toLowerCase();
  const levelOption=level && effortOption?.options?.flatMap(o=>o.options || [o]).find(o=>String(o.value).toLowerCase()===level || String(o.name||'').toLowerCase()===level);
  if(levelOption)await rpc.call('session/set_config_option',{sessionId,configId:effortOption.id,value:levelOption.value});
  if(session.modes?.availableModes?.some(m=>m.id==='default'))await rpc.call('session/set_mode',{sessionId,modeId:'default'});
  return actual || 'Padrão do Antigravity';
}
