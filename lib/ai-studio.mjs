import { readFile, stat, writeFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { AgentError } from './agents.mjs';
import { nativeIntegrations } from './integrations.mjs';
import { createToolGateway } from './tool-gateway.mjs';
import { confinedPath, listFiles, readWorkspaceFile } from './files.mjs';

export const preferredModel = 'gemini-4-hydrogen';
const freeModels = new Set([preferredModel, 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);
const paidModels = new Set(['gemini-4-carbon','gemini-4-argon','gemini-4-neon','gemini-3.1-pro-preview','gemini-omni-1.1-flash','gemini-omni-1.2-flash']);
const apiRoot = 'https://generativelanguage.googleapis.com/v1beta/';
// Tempos do streaming: o primeiro evento pode demorar com raciocínio alto; depois, silêncio longo é falha.
// Variáveis de ambiente permitem testes rápidos.
const FIRST_EVENT_MS = Number(process.env.SYNAPSE_STUDIO_FIRST_EVENT_MS) || 120000;
const STREAM_IDLE_MS = Number(process.env.SYNAPSE_STUDIO_IDLE_MS) || 60000;
// Depois de ferramentas, o contexto cresce e o primeiro evento demora mais (caso real de 23/11: 120 s sem
// resposta após ler 4 arquivos grandes, e a fala inteira se perdeu). Essas rodadas esperam mais e tentam de novo uma vez.
const FOLLOW_EVENT_MS = Number(process.env.SYNAPSE_STUDIO_FOLLOW_EVENT_MS) || 180000;
// Leitura de arquivo limitada: cada rodada reenvia tudo o que já foi lido, e a cota do Hydrogen conta requisições.
export const READ_CAP = Number(process.env.SYNAPSE_STUDIO_READ_CAP) || 40000;
const STUDIO_RETRY_MS = (process.env.SYNAPSE_STUDIO_RETRY_MS || '4000,10000').split(',').filter(Boolean).map(Number);
// Reserva de recuperação por fala, fora das rodadas da sala: novas tentativas por falha do Google (503, silêncio,
// limite por minuto) não tiram rodada de trabalho do Gemini. Caso real de 25/11, 21:00: com 3 rodadas na sala, um
// 503 gastou uma, a última requisição ficou 180 s em silêncio sem direito a repetir, e a fala se perdeu.
export const STUDIO_RECOVERY = 2;
// HTTP 429 do limite por minuto: espera o tempo que o Google indicar (até 65 s) e repete, no máximo 2 vezes por fala.
// Caso real de 23/11, 21:18: o Hydrogen leu 17 arquivos em 5 rodadas, recebeu 429 com volta em 1 s e a fala inteira se perdeu.
const LIMIT_WAIT_MAX_MS = 65000, LIMIT_PAD_MS = Number(process.env.SYNAPSE_STUDIO_LIMIT_PAD_MS ?? 1000);
export function shortLimitWait(error, waits) {
  if (error?.code !== 'RATE_LIMIT' || error.daily || waits >= 2 || !Number.isFinite(error.retryMs) || error.retryMs > LIMIT_WAIT_MAX_MS) return null;
  return error.retryMs + LIMIT_PAD_MS;
}
export async function readStudioKey() {
  if (process.env.SYNAPSE_GEMINI_API_KEY) return process.env.SYNAPSE_GEMINI_API_KEY.trim();
  const base = process.env.LOCALAPPDATA || join(homedir(), '.config');
  try { return parseEnv(await readFile(join(base, 'Synapse', 'private', '.env'), 'utf8')).SYNAPSE_GEMINI_API_KEY?.trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw new AgentError('Não foi possível ler a configuração privada do AI Studio.', 'AUTH_REQUIRED'); }
}
export async function studioError(response) {
  const body = await response.json().catch(() => ({}));
  const code = response.status === 429 ? 'RATE_LIMIT' : [401,403].includes(response.status) || body.error?.details?.some(d => d.reason === 'API_KEY_INVALID') ? 'AUTH_REQUIRED' : response.status === 404 ? 'MODEL_UNAVAILABLE' : response.status >= 500 ? 'UNAVAILABLE' : 'AGENT_FAILED';
  const error = new AgentError('Google AI Studio · HTTP ' + response.status + ' · ' + ({RATE_LIMIT:'cota temporariamente esgotada', AUTH_REQUIRED:'verifique a chave e as permissões do projeto', MODEL_UNAVAILABLE:'modelo indisponível', UNAVAILABLE:'serviço temporariamente indisponível'}[code] || 'a solicitação não foi concluída'), code);
  const retry = response.headers.get('retry-after');
  const delay = body.error?.details?.find(d => d['@type']?.endsWith('RetryInfo'))?.retryDelay;
  const time = retry && !/^\d+(\.\d+)?$/.test(retry) ? Date.parse(retry) : Date.now() + 1000 * Number(retry ?? delay?.replace(/s$/, '') ?? (code === 'RATE_LIMIT' ? 60 : 30));
  if (['RATE_LIMIT','UNAVAILABLE'].includes(code) && Number.isFinite(time)) error.resetAt = new Date(Math.max(Date.now()+1000,time)).toISOString();
  if (code === 'RATE_LIMIT') {
    // Limite por minuto (RPM/TPM) passa em segundos; o diário não. O Google identifica qual cota estourou.
    const violations = (body.error?.details || []).filter(d => d['@type']?.endsWith('QuotaFailure')).flatMap(d => d.violations || []);
    const isDaily = (v) => /per ?day|daily/i.test(v.quotaId || v.quotaMetric || '');
    error.daily = violations.some(isDaily);
    // 1.7: o Google informa o tamanho da cota diária (quotaValue) quando ela estoura. A Synapse guarda esse número
    // para mostrar o uso do Gemini em percentual; sem ele, o painel mostra só as requisições do dia.
    const limit = Number(violations.find(v => isDaily(v) && v.quotaValue != null)?.quotaValue);
    if (error.daily && Number.isFinite(limit) && limit > 0) error.dailyLimit = limit;
    const seconds = Number(retry ?? delay?.replace(/s$/, ''));
    if (Number.isFinite(seconds)) error.retryMs = Math.max(0, seconds * 1000);
  }
  return error;
}
async function request(path, key, init = {}) {
  let response;
  const controller=new AbortController();
  const timer=init.signal ? undefined : setTimeout(()=>controller.abort(),45000);
  const signal=init.signal?AbortSignal.any([init.signal,controller.signal]):controller.signal;
  try { response = await fetch(apiRoot + path, { ...init, signal, redirect:'error', headers:{'x-goog-api-key':key, 'content-type':'application/json'} }); }
  catch(error) { if(init.signal?.aborted) throw error; throw new AgentError('Falha de conexão com o AI Studio.', 'UNAVAILABLE'); }
  finally {clearTimeout(timer);}
  if (!response.ok) throw await studioError(response);
  return response;
}
export async function studioCatalog(key) {
  if (!key) return [];
  const models = [];
  let page = '';
  do {
    const response = await request('models?pageSize=100'+(page?'&pageToken='+encodeURIComponent(page):''),key,{signal:AbortSignal.timeout(10000)});
    const body = await response.json();
    for (const m of body.models || []) {
      const id = m.name?.replace(/^models\//,'');
      if (!/^gemini-[\w.-]+$/.test(id) || !m.supportedGenerationMethods?.includes('generateContent') || /image|audio|tts|robotics|computer-use|deep-research|embedding|live|nano-banana/i.test(id)) continue;
      const free = freeModels.has(id);
      models.push({id:'api:'+id, label:m.displayName || id, source:'AI Studio', tier:free?'Free Tier':paidModels.has(id)?'Pago':'Plano a verificar', availability:free?'listed':'locked'});
    }
    page = body.nextPageToken;
  } while (page && models.length < 500);
  return models.sort((a,b)=>Number(b.id==='api:'+preferredModel)-Number(a.id==='api:'+preferredModel));
}
const definitions = [
  {name:'list_files',description:'List a project folder.',parameters:{type:'OBJECT',properties:{path:{type:'STRING'}}}},
  {name:'read_file',description:'Read a UTF-8 file by 1-based line range. To continue, use nextStartLine as startLine and nextStartColumn as startColumn when present (1-based).',parameters:{type:'OBJECT',properties:{path:{type:'STRING'},startLine:{type:'INTEGER'},endLine:{type:'INTEGER'},startColumn:{type:'INTEGER'}},required:['path']}},
  {name:'write_file',description:'Create or replace one UTF-8 file in an existing project directory after user approval.',parameters:{type:'OBJECT',properties:{path:{type:'STRING'},content:{type:'STRING'}},required:['path','content']}}
];
const sharedDefinitions=[
  {name:'list_tools',description:'List the operations of one enabled integration, or supply toolName for its argument schema.',parameters:{type:'OBJECT',properties:{integration:{type:'STRING'},toolName:{type:'STRING'}},required:['integration']}},
  {name:'call_tool',description:'Call an enabled integration with exact JSON arguments after user approval.',parameters:{type:'OBJECT',properties:{integration:{type:'STRING'},name:{type:'STRING'},argumentsJson:{type:'STRING'}},required:['integration','name','argumentsJson']}}
];
async function sharedAction(call,gateway,signal) {
  if(!gateway)throw new Error('Integração indisponível nesta sala.');
  const list=call.name==='list_tools';
  const params=list?{}:{name:call.args.name,arguments:JSON.parse(call.args.argumentsJson)};
  const response=await fetch(gateway.environment.MESA_TOOL_GATEWAY_URL,{method:'POST',redirect:'error',signal,
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+gateway.environment.MESA_TOOL_GATEWAY_TOKEN},
    body:JSON.stringify({integration:call.args.integration,method:list?'tools/list':'tools/call',params})});
  if(!response.ok)throw new Error('A integração recusou a operação.');
  const data=await response.json();
  if(list) {
    if(call.args.toolName){const tool=(data.tools || []).find(t=>t.name===call.args.toolName);return tool?{name:tool.name,inputSchema:tool.inputSchema}:{error:'Ferramenta desconhecida.'};}
    return {tools:(data.tools || []).map(t=>t.name).slice(0,350)};
  }
  return {output:JSON.stringify(data).slice(0,32000)};
}
async function workspaceAction(call, args) {
  const {path='',content} = call.args || {};
  if(args.settings.access==='chat' || !definitions.some(d=>d.name===call.name)) throw new Error('Ferramenta indisponível nesta aba.');
  if(typeof path!=='string' || path.split(/[\\/]/).some(p => p==='..' || p.startsWith('.') && p!=='.') || /[:\x00-\x1f]/.test(path)) throw new Error('Use um caminho relativo do projeto.');
  const decision=await args.requestApproval?.({kind:'permission', title:'Gemini · '+call.name,detail:JSON.stringify(call.args || {}).slice(0,100000)});
  args.signal?.throwIfAborted();
  if(decision?.decision!=='allow') return {error:'Ação recusada. Respeite esta decisão.'};
  if(call.name==='list_files') return {entries:(await listFiles(args.cwd,path)).files.slice(0,150).map(f=>({path:f.path,directory:f.directory}))};
  if(call.name==='read_file') {
    const file=await readWorkspaceFile(args.cwd,path);
    if(!['text','html'].includes(file.kind) || file.size>120000) throw new Error('Selecione um arquivo de texto de até 120 KB.');
    return readSlice(file.data.toString('utf8'),call.args);
  }
  if(!path || typeof content!=='string' || Buffer.byteLength(content)>60000 || !/^[\p{L}\p{N} _.-]+$/u.test(basename(path)) || /^(con|nul|prn|aux|com\d|lpt\d)(\.|$)|[. ]$/i.test(basename(path))) throw new Error('Nome ou conteúdo de arquivo inválido.');
  const parent=await confinedPath(args.cwd,dirname(path));
  const target=join(parent,basename(path));
  // Renaming a new file replaces a link itself, never its external target.
  const exists=await stat(target).catch(e=>{if(e.code!=='ENOENT')throw e;});
  if(exists) await confinedPath(args.cwd,path);
  const temp=join(parent,'.synapse-'+randomUUID());
  try {await writeFile(temp,content,{flag:'wx',mode:0o600});args.signal?.throwIfAborted();await rename(temp,target);}
  finally {await rm(temp,{force:true});}
  return {saved:path};
}
// Trecho de um arquivo dentro do limite de leitura, com o que falta para continuar.
export function readSlice(text,{startLine,endLine,startColumn}={},cap=READ_CAP) {
  const lines=text.split('\n'),total=lines.length;
  const first=Math.min(Math.max(1,Number.isInteger(startLine)?startLine:1),total);
  const last=Math.min(total,Math.max(first,Number.isInteger(endLine)?endLine:total));
  let content='',line=first;
  for(;line<=last;line++){
    const raw=lines[line-1]+(line<total?'\n':'');
    const offset=line===first && Number.isInteger(startColumn)?Math.min(raw.length,Math.max(0,startColumn-1)):0;
    const next=raw.slice(offset);
    if(content.length+next.length>cap){
      if(content)break;
      return {content:next.slice(0,cap),lines:line+'-'+line+' de '+total,truncated:true,nextStartLine:line,nextStartColumn:offset+cap+1};
    }
    content+=next;
  }
  const shown=line-1;
  if(first===1 && shown>=total)return {content};
  return {content,lines:first+'-'+shown+' de '+total,...(shown<last?{truncated:true,nextStartLine:shown+1}:{})};
}
export async function* readEvents(body) {
  const decoder=new TextDecoder(); let buffer='';
  const eventData=event=>event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
  for await(const chunk of body) {
    buffer+=decoder.decode(chunk,{stream:true});
    let match;
    while((match=/\r?\n\r?\n/.exec(buffer))) {
      const data=eventData(buffer.slice(0,match.index));buffer=buffer.slice(match.index+match[0].length);
      if(data && data!=='[DONE]') yield JSON.parse(data);
    }
  }
  const tail=eventData(buffer+decoder.decode());
  if(tail && tail!=='[DONE]') yield JSON.parse(tail);
}
const STUDIO_COUNTS=['promptTokenCount','candidatesTokenCount','thoughtsTokenCount','cachedContentTokenCount','toolUsePromptTokenCount','totalTokenCount'];
export function sumStudioUsage(total,round) {
  const sum={...round,requests:(total?.requests || 0)+1};
  for(const k of STUDIO_COUNTS) if(Number.isFinite(round[k]) || Number.isFinite(total?.[k])) sum[k]=(total?.[k] || 0)+(round[k] || 0);
  return sum;
}
export async function runStudio(model,key,args) {
  if(!freeModels.has(model)) throw new AgentError('Este modelo não está habilitado para o perfil gratuito.', 'MODEL_UNAVAILABLE');
  if(!key) throw new AgentError('Configure a chave do Google AI Studio.', 'AUTH_REQUIRED');
  const integrations=await nativeIntegrations(args.settings);
  const gateway=integrations.length?await createToolGateway(integrations,args.requestApproval || (async()=>({decision:'deny'})),args.signal):null;
  const context=integrations.length?'\nIntegrações disponíveis: '+integrations.map(i=>i.id).join(', ')+'. Consulte list_tools antes de chamar uma ferramenta.':'';
  const contents=[{role:'user',parts:[{text:args.prompt+context}]}];
  const tools=args.settings.access==='chat' ? (args.settings.internet?[{googleSearch:{}}]:[]) : [{functionDeclarations:[...definitions,...(gateway?sharedDefinitions:[])]}];
  let text='',usage,modelVersion,toolExecuted=false,thinkingNoticed=false;
  // Resumos de raciocínio (includeThoughts) mantêm o fluxo ativo enquanto o modelo pensa: sem eles,
  // um nível alto deixa a conexão muda por dezenas de segundos. O nível vem da sala; se o modelo
  // recusar a configuração, a participação segue com o padrão dele.
  let thinking={thinkingConfig:{includeThoughts:true,...(args.effort?{thinkingLevel:String(args.effort).toUpperCase()}:{})}};
  const functions=tools.some(t=>t.functionDeclarations);
  // Teto de rodadas de ferramentas por fala: na última, as ferramentas ficam desligadas e o modelo responde
  // com o que já verificou, em vez de a fala inteira (e as requisições já gastas) se perder.
  const maxRounds=Math.max(2,Math.min(20,Number(args.settings.studioToolRounds)||Number(process.env.SYNAPSE_STUDIO_MAX_ROUNDS)||6));
  const budget=args.studioBudget || {requests:0},maxAttempts=maxRounds+STUDIO_RECOVERY;
  budget.rounds??=0;
  budget.byModel??={};
  const canRetry=()=>budget.requests-budget.rounds<STUDIO_RECOVERY && budget.requests<maxAttempts;
  const send=(signal,final)=>request('models/'+model+':streamGenerateContent?alt=sse',key,{method:'POST',signal,body:JSON.stringify({contents,...(tools.length?{tools}:{}),...(final && functions?{toolConfig:{functionCallingConfig:{mode:'NONE'}}}:{}),...(thinking?{generationConfig:thinking}:{})})});
  try {
    let silenceRetried=false;
    const attemptRound=async(firstWait,final)=>{
      const idle=new AbortController();
      const runSignal=args.signal?AbortSignal.any([args.signal,idle.signal]):idle.signal;
      let timer,silence=firstWait,got=false;
      const resetIdle=()=>{clearTimeout(timer);timer=setTimeout(()=>idle.abort(),silence);};
      let finish,roundUsage;const parts=[];
      try {
      let response;
      for(let busyRetries=0;;) {
        resetIdle();
        if(budget.requests>=maxAttempts)throw new AgentError('Limite de requisições ao AI Studio nesta participação.','INCOMPLETE');
        try {
          budget.requests++;
          budget.byModel[model]=(budget.byModel[model] || 0)+1;
          response=await send(runSignal,final);break;
        }
        catch(error) {
          if(!canRetry())throw error;
          if(thinking && error.code==='AGENT_FAILED' && /HTTP 400\b/.test(error.message)) {
            thinking=null;args.onActivity?.({tool:'effort',title:'Gemini · configuração de raciocínio não aceita',status:'info',detail:'O modelo recusou a configuração de raciocínio; a participação usa o padrão do modelo.'});
            continue;
          }
          if(args.signal?.aborted || idle.signal.aborted)throw error;
          // Limite por minuto depois de ferramentas ou texto: a fala já não pode trocar de rota, e perdê-la custaria
          // todas as requisições feitas; esperar custa segundos. Antes disso, o 429 segue para a troca de rota.
          const limitWait=toolExecuted || text?shortLimitWait(error,budget.limitWaits || 0):null;
          // Picos de demanda (HTTP 503) costumam passar em segundos: tenta de novo antes de desistir.
          const wait=limitWait ?? (error.code==='UNAVAILABLE'?STUDIO_RETRY_MS[busyRetries++]:undefined);
          if(wait===undefined)throw error;
          if(limitWait!==null){
            budget.limitWaits=(budget.limitWaits || 0)+1;
            args.onActivity?.({tool:'routing',title:'Gemini · limite por minuto do AI Studio, aguardando',status:'info',detail:error.message+' · nova tentativa em '+Math.max(1,Math.round(wait/1000))+' s'});
          } else args.onActivity?.({tool:'routing',title:'Gemini · AI Studio ocupado, nova tentativa',status:'info',detail:error.message+' · tentativa '+(busyRetries+1)+' em '+Math.round(wait/1000)+' s'});
          clearTimeout(timer);
          await new Promise((resolve,reject)=>{const t=setTimeout(resolve,wait);args.signal?.addEventListener('abort',()=>{clearTimeout(t);reject(args.signal.reason);},{once:true});});
        }
      }
      for await(const event of readEvents(response.body)) {
        got=true;silence=STREAM_IDLE_MS;resetIdle();
        if(event.error) throw await studioError(Response.json({error:event.error},{status:Number(event.error.code)||503}));
        if(typeof event.modelVersion==='string' && event.modelVersion.trim())modelVersion=event.modelVersion.trim();
        const candidate=event.candidates?.[0];finish=candidate?.finishReason || finish;roundUsage=event.usageMetadata || roundUsage;
        for(const part of candidate?.content?.parts || []) {
          parts.push(part); // Todas as partes voltam ao modelo, com as assinaturas de raciocínio.
          if(part.thought){
            if(!thinkingNoticed){thinkingNoticed=true;args.onActivity?.({tool:'thinking',title:'Gemini · raciocinando ('+model+')',status:'info',detail:'O AI Studio está enviando resumos de raciocínio.'});}
          } else if(part.text){text+=part.text;args.onDelta?.(part.text);}
        }
      }
      return {parts,finish};
      } catch(error) {
        if(idle.signal.aborted && !args.signal?.aborted)throw Object.assign(new AgentError('O AI Studio ficou '+Math.round(silence/1000)+' segundos sem transmitir dados.', 'UNAVAILABLE'),{resetAt:new Date(Date.now()+30000).toISOString(),silent:!got});
        throw error;
      } finally {
        clearTimeout(timer);
        if(roundUsage)usage=sumStudioUsage(usage,roundUsage);
      }
    };
    for(let round=0;budget.rounds<maxRounds;round++) {
      let result;
      const final=++budget.rounds===maxRounds;
      try {result=await attemptRound(round?FOLLOW_EVENT_MS:FIRST_EVENT_MS,final);}
      catch(error) {
        // Nada chegou depois de ferramentas já executadas: repetir a mesma requisição não refaz nenhuma ação.
        if(!error.silent || !round || silenceRetried || !canRetry() || args.signal?.aborted){
          // Rodada sem resposta não é trabalho do modelo. Se a reserva comporta, a requisição perdida passa a contar
          // como recuperação e o modelo seguinte (Flash → Hydrogen) não perde uma rodada de ferramentas. O teto
          // de rodadas + reserva continua valendo: requisições − rodadas nunca passa de STUDIO_RECOVERY.
          if(budget.requests-budget.rounds<STUDIO_RECOVERY)budget.rounds--;
          throw error;
        }
        silenceRetried=true;
        args.onActivity?.({tool:'routing',title:'Gemini · AI Studio sem resposta, nova tentativa',status:'info',detail:error.message+' A requisição é repetida uma vez; as ferramentas já executadas não se repetem.'});
        result=await attemptRound(FOLLOW_EVENT_MS,final);
      }
      const {parts,finish}=result;
      if(finish!=='STOP') throw new AgentError('O Google interrompeu a resposta antes da conclusão.', 'INCOMPLETE');
      const calls=parts.filter(p=>p.functionCall);
      if(!calls.length && text.trim()) return {text,usage:usage?{...usage,requests:budget.requests}:undefined,model:modelVersion || model,modelVersion};
      if(!calls.length) throw new AgentError('O Google encerrou sem conteúdo.');
      if(final)throw new AgentError('O Google pediu ferramentas depois do limite desta fala.','INCOMPLETE');
      contents.push({role:'model',parts});
      if(budget.rounds===maxRounds-1)args.onActivity?.({tool:'routing',title:'Gemini · última rodada de ferramentas',status:'info',detail:'Teto de '+maxRounds+' rodadas por fala: depois destas ferramentas, o Gemini responde com o que já verificou.'});
      const answers=[];
      for(const {functionCall:call} of calls){
        args.signal?.throwIfAborted();
        let output;
        try{toolExecuted=true;output=sharedDefinitions.some(d=>d.name===call.name)?await sharedAction(call,gateway,args.signal):await workspaceAction(call,args);}catch(error){args.signal?.throwIfAborted();output={error:error.message};}
        answers.push({functionResponse:{name:call.name,...(call.id?{id:call.id}:{}),response:output}});
      }
      contents.push({role:'user',parts:answers});
    }
    throw new AgentError('Limite de operações desta participação atingido.','INCOMPLETE');
  } catch(error){
    if(text)error.partialText=text;
    if(toolExecuted)error.toolExecuted=true;
    if(usage){error.usage={...usage,requests:budget.requests,partialUsage:true};error.model=modelVersion || model;}
    throw error;
  }
  finally {gateway?.close();}
}

