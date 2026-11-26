import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { STATUS_RULES } from './orchestrator.mjs';
import { StdioRpc } from './rpc.mjs';
import { resolveExecutable, authentication, subscriptionEnvironment, safeDiagnostic, AgentError, classifyFailure, createEventCollector, runLocalProcess } from './agents.mjs';
import { normalizeSettings } from './settings.mjs';
import { nativeIntegrations,claudeUserScripts,withoutUserDuplicates,codexHasIntegration,claudeUserServers,disabledIntegrations,excludedUserServers,mcpToolPrefix } from './integrations.mjs';
import { openGoogle as openGemini,googleModels,configureGoogleSession } from './google-client.mjs';
import { readStudioKey, studioCatalog, runStudio, preferredModel } from './ai-studio.mjs';
import { normalizeCatalog, findModel, resolveEffort, geminiVariant, effortLabel, studioEfforts, geminiName } from './models.mjs';
import { createToolGateway } from './tool-gateway.mjs';
import { pacificMidnight, studioRequests } from './analytics.mjs';

const labels={codex:'Codex',claude:'Claude',gemini:'Gemini'};
// O Antigravity às vezes entrega o aviso de cota como se fosse a resposta (caso real de 23/11:
// "⚠ Individual quota reached. ... Resets in 117h16m41s."), e a Synapse gravava o aviso como fala do Gemini.
// Só vale para uma resposta curta que seja o próprio aviso.
const noticeStarts=['individual quota','quota','usage limit'];
const noticeBody=text=>text.trim().replace(/^⚠\uFE0F?\s*/u,'');
export function possibleQuotaNotice(text) {
  if(text.length>600)return false;
  const head=noticeBody(text).toLowerCase();
  return noticeStarts.some(prefix=>prefix.startsWith(head) || head.startsWith(prefix));
}
export function antigravityQuota(text,now=Date.now()) {
  if(!text || !possibleQuotaNotice(text))return null;
  const notice=noticeBody(text).match(/^(?:(?:individual )?quota|usage limit) (?:reached|exceeded|exhausted)[.!]?(?:\s+Please upgrade your (?:subscription|plan) to increase your limits[.!]?)?(?:\s+Resets? in\s+([\w\s]+)\.?)?$/i);
  if(!notice)return null;
  const m=notice[1]?.trim().match(/^(?:(\d{1,4})\s*d(?:ays?)?\s*)?(?:(\d{1,5})\s*h(?:ours?)?\s*)?(?:(\d{1,6})\s*m(?:inutes?)?\s*)?(?:(\d{1,8})\s*s(?:econds?)?)?$/i);
  if(notice[1] && !m)return null;
  const ms=m?((+m[1]||0)*86400+(+m[2]||0)*3600+(+m[3]||0)*60+(+m[4]||0))*1000:0;
  return {resetAt:ms?new Date(now+ms).toISOString():null};
}
// Falhas de uma rota do Gemini que a outra rota pode cobrir.
const GEMINI_SWITCH=['RATE_LIMIT','UNAVAILABLE','MODEL_UNAVAILABLE'];
// O Antigravity manda vários avisos por ferramenta (criação, pendente, em andamento, concluída). Em Ações entra
// um registro por mudança de estado de cada chamada, com o título e a entrada do primeiro aviso.
export function geminiToolActivity(calls,u) {
  const status=u.status==='completed'?'completed':u.status==='failed'?'failed':'running';
  const id=u.toolCallId,seen=id?calls.get(id):null;
  if(seen?.status===status)return null;
  const activity={tool:u.kind||seen?.tool||'gemini',title:u.title||seen?.title||'Ferramenta do Gemini',status,detail:u.rawInput?safeDiagnostic(JSON.stringify(u.rawInput)):seen?.detail||''};
  if(id)calls.set(id,activity);
  return activity;
}
export const GEMINI_CATALOG_TTL=10*60000;
// Sessão realmente retomada recebe o prompt incremental; sessão nova (ou recriada) recebe o completo.
export const promptFor=(args,resumed)=>resumed && args.resumePrompt?args.resumePrompt:args.prompt;
// Teto de chamadas de ferramenta por fala (Claude e GPT, 1.6). Ao atingir, a fala não termina sem texto (o que o
// --max-turns do Claude Code fazia sozinho): o participante recebe este pedido e responde sem novas ferramentas.
export const toolCapFor=settings=>{const s=normalizeSettings(settings);return s.access==='chat'?0:s.toolCallLimit;};
export const toolCapPrompt=cap=>`[Synapse] Esta fala atingiu o teto de ${cap} chamadas de ferramenta definido na sala. Não use mais ferramentas. Responda agora ao usuário com o que já fez e verificou: arquivos alterados, verificações executadas e resultado, o que ficou pendente e o próximo passo para quem continuar. Não afirme ter verificado o que não verificou. ${STATUS_RULES}`;
// Se nem o fechamento produzir texto, a fala termina com este aviso (e o que já tinha sido escrito), sem derrubar a rodada.
const capFallback=(cap,partial='')=>`${partial.trim()?partial.trim()+'\n\n':''}[Synapse] Esta fala atingiu o teto de ${cap} chamadas de ferramenta e terminou sem um resumo final do participante. Confira em Ações o que foi executado e os arquivos antes de continuar.`;
const capActivity=(agent,cap)=>({tool:'limit',title:`Teto de ferramentas · ${agent} fecha a fala`,status:'warning',detail:`Limite de ${cap} chamadas de ferramenta nesta fala (Configurações → Execução). ${agent} responde agora com o que já fez e verificou, sem novas ferramentas.`});
// Uso de duas consultas do Claude na mesma fala (trabalho + fechamento pelo teto).
export function sumClaudeUsage(a,b) {
  if(!a)return b;if(!b)return a;
  const out={...a};
  for(const [k,v] of Object.entries(b)) if(Number.isFinite(v))out[k]=(Number.isFinite(a[k])?a[k]:0)+v;
  if(a.output_tokens_details || b.output_tokens_details)out.output_tokens_details={thinking_tokens:(a.output_tokens_details?.thinking_tokens||0)+(b.output_tokens_details?.thinking_tokens||0)};
  if(Array.isArray(a.iterations) || Array.isArray(b.iterations))out.iterations=[...(a.iterations||[]),...(b.iterations||[])];
  return out;
}
// Ferramentas do Claude: pesquisar é permitido quando a sala liga a internet; abrir uma página passa pela
// aprovação da Mesa (como read_url no Gemini); o resto também. Nada fica pré-aprovado no SDK, então o
// canUseTool da Mesa é consultado em toda chamada.
// Integração total (settings.fullIntegration): no Projeto e no Computador, cada cliente roda como na interface
// oficial (ferramentas, skills, plugins, subagentes, MCP e configurações do usuário). A aprovação da Synapse
// (ou a Autonomia) continua valendo para as ações; o Chat nunca usa a integração total.
export const integracaoTotal=settings=>{const s=normalizeSettings(settings);return s.access!=='chat' && s.fullIntegration===true;};
export function claudeAccess(settings) {
  const s=normalizeSettings(settings),working=s.access!=='chat';
  if(integracaoTotal(s)) return {tools:{type:'preset',preset:'claude_code'},permissionMode:'acceptEdits',allowedTools:[],disallowedTools:s.internet?[]:['WebSearch','WebFetch']};
  return {tools:[...(working?['Read','Write','Edit','Glob','Grep','Bash','PowerShell','AskUserQuestion']:[]),...(s.internet?['WebSearch','WebFetch']:[])],
    permissionMode:working?'acceptEdits':'default',allowedTools:[]};
}
// Padrão: modo seguro do Claude Code (sem CLAUDE.md, skills, plugins, hooks, MCP do usuário, comandos e agentes).
// Total: carrega as configurações do usuário e do projeto como o Claude Code oficial.
export function claudeLaunch(settings) {
  return integracaoTotal(settings)?{settingSources:['user','project','local'],extraArgs:{}}
    :{settingSources:[],extraArgs:{'safe-mode':null,'strict-mcp-config':null,'no-chrome':null,'disable-slash-commands':null}};
}
// Na integração total, ferramentas sem efeito fora da conversa (ler, buscar, planejar, delegar a subagentes, que
// pedem aprovação para as próprias ações) não interrompem você.
const CLAUDE_SEM_EFEITO=new Set(['Read','Glob','Grep','LS','NotebookRead','TodoWrite','ExitPlanMode','EnterPlanMode','Task','Agent','Skill','ToolSearch','ListMcpResourcesTool','ReadMcpResourceTool','BashOutput','TaskOutput']);
export function claudeToolPolicy(name,settings) {
  const s=normalizeSettings(settings);
  if(name==='WebSearch' || name==='WebFetch') return !s.internet?'deny':name==='WebSearch'?'allow':'ask';
  if(s.access==='chat') return 'deny';
  if(integracaoTotal(s) && CLAUDE_SEM_EFEITO.has(name)) return 'allow';
  return 'ask';
}
const iso=seconds=>Number.isFinite(seconds)?new Date(seconds*1000).toISOString():null;
// Custo só desta fala: total da conversa no fim menos a base registrada na primeira requisição.
export function codexTurnUsage(usage,base) {
  if(!usage?.total || !base) return usage;
  return {...usage,turn:Object.fromEntries(Object.entries(usage.total).map(([k,v])=>[k,Math.max(0,v-(base[k]||0))]))};
}
export function codexUsage(data) {
  const buckets=data?.rateLimitsByLimitId || {codex:data?.rateLimits};const windows=[];
  for(const [id,bucket] of Object.entries(buckets)) for(const key of ['primary','secondary']) {
    const w=bucket?.[key];if(!w || !Number.isFinite(w.usedPercent)) continue;
    windows.push({id:`${id}:${key}`,label:w.windowDurationMins===300?'5 horas':w.windowDurationMins===10080?'Semanal':`${w.windowDurationMins || '?'} min`,usedPercent:w.usedPercent,resetsAt:iso(w.resetsAt),...(id!=='codex'?{model:bucket.normalModelSlug || id}:{})});
  }
  return {source:'Codex app-server',observedAt:new Date().toISOString(),windows,ordinaryUsageAllowed:data?.ordinaryUsageAllowed??null};
}
export function claudeUsage(data) {
  const limits=data?.rate_limits;const windows=[];
  for(const [key,label,model] of [['five_hour','5 horas'],['seven_day','Semanal'],['seven_day_opus','Semanal · Opus','opus'],['seven_day_sonnet','Semanal · Sonnet','sonnet'],['seven_day_oauth_apps','Semanal · integrações']]) {
    const w=limits?.[key];if(w && Number.isFinite(w.utilization)) windows.push({id:key,label,usedPercent:w.utilization,resetsAt:w.resets_at,...(model?{model}:{})});
  }
  for(const w of limits?.model_scoped||[]) if(Number.isFinite(w.utilization)) windows.push({id:`model:${w.display_name}`,label:`Semanal · ${w.display_name}`,model:w.display_name.toLowerCase(),usedPercent:w.utilization,resetsAt:w.resets_at});
  return {source:'Claude Code · consulta experimental',observedAt:new Date().toISOString(),windows};
}
// Recursos que o Codex oficial liga por padrão (codex features list, 0.167) e a Synapse desliga no modo padrão.
export const CODEX_RECURSOS=['apps','plugins','hooks','multi_agent','browser_use','browser_use_external','computer_use','image_generation','memories','workspace_dependencies'];
// Na integração total, o que depende da internet segue a opção de internet da sala.
const CODEX_REDE=['browser_use','browser_use_external','apps'];
export function codexFeatureConfig(settings) {
  const s=normalizeSettings(settings),working=s.access!=='chat',total=integracaoTotal(s);
  const config={'forced_login_method':'chatgpt','web_search':s.internet?'live':'disabled','sandbox_workspace_write.network_access':s.internet};
  if(total) {for(const feature of CODEX_REDE) if(!s.internet) config[`features.${feature}`]=false;}
  else {
    Object.assign(config,{'project_doc_max_bytes':0,'agents.enabled':false,'skills.bundled.enabled':false,'features.skip_host_skill_discovery':true});
    for(const feature of CODEX_RECURSOS) config[`features.${feature}`]=false;
  }
  config['features.shell_tool']=working;config['features.view_image']=working;
  config['features.code_mode']=working || s.internet;config['features.code_mode_host']=working || s.internet;
  return config;
}
export async function codexConfig(settings,rpc,cwd) {
  const config=codexFeatureConfig(settings);
  const {config:effective}=await rpc.call('config/read',{cwd,includeLayers:false});
  const inherited=effective.mcp_servers || {},total=integracaoTotal(settings);
  const servers={};
  if(!total) for(const id of Object.keys(inherited))servers[id]={enabled:false};
  else {
    // Integração total (1.6): os servidores do usuário escolhidos para ficar fora da sala, e os que são a mesma
    // ferramenta de uma integração desligada nela (ex.: REA), não carregam.
    const s=normalizeSettings(settings),disabled=await disabledIntegrations(s);
    for(const [id,server] of Object.entries(inherited))
      if(s.mcpExclude.includes(id) || disabled.some(i=>codexHasIntegration(i,{[id]:server})))servers[id]={enabled:false};
  }
  for(const integration of await nativeIntegrations(settings)) {
    if(total && codexHasIntegration(integration,inherited))continue;
    servers[`mesa_${integration.id}`]={command:integration.command,args:integration.args,enabled:true,startup_timeout_sec:30,tool_timeout_sec:120};
  }
  config.mcp_servers=servers;
  return config;
}
// Conectores (apps, plugins e MCP) do Codex pedem dados ou autorização ao usuário por elicitação. Formulário vira
// perguntas no cartão de aprovação; URL vira um pedido de autorização. Nunca é aprovado pela Autonomia.
export function elicitacaoParaPedido(p) {
  const origem=p?.serverName?` · ${p.serverName}`:'';
  if(p?.mode==='url') return {kind:'permission',requiresUser:true,title:`Codex${origem} pede autorização`,detail:`${p.message || ''}

Abra no navegador e conclua: ${p.url}
Depois clique em Permitir. Recusar cancela esta etapa.`};
  const props=p?.requestedSchema?.properties || {},obrigatorios=new Set(p?.requestedSchema?.required || []);
  const questions=Object.entries(props).map(([id,campo])=>{
    const opcoes=campo.type==='boolean'?['sim','não']:Array.isArray(campo.enum)?campo.enum:(campo.oneOf||campo.anyOf||campo.items?.anyOf||campo.items?.oneOf||[]).map(o=>o.const).filter(Boolean);
    const extra=[campo.description,campo.type==='array'?'separe vários valores por vírgula':null,obrigatorios.has(id)?null:'opcional: deixe "-" para pular'].filter(Boolean).join(' · ');
    return {id,question:`${campo.title || id}${extra?` (${extra})`:''}`,options:opcoes};
  });
  return {kind:'question',requiresUser:true,title:`Codex${origem}: ${p?.message || 'precisa de uma informação'}`,questions};
}
export function respostaElicitacao(p,reply) {
  if(p?.mode==='url') return {action:reply?.decision==='allow'?'accept':'decline'};
  if(reply?.decision!=='answer') return {action:'decline'};
  const props=p?.requestedSchema?.properties || {},content={};
  for(const [id,campo] of Object.entries(props)) {
    const bruto=String(reply.answers?.[id] ?? '').trim();
    if(!bruto || bruto==='-') continue;
    if(campo.type==='boolean') content[id]=/^(sim|s|yes|y|true|1)$/i.test(bruto);
    else if(campo.type==='number' || campo.type==='integer') {const n=Number(bruto.replace(',','.'));if(Number.isFinite(n))content[id]=campo.type==='integer'?Math.trunc(n):n;}
    else if(campo.type==='array') content[id]=bruto.split(',').map(v=>v.trim()).filter(Boolean);
    else content[id]=bruto;
  }
  return {action:'accept',content};
}
async function openCodex(args={}) {
  const file=await resolveExecutable('codex');
  const auth=await authentication('codex',file,args.signal);
  if(!auth.subscription) throw new AgentError('Entre no Codex usando sua conta ChatGPT.','AUTH_REQUIRED');
  const rpc=new StdioRpc(file,['app-server'],args);
  try {
    await rpc.call('initialize',{clientInfo:{name:'mesa_local',title:'Synapse',version:'1.0.0'},capabilities:{experimentalApi:true,requiredHumanApproval:true}});rpc.notify('initialized');
    return rpc;
  } catch(error){rpc.close();throw error;}
}
export async function claudeOptions(cwd,settings={},extra={}) {
  const file=await resolveExecutable('claude'),auth=await authentication('claude',file,extra.abortController?.signal);
  if(auth.plan?.toLowerCase()==='free') throw new AgentError('Claude Free não inclui o Claude Code nesta conexão.', 'SUBSCRIPTION_REQUIRED');
  if(!auth.subscription) throw new AgentError('Entre no Claude Code usando sua conta Claude.','AUTH_REQUIRED');
  const s=normalizeSettings(settings);
  let integrations=await nativeIntegrations(s),semMcp=[];
  if(integracaoTotal(s)) {
    integrations=withoutUserDuplicates(integrations,await claudeUserScripts(cwd));
    // Servidores MCP do usuário que esta sala não carrega: saem do contexto do modelo (disallowedTools mcp__nome).
    semMcp=excludedUserServers(s,await claudeUserServers(cwd),await disabledIntegrations(s)).map(mcpToolPrefix);
  }
  const mcpServers=Object.fromEntries(integrations.map(i=>[`mesa_${i.id}`,{command:i.command,args:i.args}]));
  const {settingSources,extraArgs}=claudeLaunch(s),access=claudeAccess(s);
  return {cwd,pathToClaudeCodeExecutable:file,env:subscriptionEnvironment(),settingSources,mcpServers,
    ...access,...(semMcp.length?{disallowedTools:[...(access.disallowedTools||[]),...semMcp]}:{}),
    model:s.claudeModel || undefined,persistSession:true,includePartialMessages:true,
    extraArgs,...extra};
}
async function withClaudeMetadata(cwd,fn) {
  let release;const idle=new Promise(r=>release=r);async function* input(){await idle;}
  const q=query({prompt:input(),options:await claudeOptions(cwd,{}, {persistSession:false})});
  const timer=setTimeout(()=>q.close(),25000);
  try{return await fn(q);}finally{clearTimeout(timer);release();q.close();}
}
async function readClaudeUsage(q) {
  // Optional capability: an older official client may not implement this experimental method.
  const fn=q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if(typeof fn!=='function') return null;
  try{return claudeUsage(await fn.call(q,{skipBehaviors:true}));}catch{return null;}
}
export class Providers {
  constructor({dataDir,store,notify=()=>{}}) {Object.assign(this,{dataDir,store,notify});this.login=null;this.loginError=null;this.lastStatus=new Map();this.geminiCache=null;
    // Pontos de troca para os testes do Claude sem o cliente real.
    this.claudeQuery=query;this.claudeOptions=claudeOptions;}
  // O catálogo do Google só vem de uma sessão nova do Antigravity. Entre etapas de uma tarefa ele é
  // reaproveitado por alguns minutos; "Atualizar uso" na Mesa pede uma consulta nova (fresh).
  async geminiCatalog(fresh=false) {
    const cached=this.geminiCache;
    if(this.nativePause()){
      const models=cached?.models || (this.store.providerState('gemini')?.catalog || []).filter(m=>m.source==='Antigravity');
      return {models,cached:true};
    }
    if(!fresh && cached && Date.now()-cached.at<GEMINI_CATALOG_TTL) return {...cached,cached:true};
    const models=await this.probeGemini();
    this.geminiCache={at:Date.now(),models};
    return {...this.geminiCache,cached:false};
  }
  async probeGemini() {
    const cwd=join(this.dataDir,'client-probe');await mkdir(cwd,{recursive:true});
    const rpc=await openGemini({cwd,dataDir:this.dataDir});
    try {const session=await rpc.call('session/new',{cwd,mcpServers:[]},45000);return googleModels(session);}
    finally{rpc.close();}
  }
  async status({fresh=false}={}) {
    const cwd=join(this.dataDir,'client-probe');await mkdir(cwd,{recursive:true});
    return Object.fromEntries(await Promise.all(Object.keys(labels).map(async agent=>{
      const base={available:true,authenticated:false,label:labels[agent],models:[],usage:null};
      try {
        if(agent==='codex') {
          const rpc=await openCodex({cwd});
          try {
            try { base.plan=(await rpc.call('account/read',{refreshToken:false})).account?.planType; } catch {}
            let cursor,models=[];
            do {const page=await rpc.call('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});models.push(...page.data);cursor=page.nextCursor;}while(cursor && models.length<500);
            base.models=models.map(m=>({id:m.model,label:m.displayName,isDefault:m.isDefault,efforts:m.supportedReasoningEfforts?.map(v=>v.reasoningEffort),defaultEffort:m.defaultReasoningEffort}));
            try{base.usage=codexUsage(await rpc.call('account/rateLimits/read'));}catch{}
            base.authenticated=true;base.detail='Conta ChatGPT · catálogo do Codex';
          }finally{rpc.close();}
        } else if(agent==='claude') {
          const prior=this.store.providerState('claude');
          if(prior.planDenial && !fresh && Date.now()-prior.planDenial<6*3600000){
            base.plan='restricted';throw new AgentError('O Claude Code recusou o acesso pela assinatura.','SUBSCRIPTION_REQUIRED');
          }
          if(prior.planDenial) this.store.saveProviderState('claude',{...prior,planDenial:null});
          const auth=await authentication('claude',await resolveExecutable('claude'));
          base.plan=auth.plan;
          if(base.plan?.toLowerCase()==='free') throw new AgentError('Claude Free não inclui o Claude Code nesta conexão.', 'SUBSCRIPTION_REQUIRED');
          await withClaudeMetadata(cwd,async q=>{
            const models=await q.supportedModels();
            base.models=[...new Map(models.map(m=>[m.resolvedModel || m.value,{id:m.resolvedModel || m.value,label:m.displayName,description:m.description,supportsEffort:m.supportsEffort,efforts:m.supportedEffortLevels}])).values()];
            base.usage=await readClaudeUsage(q);base.authenticated=true;base.detail='Conta Claude · catálogo do Claude Code';
          });
        } else {
          const [direct,native]=await Promise.allSettled([this.directCatalog(fresh),this.login?Promise.resolve({models:[]}):this.geminiCatalog(fresh)]);
          const fallback=native.value?.models || [];
          const apiModels=direct.value || [];
          base.models=[...apiModels,...fallback.map(m=>({...m,tier:'Conta Google',source:'Antigravity',availability:'listed'}))];
          base.authenticated=base.models.some(m=>!['locked','cooldown'].includes(m.availability));
          base.detail=[apiModels.length?'AI Studio':direct.reason?.message,fallback.length?'Antigravity':null].filter(Boolean).join(' · ') || 'Conecte o Google nas configurações.';
          base.nativeConnected=fallback.length>0;base.loginPending=Boolean(this.login);
          base.origins=this.geminiOrigins({studio:apiModels.length>0,native:base.nativeConnected,
            studioModels:apiModels.filter(m=>m.availability!=='locked').map(m=>geminiName(String(m.id).replace(/^api:/,'')))});
          if(this.loginError)base.detail+=' · '+this.loginError;
        }
        if(base.usage) this.store.saveProviderState(agent,{...this.store.providerState(agent),usage:base.usage});
        else {const saved=this.store.providerState(agent).usage;if(saved) base.usage={...saved,stale:true};}
        base.blocked=base.usage?.ordinaryUsageAllowed===false;
        if(base.authenticated)this.lastStatus.set(agent,structuredClone(base));
      }catch(error){
        const previous=this.lastStatus.get(agent);
        const authFailure=['AUTH_REQUIRED','SUBSCRIPTION_REQUIRED'].includes(error.code) || /unauthenticated|authentication required|login required|not authenticated|invalid.*token/i.test(error.message);
        if(previous && !authFailure){Object.assign(base,previous,{available:false,stale:true});if(base.usage)base.usage={...base.usage,stale:true};base.detail='Consulta indisponível; última conexão preservada. '+safeDiagnostic(error.message);}
        else {base.detail=authFailure?'Reconecte sua conta no cliente oficial.':safeDiagnostic(error.message);base.available=!['UNAVAILABLE'].includes(error.code);}
      }
      const saved=this.store.providerState(agent);
      const known=base.authenticated && base.available && !base.stale;
      const previous=normalizeCatalog(agent,saved.catalog || []);
      if(known) {
        base.models=normalizeCatalog(agent,base.models).map(m=>({...m,tier:m.tier || base.plan || 'Plano não informado',availability:m.availability || 'listed'}));
        const absent=previous.filter(old=>!base.models.some(m=>m.id===old.id)).map(m=>({...m,availability:agent==='gemini' && !base.models.some(m=>m.source===old.source)?'unknown':'locked'}));
        base.models.push(...absent);
        this.store.saveProviderState(agent,{...saved,catalog:base.models});
      } else if(!base.models.length || base.stale) {
        const fallback=previous.length?previous:agent==='claude'?[{id:'claude-opus-5-5',label:'Claude Opus 5.5'}]:[];
        base.models=normalizeCatalog(agent,fallback).map(m=>({...m,tier:['free','restricted'].includes(base.plan) && agent==='claude'?'Pro ou superior':base.plan || m.tier || 'Plano não informado',availability:['free','restricted'].includes(base.plan)?'locked':'unknown'}));
      }
      if(agent==='claude' && ['free','restricted'].includes(base.plan)) {
        base.blocked=true;
        base.detail=base.plan==='free'?'Claude Free · Claude Code requer um plano compatível.':'O Claude Code recusou a assinatura. Após renovar, use Atualizar uso para revalidar.';
      }
      if(agent==='gemini')base.loginPending=Boolean(this.login);
      return [agent,base];
    })));
  }
  // Uso do Gemini identificado pela origem (1.6): o AI Studio não informa percentual de cota, então a Synapse mostra as
  // requisições que ela mesma fez desde a renovação diária (meia-noite do Pacífico) e as pausas gravadas de cada rota.
  // studioModels (1.7): modelos gratuitos do AI Studio; a rota só está esgotada quando todos eles estão.
  geminiOrigins({studio=false,native=false,studioModels=[]}={},now=Date.now()) {
    const since=pacificMidnight(now);
    const rows=this.store?.db?studioRequests(this.store.db,since):[];
    const studioState=this.store?.providerState?.('studio') || {},models=studioState.models || {},limits=studioState.limits || {};
    const paused=Object.entries(models).filter(([,v])=>v?.until && Date.parse(v.until)>now).map(([id,v])=>({model:geminiName(id.replace(/^api:/,'')),until:v.until}));
    const nativePause=this.nativePause();
    return [
      {id:'studio',label:'AI Studio',connected:studio,since,models:[...new Set(studioModels)],items:rows.map(r=>({model:geminiName(r.model),requests:r.requests,falas:r.falas,...(limits[r.model]?{limit:limits[r.model]}:{})})),paused},
      {id:'antigravity',label:'Antigravity',connected:native,paused:nativePause?[{model:'Conta Google',until:nativePause.until}]:[]},
    ];
  }
  async studioAccess() {
    const key=await readStudioKey();
    const fingerprint=key?createHash('sha256').update(key).digest('hex').slice(0,24):null;
    const saved=this.store.providerState('studio');
    if(saved.fingerprint!==fingerprint) {
      this.store.saveProviderState('studio',{fingerprint,models:{}});
      this.directCache=null;
    }
    return key;
  }
  async directCatalog(fresh=false) {
    const key=await this.studioAccess();
    if(fresh || !this.directCache || Date.now()-this.directCache.at>=GEMINI_CATALOG_TTL) {
      const models=await studioCatalog(key);
      this.directCache={at:Date.now(),models};
    }
    const limits=this.store.providerState('studio').models || {};
    return this.directCache.models.map(model=>{
      const state=limits[model.id];
      if(state?.until && Date.parse(state.until)>Date.now())return {...model,availability:'cooldown',retryAt:state.until};
      if(state?.confirmed && model.availability==='listed')return {...model,availability:'available'};
      return model;
    });
  }
  // Login Google pelo Antigravity (ACP authenticate). onDone(ok, mensagem) avisa a tela de contas (lib/accounts.mjs).
  async connectGemini({onDone}={}) {
    if(this.login) {this.loginWatchers=[...(this.loginWatchers||[]),onDone].filter(Boolean);return {status:'pending',message:'Conclua o login na página oficial do Google aberta pelo cliente.'};}
    const cwd=join(this.dataDir,'client-probe');await mkdir(cwd,{recursive:true});
    const rpc=await openGemini({cwd,dataDir:this.dataDir});this.login=rpc;this.loginError=null;this.geminiCache=null;this.loginWatchers=onDone?[onDone]:[];
    const done=(ok,message)=>{for(const watcher of this.loginWatchers||[])try{watcher(ok,message);}catch{}this.loginWatchers=[];};
    rpc.call('authenticate',{methodId:'oauth-personal'},15*60000).then(()=>{
      this.store.saveProviderState('gemini',{...this.store.providerState('gemini'),connectedAt:new Date().toISOString()});
      this.notify('update',{type:'agent-connected',agent:'gemini'});done(true);
    },error=>{
      if(rpc.cancelado){done(false,'login cancelado');return;}
      this.loginError=safeDiagnostic(error.message);this.notify('provider-error',{agent:'gemini',message:this.loginError});done(false,this.loginError);
    }).finally(()=>{rpc.close();if(this.login===rpc)this.login=null;});
    return {status:'pending',message:'Conclua o login na página oficial do Google aberta pelo cliente.'};
  }
  cancelGeminiLogin() {const rpc=this.login;if(!rpc)return;rpc.cancelado=true;rpc.close();this.login=null;}
  // Esforço de cada participante: o escolhido na sala, ajustado ao que o modelo aceita.
  withEffort(args) {
    const agent=args.agent,s=args.settings||{};
    const catalog=normalizeCatalog(agent,this.store?.providerState?.(agent)?.catalog||[]);
    const saved=s[agent+'Model'];
    const studioRoute=agent==='gemini' && (!saved || saved==='auto' || String(saved).startsWith('api:'));
    const model=findModel(agent,catalog,saved) || (studioRoute?{efforts:studioEfforts(saved || 'auto')}:agent==='codex' && !saved?catalog.find(m=>m.isDefault && m.availability!=='locked'):null);
    const {effort,adjusted,requested}=resolveEffort(s[agent+'Effort'],model);
    if(adjusted)args.onActivity?.({tool:'effort',title:'Esforço ajustado ao modelo',status:'info',detail:`${effortLabel(agent,requested)} não está disponível neste modelo; a participação usa ${effortLabel(agent,effort)}.`});
    const modelId=agent==='gemini' && saved && saved!=='auto' && !String(saved).startsWith('api:')?geminiVariant(model,saved,effort):saved;
    return {...args,effort,modelId};
  }
  async run(args) {
    args=this.withEffort(args);
    if(args.agent==='gemini')args={...args,studioBudget:{requests:0}};
    const controller=new AbortController(),abort=()=>controller.abort();args.signal?.addEventListener('abort',abort,{once:true});
    if(args.signal?.aborted) controller.abort();
    const timeout=setTimeout(abort,args.timeoutMs || 900000);
    const invoke=options=>options.agent==='codex'?this.runCodex({...options,signal:controller.signal}):options.agent==='claude'?this.runClaude({...options,controller,signal:controller.signal}):this.runGemini({...options,signal:controller.signal});
    try {
      try{return await invoke(args);}catch(error){
        if(!args.sessionId || controller.signal.aborted || !/(?:session|thread|conversation)[^\n]{0,160}(?:not found|does not exist|could not be found)|no conversation found|no saved session/i.test(error.message))throw error;
        args.onActivity?.({tool:'session',title:'Sessão recuperada pela memória da Synapse',status:'info',detail:'O cliente não encontrou a sessão anterior. Uma nova sessão receberá o histórico e os checkpoints preservados.'});
        return await invoke({...args,sessionId:undefined});
      }
    }
    catch(error){
      if(args.agent==='claude' && !controller.signal.aborted){
        const classified=classifyFailure(error.message,'claude');
        if(error.code==='SUBSCRIPTION_REQUIRED' || classified.code==='SUBSCRIPTION_REQUIRED'){
          this.store.saveProviderState('claude',{...this.store.providerState('claude'),planDenial:Date.now()});
          this.notify('update',{type:'subscription',agent:'claude'});
          throw classified.code==='SUBSCRIPTION_REQUIRED'?classified:error;
        }
      }
      if(controller.signal.aborted){
        const stopped=new AgentError(args.signal?.aborted?'Execução interrompida.':'Tempo da participação esgotado. O trabalho foi preservado.',args.signal?.aborted?'CANCELLED':'TIMEOUT');
        throw Object.assign(stopped,{usage:error.usage,model:error.model,partialText:error.partialText,toolExecuted:error.toolExecuted});
      }
      throw error.code?error:classifyFailure(error.message,args.agent);}
    finally{clearTimeout(timeout);args.signal?.removeEventListener('abort',abort);}
  }
  async runCodex(args) {
    const {cwd,settings,signal,onDelta=()=>{},onActivity=()=>{},onSession=()=>{},requestApproval=async()=>({decision:'deny'})}=args;
    let activeModel=args.settings.codexModel || null,threadId,turnId,text='',usage,usageBase,settle,settled=false;
    const completion=new Promise((resolve,reject)=>settle=(error,value)=>{if(settled)return;settled=true;error?reject(error):resolve(value);});completion.catch(()=>{});
    const finalMessages=new Map();
    // Teto de ferramentas (1.6): ao passar do limite, a fala é interrompida e um novo turno na mesma conversa pede o
    // fechamento sem ferramentas. Nesse turno, pedidos de aprovação são recusados e, se ele insistir, encerra-se assim.
    const cap=toolCapFor(settings),TOOL_ITEMS=new Set(['commandExecution','fileChange','webSearch','mcpToolCall','dynamicToolCall']);
    let tools=0,completedTools=0,capping=null,wrapTools=0;
    const startWrap=()=>{
      capping='wrapup';finalMessages.clear();
      const observed=`O cliente registrou ${tools} chamadas iniciadas e ${completedTools} encerradas antes da interrupção. Um encerramento pode incluir falha. Se faltar o resultado da última ação, indique que seus efeitos precisam ser conferidos antes de repeti-la.`;
      rpc.call('turn/start',{threadId,input:[{type:'text',text:toolCapPrompt(cap)+'\n'+observed}],model:settings.codexModel || null,...(args.effort?{effort:args.effort}:{})})
        .then(started=>{turnId=started.turn.id;},error=>settle(error));
    };
    const rpc=await (this.openCodex ?? openCodex)({cwd,signal,onNotification:(method,p)=>{
      if(method==='account/rateLimits/updated') {const value=codexUsage(p);this.store.saveProviderState('codex',{...this.store.providerState('codex'),usage:value});args.onUsage?.(value);}
      if(p?.threadId && p.threadId!==threadId) return;
      if(method==='turn/started') turnId=p.turn.id;
      if(method==='item/agentMessage/delta') {text+=p.delta;onDelta(p.delta);}
      if(method==='thread/tokenUsage/updated') {
        usage=p.tokenUsage;
        // O total é da conversa inteira; a base (total antes da 1ª requisição desta fala) isola o custo da fala.
        if(!usageBase && usage?.total && usage?.last) usageBase=Object.fromEntries(Object.entries(usage.total).map(([k,v])=>[k,v-(usage.last[k]||0)]));
      }
      if(method==='item/completed' && p.item?.type==='agentMessage') finalMessages.set(p.item.id,p.item);
      if(['item/started','item/completed'].includes(method)) {
        const item=p.item,title={commandExecution:'Comando',fileChange:'Alteração de arquivos',webSearch:'Pesquisa na web',mcpToolCall:'Ferramenta conectada'}[item?.type];
        if(title) onActivity({tool:item.type,title,status:method==='item/started'?'running':item.status==='failed'?'failed':'completed',detail:safeDiagnostic(item.command||item.query||item.tool||item.changes?.map(c=>c.path).join(', '))});
        if(cap && TOOL_ITEMS.has(item?.type) && turnId && !signal.aborted) {
          const starting=method==='item/started';
          if(!capping || capping==='interrupting'){
            if(starting) tools++;
            else completedTools++;
          }
          if(!capping && (tools>cap || completedTools>=cap)){
            capping='interrupting';onActivity(capActivity('GPT',cap));
            rpc.call('turn/interrupt',{threadId,turnId},10000).catch(()=>{});
          } else if(capping==='wrapup' && starting && ++wrapTools>3){capping='final';rpc.call('turn/interrupt',{threadId,turnId},10000).catch(()=>{});}
        }
      }
      if(method==='turn/completed') {
        const turn=p.turn;
        if(turn.status==='interrupted' && capping==='interrupting' && !signal.aborted) {startWrap();return;}
        if(turn.status==='interrupted' && capping==='final' && !signal.aborted) {
          const parts=[...finalMessages.values()],texto=parts.map(p=>p.text).join('\n\n').trim();
          settle(null,{text:texto || capFallback(cap,text),model:activeModel,sessionId:threadId,usage:codexTurnUsage(usage,usageBase),toolCap:cap});
          return;
        }
        if(turn.status==='failed') settle(classifyFailure(turn.error?.message || 'Falha na resposta.','codex'));
        else if(turn.status==='interrupted') settle(new AgentError('Participação interrompida.','CANCELLED'));
        else {const parts=[...finalMessages.values()];const final=parts.filter(p=>p.phase==='final_answer');settle(null,{text:(final.length?final:parts).map(p=>p.text).join('\n\n') || text,model:activeModel,sessionId:threadId,usage:codexTurnUsage(usage,usageBase),...(capping?{toolCap:cap}:{})});}
      }
    },onRequest:async(method,p)=>{
      // Fechamento pelo teto: nenhuma ação nova é aprovada.
      if(capping && ['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(method))return {decision:'decline'};
      if(capping && method==='item/permissions/requestApproval')return {permissions:{},scope:'turn'};
      if(method==='item/tool/requestUserInput') {
        const response=await requestApproval({kind:'question',title:'O Codex precisa de uma resposta',questions:p.questions});
        return {answers:Object.fromEntries(p.questions.map(q=>[q.id,{answers:[response.answers?.[q.id] || 'O usuário não respondeu. Pare e preserve o trabalho.']}]))};
      }
      if(method==='mcpServer/elicitation/request') return respostaElicitacao(p,await requestApproval(elicitacaoParaPedido(p)));
      if(['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].includes(method)) {
        const response=await requestApproval({kind:'permission',requiresUser:method==='item/permissions/requestApproval',title:p.reason || 'O Codex solicita acesso',detail:p.command || JSON.stringify(p.permissions || p.changes || p)});
        if(method==='item/permissions/requestApproval') return {permissions:response.decision==='allow'?p.permissions:{},scope:'turn'};
        return {decision:response.decision==='allow'?'accept':'decline'};
      }
      throw new Error('Solicitação não suportada pela Synapse; a ação foi bloqueada.');
    }});
    rpc.onClose=error=>settle(error);
    try {
      const params={cwd,model:settings.codexModel || null,sandbox:settings.access==='chat'?'read-only':'workspace-write',approvalPolicy:'on-request',approvalsReviewer:'user',config:await codexConfig(settings,rpc,cwd)};
      const opened=await rpc.call(args.sessionId?'thread/resume':'thread/start',{...params,...(args.sessionId?{threadId:args.sessionId}:{ephemeral:false})});
      activeModel=opened.model || activeModel;threadId=opened.thread.id;onSession(threadId);
      const started=await rpc.call('turn/start',{threadId,input:[{type:'text',text:promptFor(args,args.sessionId && threadId===args.sessionId)}],model:settings.codexModel || null,...(args.effort?{effort:args.effort}:{})});turnId=started.turn.id;
      return await completion;
    }finally{if(signal.aborted && threadId && turnId) rpc.notify('turn/interrupt',{threadId,turnId});rpc.close();}
  }
  async runClaude(args) {
    const collector=createEventCollector('claude',args),requestApproval=args.requestApproval || (async()=>({decision:'deny'}));
    const options=await this.claudeOptions(args.cwd,args.settings,{abortController:args.controller,resume:args.sessionId,...(args.effort?{effort:args.effort}:{}),
      canUseTool:async(name,input,context)=>{
        const policy=claudeToolPolicy(name,args.settings);
        if(policy==='allow') return {behavior:'allow',updatedInput:input};
        if(policy==='deny') return {behavior:'deny',message:'Esta ferramenta não está liberada nesta sala. Não tente contornar.'};
        if(name==='AskUserQuestion') {
          const questions=(input.questions||[]).map((q,index)=>({id:String(index),question:q.question,options:q.options}));
          const response=await requestApproval({kind:'question',title:'O Claude precisa de uma resposta',questions});
          return response.decision==='answer'?{behavior:'allow',updatedInput:{...input,answers:Object.fromEntries(questions.map(q=>[q.question,response.answers[q.id]]))}}:{behavior:'deny',message:'O usuário não respondeu. Preserve o trabalho.'};
        }
        const response=await requestApproval({kind:'permission',title:`Claude · ${name}`,detail:JSON.stringify(input)});
        return response.decision==='allow'?{behavior:'allow',updatedInput:input}:{behavior:'deny',message:'Ação recusada pelo usuário na Synapse. Não tente contornar.'};
      }});
    const cap=toolCapFor(args.settings);
    if(cap)options.maxTurns=cap;
    let capped=false;
    const consume=async(q,c)=>{
      let maxed=false;
      try {
        for await(const event of q) {
          if(event.session_id) args.onSession?.(event.session_id);
          if(event.type==='result' && event.subtype==='error_max_turns' && cap){capped=maxed=true;c.capUsage=event.usage;c.capSession=event.session_id;continue;}
          c.accept(JSON.stringify(event));
          if(event.type==='rate_limit_event' && event.rate_limit_info?.status==='rejected') {
            const error=classifyFailure('Limite de uso atingido.','claude');error.resetAt=iso(event.rate_limit_info.resetsAt);throw error;
          }
        }
      }catch(error){
        // O Agent SDK real (0.3.325) lança "Reached maximum number of turns" logo depois do result error_max_turns.
        // O teto já foi registrado: a fala segue para o fechamento em vez de cair. Qualquer outro erro continua subindo.
        // Sem âncoras no prefixo: uma mudança de redação do SDK em volta da frase não pode voltar a derrubar a fala.
        if(!maxed || !/Reached maximum number of turns \(\d+\)/.test(error?.message)) throw error;
      }finally{q.close();}
    };
    await consume(this.claudeQuery({prompt:promptFor(args,Boolean(args.sessionId)),options}),collector);
    if(capped) {
      // Teto atingido: a mesma sessão fecha a fala, sem ferramentas (nem as do Claude Code nem as de MCP).
      args.onActivity?.(capActivity('Claude',cap));
      const partial=collector.result(),wrap=createEventCollector('claude',{...args,onDelta:text=>args.onDelta?.(text)});
      const sessionId=collector.capSession || partial.sessionId || args.sessionId;
      await consume(this.claudeQuery({prompt:toolCapPrompt(cap),options:{...options,resume:sessionId,maxTurns:1,tools:[],allowedTools:[],disallowedTools:[...(options.disallowedTools||[]),'mcp__*'],
        canUseTool:async()=>({behavior:'deny',message:'O teto de ferramentas desta fala foi atingido. Responda sem ferramentas.'})}}),wrap);
      const final=wrap.result();
      const usage=sumClaudeUsage(collector.capUsage || partial.usage,final.usage);
      if(final.error && !final.text) throw Object.assign(classifyFailure(final.error,'claude'),{partialText:partial.text,usage:usage?{...usage,partialUsage:true}:undefined});
      return {...final,text:final.text || capFallback(cap,partial.text),usage,sessionId:final.sessionId || sessionId,model:final.model || partial.model,toolCap:cap};
    }
    const result=collector.result();if(result.error) throw classifyFailure(result.error,'claude');
    if(!result.text) throw new AgentError('O Claude encerrou sem uma resposta.');return result;
  }
  // Pausa gravada de um modelo do AI Studio (429/503 com horário de volta). Sobrevive a reinícios.
  studioPause(id) {const s=this.store.providerState('studio').models?.[id];return s?.until && Date.parse(s.until)>Date.now()?s:null;}
  saveStudio(id,value) {const state=this.store.providerState('studio');this.store.saveProviderState('studio',{...state,models:{...state.models,[id]:value}});}
  // Só a falha do próprio AI Studio grava pausa do AI Studio: a de outra rota não pode bloquear o Hydrogen.
  async runStudioRoute(id,key,args) {
    const paused=this.studioPause(id);
    if(paused)throw Object.assign(new AgentError('O AI Studio está em pausa até '+paused.until,paused.code || 'RATE_LIMIT'),{resetAt:paused.until,paused:true});
    const {effort}=resolveEffort(args.settings.geminiEffort || args.effort,{efforts:studioEfforts(id)});
    try {const result=await runStudio(id.slice(4),key,{...args,effort});this.saveStudio(id,{confirmed:true});return result;}
    catch(error) {
      if(error.resetAt)this.saveStudio(id,{until:error.resetAt,code:error.code});
      if(error.dailyLimit){const state=this.store.providerState('studio');this.store.saveProviderState('studio',{...state,limits:{...state.limits,[id.slice(4)]:error.dailyLimit}});}
      throw error;
    }
  }
  // Duas rotas do Gemini: AI Studio (Hydrogen, chave de API) e Antigravity (Flash, conta Google). Se a rota escolhida
  // esgota ou fica indisponível antes de escrever texto ou executar ferramentas, a outra assume (pedido do usuário,
  // 22/11: "esgotou o limite de um passa para o outro"). Se as duas falham, vale o horário de volta mais próximo.
  // Pausa do Antigravity (cota da conta Google esgotada), gravada com o horário de volta informado pelo cliente.
  // Enquanto durar, o Antigravity nem é aberto e a outra rota assume direto.
  nativePause() {const s=this.store?.providerState?.('antigravity');return s?.until && Date.parse(s.until)>Date.now()?s:null;}
  async runNativeRoute(args) {
    const paused=this.nativePause();
    if(paused)throw Object.assign(new AgentError('O Antigravity está em pausa até '+paused.until,paused.code || 'RATE_LIMIT'),{resetAt:paused.until,paused:true});
    try {return await this.runNativeGemini(args);}
    catch(error) {if(error.resetAt && error.code==='RATE_LIMIT')this.store.saveProviderState('antigravity',{until:error.resetAt,code:error.code});throw error;}
  }
  // Ordem do AI Studio quando o Automático perde o Antigravity no Code: Flash listado no catálogo da chave, depois Hydrogen.
  async studioCodeOrder() {
    const models=await this.directCatalog().catch(()=>[]);
    const usable=m=>['listed','available'].includes(m.availability);
    const flash=models.find(m=>m.id==='api:gemini-3.8-flash' && usable(m)) || models.find(m=>/^api:gemini-[\d.]+-flash$/.test(m.id) && usable(m));
    return [...new Set([...(flash?[flash.id]:[]),'api:'+preferredModel])];
  }
  async runGemini(args) {
    const budget=args.studioBudget || {requests:0};
    try {
      const result=await this.runGeminiRoutes({...args,studioBudget:budget});
      if(budget.requests)result.usage={...result.usage,studioRequestsByModel:budget.byModel};
      return result;
    } catch(error) {
      if(budget.requests)error.usage={...error.usage,partialUsage:true,studioRequestsByModel:budget.byModel};
      throw error;
    }
  }
  async runGeminiRoutes(args) {
    const choice=args.settings.geminiModel || 'auto',automatic=choice==='auto';
    // Automático economiza as duas cotas: no Chat, o Hydrogen responde com uma requisição por fala; no Projeto e
    // no Computador, cada rodada de ferramentas seria outra requisição do AI Studio, então o Antigravity começa.
    const id=automatic?(args.settings.access==='chat'?'api:'+preferredModel:'auto'):choice;
    const switchable=(error,codes=GEMINI_SWITCH)=>!args.signal?.aborted && !error.partialText && !error.toolExecuted && codes.includes(error.code);
    const both=(first,second)=>{
      if(args.signal?.aborted || second.partialText || second.toolExecuted)return second;
      // Uma falha de limite descreve melhor o estado do Gemini do que uma chave inválida ou um erro do cliente.
      const main=GEMINI_SWITCH.includes(second.code) || !GEMINI_SWITCH.includes(first.code)?second:first,other=main===second?first:second;
      const times=[first.resetAt,second.resetAt].map(t=>Date.parse(t)).filter(Number.isFinite);
      if(times.length)main.resetAt=new Date(Math.min(...times)).toISOString();
      main.message=`${main.message} A outra rota também falhou: ${other.message}`;
      return main;
    };
    if(!id.startsWith('api:')) {
      try {return await this.runNativeRoute(args);}
      catch(error) {
        if(!switchable(error))throw error;
        const key=await this.studioAccess();
        if(!key)throw error;
        // Automático no Projeto/Computador (1.6): a rota normal é o Flash do Antigravity. Com ela fora, o Flash do
        // AI Studio (mesma família, cota diária maior) vem antes do Hydrogen, cuja cota diária acabou em cerca de
        // 25 requisições em 23/11 — uma fala de Code gasta até studioToolRounds delas. O Hydrogen fica de reserva.
        const order=automatic?await this.studioCodeOrder():['api:'+preferredModel];
        let last=error;
        for(const studioId of order) {
          const paused=this.studioPause(studioId);
          if(paused){last=both(Object.assign(new AgentError(`${studioId.slice(4)}: AI Studio em pausa até ${paused.until}`,paused.code || 'RATE_LIMIT'),{resetAt:paused.until}),last);continue;}
          args.onActivity?.({tool:'routing',title:'Gemini · Antigravity indisponível, alternando para AI Studio ('+studioId.slice(4)+')',status:'warning',detail:error.message});
          try {return await this.runStudioRoute(studioId,key,{...args,settings:{...args.settings,geminiModel:studioId}});}
          catch(second) {last=both(last,second);if(!switchable(second))throw last;}
        }
        throw last;
      }
    }
    const key=await this.studioAccess();
    if(automatic && !key)return this.runNativeRoute(args);
    try {return await this.runStudioRoute(id,key,args);}
    catch(error) {
      // Chave inválida no automático segue pelo Antigravity; no modelo escolhido, ela precisa da sua ação.
      if(!switchable(error,automatic?[...GEMINI_SWITCH,'AUTH_REQUIRED']:GEMINI_SWITCH))throw error;
      const paused=this.nativePause();
      if(paused)throw both(error,Object.assign(new AgentError('Antigravity em pausa até '+paused.until,'RATE_LIMIT'),{resetAt:paused.until}));
      const native=await this.geminiCatalog().catch(()=>null);
      if(!native?.models?.length){
        if(!['UNAVAILABLE','MODEL_UNAVAILABLE'].includes(error.code))throw error;
        const models=await this.directCatalog().catch(()=>[]);
        const next=models.find(m=>m.id!==id && m.tier==='Free Tier' && ['listed','available'].includes(m.availability));
        if(!next)throw error;
        args.onActivity?.({tool:'routing',title:'Gemini · troca de modelo no AI Studio',status:'info',detail:error.message+' · '+next.label});
        return this.runStudioRoute(next.id,key,{...args,settings:{...args.settings,geminiModel:next.id}});
      }
      args.onActivity?.({tool:'routing',title:'Gemini · '+id.slice(4)+(error.paused?' em pausa':' indisponível')+', alternando para Antigravity',status:'warning',detail:error.message});
      try {return await this.runNativeRoute({...args,settings:{...args.settings,geminiModel:'auto'},modelId:'auto'});}
      catch(second) {throw both(error,second);}
    }
  }
  async runNativeGemini(args) {
    let text='',sent=0,sessionId=args.sessionId,prompting=false,toolRan=false;const toolCalls=new Map();
    const flushText=()=>{if(text.length>sent){args.onDelta?.(text.slice(sent));sent=text.length;}};
    if(args.settings.access==='chat') {args={...args,cwd:join(this.dataDir,'chat-contexts',createHash('sha256').update(args.cwd).digest('hex').slice(0,24))};await mkdir(args.cwd,{recursive:true});}
    const integrations=await nativeIntegrations(args.settings);
    const gateway=await createToolGateway(integrations,args.requestApproval || (async()=>({decision:'deny'})),args.signal);
    const rpc=await openGemini({...args,dataDir:this.dataDir,toolEnvironment:gateway.environment,onNotification:(method,p)=>{
      if(method!=='session/update' || !prompting) return;
      const u=p.update;
      if(u?.sessionUpdate==='agent_message_chunk' && u.content?.type==='text') {
        text+=u.content.text;
        if(sent || !possibleQuotaNotice(text))flushText();
      }
      if(['tool_call','tool_call_update'].includes(u?.sessionUpdate)) {toolRan=true;const activity=geminiToolActivity(toolCalls,u);if(activity)args.onActivity?.(activity);}
    },onRequest:async(method,p)=>{
      if(method!=='session/request_permission') throw new Error('Solicitação não suportada.');
      const reject=(p.options||[]).find(o=>o.kind==='reject_once');
      const denied=reject?{outcome:{outcome:'selected',optionId:reject.optionId}}:{outcome:{outcome:'cancelled'}};
      const web=/search_web|read_url|fetch|browse/i.test(p.toolCall?.name || p.toolCall?.kind || '');
      if((args.settings.access==='chat' && !web) || (!args.settings.internet && web))return denied;
      const once=(p.options||[]).filter(o=>o.kind==='allow_once');
      if(!once.length) return denied;
      const reply=await (args.requestApproval || (async()=>({decision:'deny'})))({kind:'permission',title:p.toolCall?.title || 'Gemini solicita acesso',detail:JSON.stringify(p.toolCall?.rawInput || p.toolCall?.content || ''),options:once.map(o=>({id:o.optionId,label:o.name}))});
      return reply.decision==='allow'?{outcome:{outcome:'selected',optionId:reply.optionId}}:denied;
    }}).catch(error=>{gateway.close();throw error;});
    try {
      const mcpServers=[];
      if(sessionId && rpc.info.agentCapabilities?.loadSession===false){sessionId=undefined;args.onActivity?.({tool:'session',title:'Sessão recuperada pela memória da Synapse',status:'info',detail:'O cliente não oferece retomada nativa; histórico e checkpoints seguem no contexto.'});}
      const requestedSession=sessionId;
      const opened=await rpc.call(sessionId?'session/load':'session/new',{cwd:args.cwd,mcpServers,...(sessionId?{sessionId}:{})},45000);
      sessionId=opened.sessionId || sessionId;args.onSession?.(sessionId);
      text=''; // session/load can replay history; only this prompt's output belongs in the new message.
      const model=await configureGoogleSession(rpc,opened,sessionId,{...args.settings,geminiModel:args.modelId || args.settings.geminiModel},args.effort);
      prompting=true;
      const bridge=integrations.length?`\nFERRAMENTAS COMPARTILHADAS: ${integrations.map(i=>i.id+' ('+i.label+')').join(', ')}. Neste cliente elas são acessadas pelo comando local, com aprovação na Synapse antes de cada operação. Não configure MCP nem altere o agente. Descubra ferramentas executando node ${JSON.stringify(gateway.command)} <integração> --list e consulte o esquema retornado. Execute com node ${JSON.stringify(gateway.command)} <integração> <nome_da_ferramenta> --json-base64 <JSON_UTF8_em_base64>. Alternativamente grave os argumentos em um arquivo JSON do projeto e passe "@caminho-completo.json". Não passe JSON literal ao executável no PowerShell, pois as aspas podem ser removidas. Não imprima variáveis de ambiente. A ponte local é permitida mesmo sem internet para REA local. Não use a ponte para contornar uma recusa.`:'';
      const result=await rpc.call('session/prompt',{sessionId,prompt:[{type:'text',text:promptFor(args,requestedSession && requestedSession===sessionId)+bridge}]},args.timeoutMs || 900000);
      if(result.stopReason==='cancelled') throw new AgentError('Participação interrompida.','CANCELLED');
      if(result.stopReason!=='end_turn') {const error=new AgentError(`O Gemini interrompeu a resposta (${result.stopReason || 'motivo desconhecido'}). O trabalho precisa de continuação.`, 'INCOMPLETE');error.partialText=text;throw error;}
      if(!text.trim()) throw new AgentError('O Gemini encerrou sem uma resposta.');
      const cota=antigravityQuota(text);
      if(cota)throw Object.assign(new AgentError('Antigravity: cota da conta Google esgotada. '+safeDiagnostic(text.trim()),'RATE_LIMIT'),{resetAt:cota.resetAt,avisoDeCota:true});
      flushText();
      if(/failed to construct executor|failed to resolve components|unknown component: tool/i.test(text))throw new AgentError('O Antigravity não conseguiu preparar as ferramentas. '+safeDiagnostic(text),'TOOL_CONFIGURATION');
      const models=result._meta?.quota?.model_usage?.map(m=>m.model).filter(Boolean);
      return {text,sessionId,model:models?.join(' + ') || model,usage:result.usage};
    }catch(error){
      // Sinaliza trabalho já feito: a outra rota do Gemini não pode refazer a fala do zero.
      if(text.trim() && !error.partialText && !error.avisoDeCota)error.partialText=text;
      if(toolRan)error.toolExecuted=true;
      throw error;
    }finally{gateway?.close();rpc.close();}
  }
  close() {this.login?.close();this.login=null;}
}
