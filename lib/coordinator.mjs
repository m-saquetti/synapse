import { createHash, randomUUID } from 'node:crypto';
import { MAX_CHAMADAS, STAGES, planNext, queueCalls, recordTurn, roundDone, stageDirections, startRound, upcoming } from './rounds.mjs';
import { parseMentions } from './mentions.mjs';
import { mkdir } from 'node:fs/promises';
import { Orchestrator, planFor, buildPrompt, pickHistory, replyHint, STATUS_RULES } from './orchestrator.mjs';
import { workspaceFor,verifyDirectory } from './files.mjs';
import { PROVIDERS,chooseAgent,modelEligible,normalizeLane,parseHandoff,quotaPressure,contextTokens } from './routing.mjs';
import { normalizeSettings } from './settings.mjs';

const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const ACCESS_RANK={chat:0,project:1,computer:2};
const GRANTS=['internet','reaEnabled','browserEnabled','githubEnabled','autoResume','autoApprove','fullIntegration'];
// Continuing never widens what the task was granted: access and tool grants take the stricter of
// the original task and the room now. Folder and non-permission preferences follow the room now.
export function narrowSettings(granted,current) {
  const access=ACCESS_RANK[current.access]<=ACCESS_RANK[granted.access]?current.access:granted.access;
  const narrowed={...current,access};
  for(const key of GRANTS)narrowed[key]=Boolean(granted[key] && current[key]);
  return normalizeSettings(narrowed);
}
// A reset time alone is not capacity: require fresh, known telemetry below the hard limit.
export function capacityRestored(limit,s,model,now=Date.now()) {
  if(!limit?.resetAt || !(Date.parse(limit.resetAt)<=now)) return false;
  if(!s?.available || !s.authenticated || s.blocked || s.usage?.stale) return false;
  if(limit.direct && model?.startsWith('api:') && s.models?.some(m=>m.id===model && ['available','listed'].includes(m.availability)))return true;
  const pressure=quotaPressure(s.usage,model);if(pressure===null || pressure>=100) return false;
  const observed=Date.parse(s.usage.observedAt || '');
  return Number.isFinite(observed) && observed>=Date.parse(limit.resetAt) && observed<=now;
}
// Um limite vale para a configuração que o atingiu. Trocar o modelo ou a rota (AI Studio → Antigravity)
// encerra a exclusão: a configuração nova ainda não falhou.
export function limitApplies(limit,model) {
  if(!limit) return false;
  if(typeof limit.model==='string') return limit.model===(model || '');
  // Limites gravados antes da 1.1.1, sem o modelo: o do AI Studio só vale enquanto a rota passar por ele.
  if(limit.direct) return !model || model==='auto' || String(model).startsWith('api:');
  return true;
}
const FAILURE_TEXT={AUTH_REQUIRED:'login necessário no cliente oficial',SUBSCRIPTION_REQUIRED:'plano sem acesso a este cliente',UNAVAILABLE:'cliente indisponível nesta tarefa',MODEL_UNAVAILABLE:'modelo indisponível nesta tarefa'};
const clock=iso=>{const t=Date.parse(iso);return Number.isFinite(t)?new Date(t).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}):iso;};
// Motivo legível para um participante ficar fora da rodada (mostrado em Ações e no contexto dos colegas).
export function absenceReason({status:s,model,failure,limit}) {
  if(limit) return limit.resetAt?`limite de uso até ${clock(limit.resetAt)}${Date.parse(limit.resetAt)<=Date.now()?' (renovação ainda não confirmada)':''}`:'limite de uso sem horário de renovação informado';
  if(failure) return FAILURE_TEXT[failure] || `falha nesta tarefa (${failure})`;
  if(!s || s.loading) return 'status do cliente ainda desconhecido';
  if(!s.available) return 'cliente indisponível';
  if(!s.authenticated) return 'conta não conectada';
  if(s.blocked) return 'uso bloqueado pelo plano';
  const selected=model && model!=='auto'?s.models?.find(m=>m.id===model):null;
  if(['locked','cooldown'].includes(selected?.availability)) return `modelo ${selected.label || model} bloqueado ou em pausa`;
  const pressure=quotaPressure(s.usage,model);
  if(pressure!==null && pressure>=100) return 'limite de uso esgotado';
  return 'indisponível no momento';
}
// Uso informado pelo cliente no início da fala, para explicar depois uma passagem de vez ou um limite atingido.
function usageNote(s,model,handoff) {
  const p=quotaPressure(s?.usage,model);
  if(p===null)return ' Uso: não informado pelo cliente.';
  return ` Uso: ${Math.round(p)}%${s.usage?.stale?' (medição antiga)':''}; limite preventivo ${handoff}%.`;
}
const READ_ONLY=/somente[ -]leitura|apenas[ -]leitura|read[- ]only|sem alterar (?:nenhum )?arquivos?\b|n[aã]o (?:altere|modifique) (?:nenhum )?arquivos?\b(?!\s+fora)/iu;
export function readOnlyRequested(messages=[]) {
  const last=[...messages].reverse().find(m=>m.role==='user');
  return Boolean(last && READ_ONLY.test(last.content || ''));
}
const actorName=agent=>agent==='gemini'?'Gemini, do Google':agent==='claude'?'Claude, da Anthropic':'GPT, da OpenAI (pelo cliente Codex)';
// Prompt incremental para uma sessão retomada: o cliente já guarda as regras da sala, o histórico e as
// próprias respostas; a Synapse envia só as mensagens posteriores à marca da sessão, a memória nova e a
// coordenação desta fala. Devolve null quando a marca não existe mais (a fala recebe o prompt completo).
export function resumePrompt({room,messages,agent,lane,phase,step,totalSteps,checkpoints,stage,round,parentRole,called=false,since,skipId}) {
  const relevant=messages.filter(m=>m.role!=='system' && m.status==='completed');
  const index=since?relevant.findIndex(m=>m.id===since):-1;
  if(index<0) return null;
  const sinceAt=relevant[index].createdAt;
  const fresh=relevant.slice(index+1).filter(m=>m.id!==skipId);
  const {chosen,truncated}=pickHistory(fresh,56000,60,true,messages);
  const memory=checkpoints.filter(c=>c.createdAt>sinceAt && c.agent!==agent).slice(0,6).map(c=>({agent:c.agent,createdAt:c.createdAt,...c.content}));
  const actor=actorName(agent);
  return `[Synapse · continuação desta sessão na sala ${JSON.stringify(room.title)}. As regras da sala, o briefing e o histórico anterior já estão nesta conversa e continuam valendo; abaixo vai só o que mudou desde a sua última fala.]
Etapa ${step}/${totalSteps}. Você é ${actor}.
${chosen.length<fresh.length || truncated?'Parte das mensagens novas foi omitida ou truncada pelo limite de contexto. Não presuma conhecer trechos ausentes.\n':''}MENSAGENS NOVAS DA SALA (JSON, em ordem; as do usuário têm prioridade):${replyHint(chosen)}
${chosen.length?JSON.stringify(chosen):'[] (nenhuma mensagem nova desde a sua última fala)'}

COORDENAÇÃO DA SYNAPSE:
${coordination({messages,agent,lane,phase,stage,round,parentRole,called})}
${memory.length?`Memória nova de outros participantes (confirme afirmações nos arquivos):\n${JSON.stringify(memory).slice(0,8000)}\n`:''}${STATUS_RULES}
Responda como ${actor}.`;
}
// Cada chamada de ferramenta relê o contexto inteiro: o custo de uma fala de Code é (nº de chamadas) × (tamanho
// do contexto). Estas regras cortam os dois fatores sem reduzir o que é verificado.
export const TOOL_ECONOMY='Uso eficiente de ferramentas (mesma verificação, menos cota): cada chamada relê todo o contexto. Agrupe leituras e comandos independentes na mesma chamada ou em paralelo. Em arquivos grandes, leia os trechos pertinentes (intervalo de linhas, busca com contexto) e não o arquivo inteiro. Limite saídas longas de comandos. Não releia nesta fala o que não mudou. Nunca deixe de verificar o necessário por economia.';
function coordination({messages,agent,lane,phase,stage,round,parentRole,called}) {
  const team=stage?`\n${stageDirections(stage,{round,agent,parentRole,called,readOnly:lane==='code' && readOnlyRequested(messages)})}`
    :`\nRESPOSTA INDIVIDUAL: o usuário pediu a sua resposta. Se precisar da resposta direta de um colega, escreva @GPT, @Claude ou @Gemini no texto: ele fala logo depois de você (${lane==='code'?'revisando o que você fez':'respondendo ao seu ponto'}), até ${MAX_CHAMADAS} chamadas. Para apenas citar alguém, escreva o nome sem @.`;
  const directions=(lane==='chat'
    ? 'Modo Chat: desenvolva ideias, planejamento e explicações. Se o pedido exigir criar ou alterar arquivos reais, recomende mudar a sala para o modo Code e explique o próximo passo. Não execute o projeto neste modo.'
    : readOnlyRequested(messages)
      ? 'Modo Code, revisão somente leitura pedida pelo usuário: não crie, altere nem apague arquivos e não execute comandos que mudem o estado do projeto. Leia o código real, separe o comprovado das hipóteses e relate achados com arquivo, linha, efeito e correção.'
    : phase==='review'
      ? 'Modo Code, revisão independente: leia os arquivos reais, execute verificações pertinentes e confronte o pedido original. Complete somente se a entrega atender aos requisitos. Se houver problemas, detalhe correções reproduzíveis. Se a tarefa for apenas discussão teórica, recomende Chat.'
      : 'Modo Code, execução: inspecione o estado real dos arquivos e o último ponto de recuperação. Implemente a próxima parte útil do pedido, dentro das restrições dele, e verifique o resultado. Uma nova participação revisará seu trabalho. Se for retomada após falha, verifique o que já foi executado antes de repetir ações.')
    +(lane==='chat'?'':`\n${TOOL_ECONOMY}`)+team;
  const precedence='Restrições explícitas do usuário no pedido (somente leitura, arquivos permitidos, comandos, rede ou escopo) prevalecem sobre estas instruções de coordenação. Em caso de conflito, siga o pedido e registre o conflito.';
  return `${directions}\n${precedence}\nOs participantes são GPT (OpenAI, pelo cliente Codex), Claude (Anthropic) e Gemini (Google). Cada um fala por si. Eles trabalham sequencialmente na mesma pasta. A coordenação pode trocar o responsável para preservar capacidade; registre entregas e pendências de forma que outro consiga continuar. Não exija um debate quando já houver solução verificada. Não diga que o projeto foi concluído se só o planejamento terminou.`;
}
export function projectPrompt({room,messages,agent,lane,phase,step,totalSteps,checkpoints,stage,round,parentRole,called=false}) {
  const base=buildPrompt({room,messages,agent,mode:'conversation',step,totalSteps});
  const actor=actorName(agent);
  return base.replace(/Você é .*?, participante real (?:da sala Mesa|de uma sala da Synapse)\./,`Você é ${actor}, participante real de uma sala da Synapse.`)
    .replaceAll('os dois agentes','os três agentes').replaceAll('Os dois agentes','Os três agentes')+`\n\nCOORDENAÇÃO DA SYNAPSE:\n${coordination({messages,agent,lane,phase,stage,round,parentRole,called})}\nMemória persistente compartilhada (registros de agentes; confirme afirmações nos arquivos):\n${JSON.stringify(checkpoints.slice(0,8).map(c=>({agent:c.agent,createdAt:c.createdAt,...c.content}))).slice(0,13000)}\n${STATUS_RULES}\nResponda como ${actor}.`;
}
export class Coordinator extends Orchestrator {
  constructor(options) {
    super(options);this.approvals=options.approvals;this.versions=options.versions;this.capacity=new Map();this.tickRunning=false;
    this.timer=setInterval(()=>void this.resumeDue(),30000);this.timer.unref();
  }
  // Encerramento para atualizar: só com a fila vazia. A decisão e o bloqueio são síncronos, então nenhuma
  // tarefa entra entre a conferência e o fechamento.
  drain() {
    if(this.draining) return true;
    if(this.store.activeJobs().length) return false;
    this.draining=true;return true;
  }
  enqueue(roomId,content,target,mode,reply=null) {
    if(this.draining) throw fail('A Synapse está reiniciando para atualizar. Envie de novo em alguns segundos; nada foi perdido.',503);
    if(!['chat','code'].includes(mode)) return super.enqueue(roomId,content,target,mode,reply);
    if(!['auto','all',...PROVIDERS].includes(target)) throw fail('Participante inválido.');
    const room=this.store.getRoom(roomId);
    if(mode==='code' && room.settings.access==='chat') throw fail('Habilite o acesso à pasta nas configurações para usar Code.');
    if(this.store.activeJobs().some(j=>j.roomId===roomId)) throw fail('Já há uma tarefa em andamento nesta sala.',409);
    if(this.store.resumableJobs().some(j=>j.roomId===roomId && ['waiting_capacity','paused_budget','paused_input'].includes(j.status))) throw fail('Continue ou encerre a tarefa pausada antes de iniciar outra.',409);
    if(this.store.activeJobs().length>=8) throw fail('A fila está cheia.',429);
    // @menções no envio (com o destinatário em "Grupo"): uma menção = só ela responde; várias = só elas, na ordem citada.
    const mentions=target==='auto'?parseMentions(content):[];
    if(mentions.length===1) target=mentions[0];
    const team=!PROVIDERS.includes(target);
    // Mensagem nova é uma ação explícita, como Continuar: limites de tarefas anteriores sem renovação futura
    // conhecida não barram ninguém de antemão (o Gemini não tem telemetria de uso para "confirmar" a volta).
    // Quem continuar limitado falha uma vez, é registrado de novo e a rodada segue sem ele.
    const now=Date.now();
    for(const [agent,l] of this.capacity) if(!(l.resetAt && Date.parse(l.resetAt)>now)) this.capacity.delete(agent);
    // Chat em grupo: abertura, uma análise de cada colega, a síntese e até MAX_CHAMADAS chamadas por @. Code: orçamento da sala.
    const totalSteps=team?(mode==='chat'?4+MAX_CHAMADAS:room.settings.maxSteps):1;
    const result=this.store.transaction(()=>{
      const job=this.store.createJob(roomId,target,mode,totalSteps);
      this.store.updateJob(job.id,{progress:{completed:0,phase:'execute',visited:[],failures:{},liveDebate:team,task:content,...(mentions.length?{mentions}:{}),...(team && mentions.length>1?{only:mentions}:{})}});
      const message=this.store.addMessage(roomId,'user',content,{jobId:job.id,reply});return {job:this.store.getJob(job.id),message};
    });
    this.notify('update',{type:'queued',roomId,jobId:result.job.id});setImmediate(()=>this.pump());return result;
  }
  cancel(id) {
    const job=this.store.getJob(id);if(!job)return null;
    if(!['queued','running','waiting_capacity','paused_budget','paused_input','interrupted'].includes(job.status))return job;
    this.store.updateJob(id,{status:'cancelled',error:'Tarefa encerrada por você. Arquivos, sessões e memória foram preservados.'});
    if(this.active?.id===id) this.active.controller.abort();
    this.notify('update',{type:'cancelled',roomId:job.roomId,jobId:id});return this.store.getJob(id);
  }
  resume(id,{automatic=false}={}) {
    const job=this.store.getJob(id);if(!job)throw fail('Tarefa não encontrada.',404);
    if(this.draining)throw fail('A Synapse está reiniciando para atualizar. Continue a tarefa depois que ela abrir.',503);
    if(!['waiting_capacity','paused_budget','paused_input','interrupted','failed'].includes(job.status))throw fail('Esta tarefa não está pausada.',409);
    if(this.store.activeJobs().some(j=>j.roomId===job.roomId))throw fail('A sala já possui uma tarefa em andamento.',409);
    if(this.store.activeJobs().length>=8)throw fail('A fila está cheia.',429);
    const settings=narrowSettings(job.settings,this.store.getRoom(job.roomId).settings);
    if(job.mode==='code' && settings.access==='chat') {
      const message='O acesso à pasta (Code) foi revogado nesta sala. Reabilite o acesso nas configurações para continuar ou encerre a tarefa. Nada foi executado.';
      this.store.updateJob(id,{status:'paused_input',error:message});this.notify('update',{type:'blocked',roomId:job.roomId,jobId:id});
      throw fail(message,409);
    }
    const now=Date.now(),previous=job.progress||{};
    // Automatic resumes keep auth/availability failures, so a broken login cannot loop.
    // Manual Continue clears them (the user may have reconnected) but keeps limits with a future reset.
    const failures=automatic?Object.fromEntries(Object.entries(previous.failures||{}).filter(([,code])=>code!=='RATE_LIMIT')):{};
    const limits=Object.fromEntries(Object.entries(previous.limits||{}).filter(([,l])=>automatic || (l.resetAt && Date.parse(l.resetAt)>now)));
    const progress={...previous,failures,limits,retryAt:null};
    if(!automatic) {
      for(const [agent,l] of this.capacity) if(!(l.resetAt && Date.parse(l.resetAt)>now)) this.capacity.delete(agent);
      progress.resumeRequestedAt=new Date().toISOString();
    }
    const changed=['access','internet','reaEnabled','browserEnabled','githubEnabled','autoResume','autoApprove','fullIntegration','workspace'].filter(k=>job.settings[k]!==settings[k]);
    if(changed.length)this.store.addEvent(job.roomId,id,'system',{tool:'settings',title:'Permissões atualizadas na retomada',status:'info',detail:`Configurações atuais da sala aplicadas sem ampliar concessões: ${changed.join(', ')}.`});
    this.store.updateJob(id,{status:'queued',error:null,progress,settings,totalSteps:job.status==='paused_budget'?Math.min(240,job.totalSteps+settings.maxSteps):job.totalSteps});
    this.notify('update',{type:'queued',roomId:job.roomId,jobId:id});setImmediate(()=>this.pump());return this.store.getJob(id);
  }
  async resumeDue() {
    if(this.stopping || this.tickRunning)return;this.tickRunning=true;
    try {
      for(const job of this.store.resumableJobs()) if(job.status==='waiting_capacity' && job.settings.autoResume && job.progress?.retryAt && new Date(job.progress.retryAt).getTime()<=Date.now()) {
        try {
          // Refresh native telemetry; a reset timestamp alone is not permission to spend again.
          const status=await this.getAgentStatus();
          const settings=narrowSettings(job.settings,this.store.getRoom(job.roomId).settings);
          const progress={...job.progress,limits:{...job.progress.limits}},view={...job,settings};
          const candidate=settings.autoResume && this.select(view,status,progress,this.excluded(view,progress,status,{peek:true}));
          if(candidate) this.resume(job.id,{automatic:true});
          else this.store.updateJob(job.id,{progress:{...job.progress,retryAt:new Date(Date.now()+5*60000).toISOString()}});
        }catch{}
      }
    }finally{this.tickRunning=false;}
  }
  limitsFor(job,progress) {
    const limits={};
    for(const agent of PROVIDERS) {
      const model=job.settings[`${agent}Model`] || '';
      const cached=this.capacity.get(`${agent}:${model}`);
      const saved=progress.limits?.[agent];
      if(cached) limits[agent]=cached;
      else if(limitApplies(saved,model)) limits[agent]=saved;
    }
    return limits;
  }
  excluded(job,progress,status,{peek=false}={}) {
    const out=new Set(Object.entries(progress.failures||{}).filter(([,code])=>code!=='RATE_LIMIT').map(([agent])=>agent));
    const limits=this.limitsFor(job,progress);
    if(!peek) for(const [agent,limit] of Object.entries(progress.limits||{})) {
      if(limitApplies(limit,job.settings[`${agent}Model`]))continue;
      delete progress.limits[agent];
      if(progress.failures?.[agent]==='RATE_LIMIT')delete progress.failures[agent];
      this.store.addEvent(job.roomId,job.id,'system',{tool:'capacity',title:`${labels[agent]}: configuração alterada`,status:'info',detail:'O limite da configuração anterior continua restrito ao modelo de origem.'});
    }
    for(const [agent,limit] of Object.entries(limits)) {
      const model=job.settings[`${agent}Model`];
      if(!capacityRestored(limit,status[agent],model)) {out.add(agent);continue;}
      if(peek) continue;
      this.capacity.delete(`${agent}:${model || ''}`);if(progress.limits)delete progress.limits[agent];if(progress.failures?.[agent]==='RATE_LIMIT')delete progress.failures[agent];
      this.store.addEvent(job.roomId,job.id,'system',{tool:'capacity',title:`${labels[agent]} disponível novamente`,status:'info',detail:'Horário de renovação passou e o uso medido confirmou capacidade.'});
    }
    return [...out];
  }
  // Participantes que podem falar agora, na ordem de preferência do modo; quem passou do limite
  // preventivo vai para o fim da fila, mas continua disponível.
  // Ordem da rodada: a preferência do modo ou, se o usuário mencionou vários participantes, só eles na ordem citada.
  preference(job) {
    const lane=normalizeLane(job.mode);
    return job.progress?.only?.length?job.progress.only:job.settings[lane==='code'?'codePreference':'chatPreference'];
  }
  available(job,status,exclude=[]) {
    const preference=this.preference(job);
    const pressure=a=>quotaPressure(status[a]?.usage,job.settings[`${a}Model`]);
    const ready=preference.filter(a=>!exclude.includes(a) && modelEligible(status[a],job.settings[`${a}Model`]) && (pressure(a)??0)<100);
    return [...ready.filter(a=>(pressure(a)??0)<job.settings.handoffPercent),...ready.filter(a=>(pressure(a)??0)>=job.settings.handoffPercent)];
  }
  // Ordem efetiva da rodada e motivo de cada ausência, registrados antes da primeira fala.
  announceOrder(job,status,progress,excluded,ready) {
    const preference=this.preference(job);
    const limits=this.limitsFor(job,progress),absent={};
    for(const agent of preference) {
      if(ready.includes(agent)) continue;
      const model=job.settings[`${agent}Model`],out=excluded.includes(agent),failure=progress.failures?.[agent];
      absent[agent]=absenceReason({status:status[agent],model,failure:out && failure!=='RATE_LIMIT'?failure:undefined,limit:out && limitApplies(limits[agent],model)?limits[agent]:undefined});
    }
    if(progress.round)progress.round.absent=absent;
    const missing=Object.entries(absent).map(([agent,why])=>`${labels[agent]}: ${why}`).join(' · ');
    this.store.addEvent(job.roomId,job.id,'system',{tool:'routing',title:`Ordem da rodada: ${ready.map(a=>labels[a]).join(' → ') || 'ninguém disponível'}`,status:missing?'warning':'info',detail:missing?`Fora desta rodada: ${missing}.`:'Todos os participantes disponíveis.'});
    return absent;
  }
  // Mensagens suas enviadas durante a rodada: as @menções viram chamadas. O cursor fica na própria rodada,
  // então cada mensagem é lida uma vez, inclusive depois de uma retomada.
  absorbUserCalls(job,progress,reserve=[]) {
    const round=progress.round;if(!round)return;
    // A primeira mensagem já definiu o destinatário em enqueue. Orientações podem chegar ainda na fila.
    if(round.userCursor===undefined) {
      // Uma rodada salva antes da 1.2 não roteava menções. Não reexecute seu histórico.
      round.userCursor=this.store.userMessagesAfter(job.id,0).length;
      return;
    }
    const cursor=round.userCursor;
    const novas=this.store.userMessagesAfter(job.id,cursor);
    for(const message of novas)this.registerCalls(job,round,parseMentions(message.content),'user',reserve);
    round.userCursor=cursor+novas.length;
  }
  registerCalls(job,round,agents,from,reserve=[]) {
    if(!round || !agents.length)return;
    const {accepted,dropped}=queueCalls(round,agents,from,round.order,{reserve});
    const quem=from==='user'?'Você':labels[from];
    for(const agent of accepted)this.store.addEvent(job.roomId,job.id,'system',{tool:'routing',title:`${quem} chamou ${labels[agent]}`,status:'info',detail:`${labels[agent]} responde em seguida, fora da fila.`});
    for(const {agent,reason} of dropped)this.store.addEvent(job.roomId,job.id,'system',{tool:'routing',title:`Chamada para ${labels[agent]} não atendida`,status:'warning',detail:`${quem} chamou ${labels[agent]}, mas ${reason}.`});
  }
  // Resposta individual ("Só X") com @menção (1.6): o colega mencionado é chamado como numa rodada. No Chat ele responde
  // logo em seguida (rodada rápida, sem síntese); no Code ele revisa o que X fez, e a rodada segue até a aprovação,
  // só entre os participantes envolvidos. Mesmas regras das chamadas em grupo: até MAX_CHAMADAS, ninguém chama a si
  // mesmo, e quem passou do limite preventivo não é chamado por um colega. Devolve true se a tarefa virou rodada.
  promoteToRound(job,progress,lane,turn,status) {
    const called=[...new Set(parseMentions(turn.text,{exclude:turn.agent}).filter(a=>PROVIDERS.includes(a) && a!==turn.agent))];
    if(!called.length)return false;
    const only=[turn.agent,...called];
    progress.only=only;progress.liveDebate=true;progress.promotedFrom=turn.agent;
    const {reserve}=this.turnPool(job,status,this.excluded(job,progress,status,{peek:true}));
    const round=startRound(lane,only,{quick:lane==='chat'});
    round.userCursor=this.store.userMessagesAfter(job.id,0).length;round.absent={};
    recordTurn(round,{agent:turn.agent,stage:lane==='chat'?'abertura':'implementacao',control:turn.control,changed:turn.changed,docsOnly:turn.docsOnly,step:turn.step});
    progress.round=round;
    this.registerCalls(job,round,called,turn.agent,reserve);
    if(!round.calls.length){delete progress.only;delete progress.promotedFrom;progress.liveDebate=false;delete progress.round;this.store.updateJob(job.id,{progress});return false;}
    const totalSteps=Math.min(240,Math.max(job.totalSteps,progress.completed+(lane==='chat'?round.calls.length:job.settings.maxSteps)));
    job.totalSteps=totalSteps;
    if(lane==='code')progress.implementer=turn.agent;
    this.store.updateJob(job.id,{progress,totalSteps});
    return true;
  }
  // Limite preventivo (handoffPercent): quem passou dele passa a vez enquanto algum colega abaixo do limite puder
  // falar. Se todos passaram, todos seguem disponíveis (último recurso; quem esgota 100% já sai em available).
  turnPool(job,status,excluded=[]) {
    const ready=this.available(job,status,excluded);
    const over=a=>(quotaPressure(status[a]?.usage,job.settings[`${a}Model`])??0)>=job.settings.handoffPercent;
    const below=ready.filter(a=>!over(a));
    return below.length?{ready,pool:below,reserve:ready.filter(over)}:{ready,pool:ready,reserve:[]};
  }
  // Avisa uma vez por rodada quem passou a vez, em Ações e no contexto dos colegas.
  noteReserve(job,progress,reserve,status) {
    const round=progress.round;if(!round || !reserve.length)return;
    round.reserveNoted ||= [];round.absent ||= {};
    for(const agent of reserve) {
      if(round.reserveNoted.includes(agent))continue;
      round.reserveNoted.push(agent);
      const uso=Math.round(quotaPressure(status[agent]?.usage,job.settings[`${agent}Model`]));
      round.absent[agent]=`passou a vez: uso em ${uso}%, acima do limite preventivo de ${job.settings.handoffPercent}%`;
      this.store.addEvent(job.roomId,job.id,'system',{tool:'capacity',title:`${labels[agent]} passou a vez`,status:'warning',detail:`Uso em ${uso}%, acima do limite preventivo de ${job.settings.handoffPercent}%. Os colegas assumem as próximas falas desta rodada. Uma chamada sua com @ ainda alcança ${labels[agent]}.`});
    }
  }
  select(job,status,progress,exclude) {
    if(PROVIDERS.includes(job.target)) {
      const a=job.target,s=status[a];return !exclude.includes(a) && modelEligible(s,job.settings[`${a}Model`]) && (quotaPressure(s.usage,job.settings[`${a}Model`])??0)<100?{agent:a,reason:'Participante escolhido por você.'}:null;
    }
    return chooseAgent({status,settings:job.settings,lane:normalizeLane(job.mode),exclude:[...exclude,...(job.mode==='chat'?progress.visited||[]:[]),...(progress.phase==='review'&&progress.implementer?[progress.implementer]:[])],preferDifferent:progress.phase==='review'?progress.implementer:undefined});
  }
  async snapshot(job,cwd,agent,phase) {
    if(!this.versions || job.mode!=='code') return;
    const snapshot=await this.versions.capture(job.roomId,cwd,{jobId:job.id,agent,phase});
    this.store.addEvent(job.roomId,job.id,'system',{tool:'snapshot',title:'Versão dos arquivos salva',status:'completed',detail:`${snapshot.files} arquivos${snapshot.partial?' · captura parcial; veja Versões':''}`});
    return snapshot;
  }
  async pump() {
    if(this.pumping || this.stopping)return;this.pumping=true;
    try {
      while(!this.stopping) {
        let job=this.store.activeJobs().find(j=>j.status==='queued');if(!job)break;
        const controller=new AbortController();this.active={id:job.id,controller};
        const modern=['chat','code'].includes(job.mode),lane=normalizeLane(job.mode);
        const progress={completed:0,phase:'execute',visited:[],failures:{},...job.progress};
        try {
          this.store.updateJob(job.id,{status:'running',error:null});this.notify('update',{type:'started',roomId:job.roomId,jobId:job.id});
          const room={...this.store.getRoom(job.roomId),settings:{...job.settings,...(lane==='chat' && modern?{access:'chat'}:{})}};
          let cwd=workspaceFor(room,this.workspaceRoot);if(!room.settings.workspace)await mkdir(cwd,{recursive:true});cwd=await verifyDirectory(cwd);room.workspacePath=cwd;
          const legacyPlan=modern?null:planFor(job.target,job.mode);
          let status=await this.getAgentStatus(),attempts=0;
          let team=modern && !PROVIDERS.includes(job.target);
          let plan=null;
          while(progress.completed<job.totalSteps && !controller.signal.aborted && !this.stopping) {
            const excluded=modern?this.excluded(job,progress,status):[];
            let selection,reserve=[];
            if(team) {
              const {ready,pool,reserve:reservaAgora}=this.turnPool(job,status,excluded);reserve=reservaAgora;
              if(!progress.round){
                progress.round=startRound(lane,ready,{quick:lane==='chat' && (progress.only?.length||0)>1});
                if(progress.round)progress.round.userCursor=1;
                this.announceOrder(job,status,progress,excluded,ready);
              }
              this.absorbUserCalls(job,progress,reserve);
              this.noteReserve(job,progress,reserve,status);
              plan=planNext(progress.round,pool,{userCalls:reserve});
              if(plan.done){progress.activeAgents=[];progress.currentAgent=null;this.store.updateJob(job.id,{status:'completed',error:null,progress});break;}
              selection=plan.agent?{agent:plan.agent,reason:plan.call?`Chamado com @ por ${plan.parentRole==='user'?'você':labels[plan.parentRole]}.`:plan.stage==='abertura' || plan.stage==='implementacao'?'Lidera a rodada neste modo.':`${STAGES[plan.stage].label} na rodada em grupo.`}:null;
              if(selection){progress.phase=STAGES[plan.stage].phase;progress.stage=plan.stage;progress.round.queue=upcoming(progress.round,pool,plan);}
            } else selection=modern?this.select(job,status,progress,excluded):{agent:legacyPlan[progress.completed],reason:'Rodada anterior à versão 0.3.'};
            if(!selection || !status[selection.agent]?.authenticated) {
              if(modern && lane==='chat' && progress.completed>0) {progress.activeAgents=[];this.store.updateJob(job.id,{status:'completed',progress});break;}
              const limitResets=Object.values(this.limitsFor(job,progress)).map(v=>v.resetAt).filter(Boolean);
              const resets=Object.values(status).flatMap(s=>(s.usage?.windows||[]).filter(w=>w.usedPercent>=100 && w.resetsAt).map(w=>w.resetsAt)).concat(limitResets).filter(d=>new Date(d)>new Date()).sort();
              // Reset passed but capacity not yet confirmed: re-check telemetry for a day, not forever.
              const awaiting=limitResets.some(d=>{const t=Date.parse(d);return t<=Date.now() && Date.now()-t<86400000;});
              progress.retryAt=resets[0] || (awaiting?new Date(Date.now()+5*60000).toISOString():null);
              this.store.updateJob(job.id,{status:modern?'waiting_capacity':'failed',progress,error:plan?.reason?`${plan.reason} O trabalho está salvo; conecte um agente ou aguarde a renovação de uso e continue.`:'Nenhum participante elegível está disponível. O trabalho está salvo. Conecte um agente ou aguarde a renovação de uso e continue.'});break;
            }
            const {agent,reason}=selection;progress.currentAgent=agent;progress.activeAgents=[agent];
            const step=progress.completed+1;this.store.updateJob(job.id,{step,progress});
            if(modern)this.store.addEvent(job.roomId,job.id,'system',{tool:'routing',title:plan?.stage?`${labels[agent]} · ${STAGES[plan.stage].label}`:`Responsável: ${labels[agent]}`,status:'info',detail:reason+(!plan && progress.phase==='review'?' Revisão da entrega.':'')+usageNote(status[agent],job.settings[`${agent}Model`],job.settings.handoffPercent)});
            this.notify('update',{type:'step',roomId:job.roomId,jobId:job.id,agent});
            const before=await this.snapshot(job,cwd,agent,'before');
            const briefHash=room.brief?createHash('sha256').update(room.brief).digest('hex'):'';
            const binding=`${cwd}|${room.settings.access}|${room.settings.internet}${room.settings.fullIntegration && room.settings.access!=='chat'?'|total':''}${briefHash?'|brief:'+briefHash:''}`;
            let partialText='',captured=false;
            // Prompt completo para sessões novas; incremental quando a sessão é retomada (ver resumePrompt).
            let saved=modern?this.store.session(job.roomId,agent,lane,binding):undefined;
            const roomMessages=this.store.messages(job.roomId);
            // Conversa grande demais: cada chamada de ferramenta relê o contexto inteiro e consome cota. A fala
            // começa uma conversa nova com o prompt completo (histórico recente e memória consolidada da sala).
            const size=saved?.replyId?contextTokens(agent,roomMessages.find(m=>m.id===saved.replyId)?.usage):null;
            if(saved && size && job.settings.sessionMaxTokens && size>job.settings.sessionMaxTokens) {
              saved=undefined;
              const event=this.store.addEvent(job.roomId,job.id,'system',{tool:'session',title:`${labels[agent] || agent} · conversa renovada`,status:'info',detail:`A conversa anterior chegou a ${Math.round(size/1000)} mil tokens de contexto (limite ${Math.round(job.settings.sessionMaxTokens/1000)} mil). Esta fala começa uma nova, com o estado consolidado da sala.`});
              this.notify('activity',event);
            }
            const promptArgs={room,messages:roomMessages,agent,lane,phase:progress.phase,step,totalSteps:job.totalSteps,checkpoints:this.store.checkpoints(job.roomId),stage:plan?.stage,round:progress.round,parentRole:plan?.parentRole,called:Boolean(plan?.call)};
            const incremental=saved?.watermark && job.settings.incrementalContext!==false?resumePrompt({...promptArgs,since:saved.watermark,skipId:saved.replyId}):null;
            const watermark=roomMessages.filter(m=>m.role!=='system' && m.status==='completed').at(-1)?.id;
            try {
              const result=await this.runAgent({agent,cwd,settings:room.settings,signal:controller.signal,timeoutMs:this.timeoutMs??job.settings.timeoutMinutes*60000,
                sessionId:saved?.sessionId,
                ...(incremental?{resumePrompt:incremental}:{}),
                onSession:id=>{if(modern)this.store.saveSession(job.roomId,agent,lane,id,binding);},
                requestApproval:request=>this.approvals.request({roomId:job.roomId,jobId:job.id,agent,request,signal:controller.signal,
                  auto:room.settings.autoApprove===true && room.settings.access!=='chat',
                  aoAprovar:safe=>{const event=this.store.addEvent(job.roomId,job.id,agent,{tool:'approval',title:`Aprovado pela Autonomia · ${safe.title}`,status:'completed',detail:String(safe.detail||'').slice(0,600)});this.notify('activity',event);}}),
                prompt:modern?projectPrompt(promptArgs):buildPrompt({room,messages:roomMessages,agent,mode:job.mode,step,totalSteps:job.totalSteps}),
                onDelta:text=>{partialText=(partialText+text).slice(-50000);this.notify('delta',{roomId:job.roomId,jobId:job.id,role:agent,text});},
                onActivity:activity=>{const event=this.store.addEvent(job.roomId,job.id,agent,typeof activity==='string'?{title:activity,status:'info',detail:''}:activity);this.notify('activity',event);},
                onUsage:usage=>{status[agent]={...status[agent],usage};}
              });
              if(controller.signal.aborted || this.stopping)break;
              if(!result.text?.trim())throw new Error('O participante encerrou sem uma resposta.');
              const parsed=modern?parseHandoff(result.text):{text:result.text,control:{}};
              // Versão final antes de qualquer mudança de estado: quem vê "concluída" já encontra os arquivos salvos.
              const after=await this.snapshot(job,cwd,agent,'after');captured=true;
              const changed=Boolean(before && after && before.fingerprint!==after.fingerprint);
              const docsOnly=changed && team?await this.versions.docsOnly(job.roomId,before,after).catch(()=>false):false;
              this.store.transaction(()=>{
                const reply=this.store.addMessage(job.roomId,agent,parsed.text || 'Estado do trabalho registrado.',{jobId:job.id,model:result.model,usage:result.usage,...(plan?.stage?{debate:{stage:plan.stage,parentRole:plan.parentRole,lead:progress.round.lead,turnId:randomUUID(),changed}}:{})});
                // A marca só avança quando a sessão que respondeu é a que recebeu este prompt.
                if(result.sessionId && modern)this.store.saveSession(job.roomId,agent,lane,result.sessionId,binding,watermark?{watermark,replyId:reply?.id}:{});
                if(modern)this.store.checkpoint(job.roomId,job.id,agent,{...parsed.control,summary:parsed.control.summary || parsed.text.slice(-5000),step,phase:progress.phase});
                progress.completed++;progress.visited.push(agent);
                const reviewed=progress.phase==='review' && progress.implementer!==agent;
                if(team) {
                  progress.activeAgents=[];
                  // Bloqueio: a mesma fala é refeita depois da resposta do usuário, então a rodada não avança.
                  if(parsed.control.status==='blocked' && lane==='code')this.store.updateJob(job.id,{status:'paused_input',error:'O participante precisa de uma decisão ou informação. Veja a última resposta.'});
                  else {
                    const comparisonComplete=Boolean(before && after && !before.partial && !after.partial);
                    recordTurn(progress.round,{agent,stage:plan.stage,control:parsed.control,changed,docsOnly,comparisonComplete,step});
                    if(lane==='code' && progress.round.pass){
                      const supplied=roomMessages.filter(m=>m.jobId===job.id && m.role==='user').length;
                      if(this.store.userMessagesAfter(job.id,supplied).length)progress.round.pass.issues=true;
                    }
                    this.absorbUserCalls(job,progress,reserve);
                    this.registerCalls(job,progress.round,parseMentions(parsed.text,{exclude:agent}),agent,reserve);
                  }
                  progress.implementer=progress.round.lastChange?.agent;progress.stage=null;
                } else if(lane==='code' && modern) {
                  if(parsed.control.status==='blocked') {
                    // Keep phase and implementer: the same stage resumes after the user answers.
                    this.store.updateJob(job.id,{status:'paused_input',error:'O participante precisa de uma decisão ou informação. Veja a última resposta.'});
                  } else {
                    if(reviewed && parsed.control.status==='complete')this.store.updateJob(job.id,{status:'completed'});
                    if(progress.phase==='execute'){progress.implementer=agent;progress.phase='review';}else progress.phase='execute';
                  }
                }
                this.store.updateJob(job.id,{progress});
              });
              this.notify('update',{type:'message',roomId:job.roomId,jobId:job.id});
              if(modern && !team && parsed.control.status!=='blocked' && this.store.getJob(job.id).status==='running')
                team=this.promoteToRound(job,progress,lane,{agent,text:parsed.text,control:parsed.control,changed,docsOnly,step},status);
              if(this.store.getJob(job.id).status!=='running')break;
              if(modern && progress.completed<job.totalSteps)status=await this.getAgentStatus();
            } catch(error) {
              const partial=(error.partialText || partialText).trim();
              if(partial || error.usage?.partialUsage){
                this.store.addMessage(job.roomId,agent,partial || 'Participação interrompida antes da resposta final.',{jobId:job.id,status:'interrupted',usage:error.usage,model:error.model});
                this.store.checkpoint(job.roomId,job.id,agent,{status:'continue',summary:'Resposta parcial interrompida: '+partial.slice(-5000),next:['Conferir arquivos e a resposta parcial antes de continuar.'],step,phase:progress.phase});
              }
              if(controller.signal.aborted || this.stopping)break;
              if(modern && ['RATE_LIMIT','AUTH_REQUIRED','UNAVAILABLE','MODEL_UNAVAILABLE','SUBSCRIPTION_REQUIRED'].includes(error.code)) {
                progress.failures[agent]=error.code;
                if(error.code==='RATE_LIMIT') {
                  status=await this.getAgentStatus();
                  const resets=(status[agent]?.usage?.windows||[]).filter(w=>w.usedPercent>=100 && w.resetsAt).map(w=>w.resetsAt).sort();
                  const limit={direct:agent==='gemini' && job.settings.geminiModel.startsWith('api:'),model:job.settings[`${agent}Model`] || '',resetAt:error.resetAt || resets[0] || null,limitedAt:new Date().toISOString()};
                  this.capacity.set(`${agent}:${limit.model}`,limit);progress.limits={...(progress.limits||{}),[agent]:limit};
                }
                this.store.checkpoint(job.roomId,job.id,agent,{summary:'Participação interrompida: '+error.message,next:['Inspecionar arquivos atuais antes de continuar; uma ferramenta pode ter concluído antes da interrupção.'],step,phase:progress.phase});
                this.store.updateJob(job.id,{progress});this.store.addEvent(job.roomId,job.id,'system',{tool:'handoff',title:'Transferindo o trabalho',status:'info',detail:error.message});
                this.notify('update',{type:'handoff',roomId:job.roomId,jobId:job.id});
                if(++attempts>PROVIDERS.length)throw error;
              } else throw error;
            } finally {progress.activeAgents=[];if(!captured)await this.snapshot(job,cwd,agent,'after');}
          }
          if(!controller.signal.aborted && !this.stopping && this.store.getJob(job.id).status==='running') {
            const bounded=modern && lane==='code' && team && !roundDone(progress.round,this.turnPool(job,status,this.excluded(job,progress,status,{peek:true})).pool);
            progress.activeAgents=[];progress.currentAgent=null;
            this.store.updateJob(job.id,{status:bounded?'paused_budget':'completed',error:bounded?'O limite de participações desta tarefa foi atingido. Revise o andamento e use Continuar para autorizar mais uma rodada.':null,progress});
          }
        } catch(error) {if(!controller.signal.aborted && !this.stopping)this.store.updateJob(job.id,{status:'failed',progress,error:String(error.message||error).slice(0,1800)});}
        finally {this.active=null;this.notify('update',{type:'finished',roomId:job.roomId,jobId:job.id});}
      }
    }finally{this.pumping=false;}
  }
  async stop(){clearInterval(this.timer);this.approvals?.close();await super.stop();}
}
const labels={codex:'GPT',claude:'Claude',gemini:'Gemini'};
