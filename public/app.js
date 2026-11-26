/* Synapse — interface local da sala. Todo texto de modelo ou do usuário entra pelo DOM (nunca como HTML). */
'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  csrfToken: '', rooms: [], agents: {}, activeJobs: [], room: null,
  messages: [], jobs: [], selectedId: null, loading: true, sending: false,
  roomRequest: 0, streams: new Map(), drafts: new Map(), connected: false,
  events: [], models: {}, panel:'context', filePath:'', fileRequest:0, viewedFile:null,
  sessions:[], checkpoints:[], approvals:[], lane:'chat', accounts:{}, approvalSignature:'',
  seen:new Set(), seenRoom:null, recentStream:null, switching:null, stepsSignature:'', replyTo:null,
};
const MOVIMENTO = !matchMedia('(prefers-reduced-motion: reduce)').matches;
let eventSource;
let updateTimer;
let streamTimer;
let toastTimer;
const names = {user: 'Você', codex: 'GPT', claude: 'Claude', gemini:'Gemini', system: 'Synapse'};
const companies = {codex: 'OpenAI', claude: 'Anthropic', gemini: 'Google'};
const STAGE_LABELS = {abertura:'Abertura',analise:'Análise',sintese:'Síntese',implementacao:'Implementação',revisao:'Revisão',refino:'Refino',verificacao:'Verificação',proposal:'Proposta',reaction:'Réplica',synthesis:'Síntese',replica:'Réplica'};
// @menções, como num grupo de mensagens (mesma regra de lib/mentions.mjs no servidor).
const MENCAO=/(^|[^\w@./\\-])@(gpt|codex|claude|gemini)(?![\w@/\\-]|\.\w)/gi;
const MENCAO_AGENTE={gpt:'codex',codex:'codex',claude:'claude',gemini:'gemini'};
function mencoes(texto){
  const vistos=[];
  const limpo=String(texto||'').replace(/```[\s\S]*?(```|$)/g,' ').replace(/`[^`\n]*`/g,' ');
  for(const m of limpo.matchAll(MENCAO)){const a=MENCAO_AGENTE[m[2].toLowerCase()];if(!vistos.includes(a))vistos.push(a);}
  return vistos;
}
function appendText(parent,texto){
  let cursor=0;
  for(const m of texto.matchAll(MENCAO)){
    const inicio=m.index+m[1].length,agente=MENCAO_AGENTE[m[2].toLowerCase()];
    parent.append(document.createTextNode(texto.slice(cursor,inicio)));
    parent.append(element('span',`mencao role-${agente}`,`@${names[agente]}`));
    cursor=inicio+m[2].length+1;
  }
  parent.append(document.createTextNode(texto.slice(cursor)));
}
const EFFORT_ORDER = ['none','minimal','low','medium','high','xhigh','max','ultra'];
const EFFORT_LABELS = {none:'None',minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'Extra High',max:'Max',ultra:'Ultra'};
// Mesmo nome que o cliente oficial mostra (ver EFFORT_NAMES em lib/models.mjs).
const EFFORT_NAMES = {codex:{xhigh:'Extra high'},claude:{xhigh:'Extra'}};
const effortLabel=(provider,level)=>EFFORT_NAMES[provider]?.[level] || EFFORT_LABELS[level] || level;
const PROVIDER_EFFORTS = {codex:['low','medium','high'],claude:['low','medium','high'],gemini:['low','high']};
const symbols = {user: 'V', codex: 'C', claude: 'A', gemini:'G', system: 'M'};
const providers=['codex','claude','gemini'];
const resumableStatuses=new Set(['waiting_capacity','paused_budget','paused_input','interrupted','failed']);
const activeStatuses = new Set(['queued', 'running']);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function icon(kind) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', kind === 'copy'
    ? 'M9 8h11v13H9zM5 16H3V3h11v2'
    : kind === 'reply' ? 'M10 8 5 12l5 4M5 12h9a5 5 0 0 1 5 5v1'
    : kind === 'more' ? 'M6 12h.01M12 12h.01M18 12h.01'
    : 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3H3V6a2 2 0 0 1 2-2Z');
  if (kind === 'more') node.classList.add('icon-more');
  node.append(path);
  return node;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET') headers.set('X-CSRF-Token', state.csrfToken);
  let response;
  try {
    response = await fetch(path, {credentials: 'same-origin', ...options, headers});
  } catch {
    throw new Error('A central não respondeu. Verifique se ela continua aberta neste computador.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `Não foi possível concluir a ação (${response.status}).`);
  return data;
}

function showError(error) {
  $('error-message').textContent = error instanceof Error ? error.message : String(error);
  $('error-banner').hidden = false;
}

function toast(text) {
  clearTimeout(toastTimer);
  $('toast').textContent = text;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2800);
}

function clock(date) {
  const value = new Date(date);
  return Number.isNaN(value.getTime()) ? '' : value.toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'});
}

function dateLabel(date) {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return '';
  return value.toLocaleString('pt-BR', {day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'});
}

function rememberRoom(id) {
  try { localStorage.setItem('mesa-selected-room', id); } catch { /* The app still works with browser storage disabled. */ }
}

function activeJob() {
  return state.jobs.find((job) => activeStatuses.has(job.status))
    || state.activeJobs.find((job) => job.roomId === state.selectedId && activeStatuses.has(job.status));
}

function agentForJob(job) {
  for (const value of [job.progress?.currentAgent, job.agent, job.currentAgent, job.target]) if (providers.includes(value)) return value;
  return null;
}

function statusText(job) {
  return ({queued: 'Na fila', running: 'Em andamento', completed: 'Tarefa concluída', failed: 'Tarefa não concluída', cancelled: 'Tarefa encerrada', interrupted: 'Execução interrompida',waiting_capacity:'Aguardando disponibilidade',paused_budget:'Limite de participações atingido',paused_input:'Aguardando sua orientação'})[job.status] || 'Atualizando';
}

function roomButton(room) {
  const item = element('div', `room-item${room.id === state.selectedId ? ' selected' : ''}${room.archivedAt ? ' arquivada' : ''}`);
  const button = element('button', 'room-open');
  button.type = 'button';
  button.title = room.title;
  button.setAttribute('aria-current', room.id === state.selectedId ? 'page' : 'false');
  button.dataset.inicial = (room.title.trim()[0] || 'S').toUpperCase();
  button.append(icon('chat'), element('span', 'room-item-text', room.title));
  if (state.activeJobs.some((job) => job.roomId === room.id && activeStatuses.has(job.status))) {
    const dot = element('span', 'room-running');
    dot.title = 'Rodada em andamento';
    button.append(dot);
  }
  button.addEventListener('click', () => { if (document.body.dataset.drawer === 'rooms') setDrawer(null); selectRoom(room.id); });
  const more = element('button', 'room-more');
  more.type = 'button';
  more.setAttribute('aria-label', `Ações da sala ${room.title}`);
  more.setAttribute('aria-haspopup', 'menu');
  more.append(icon('more'));
  more.addEventListener('click', (event) => { event.stopPropagation(); openRoomMenu(room, more); });
  item.addEventListener('contextmenu', (event) => { event.preventDefault(); openRoomMenu(room, more, event); });
  item.append(button, more);
  return item;
}
function renderRooms() {
  const ativas = state.rooms.filter((room) => !room.archivedAt), arquivadas = state.rooms.filter((room) => room.archivedAt);
  $('room-count').textContent = ativas.length;
  const fragment = document.createDocumentFragment();
  if (!ativas.length) fragment.append(element('p', 'no-rooms', arquivadas.length ? 'Nenhuma sala ativa. Crie uma ou restaure uma arquivada.' : 'Crie uma sala para começar um projeto com os agentes.'));
  for (const room of ativas) fragment.append(roomButton(room));
  state.roomInd ||= element('span', 'room-ind');
  fragment.prepend(state.roomInd);
  $('room-list').replaceChildren(fragment);
  $('archived-rooms').hidden = !arquivadas.length;
  $('archived-count').textContent = arquivadas.length;
  $('archived-list').replaceChildren(...arquivadas.map(roomButton));
  if (arquivadas.some((room) => room.id === state.selectedId)) $('archived-rooms').open = true;
  requestAnimationFrame(moveRoomIndicator);
}
function moveRoomIndicator() {
  const selected = $('room-list').querySelector(':scope > .room-item.selected'), ind = state.roomInd;
  if (!ind) return;
  if (!selected) { ind.style.opacity = '0'; return; }
  ind.style.opacity = '1';
  ind.style.height = `${selected.offsetHeight}px`;
  ind.style.transform = `translateY(${selected.offsetTop}px)`;
}

function renderAgents() {
  for (const provider of providers) {
    const agent = state.agents[provider];
    const dot = $(`${provider}-dot`);
    const label = $(`${provider}-status`);
    if (!agent || agent.loading) {
      label.textContent = 'Verificando conexão…';
      dot.className = 'agent-status-dot';
    } else if (agent.available && agent.authenticated) {
      label.textContent = provider==='gemini'?agent.detail:provider === 'codex' ? 'Conectado ao ChatGPT' : provider==='claude'?'Conectado ao Claude':'Conectado ao Google';
      dot.className = `agent-status-dot ready${estadoAgente(provider)==='esgotado'?' esgotado':''}`;
    } else {
      label.textContent = agent.blocked && ['free','restricted'].includes(agent.plan)?'Assinatura indisponível':agent.stale ? 'Consulta indisponível' : agent.available ? 'Login necessário' : 'Não encontrado';
      dot.className = 'agent-status-dot error';
    }
    label.title = agent?.detail || agent?.version || '';
    renderUsage(provider,agent?.usage);
  }
  renderAccountButtons();
  renderGeminiOrigins();
  updateParticipants();
}

// Uso do Gemini pela origem (1.6): o AI Studio não informa percentual, então a linha mostra as requisições feitas
// pela Synapse desde a renovação diária do Google e as pausas gravadas; o Antigravity mostra conexão e pausa.
function renderGeminiOrigins() {
  const box=$('gemini-origins');if(!box)return;
  const origins=state.agents.gemini?.origins;
  box.replaceChildren();box.hidden=!Array.isArray(origins) || !origins.length;
  if(box.hidden)return;
  for(const o of origins) {
    const row=document.createElement('div');row.className='usage-origin';
    const nome=document.createElement('span');nome.className='usage-origin-nome';nome.textContent=o.label;
    const valor=document.createElement('span');valor.className='usage-origin-valor';
    const linha=(texto,classe='')=>{const span=document.createElement('span');span.textContent=texto;if(classe)span.className=classe;valor.append(span);};
    const pausas=(o.paused||[]).map(p=>`${o.id==='studio'?p.model+' · ':''}em pausa até ${dateLabel(p.until)}`);
    if(o.id==='studio') {
      if(!o.connected)linha('chave não configurada');
      else if(!(o.items||[]).length)linha('nenhuma requisição hoje');
      for(const i of o.items||[])linha(`${i.model} · ${i.requests} req. hoje`);
      row.title='Requisições feitas pela Synapse desde a meia-noite do Pacífico, quando a cota diária do AI Studio renova. O Google não informa o percentual.';
    } else {
      if(!pausas.length)linha(o.connected?'conta Google conectada':'conta Google não conectada');
      row.title='Rota da conta Google pelo Antigravity. A cota da conta só aparece quando o Antigravity avisa que ela acabou.';
    }
    for(const pausa of pausas)linha(pausa,'pausa');
    row.append(nome,valor);box.append(row);
  }
}

// Anéis de uso: cada janela informada pelo cliente oficial vira um anel. A cor é a do participante até 70%,
// depois alerta e crítico. O anel parte do valor anterior, então uma atualização igual não pisca.
const usageLevel=p=>p>=100?'cheio':p>=85?'alto':p>=70?'medio':'ok';
const ringMemory=new Map();
function usageRing(key,percent,size=46,stroke=4,inset=0) {
  const ns='http://www.w3.org/2000/svg',r=(size-stroke)/2-inset,c=2*Math.PI*r,p=Math.min(100,Math.max(0,percent));
  const svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox',`0 0 ${size} ${size}`);svg.setAttribute('aria-hidden','true');svg.classList.add('anel');
  const base=document.createElementNS(ns,'circle'),arc=document.createElementNS(ns,'circle');
  for(const el of [base,arc]){el.setAttribute('cx',size/2);el.setAttribute('cy',size/2);el.setAttribute('r',r);el.setAttribute('stroke-width',stroke);}
  base.classList.add('anel-base');arc.classList.add('anel-arco');
  const before=ringMemory.has(key)?ringMemory.get(key):0;ringMemory.set(key,p);
  arc.style.strokeDasharray=String(c);arc.style.strokeDashoffset=String(c*(1-p/100));arc.style.setProperty('--de',String(c*(1-before/100)));
  svg.append(base,arc);return svg;
}
function usageTitle(usage,window) {return `${usage.source || 'Cliente oficial'} · consultado ${dateLabel(usage.observedAt)}${window.resetsAt?' · renova '+dateLabel(window.resetsAt):''}${usage.stale?' · última leitura disponível':''}`;}
function renderUsage(provider,usage) {
  const box=$(`${provider}-usage`);box.replaceChildren();
  state.usage={...state.usage,[provider]:usage};renderUsageDock();
  if(!usage?.windows?.length && provider==='gemini' && state.agents?.gemini?.origins?.length) {
    // O Gemini não tem percentual oficial: os anéis mostram o mesmo que o rodapé (hoje no AI Studio e a conta Google).
    const grid=element('div','usage-rings');
    geminiSlots(state.agents.gemini.origins).forEach((s,i)=>{
      const cell=element('div',`usage-ring ${s.pct===null?'sem-dado':'nivel-'+usageLevel(s.pct)}`),dial=element('div','usage-dial');
      dial.append(usageRing(`gemini:${i}`,s.pct??0),element('span','usage-value',s.texto));
      cell.append(dial,element('span','usage-label',s.nome));cell.title=s.detalhe;grid.append(cell);
    });
    box.append(grid);return;
  }
  if(!usage?.windows?.length) {box.append(element('span','usage-unknown','Uso não informado'));return;}
  const grid=element('div','usage-rings');
  for(const window of usage.windows) {
    const p=Math.round(window.usedPercent),cell=element('div',`usage-ring nivel-${usageLevel(p)}`),dial=element('div','usage-dial');
    dial.append(usageRing(`${provider}:${window.label}`,p),element('span','usage-value',`${p}%`));
    cell.append(dial,element('span','usage-label',window.label));
    if(window.resetsAt && p>=70)cell.append(element('span','usage-reset',`renova ${dateLabel(window.resetsAt)}`));
    cell.title=usageTitle(usage,window);grid.append(cell);
  }
  box.append(grid);
  if(usage.stale)box.append(element('span','usage-unknown','Última leitura · atualização indisponível'));
}
// Rodapé das salas (1.7): o mesmo padrão para os três participantes. Anel externo = janela curta, anel interno =
// janela longa, e os dois valores aparecem lado a lado, na mesma ordem. GPT e Claude: 5 horas e semana (a maior das
// semanais, inclusive as de um modelo). Gemini: requisições de hoje no AI Studio (em percentual quando o Google já
// informou o tamanho da cota diária) e a cota da conta Google no Antigravity, que só é conhecida quando acaba.
// ativo: a rota pode atender. As duas rotas do Gemini são alternativas, então o botão só fica esgotado quando
// todas as rotas ativas estão em 100% (dockEsgotado); em GPT e Claude, qualquer janela em 100% bloqueia.
function dockSlot(nome,pct,texto,detalhe,ativo=true){return {nome,pct:Number.isFinite(pct)?pct:null,texto,detalhe,ativo};}
function geminiSlots(origins,now=Date.now()) {
  const studio=origins?.find(o=>o.id==='studio'),native=origins?.find(o=>o.id==='antigravity');
  let hoje=dockSlot('Hoje',null,'–','AI Studio · chave não configurada',false);
  if(studio?.connected) {
    const items=studio.items||[],reqs=items.reduce((s,i)=>s+(i.requests||0),0);
    // Pausa longa (cota diária) esgota o modelo; a de minutos (limite por minuto, 503) não descreve o dia.
    const pausados=(studio.paused||[]).filter(p=>Date.parse(p.until)-now>3600e3);
    const fora=new Set([...pausados.map(p=>p.model),...items.filter(i=>i.limit && i.requests>=i.limit).map(i=>i.model)]);
    // A rota só acaba quando todos os modelos gratuitos dela acabam. Sem a lista (estado antigo), usa os de hoje.
    const modelos=studio.models?.length?studio.models:[...new Set([...items.map(i=>i.model),...pausados.map(p=>p.model)])];
    const esgotada=modelos.length>0 && modelos.every(m=>fora.has(m));
    // Fora isso, o anel mostra o modelo com mais folga entre os de cota conhecida; um modelo esgotado não puxa para 100%.
    const folgas=items.filter(i=>i.limit && !fora.has(i.model)).map(i=>100*i.requests/i.limit);
    const pct=esgotada?100:folgas.length?Math.min(...folgas):null;
    const ate=m=>{const p=pausados.find(x=>x.model===m);return p?` esgotado até ${dateLabel(p.until)}`:'';};
    const partes=items.map(i=>`${i.model} ${i.requests}${i.limit?'/'+i.limit:''} req.${ate(i.model)}`)
      .concat(pausados.filter(p=>!items.some(i=>i.model===p.model)).map(p=>`${p.model}${ate(p.model)}`));
    hoje=dockSlot('Hoje',pct,pct===null?`${reqs} req`:`${Math.round(pct)}%`,
      `AI Studio hoje · ${partes.length?partes.join(' · '):'nenhuma requisição'}${pct===null?' · o Google só informa o tamanho da cota quando ela acaba':''}`);
  }
  const pausa=native?.paused?.[0];
  const conta=pausa?dockSlot('Conta',100,'100%',`Antigravity · cota da conta Google esgotada até ${dateLabel(pausa.until)}`)
    :dockSlot('Conta',null,'–',native?.connected?'Antigravity · conectado; a conta Google só informa a cota quando ela acaba':'Antigravity · conta Google não conectada',Boolean(native?.connected));
  return [hoje,conta];
}
function dockEsgotado(p,slots) {
  if(p!=='gemini')return slots.some(s=>s.pct>=100);
  const ativos=slots.filter(s=>s.ativo);
  return ativos.length>0 && ativos.every(s=>s.pct>=100);
}
function dockSlots(p) {
  if(p==='gemini')return geminiSlots(state.agents?.gemini?.origins);
  const ws=state.usage?.[p]?.windows||[];
  const maior=teste=>ws.filter(teste).sort((a,b)=>b.usedPercent-a.usedPercent)[0];
  const slot=(nome,w)=>w?dockSlot(nome,w.usedPercent,`${Math.round(w.usedPercent)}%`,`${w.label} ${Math.round(w.usedPercent)}%${w.resetsAt?' · renova '+dateLabel(w.resetsAt):''}`)
    :dockSlot(nome,null,'–',`${nome} · não informado`);
  return [slot('5 h',maior(w=>w.label==='5 horas')),slot('Semana',maior(w=>/^Semanal/.test(w.label)))];
}
function renderUsageDock() {
  const dock=$('usage-dock');if(!dock)return;
  dock.replaceChildren();
  for(const p of providers) {
    const slots=dockSlots(p),semUso=slots.every(s=>s.pct===null);
    // O nível fica em cada anel (não no botão), para a cor de um não passar para o outro.
    const item=element('button',`dock-item seat-${p}${semUso?' sem-uso':''}${dockEsgotado(p,slots)?' esgotado':''}${state.falando?.has(p)?' falando':''}`);item.type='button';
    const dial=element('span','usage-dial mini duplo');
    slots.forEach((s,i)=>{const anel=usageRing(`dock:${p}:${i}`,s.pct??0,34,3,i*5);anel.classList.add(s.pct===null?'sem-dado':'nivel-'+usageLevel(s.pct),i?'interno':'externo');dial.append(anel);});
    const vals=element('span','dock-vals');
    slots.forEach((s,i)=>{if(i)vals.append(element('i','','·'));vals.append(element('b',s.pct===null?'':'nivel-'+usageLevel(s.pct),s.texto));});
    item.append(dial,element('span','dock-nome',names[p]),vals);
    item.title=`${names[p]} · anel externo: ${slots[0].nome.toLowerCase()} · interno: ${slots[1].nome.toLowerCase()}\n`+slots.map(s=>s.detalhe).join('\n');
    item.setAttribute('aria-label',`${names[p]}: `+slots.map(s=>s.detalhe).join('; '));
    item.addEventListener('click',abrirPainelProjeto);
    dock.append(item);
  }
}
function pausedJob(){const job=state.jobs[0];return job && resumableStatuses.has(job.status)?job:null;}

function updateConnection(online) {
  state.connected = online;
  const connection = $('connection');
  connection.className = `connection ${online ? 'online' : 'offline'}`;
  connection.replaceChildren(element('span'), document.createTextNode(online ? 'Local · conectado' : 'Reconectando'));
}

function appendInline(parent, source) {
  // Never interpret HTML, model-authored attributes, or non-http link protocols.
  const expression = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\([^\s)]+\)|\*[^*\n]+\*)/g;
  let cursor = 0;
  for (const match of source.matchAll(expression)) {
    appendText(parent, source.slice(cursor, match.index));
    const token = match[0];
    if (token[0] === '`') parent.append(element('code', '', token.slice(1, -1)));
    else if (token.startsWith('**') || token.startsWith('__')) parent.append(element('strong', '', token.slice(2, -2)));
    else if (token[0] === '*') parent.append(element('em', '', token.slice(1, -1)));
    else {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
      let target;
      try { target = new URL(linkMatch[2]); } catch { target = null; }
      if (target && ['https:', 'http:'].includes(target.protocol)) {
        const link = element('a', '', linkMatch[1]);
        link.href = target.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        parent.append(link);
      } else parent.append(document.createTextNode(token));
    }
    cursor = match.index + token.length;
  }
  appendText(parent, source.slice(cursor));
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const old = button.textContent;
      button.textContent = 'Copiado';
      setTimeout(() => { if (button.isConnected) button.textContent = old; }, 1600);
    } else toast('Texto copiado.');
  } catch {
    toast('Não foi possível copiar. Selecione o texto e use Ctrl+C.');
  }
}

function markdown(text) {
  const fragment = document.createDocumentFragment();
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const isSpecial = (line) => /^\s*(```|~~~|#{1,6}\s|[-*+]\s|\d+[.)]\s|>|(?:---+|\*\*\*+)\s*$)/.test(line);
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^\s*(```|~~~)(.*)$/);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
      if (i < lines.length) i++;
      const block = element('div', 'code-block');
      const header = element('div', 'code-header');
      const button = element('button', 'copy-code', 'Copiar código');
      button.type = 'button';
      button.addEventListener('click', () => copy(code.join('\n'), button));
      header.append(element('span', '', fence[2].trim().slice(0, 60) || 'código'), button);
      const pre = element('pre');
      pre.append(element('code', '', code.join('\n')));
      block.append(header, pre);
      fragment.append(block);
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      const h = element(`h${Math.min(4, heading[1].length + 1)}`);
      appendInline(h, heading[2]);
      fragment.append(h);
      i++;
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { fragment.append(element('hr')); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]) && cells(lines[i + 1]).every((cell) => /^:?-{3,}:?$/.test(cell))) {
      const wrapper = element('div', 'table-scroll');
      const table = element('table');
      const head = element('thead');
      const headRow = element('tr');
      for (const cell of cells(line)) { const th = element('th'); appendInline(th, cell); headRow.append(th); }
      head.append(headRow);
      table.append(head);
      const body = element('tbody');
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const row = element('tr');
        for (const cell of cells(lines[i++])) { const td = element('td'); appendInline(td, cell); row.append(td); }
        body.append(row);
      }
      table.append(body);
      wrapper.append(table);
      fragment.append(wrapper);
      continue;
    }
    const unordered = /^\s*[-*+]\s+/.test(line);
    const ordered = /^\s*\d+[.)]\s+/.test(line);
    if (unordered || ordered) {
      const list = element(ordered ? 'ol' : 'ul');
      const expression = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      if (ordered) list.start = Number(line.trim().match(/^\d+/)[0]);
      while (i < lines.length && expression.test(lines[i])) {
        const li = element('li');
        appendInline(li, lines[i++].replace(expression, ''));
        list.append(li);
      }
      fragment.append(list);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = element('blockquote');
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        if (quote.childNodes.length) quote.append(element('br'));
        appendInline(quote, lines[i++].replace(/^\s*>\s?/, ''));
      }
      fragment.append(quote);
      continue;
    }
    const p = element('p');
    do {
      if (p.childNodes.length) p.append(element('br'));
      appendInline(p, lines[i++]);
    } while (i < lines.length && lines[i].trim() && !isSpecial(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])));
    fragment.append(p);
  }
  return fragment;
}

function messageNode(message, transient = false, fresh = false) {
  const role = Object.hasOwn(names, message.role) ? message.role : 'system';
  const article = element('article', `message role-${role}${transient ? ' transient' : ''}${fresh ? ' nova' : ''}`);
  if (message.id) article.dataset.messageId = message.id;
  const main = element('div', 'message-main');
  const heading = element('div', 'message-heading');
  heading.append(element('span', `seat seat-${role}`), element('strong', '', names[role]));
  if (message.createdAt) {
    const time = element('time', '', clock(message.createdAt));
    time.dateTime = message.createdAt;
    time.title = dateLabel(message.createdAt);
    heading.append(time);
  }
  if (providers.includes(role)) heading.append(element('span', 'message-company', companies[role]));
  if (message.debate?.stage && STAGE_LABELS[message.debate.stage]) heading.append(element('span', 'debate-stage', STAGE_LABELS[message.debate.stage]));
  if (transient) heading.append(element('span', 'message-badge ao-vivo', 'escrevendo'));
  if (message.model) { const badge=element('span','message-badge',providers.includes(role)?modelName(role,message.model):message.model); badge.title=message.model; heading.append(badge); }
  const content = element('div', 'message-content');
  content.append(markdown(message.content));
  main.append(heading);
  const quoted = replyTarget(message);
  if (quoted) {
    const quote = element('button', `reply-quote role-${quoted.role}${quoted.quote ? ' trecho' : ''}`);
    quote.type = 'button';
    quote.title = 'Ir para a mensagem respondida';
    quote.append(element('strong', '', `Respondendo a ${names[quoted.role] || 'mensagem'}${quoted.quote ? ' · trecho' : ''}`), element('span', '', quoted.quote ? `“${quoted.quote}”` : plainExcerpt(quoted.content || 'Mensagem removida.')));
    quote.addEventListener('click', () => irParaMensagem(quoted.id));
    main.append(quote);
  }
  main.append(content);
  if (!transient && role !== 'system') {
    const actions = element('div', 'message-actions');
    const button = element('button', 'copy-message');
    button.type = 'button';
    button.setAttribute('aria-label', `Copiar mensagem de ${names[role]}`);
    button.append(icon('copy'), document.createTextNode('Copiar'));
    button.addEventListener('click', () => copy(message.content));
    actions.append(button);
    if (message.id) {
      // Responder a esta mensagem; se houver texto selecionado dentro dela, a resposta cita exatamente esse trecho.
      const reply = element('button', 'copy-message reply-message');
      reply.type = 'button';
      reply.setAttribute('aria-label', `Responder à mensagem de ${names[role]}`);
      reply.title = 'Responder a esta mensagem. Selecione um trecho antes para citá-lo.';
      reply.append(icon('reply'), document.createTextNode('Responder'));
      let trecho = '';
      reply.addEventListener('pointerdown', () => { trecho = trechoSelecionado(content); });
      reply.addEventListener('click', () => { responderA(message, trecho || trechoSelecionado(content)); trecho = ''; });
      actions.append(reply);
    }
    if (['partial', 'interrupted', 'cancelled'].includes(message.status)) actions.append(element('span', 'message-partial', 'Resposta parcial'));
    main.append(actions);
  }
  article.append(main);
  return article;
}

// Mensagem a que esta fala responde: a última do participante citado na mesma rodada.
const plainExcerpt = (text, max = 320) => text.split('<mesa_status>')[0].replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
function irParaMensagem(id) {
  const target = $('messages').querySelector(`[data-message-id="${CSS.escape(id)}"]`);
  if (target) { target.scrollIntoView({behavior: MOVIMENTO ? 'smooth' : 'auto', block: 'center'}); target.classList.remove('destaque'); void target.offsetWidth; target.classList.add('destaque'); }
}
function trechoSelecionado(container) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return '';
  return sel.toString().replace(/\s+/g, ' ').trim().slice(0, 1200);
}
function responderA(message, quote = '') {
  state.replyTo = {id: message.id, role: message.role, roomId: state.selectedId, content: message.content, ...(quote ? {quote} : {})};
  renderReplyChip();
  window.getSelection()?.removeAllRanges();
  $('message-input').focus();
}
function cancelarResposta() { state.replyTo = null; renderReplyChip(); }
function renderReplyChip() {
  const chip = $('reply-chip');
  if (state.replyTo && state.replyTo.roomId !== state.selectedId) state.replyTo = null;
  const r = state.replyTo;
  chip.hidden = !r;
  $('composer-form').classList.toggle('respondendo', Boolean(r));
  if (!r) { chip.replaceChildren(); return; }
  chip.className = `reply-chip role-${r.role}`;
  const ir = element('button', 'reply-chip-text');
  ir.type = 'button';
  ir.title = 'Ir para a mensagem respondida';
  ir.append(icon('reply'), element('strong', '', `Respondendo a ${names[r.role]}${r.quote ? ' · trecho' : ''}`), element('span', '', r.quote ? `“${r.quote}”` : plainExcerpt(r.content, 180)));
  ir.addEventListener('click', () => irParaMensagem(r.id));
  const fechar = element('button', 'reply-chip-close', '×');
  fechar.type = 'button';
  fechar.setAttribute('aria-label', 'Cancelar resposta (Esc)');
  fechar.title = 'Cancelar resposta (Esc)';
  fechar.addEventListener('click', () => { cancelarResposta(); $('message-input').focus(); });
  chip.replaceChildren(ir, fechar);
}
function replyTarget(message) {
  if (message.reply?.id) {
    const alvo = state.messages.find((m) => m.id === message.reply.id);
    return {id: message.reply.id, role: message.reply.role || alvo?.role, content: alvo?.content || '', quote: message.reply.quote || ''};
  }
  const parent = message.debate?.parentRole;
  if (!parent || !message.jobId) return null;
  const index = message.id ? state.messages.findIndex((m) => m.id === message.id) : state.messages.length;
  for (let i = (index < 0 ? state.messages.length : index) - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.jobId === message.jobId && m.role === parent && m.content) return m;
  }
  return null;
}
// Escrita ao vivo. Os pedaços chegam em rajadas; o texto aparece em ritmo contínuo, como digitação, e só a
// mensagem que está sendo escrita é redesenhada (antes, a conversa inteira era refeita a cada 65 ms).
function liveNode(key,live) {
  const shown=Math.min(live.text.length,live.shown ?? live.text.length);
  const node=messageNode({role:live.role,content:live.text.slice(0,shown).split('<mesa_status>')[0],jobId:live.jobId,debate:live.stage?live:liveStage(live)},true);
  node.dataset.stream=key;node.dataset.shown=String(shown);
  return node;
}
let escritaFrame=null,escritaUltimo=0;
function agendarEscrita(){if(!escritaFrame)escritaFrame=requestAnimationFrame(passoEscrita);}
function passoEscrita(agora) {
  escritaFrame=null;
  if(agora-escritaUltimo<33){agendarEscrita();return;}
  escritaUltimo=agora;
  const container=$('conversation'),perto=container.scrollHeight-container.scrollTop-container.clientHeight<110;
  let pendente=false,estrutura=false;
  for(const [key,live] of state.streams) {
    if(live.roomId!==state.selectedId || !live.text)continue;
    const alvo=live.text.length,atual=live.shown ?? 0;
    live.shown=!MOVIMENTO || document.hidden?alvo:Math.min(alvo,atual+Math.max(4,Math.ceil((alvo-atual)/7)));
    if(live.shown<alvo)pendente=true;
    const node=[...$('messages').querySelectorAll('article.transient')].find(n=>n.dataset.stream===key);
    if(!node){estrutura=true;continue;}
    if(node.dataset.shown!==String(live.shown))node.replaceWith(liveNode(key,live));
  }
  if(estrutura){renderMessages();renderControls();}
  else if(perto)container.scrollTop=container.scrollHeight;
  if(pendente)agendarEscrita();
}
function marcarFalando() {
  state.falando=new Set([...state.streams.values()].filter(l=>l.roomId===state.selectedId && l.text).map(l=>l.role));
  for(const p of providers) for(const el of document.querySelectorAll(`.participant.role-${p}, .dock-item.seat-${p}`))el.classList.toggle('falando',state.falando.has(p));
}
function renderMessages(forceScroll = false) {
  const container = $('conversation');
  // Ao trocar de sala, a conversa anterior fica esmaecida até a nova chegar (sem piscar a tela inicial).
  if (state.loading && !state.messages.length && state.selectedId) { container.classList.add('trocando'); return; }
  container.classList.remove('trocando');
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 110;
  const wasEmpty = !$('empty-state').hidden;
  const fragment = document.createDocumentFragment();
  const primed = state.seenRoom === state.selectedId;
  for (const message of state.messages) {
    if (!message.content) continue;
    const fresh = MOVIMENTO && primed && message.id && !state.seen.has(message.id) && state.recentStream?.role !== message.role;
    fragment.append(messageNode(message, false, Boolean(fresh)));
  }
  if (primed) for (const message of state.messages) { if (message.id) state.seen.add(message.id); }
  else { state.seen = new Set(state.messages.map((message) => message.id).filter(Boolean)); state.seenRoom = state.selectedId; }
  state.recentStream = null;
  for(const [key,live] of state.streams) {
    if(live.roomId===state.selectedId && live.text)fragment.append(liveNode(key,live));
  }
  marcarFalando();
  const lastJob = state.jobs[0];
  if (lastJob && ['failed', 'interrupted', 'cancelled','waiting_capacity','paused_budget','paused_input'].includes(lastJob.status)) {
    const notice = element('div', 'round-notice');
    notice.setAttribute('role', 'status');
    notice.append(element('strong', '', statusText(lastJob)), element('p', '', lastJob.error || 'Envie outra mensagem para continuar.'));
    fragment.append(notice);
  }
  $('messages').replaceChildren(fragment);
  const isEmpty = state.messages.length === 0 && !state.streams.size;
  $('empty-state').hidden = !isEmpty;
  // Empty rooms start at the introduction, even when it needs scrolling on a
  // short viewport. Only actual conversations should follow the newest message.
  if (isEmpty) {
    if (forceScroll || !wasEmpty) container.scrollTop = 0;
    return;
  }
  if (forceScroll || nearBottom) requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
}

function renderActivity() {
  $('activity-count').textContent = state.jobs.length;
  const fragment = document.createDocumentFragment();
  const recent = [...state.jobs].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 6);
  if (!recent.length) fragment.append(element('p', 'activity-empty', 'O trabalho dos agentes aparecerá aqui.'));
  for (const job of recent) {
    const item = element('div', 'activity-item');
    item.append(element('span', `activity-indicator ${job.status}`));
    const detail = element('div');
    detail.append(element('strong', '', statusText(job)));
    const mode = ({chat:'Chat',code:'Code',debate:'Debate',build:'Construção',conversation:'Conversa'})[job.mode] || 'Rodada';
    const target = job.target === 'both' ? 'Codex + Claude' : job.target === 'auto' ? 'Equipe automática' : names[job.target] || 'Agentes';
    detail.append(element('p', '', `${mode} · ${target}`));
    detail.append(element('p', '', dateLabel(job.createdAt)));
    if (job.error) detail.append(element('p', 'activity-error', job.error));
    item.append(detail);
    fragment.append(item);
  }
  $('activity-list').replaceChildren(fragment);
}

function liveStage(live) {
  const job = state.jobs.find((j) => j.id === live.jobId);
  const round = job?.progress?.round;
  return round && job.progress.currentAgent === live.role ? {stage: job.progress.stage || null, parentRole: round.turns?.at(-1)?.agent || null} : null;
}
function canSteer(job) {
  return job?.progress?.liveDebate && job.progress.stage !== 'sintese' && !job.progress.round?.synthesized && ['queued','running'].includes(job.status) && (job.progress.completed || 0)+(job.progress.activeAgents?.length || 0)<job.totalSteps;
}
function renderControls() {
  const job = activeJob();
  const busy = Boolean(job) || state.sending;
  $('send-message').disabled = state.loading || state.sending || Boolean(job && !canSteer(job)) || !$('message-input').value.trim();
  $('message-input').disabled = state.loading;
  $('mode-select').disabled = state.loading || busy;
  $('target-select').disabled = state.loading || busy;
  $('mode-button').disabled = state.loading || busy || !state.room || Boolean(state.room?.archivedAt);
  $('export-room').disabled = !state.room;
  $('edit-brief').disabled = !state.room || busy;
  $('open-settings').disabled = !state.room || busy;
  $('change-workspace').disabled = !state.room || busy;
  $('edit-brief').title = busy ? 'O contexto pode ser editado quando a rodada terminar.' : 'Editar nome e contexto da sala';
  const paused=pausedJob();
  $('job-strip').hidden = !job && !paused;
  $('resume-job').hidden=!paused || Boolean(job);
  $('resume-job').disabled=state.sending;
  $('typing').hidden = !job || Boolean(state.streams.size);
  if (job) {
    const role = agentForJob(job), who = role ? names[role] : 'A equipe', tone = `role-${role || 'system'}`;
    $('typing').className = `typing-indicator ${tone}`;
    $('job-strip').className = `job-strip ${tone}`;
    $('typing-avatar').className = `seat seat-${role || 'system'}`;
    $('typing-avatar').textContent = '';
    const stage = job.progress?.round ? STAGE_LABELS[currentStage(job)] : null;
    const fila = (job.progress?.round?.queue || []).filter((p) => p !== role).map((p) => names[p]);
    $('typing-label').textContent = job.status === 'queued' ? 'A rodada está na fila' : role ? `${who} está ${stage ? stageVerb(currentStage(job)) : 'elaborando'}` : 'Escolhendo quem abre a rodada';
    const latest=state.events.find(e=>e.jobId===job.id && (!role || e.role===role) && e.activity?.tool!=='routing');
    $('typing-detail').textContent = job.status === 'queued' ? 'Começa assim que a rodada anterior terminar.' : [latest?.activity?.title, fila.length ? `depois: ${fila.join(' → ')}` : null].filter(Boolean).join(' · ') || 'A resposta aparece aqui enquanto é escrita.';
    $('job-label').textContent=job.status==='queued'?'Rodada na fila':stage?`${who} · ${stage}`:`${who} com a vez`;
    $('job-progress').textContent = job.totalSteps ? `${Math.max(1, job.step || 1)} de ${job.totalSteps}` : '';
    $('cancel-job').disabled = false;
  } else if(paused) {
    $('job-strip').className = 'job-strip role-system';
    $('job-label').textContent=statusText(paused);$('job-progress').textContent=`${paused.progress?.completed ?? paused.step} participações salvas`;
    $('cancel-job').disabled=false;
  }
  renderSteps(job || paused);
  $('cancel-job').textContent=job?'Interromper':'Encerrar tarefa';
  $('send-message').title=canSteer(job)?'Acrescentar orientação para a próxima participação':paused?'Enviar orientação e continuar':'Enviar mensagem (Enter)';
  const ordem = orderFor(state.lane).map((p) => names[p]);
  const citados = $('target-select').value === 'auto' || canSteer(job) ? mencoes($('message-input').value) : [];
  const nomesCitados = citados.map((p) => names[p]).join(' e ');
  $('mode-description').textContent = canSteer(job) && citados.length ? `${nomesCitados} ${citados.length > 1 ? 'respondem' : 'responde'} em seguida, fora da fila.`
    : canSteer(job) ? 'Sua mensagem entra na conversa e o próximo da fila responde a ela.'
    : citados.length === 1 && !job ? `Só ${nomesCitados} responde (menção), sem rodada em grupo.`
    : citados.length > 1 && !job ? `Só ${nomesCitados} respondem, nessa ordem (menção).`
    : state.room?.archivedAt ? 'Sala arquivada. Restaure pelo menu da sala para continuar.'
    : $('target-select').value !== 'auto' ? `Só ${names[$('target-select').value]} responde, sem rodada em grupo.`
    : state.lane === 'code' ? `${ordem[0]} implementa, ${ordem.slice(1).join(' e ')} revisam e testam · até ${state.room?.settings.maxSteps || 8} falas.`
    : `${ordem[0]} abre, ${ordem.slice(1).join(' e ')} analisam e ${ordem[0]} fecha com a síntese.`;
  const input=$('message-input').value;
  const practical=/\b(crie|criar|implemente|implementar|corrija|corrigir|construa|construir|desenvolva|gere)\b[\s\S]{0,100}\b(arquivo|aplicativo|aplicação|sistema|programa|site|código|script|automação|planilha)\b/i.test(input);
  const theoretical=/\b(explique|explicar|discuta|planeje|planejar|debata|conceito|teoria)\b/i.test(input) && !practical;
  const suggest=state.lane==='chat'&&practical?'code':state.lane==='code'&&theoretical?'chat':null;
  $('lane-suggestion').hidden=!suggest || busy;$('lane-suggestion').dataset.lane=suggest || '';
  $('lane-suggestion').textContent=suggest==='code'?'Vai criar arquivos? Mudar para Code':'Só planejamento? Mudar para Chat';
  renderModeSwitch();
  $('message-input').placeholder = canSteer(job) ? 'Escreva para a rodada: o próximo da fila lê sua mensagem' : state.lane === 'code' ? 'O que vamos construir nesta pasta?' : 'Que ideia vamos desenvolver juntos?';
  updateParticipants();
}

function currentStage(job) {
  const round = job?.progress?.round;
  if (!round) return null;
  if (job.progress.stage) return job.progress.stage;
  const role = agentForJob(job), turns = round.turns || [];
  if (round.lane === 'chat') return !turns.length ? 'abertura' : round.spoken?.includes(role) ? 'sintese' : 'analise';
  if (!round.lastChange) return 'implementacao';
  return role === round.lead ? (round.pass?.issues ? 'refino' : 'verificacao') : 'revisao';
}
function stageVerb(stage) {
  return ({replica:'respondendo à chamada',abertura:'abrindo a rodada',analise:'analisando',sintese:'fechando a síntese',implementacao:'implementando',revisao:'revisando e testando',refino:'aplicando as correções',verificacao:'verificando as mudanças'})[stage] || 'elaborando';
}
function orderFor(lane) {
  const settings = state.room?.settings;
  const order = settings?.[lane === 'code' ? 'codePreference' : 'chatPreference'] || (lane === 'code' ? ['claude','codex','gemini'] : ['codex','claude','gemini']);
  const ready = order.filter((p) => estadoAgente(p) !== 'fora');
  return ready.length ? ready : order;
}
function renderModeSwitch() {
  const lane = state.lane;
  const chat = orderFor('chat').map((p) => names[p]), code = orderFor('code').map((p) => names[p]);
  $('mode-name').textContent = lane === 'code' ? 'Code' : 'Chat';
  $('mode-lead').textContent = lane === 'code' ? `${code[0]} lidera` : `${chat[0]} abre`;
  $('mode-chat-order').textContent = `${chat[0]} abre · ${chat.slice(1).join(' e ')} analisam · ${chat[0]} sintetiza`;
  $('mode-code-order').textContent = `${code[0]} implementa · ${code.slice(1).join(' e ')} revisam · ${code[0]} refina`;
  for (const item of $('mode-menu').querySelectorAll('[data-mode]')) item.setAttribute('aria-checked', String(item.dataset.mode === lane));
  $('mode-button').dataset.mode = lane;
}
function renderRoom() {
  $('room-title').textContent = state.room?.title || 'Synapse';
  document.title = state.room ? `${state.room.title} · Synapse` : 'Synapse';
  $('barra-sala').textContent = state.room?.title || '';
  $('room-brief').textContent = state.room?.brief || 'Defina o objetivo e as restrições do projeto. Esse contexto acompanha os três agentes em cada rodada.';
  $('room-brief').className = `brief-text${state.room?.brief ? ' has-brief' : ''}`;
  renderRooms();
  renderMessages();
  renderActivity();
  renderControls();
  renderSettingsSummary();
  renderTools();
  renderMemory();renderApprovals();renderCapabilities();renderSessions();
  renderReplyChip();
}

async function loadRoom(id, forceScroll = false) {
  const sequence = ++state.roomRequest;
  const data = await api(`/api/rooms/${encodeURIComponent(id)}`);
  if (sequence !== state.roomRequest || id !== state.selectedId) return;
  const swap = state.switching === id;
  state.switching = null;
  const apply = () => applyRoom(id, data, forceScroll);
  // A transição é só enfeite: com a aba oculta ou lenta, o navegador pode abortá-la, e isso não é erro.
  if (swap && MOVIMENTO && !document.hidden && document.startViewTransition) {
    const transicao = document.startViewTransition(apply);
    transicao.ready.catch(() => {}); transicao.finished.catch(() => {});
    await transicao.updateCallbackDone.catch(() => {});
  } else apply();
}
function applyRoom(id, data, forceScroll) {
  state.room = data.room;
  state.messages = data.messages || [];
  state.jobs = data.jobs || [];
  const current=state.jobs.find(j=>activeStatuses.has(j.status));
  state.lane = data.room?.settings?.mode === 'code' ? 'code' : 'chat';
  if(current) {state.lane=['code','build'].includes(current.mode)?'code':'chat';if(providers.includes(current.target)||current.target==='auto')$('target-select').value=current.target;}
  $('mode-select').value=state.lane;
  state.events = data.events || [];
  state.sessions=data.sessions || [];state.checkpoints=data.checkpoints || [];state.approvals=data.approvals || [];
  // A resposta ao vivo só sai de cena quando a mensagem final dela foi salva ou a tarefa parou.
  for(const [key,live] of state.streams) {
    const saved=state.messages.some(m=>m.jobId===live.jobId && m.role===live.role && (live.turnId?m.debate?.turnId===live.turnId:!live.known.has(m.id)));
    if(saved || !state.jobs.some(j=>j.id===live.jobId && activeStatuses.has(j.status)))state.streams.delete(key);
  }
  state.loading = false;
  state.activeJobs = state.activeJobs.filter((job) => job.roomId !== id).concat(state.jobs.filter((job) => activeStatuses.has(job.status)));
  renderRoom();
  if (forceScroll) renderMessages(true);
  if (state.panel==='files') {void refreshFiles().catch(showError);void refreshVersions().catch(showError);}
}

async function selectRoom(id) {
  if (id === state.selectedId && state.room) return;
  if (state.selectedId) state.drafts.set(state.selectedId, $('message-input').value);
  state.selectedId = id;
  state.room = state.rooms.find((room) => room.id === id) || null;
  state.messages = [];
  state.jobs = [];
  state.events = [];
  state.sessions=[];state.checkpoints=[];state.approvals=[];
  state.lane = state.room?.settings?.mode === 'code' ? 'code' : 'chat';
  $('mode-select').value=state.lane;
  state.filePath = '';
  state.fileRequest++;
  state.streams.clear();
  state.loading = true;
  state.switching = state.seenRoom ? id : null;
  $('message-input').value = state.drafts.get(id) || '';
  resizeComposer();
  renderRoom();
  try {
    rememberRoom(id);
    await loadRoom(id, true);
  } catch (error) { state.loading = false; renderControls(); showError(error); }
}

async function refreshBootstrap() {
  const data = await api('/api/bootstrap');
  state.csrfToken = data.csrfToken;
  state.rooms = data.rooms || [];
  state.agents = data.agents || {};
  state.activeJobs = data.activeJobs || [];
  state.models = data.models || {};
  state.integrations=data.integrations || [];
  if(data.accounts)state.accounts=data.accounts;
  if($('settings-dialog').open)for(const p of providers){
    const select=$(p+'-model');
    if(select.value!=='custom'){
      const effort=$(p+'-effort').value;
      fillModels(p,select.value);fillEffort(p,effort);
    }
  }
  renderRooms();
  renderAgents();
  renderControls();
}

function connectEvents() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/events');
  eventSource.onopen = () => {
    updateConnection(true);
    scheduleRefresh();
  };
  eventSource.onerror = () => updateConnection(false);
  eventSource.addEventListener('update', (event) => {
    try { const data = JSON.parse(event.data); if (data.type === 'room-deleted' && data.roomId === state.selectedId) { state.selectedId = null; state.room = null; } } catch {}
    scheduleRefresh();
  });
  // Falha do login do Google: o diálogo de contas já mostra o motivo quando está aberto.
  eventSource.addEventListener('provider-error',event=>{try{const data=JSON.parse(event.data);if(!(contaAberta===data.agent && $('account-dialog').open))showError(data.message);}catch{}});
  eventSource.addEventListener('account',event=>{try{aoMudarConta(JSON.parse(event.data));}catch{}});
  eventSource.addEventListener('activity', event => {
    let item; try {item=JSON.parse(event.data);} catch{return;}
    if(item.roomId!==state.selectedId) return;
    if(!state.events.some(e=>e.id===item.id)) state.events.unshift(item);
    state.events=state.events.slice(0,100);
    renderTools(); renderControls();
  });
  eventSource.addEventListener('delta', (event) => {
    let delta;
    try { delta = JSON.parse(event.data); } catch { return; }
    if (delta.roomId !== state.selectedId || typeof delta.text !== 'string') return;
    const key=delta.turnId || delta.jobId+'-'+delta.role;
    if(!state.streams.has(key))state.streams.set(key,{...delta,text:'',shown:0,known:new Set(state.messages.map(m=>m.id))});
    const live=state.streams.get(key);
    const antes=live.text.length;
    live.text=(live.text+delta.text).slice(-120000);
    if(live.text.length<antes+delta.text.length)live.shown=Math.max(0,live.shown-(antes+delta.text.length-live.text.length));
    agendarEscrita();
  });
}

function scheduleRefresh() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(async () => {
    try {
      await refreshBootstrap();
      if (state.selectedId && !state.rooms.some((room) => room.id === state.selectedId)) { state.selectedId = null; state.room = null; }
      if (!state.selectedId) {
        const next = state.rooms.find((room) => !room.archivedAt);
        if (next) await selectRoom(next.id); else { state.loading = false; renderRoom(); }
      } else await loadRoom(state.selectedId);
      if (typeof Analises !== 'undefined') Analises.aoAtualizar();
    } catch (error) { showError(error); }
  }, 180);
}

function resizeComposer() {
  const input = $('message-input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(180, Math.max(70, input.scrollHeight))}px`;
}

async function submitMessage(event) {
  event.preventDefault();
  const content = $('message-input').value.trim();
  const current=activeJob();
  if (!content || state.sending || state.loading || (current && !canSteer(current))) return;
  state.sending = true;
  renderControls();
  const originalRoom = state.selectedId;
  const target = $('target-select').value;
  const mode = $('mode-select').value;
  try {
    if (!state.selectedId) {
      const title = content.split('\n')[0].slice(0, 65);
      const created = await api('/api/rooms', {method: 'POST', body: JSON.stringify({title, brief: ''})});
      state.rooms.unshift(created.room);
      state.selectedId = created.room.id;
      state.room = created.room;
      rememberRoom(created.room.id);
    }
    const roomId = state.selectedId;
    const paused=pausedJob();
    const replyTo = state.replyTo?.roomId === roomId ? {id: state.replyTo.id, ...(state.replyTo.quote ? {quote: state.replyTo.quote} : {})} : undefined;
    const data = await api(current?'/api/jobs/'+current.id+'/steer':paused?`/api/jobs/${paused.id}/resume`:`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: 'POST', body: JSON.stringify(current || paused?{content, replyTo}:{content, target, mode, replyTo}),
    });
    state.drafts.delete(roomId);
    if (replyTo && state.replyTo?.id === replyTo.id) cancelarResposta();
    if (state.selectedId === roomId) {
      if (data.message && !state.messages.some(m=>m.id===data.message.id)) state.messages.push(data.message);
      if (data.job) { state.jobs.unshift(data.job); state.activeJobs.push(data.job); }
      $('message-input').value = '';
      resizeComposer();
      renderRoom();
      renderMessages(true);
      $('message-input').focus();
    }
    await refreshBootstrap();
    if (state.selectedId === roomId) await loadRoom(roomId, true);
  } catch (error) {
    if (!state.selectedId && originalRoom) state.selectedId = originalRoom;
    showError(error);
  } finally {
    state.sending = false;
    renderControls();
  }
}

function openNewRoom() {
  $('new-room-title').value = '';
  $('new-room-brief').value = '';
  $('room-dialog').showModal();
  $('new-room-title').focus();
}

$('new-room').addEventListener('click', openNewRoom);
$('composer-form').addEventListener('submit', submitMessage);
$('message-input').addEventListener('input', () => { resizeComposer(); renderControls(); sugerirMencao(); });
$('message-input').addEventListener('blur', () => setTimeout(fecharMencao, 120));
$('message-input').addEventListener('keydown', (event) => {
  if (teclaDaMencao(event)) return;
  if (event.key === 'Escape' && state.replyTo) { event.preventDefault(); event.stopPropagation(); cancelarResposta(); return; }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('composer-form').requestSubmit();
  }
});
for (const control of [$('target-select'), $('mode-select')]) control.addEventListener('change', renderControls);
$('dismiss-error').addEventListener('click', () => { $('error-banner').hidden = true; });
$('toggle-details').addEventListener('click', () => {
  if (painelFixo()) { layout.painelRecolhido = !layout.painelRecolhido; saveLayout(); return; }
  setDrawer(document.body.dataset.drawer === 'details' ? null : 'details');
});
$('toggle-rooms').addEventListener('click', () => setDrawer(document.body.dataset.drawer === 'rooms' ? null : 'rooms'));
$('close-details').addEventListener('click', () => { if (painelFixo()) { layout.painelRecolhido = true; saveLayout(); } else setDrawer(null); });
$('veu').addEventListener('click', () => setDrawer(null));

document.querySelectorAll('.starter').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.lane) setLane(button.dataset.lane);
    $('message-input').value = button.dataset.prompt;
    resizeComposer();
    renderControls();
    $('message-input').focus();
  });
});

document.querySelectorAll('[data-close]').forEach((button) => {
  button.addEventListener('click', () => $(button.dataset.close).close());
});
document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
});

$('room-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = $('new-room-title').value.trim();
  if (!title) return;
  const submit = $('create-room-submit');
  submit.disabled = true;
  try {
    const data = await api('/api/rooms', {method: 'POST', body: JSON.stringify({title, brief: $('new-room-brief').value.trim(),settings:{access:$('new-room-project').checked?'project':'chat',internet:$('new-room-project').checked}})});
    state.rooms.unshift(data.room);
    $('room-dialog').close();
    await selectRoom(data.room.id);
    $('message-input').focus();
  } catch (error) { showError(error); $('room-dialog').close(); }
  finally { submit.disabled = false; }
});

$('edit-brief').addEventListener('click', () => {
  if (!state.room) return;
  $('edit-room-title').value = state.room.title;
  $('edit-room-brief').value = state.room.brief || '';
  $('brief-dialog').showModal();
  $('edit-room-brief').focus();
});

$('brief-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.room) return;
  const roomId = state.room.id;
  const title = $('edit-room-title').value.trim();
  if (!title) return;
  $('save-brief-submit').disabled = true;
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(roomId)}`, {method: 'PATCH', body: JSON.stringify({title, brief: $('edit-room-brief').value.trim()})});
    state.rooms = state.rooms.map((room) => room.id === roomId ? data.room : room);
    if (state.selectedId === roomId) state.room = data.room;
    $('brief-dialog').close();
    renderRoom();
    toast('Contexto salvo para as próximas rodadas.');
  } catch (error) { showError(error); $('brief-dialog').close(); }
  finally { $('save-brief-submit').disabled = false; }
});

$('cancel-job').addEventListener('click', async () => {
  const job = activeJob() || pausedJob();
  if (!job) return;
  $('cancel-job').disabled = true;
  try {
    await api(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, {method: 'POST', body: JSON.stringify({})});
    state.streams.clear();
    if (state.selectedId === job.roomId) await loadRoom(job.roomId);
    toast('Interrupção solicitada.');
  } catch (error) { showError(error); }
  finally { renderControls(); }
});

$('export-room').addEventListener('click', () => {
  if (!state.room) return;
  const link = element('a');
  link.href = `/api/rooms/${encodeURIComponent(state.room.id)}/export`;
  link.download = `${state.room.title.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 70) || 'conversa'}.md`;
  document.body.append(link);
  link.click();
  link.remove();
});

document.addEventListener('keydown', (event) => {
  const active = document.activeElement;
  if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey && !event.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(active?.tagName) && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    openNewRoom();
  }
  if (event.key === 'Escape' && !document.querySelector('dialog[open]')) setDrawer(null);
});

window.addEventListener('beforeunload', () => { if (eventSource) eventSource.close(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.csrfToken) scheduleRefresh(); });

const accessNames={chat:'Só conversa',project:'Projeto',computer:'Computador'};
// Nome oficial do modelo salvo na sala; IDs antigos com sufixo de raciocínio caem no modelo base.
function findModel(provider,id) {
  const rows=state.models[provider] || [];
  if(!id) return null;
  const direct=rows.find(m=>m.id===id);
  if(direct || provider!=='gemini') return direct || null;
  const base=String(id).replace(/-(minimal|low|medium|high|xhigh|max)$/i,'');
  return rows.find(m=>m.id===base) || null;
}
function prettyModel(provider,id) {
  const raw=String(id).replace(/^api:/,'').replace(/-(minimal|low|medium|high|xhigh|max)$/i,'');
  const words=raw.split('-').filter(w=>!/^\d{8}$/.test(w)).map(w=>/^\d/.test(w)?w:w.charAt(0).toUpperCase()+w.slice(1));
  if(provider==='codex' && /^gpt$/i.test(words[0])) return `GPT-${words[1] || ''} ${words.slice(2).join(' ')}`.trim();
  if(provider==='claude' && /^claude$/i.test(words[0])) return `Claude ${words[1] || ''} ${words.slice(2).join('.')}`.trim().replace(/\[1m\]/i,' · 1M de contexto');
  return words.join(' ').replace('Flash Lite','Flash-Lite');
}
const modelName=(provider,id)=>!id || id==='auto' ? (provider==='gemini'?'Automático':'Padrão da conta') : findModel(provider,id)?.label || prettyModel(provider,id);
function effortName(provider,settings) {
  const value=settings?.[`${provider}Effort`];
  return value ? effortLabel(provider,value) : null;
}
function renderSettingsSummary() {
  const settings=state.room?.settings || {};
  $('access-summary').textContent=accessNames[settings.access] || 'Só conversa';
  $('models-summary').textContent=providers.map(p=>{const id=settings[`${p}Model`];return !id || id==='auto'?`${names[p]} ${p==='gemini'?'automático':'padrão'}`:modelName(p,id);}).join(' · ');
  $('web-summary').textContent=settings.internet?'Web ligada':'Web desligada';$('web-summary').classList.toggle('ligada',Boolean(settings.internet));
  for(const provider of providers) {
    const effort=effortName(provider,settings);
    $(`${provider}-model-label`).textContent=modelName(provider,settings[`${provider}Model`])+(effort?` · ${effort}`:'');
  }
  $('workspace-path').textContent=state.room?.workspacePath || 'Pasta própria da sala';
  $('capabilities-note').textContent=state.lane==='chat'?'No modo Chat a equipe discute e decide, sem alterar arquivos. Mude para Code para trabalhar na pasta.':({chat:'Habilite Projeto nas configurações para criar arquivos.',project:'Arquivos e comandos nesta pasta. Pedidos de aprovação aparecem na Synapse.',computer:'Automações por comandos. Acesso adicional requer a aprovação solicitada pelo cliente.'})[settings.access] || '';
}
function renderTools() {
  $('tool-count').textContent=state.events.length;
  const fragment=document.createDocumentFragment();
  if(!state.events.length) fragment.append(element('p','activity-empty','Leituras, alterações, comandos e pesquisas aparecerão aqui durante o trabalho.'));
  for(const event of state.events.slice(0,60)) {
    const activity=event.activity || {},row=element('div','tool-item'),heading=element('div','tool-heading');
    const title=activity.tool==='command_execution' && activity.status!=='running'
      ? activity.status==='failed'?'Comando não concluído':'Comando concluído':activity.title || 'Atividade';
    heading.append(element('span',`activity-indicator ${activity.status || 'info'}`),element('span','',title));
    row.append(heading,element('div','tool-meta',`${names[event.role] || event.role} · ${clock(event.createdAt)}`));
    if(activity.detail) {
      const details=element('details','tool-details');
      details.append(element('summary','','Ver detalhes'),element('code','',activity.detail));
      row.append(details);
    }
    fragment.append(row);
  }
  $('tool-list').replaceChildren(fragment);
}
function showPanel(panel) {
  state.panel=panel;
  for(const item of ['context','files','activity','memory']) {
    $(`panel-${item}`).hidden=item!==panel;
    $(`tab-${item}`).classList.toggle('active',item===panel);
    $(`tab-${item}`).setAttribute('aria-selected',String(item===panel));
  }
  moveInk($('panel-ink'), $(`tab-${panel}`));
  if(panel==='files') {void refreshFiles().catch(showError);void refreshVersions().catch(showError);}
}
for(const tab of document.querySelectorAll('[data-panel]')) tab.addEventListener('click',()=>showPanel(tab.dataset.panel));
function fillModels(provider,value) {
  const select=$(`${provider}-model`);
  select.replaceChildren();
  const button=element('button');button.type='button';button.append(element('selectedcontent'));select.append(button);
  const rows=[...(state.models[provider] || [])];
  const saved=findModel(provider,value);
  if(saved) value=saved.id;
  const automatic={id:provider==='gemini'?'auto':'',label:provider==='gemini'?'Automático':'Padrão da conta',availability:'auto',hint:provider==='gemini'?'Chat pelo Hydrogen (AI Studio); Projeto e Computador pelo Antigravity. Se um esgotar, o outro assume':'O modelo padrão do cliente oficial'};
  const states={unknown:'a verificar',locked:'indisponível na conta',cooldown:'em pausa'};
  const option=model=>{
    const item=element('option');item.value=model.id;
    const availability=model.availability || 'unknown';
    item.disabled=['locked','cooldown'].includes(availability);
    item.title=[model.tier,model.source].filter(Boolean).join(' · ');
    item.append(element('span','model-label',model.label));
    const note=model.hint || states[availability];
    if(note) item.append(element('small','model-state',note));
    return item;
  };
  select.append(option(automatic));
  const groups=new Map();
  for(const model of rows) {const key=model.group || ''; if(!groups.has(key))groups.set(key,[]); groups.get(key).push(model);}
  for(const [label,models] of groups) {
    if(groups.size>1 && label) {const group=element('optgroup');group.label=label;models.forEach(m=>group.append(option(m)));select.append(group);}
    else models.forEach(m=>select.append(option(m)));
  }
  if(value && value!==automatic.id && !rows.some(m=>m.id===value)) select.append(option({id:value,label:prettyModel(provider,value),availability:'unknown',hint:'salvo na sala, fora do catálogo atual'}));
  const custom=element('option','','Outro modelo…');custom.value='custom';select.append(custom);
  const known=[...select.querySelectorAll('option')].some(o=>o.value===(value||automatic.id) && o.value!=='custom');
  select.value=known?(value||automatic.id):'custom';
  $(`${provider}-custom`).value=known?'':value || '';
  $(`${provider}-custom`).hidden=known;
  $(`${provider}-custom`).required=!known;
}
// Níveis de raciocínio oferecidos pelo modelo escolhido, como no aplicativo oficial de cada um.
function fillEffort(provider,value) {
  const select=$(`${provider}-effort`);
  const chosen=$(`${provider}-model`).value;
  const model=provider==='codex' && !chosen?(state.models.codex || []).find(m=>m.isDefault && m.availability!=='locked'):findModel(provider,chosen);
  const studio=provider==='gemini' && (chosen==='auto' || String(chosen).startsWith('api:'));
  const studioLevels=['auto','api:gemini-4-hydrogen'].includes(chosen)?['low','medium','high','xhigh']:['minimal','low','medium','high'];
  const levels=model?.efforts?.length?model.efforts:studio?studioLevels:[...new Set([...PROVIDER_EFFORTS[provider],value].filter(Boolean))];
  const sorted=[...levels].sort((a,b)=>EFFORT_ORDER.indexOf(a)-EFFORT_ORDER.indexOf(b));
  select.replaceChildren();
  select.disabled=model?.supportsEffort===false;
  if(select.disabled) {
    const item=element('option','','Modelo sem ajuste de esforço');item.value='';select.append(item);
    return;
  }
  const fallback=element('option','',`Padrão do modelo${model?.defaultEffort?` (${effortLabel(provider,model.defaultEffort)})`:''}`);fallback.value='';select.append(fallback);
  for(const level of sorted){const item=element('option','',effortLabel(provider,level));item.value=level;select.append(item);}
  if(value && !sorted.includes(value)) {
    // Nível salvo que este modelo não oferece: mostra o mais próximo, que é o que a participação vai usar.
    const target=EFFORT_ORDER.indexOf(value);
    value=[...sorted].sort((a,b)=>Math.abs(EFFORT_ORDER.indexOf(a)-target)-Math.abs(EFFORT_ORDER.indexOf(b)-target) || EFFORT_ORDER.indexOf(b)-EFFORT_ORDER.indexOf(a))[0] || '';
  }
  select.value=value || '';
}
function explainAccess() {
  $('access-help').textContent=({chat:'Permite texto e pesquisa opcional. Code requer acesso ao projeto.',project:'No modo Code, cria e edita arquivos e executa verificações. Pedidos de aprovação dos clientes aparecem aqui.',computer:'No modo Code, permite solicitar automações fora da pasta quando necessárias ao pedido. Os clientes mantêm seus controles de acesso. Controle visual depende de uma ferramenta conectada.'})[$('access-mode').value];
}
function openSettings() {
  if(!state.room || activeJob()) return;
  const s=state.room.settings;
  for(const provider of providers) {fillModels(provider,s[`${provider}Model`]);fillEffort(provider,s[`${provider}Effort`] || (findModel(provider,s[`${provider}Model`])?.variants?String(s[`${provider}Model`]).match(/-(minimal|low|medium|high|xhigh|max)$/i)?.[1]?.toLowerCase():''));}
  $('code-preference').value=s.codePreference.join(',');$('chat-preference').value=s.chatPreference.join(',');
  $('studio-rounds').value=s.studioToolRounds ?? 6;
  $('handoff-percent').value=s.handoffPercent;$('max-steps').value=s.maxSteps;$('auto-resume').checked=s.autoResume;$('auto-approve').checked=s.autoApprove===true;$('full-integration').checked=s.fullIntegration===true;
  for(const key of ['rea','browser','github'])$(`${key}-enabled`).checked=s[`${key}Enabled`];
  $('access-mode').value=s.access;$('workspace-input').value=s.workspace;
  $('internet-enabled').checked=s.internet;$('timeout-minutes').value=s.timeoutMinutes;$('tool-call-limit').value=s.toolCallLimit ?? 80;
  mcpSala={excluir:new Set(s.mcpExclude || []),lista:null};renderUserMcp();void carregarUserMcp(state.room.id);
  $('settings-dialog').dataset.roomId=state.room.id;
  $('settings-error').hidden=true;explainAccess();$('settings-dialog').showModal();
}
$('open-settings').addEventListener('click',openSettings);
$('change-workspace').addEventListener('click',openSettings);
$('access-mode').addEventListener('change',()=>{explainAccess();renderUserMcp();});
// Servidores MCP do usuário por sala (1.6): só aparecem com a integração total no Projeto ou no Computador.
let mcpSala={excluir:new Set(),lista:null};
async function carregarUserMcp(roomId) {
  try{const {servers}=await api(`/api/integrations/user-mcp?roomId=${encodeURIComponent(roomId)}`);if($('settings-dialog').dataset.roomId===roomId){mcpSala.lista=servers || [];renderUserMcp();}}
  catch{mcpSala.lista=[];renderUserMcp();}
}
function renderUserMcp() {
  const box=$('user-mcp'),list=$('user-mcp-list');
  const visivel=$('full-integration').checked && $('access-mode').value!=='chat' && Array.isArray(mcpSala.lista) && mcpSala.lista.length>0;
  box.hidden=!visivel;if(!visivel)return;
  list.replaceChildren();
  for(const server of mcpSala.lista) {
    const label=document.createElement('label');label.className='checkbox-row user-mcp-item';
    const input=document.createElement('input');input.type='checkbox';input.dataset.name=server.name;
    const ligadaPelaSala=server.integration?$(`${server.integration}-enabled`)?.checked!==false:true;
    input.checked=ligadaPelaSala && !mcpSala.excluir.has(server.name);input.disabled=!ligadaPelaSala;
    input.addEventListener('change',()=>{if(input.checked)mcpSala.excluir.delete(server.name);else mcpSala.excluir.add(server.name);});
    const texto=document.createElement('span');
    const nome=document.createElement('strong');nome.textContent=server.name;
    const onde=document.createElement('small');onde.textContent=' · '+server.clients.map(c=>c==='claude'?'Claude Code':'Codex').join(' e ')+(server.integration && !ligadaPelaSala?` · segue a opção ${({rea:'REA',browser:'Navegador isolado',github:'GitHub público'})[server.integration] || server.integration} desligada acima`:'');
    texto.append(nome,onde);label.append(input,texto);list.append(label);
  }
}
for(const id of ['full-integration','rea-enabled','browser-enabled','github-enabled'])$(id).addEventListener('change',renderUserMcp);
for(const provider of providers) $(`${provider}-model`).addEventListener('change',()=>{
  const custom=$(`${provider}-model`).value==='custom';
  $(`${provider}-custom`).hidden=!custom;$(`${provider}-custom`).required=custom;
  fillEffort(provider,$(`${provider}-effort`).value);
  if(custom) $(`${provider}-custom`).focus();
});
$('settings-form').addEventListener('submit',async event=>{
  event.preventDefault();const roomId=$('settings-dialog').dataset.roomId;
  const settings={access:$('access-mode').value,workspace:$('workspace-input').value.trim(),internet:$('internet-enabled').checked,timeoutMinutes:Number($('timeout-minutes').value)};
  for(const provider of providers) {
    settings[`${provider}Model`]=$(`${provider}-model`).value==='custom'?$(`${provider}-custom`).value.trim():$(`${provider}-model`).value;
    settings[`${provider}Effort`]=$(`${provider}-effort`).value;
  }
  if(settings.access==='chat' && state.lane==='code') settings.mode='chat';
  settings.studioToolRounds=Number($('studio-rounds').value);
  settings.codePreference=$('code-preference').value.split(',');settings.chatPreference=$('chat-preference').value.split(',');settings.handoffPercent=Number($('handoff-percent').value);settings.maxSteps=Number($('max-steps').value);settings.autoResume=$('auto-resume').checked;settings.autoApprove=$('auto-approve').checked;settings.fullIntegration=$('full-integration').checked;
  for(const key of ['rea','browser','github'])settings[`${key}Enabled`]=$(`${key}-enabled`).checked;
  settings.toolCallLimit=Number($('tool-call-limit').value);
  // Mantém nomes que não apareceram nesta leitura (servidor removido temporariamente das configurações).
  settings.mcpExclude=[...mcpSala.excluir].filter(name=>/^[A-Za-z0-9_.-]{1,64}$/.test(name));
  $('save-settings').disabled=true;$('settings-error').hidden=true;
  try {
    const {room}=await api(`/api/rooms/${roomId}`,{method:'PATCH',body:JSON.stringify({settings})});
    state.rooms=state.rooms.map(r=>r.id===roomId?room:r);
    if(state.selectedId===roomId) {state.room=room;state.filePath='';}
    $('settings-dialog').close();renderRoom();toast('Configurações salvas para a próxima rodada.');
  } catch(error){$('settings-error').textContent=error.message;$('settings-error').hidden=false;}
  finally{$('save-settings').disabled=false;}
});
let folderState,folderSequence=0;
// O modo é uma propriedade da sala: muda o propósito, quem lidera e o que os agentes podem fazer.
async function setLane(lane) {
  if(!['chat','code'].includes(lane) || !state.room || activeJob() || state.room.archivedAt) return;
  closeMenus();
  if(lane===state.lane) return;
  const settings={mode:lane};
  if(lane==='code' && state.room.settings.access==='chat') {
    const ok=await confirmar({titulo:'Liberar a pasta para o modo Code?',texto:'No modo Code os agentes criam e alteram arquivos e executam verificações na pasta desta sala. Cada pedido de acesso dos clientes continua aparecendo para você aprovar.',acao:'Liberar e usar Code',perigo:false});
    if(!ok) return;
    settings.access='project';
  }
  const previous=state.lane;
  state.lane=lane;$('mode-select').value=lane;renderControls();
  try {
    const {room}=await api(`/api/rooms/${state.room.id}`,{method:'PATCH',body:JSON.stringify({settings})});
    state.rooms=state.rooms.map(r=>r.id===room.id?room:r);state.room=room;
    renderSettingsSummary();renderSessions();renderCapabilities();renderControls();
    toast(lane==='code'?'Modo Code: a equipe trabalha nos arquivos da sala.':'Modo Chat: ideias e decisões, sem alterar arquivos.');
  } catch(error) {state.lane=previous;$('mode-select').value=previous;renderControls();showError(error);}
}

$('lane-suggestion').addEventListener('click',()=>setLane($('lane-suggestion').dataset.lane));
$('resume-job').addEventListener('click',async()=>{
  const job=pausedJob();if(!job)return;
  if(job.status==='paused_input' && !$('message-input').value.trim()) {$('message-input').focus();toast('Escreva sua orientação e envie para continuar.');return;}
  $('resume-job').disabled=true;
  try{await api(`/api/jobs/${job.id}/resume`,{method:'POST',body:JSON.stringify({content:$('message-input').value.trim()})});$('message-input').value='';await loadRoom(job.roomId);}
  catch(error){showError(error);}finally{renderControls();}
});
$('refresh-agents').addEventListener('click',async()=>{
  $('refresh-agents').disabled=true;
  try{await api('/api/agents');await refreshBootstrap();renderSessions();renderCapabilities();toast('Disponibilidade atualizada.');}catch(error){showError(error);}finally{$('refresh-agents').disabled=false;}
});
// Contas oficiais (1.6): cada participante tem o botão Conectar/Reconectar. O login roda pelo cliente oficial;
// a Synapse só abre a página do fornecedor, repassa o código colado (Claude) e acompanha o resultado.
const CONTAS={
  codex:{titulo:'Conectar GPT',cliente:'Codex',conta:'ChatGPT',intro:'O login é feito pelo Codex, o cliente oficial da OpenAI, com a sua conta ChatGPT. A Synapse não vê sua senha nem o token.'},
  claude:{titulo:'Conectar Claude',cliente:'Claude Code',conta:'Claude',intro:'O login é feito pelo Claude Code, o cliente oficial da Anthropic, com a sua assinatura Claude. A Synapse não vê sua senha nem o token.'},
  gemini:{titulo:'Conectar Gemini',cliente:'Antigravity',conta:'Google',intro:'O login é feito pelo Antigravity, o cliente oficial do Google, com a sua conta Google. A chave do AI Studio continua separada e não muda.'},
};
let contaAberta=null;const paginasAbertas=new Set();
const contaDe=agent=>state.accounts?.[agent] || {agent,status:'idle'};
function precisaConectar(agent) {
  const a=state.agents[agent];
  if(!a || a.loading)return false;
  if(agent==='gemini')return !a.nativeConnected;
  return !a.authenticated && !(a.blocked && ['free','restricted'].includes(a.plan));
}
function renderAccountButtons() {
  for(const agent of providers) {
    const button=$(`${agent}-connect`);if(!button)continue;
    const a=state.agents[agent],conta=contaDe(agent),pendente=conta.status==='pending',precisa=precisaConectar(agent);
    button.hidden=!a || Boolean(a.loading && !pendente);
    button.classList.toggle('destaque',precisa || pendente);
    button.classList.toggle('aguardando',pendente);
    button.textContent=pendente?'Aguardando login…':precisa?(agent==='gemini' && a?.authenticated?'Conectar conta Google':'Conectar'):'Reconectar';
    button.title=pendente?'Ver o login em andamento':precisa?`Entrar pelo ${CONTAS[agent].cliente}`:`Entrar de novo pelo ${CONTAS[agent].cliente} (troca ou renova o login)`;
  }
}
function renderAccountDialog() {
  const agent=contaAberta;if(!agent)return;
  const conta=contaDe(agent),info=CONTAS[agent],dialog=$('account-dialog');
  dialog.className=`modal account-modal role-${agent} estado-${conta.status}`;
  $('account-title').textContent=info.titulo;$('account-intro').textContent=info.intro;
  const pendente=conta.status==='pending';
  const mensagens={idle:'Pronto para abrir o login oficial.',pending:conta.message || 'Abrindo o login oficial…',completed:conta.message || `${info.conta} conectado.`,failed:conta.message || 'O login não foi concluído.',cancelled:conta.message || 'Login cancelado.'};
  $('account-message').textContent=mensagens[conta.status] || conta.message || '';
  $('account-link').hidden=!(pendente && conta.url);
  if(conta.url)$('account-link').href=conta.url;
  $('account-link').textContent=agent==='claude'?'Abrir a página de login (se o navegador não abriu)':'Abrir a página de login';
  $('account-device').hidden=!(pendente && conta.userCode);
  $('account-user-code').textContent=conta.userCode || '';
  $('account-code-form').hidden=!(pendente && agent==='claude' && conta.acceptsCode);
  $('account-code-send').disabled=false;
  $('account-alt').hidden=!(pendente && agent==='codex' && conta.method!=='device');
  $('account-cancel').hidden=!pendente;
  $('account-retry').hidden=!['failed','cancelled'].includes(conta.status);
  $('account-done').hidden=conta.status!=='completed';
  const pausada=state.job && ['waiting_capacity','paused_input','paused_budget','failed','interrupted'].includes(state.job.status);
  $('account-note').textContent=conta.status==='completed'
    ?(pausada?'A tarefa desta sala está pausada. Use Continuar para ela seguir com o participante conectado.':'Pronto. Os próximos pedidos já usam esta conta.')
    :pendente?'Você pode fechar esta janela: o login continua e o botão do participante mostra quando terminar.':'';
}
async function iniciarConta(agent,{method='browser',restart=false}={}) {
  try {
    const conta=await api(`/api/accounts/${agent}/login`,{method:'POST',body:JSON.stringify({method,restart})});
    aoMudarConta(conta);
  } catch(error) {aoMudarConta({...contaDe(agent),agent,status:'failed',message:error.message});}
}
function abrirConta(agent) {
  contaAberta=agent;renderAccountDialog();
  if(!$('account-dialog').open)$('account-dialog').showModal();
  if(contaDe(agent).status!=='pending')void iniciarConta(agent);
}
function aoMudarConta(conta) {
  if(!conta?.agent || !providers.includes(conta.agent))return;
  const anterior=contaDe(conta.agent);
  state.accounts={...state.accounts,[conta.agent]:conta};
  // GPT: a página do ChatGPT abre sozinha uma vez por login. Claude e Gemini: o próprio cliente abre o navegador.
  const chave=`${conta.agent}:${conta.startedAt}:${conta.url}`;
  if(conta.status==='pending' && conta.url && conta.agent==='codex' && !paginasAbertas.has(chave)){paginasAbertas.add(chave);window.open(conta.url,'_blank','noopener');}
  renderAccountButtons();
  if(contaAberta===conta.agent && $('account-dialog').open)renderAccountDialog();
  if(conta.status==='completed' && anterior.status==='pending'){toast(`${CONTAS[conta.agent].conta} conectado pelo ${CONTAS[conta.agent].cliente}.`);scheduleRefresh();}
}
for(const agent of providers)$(`${agent}-connect`)?.addEventListener('click',()=>abrirConta(agent));
$('account-cancel').addEventListener('click',async()=>{try{aoMudarConta(await api(`/api/accounts/${contaAberta}/cancel`,{method:'POST',body:'{}'}));}catch(error){showError(error);}});
$('account-retry').addEventListener('click',()=>void iniciarConta(contaAberta,{restart:true}));
$('account-alt').addEventListener('click',()=>void iniciarConta(contaAberta,{method:'device',restart:true}));
$('account-done').addEventListener('click',()=>$('account-dialog').close());
$('account-copy-code').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('account-user-code').textContent);toast('Código copiado.');}catch{toast('Selecione e copie o código.');}});
$('account-code-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const code=$('account-code').value.trim();if(!code)return;
  $('account-code-send').disabled=true;
  try{aoMudarConta(await api(`/api/accounts/${contaAberta}/code`,{method:'POST',body:JSON.stringify({code})}));$('account-code').value='';}
  catch(error){$('account-code-send').disabled=false;$('account-message').textContent=error.message;}
});
function renderSessions() {
  for(const provider of providers) {
    const session=state.sessions.find(s=>s.agent===provider && s.lane===state.lane);
    $(`${provider}-session`).textContent=session?'Sessão contínua · '+dateLabel(session.updatedAt):'Nova sessão ao participar';
  }
}
function renderMemory() {
  $('memory-count').textContent=state.checkpoints.length;
  const box=$('memory-list');box.replaceChildren();
  if(!state.checkpoints.length)box.append(element('p','activity-empty','As decisões e os pontos de recuperação serão registrados ao longo do trabalho.'));
  for(const record of state.checkpoints) {
    const item=element('details','memory-item'),content=record.content;
    item.append(element('summary','',`${names[record.agent] || 'Synapse'} · ${dateLabel(record.createdAt)}`));
    item.append(element('p','',content.summary || 'Estado registrado.'));
    for(const [key,label] of [['decisions','Decisões'],['next','Pendências'],['tests','Verificações relatadas']])if(content[key]?.length) {
      item.append(element('strong','memory-label',label));const list=element('ul');for(const text of content[key])list.append(element('li','',text));item.append(list);
    }
    box.append(item);
  }
}
function renderCapabilities() {
  const box=$('capability-list');box.replaceChildren();
  const files=state.lane==='code' && state.room?.settings.access!=='chat';
  for(const [label,available] of [['Arquivos e comandos',files],['Pesquisa na web',state.room?.settings.internet],['Sessões e memória',true],['Aprovações na Synapse',true]]) {
    const row=element('div','capability-row');row.append(element('span','',label),element('span',available?'capability-on':'',available?'Ativo':'Desativado'));box.append(row);
  }
  for(const integration of state.integrations || []) {
    const enabled=files && state.room?.settings[`${integration.id}Enabled`] && (integration.id==='rea' || state.room?.settings.internet);
    const row=element('div','capability-row');row.title=integration.detail;
    row.append(element('span','',integration.label),element('span',enabled && integration.connected?'capability-on':'',!integration.connected?'Indisponível':enabled?`${integration.toolCount} ferramentas`:'Em Code'));box.append(row);
  }
}
function renderApprovals() {
  const pending=state.approvals.filter(a=>a.status==='pending');
  const signature=JSON.stringify(pending.map(a=>a.id));if(state.approvalSignature===signature)return;state.approvalSignature=signature;
  const box=$('approval-stack');box.hidden=!pending.length;box.replaceChildren();
  for(const approval of pending) {
    const card=element('form',`approval-card role-${Object.hasOwn(names,approval.agent)?approval.agent:'system'}`),request=approval.request;
    card.append(element('span','modal-eyebrow',`${names[approval.agent] || 'Agente'} pede sua decisão`),element('strong','approval-title',request.title || 'Aprovação necessária'));
    if(request.detail)card.append(detalheAprovacao(request.detail));
    const answers=new Map();
    for(const question of request.questions||[]) {
      const label=element('label','',question.question),input=element('input');input.required=true;input.maxLength=4000;input.id=`answer-${approval.id}-${answers.size}`;label.htmlFor=input.id;
      card.append(label,input);answers.set(question.id,input);
      if(question.options?.length){const options=element('div','approval-options');for(const text of question.options){const button=element('button','secondary-button',text);button.type='button';button.addEventListener('click',()=>input.value=text);options.append(button);}card.append(options);}
    }
    const actions=element('div','approval-actions'),deny=element('button','secondary-button',request.kind==='question'?'Agora não':'Recusar');deny.type='button';
    const approve=element('button','primary-button',request.kind==='question'?'Responder e continuar':'Permitir esta ação');approve.type='submit';
    const message=element('p','inline-error');message.hidden=true;
    const send=async answer=>{approve.disabled=true;deny.disabled=true;try{await api(`/api/approvals/${approval.id}`,{method:'POST',body:JSON.stringify(answer)});await loadRoom(approval.roomId);}catch(error){message.textContent=error.message;message.hidden=false;approve.disabled=false;deny.disabled=false;}};
    deny.addEventListener('click',()=>send({decision:'deny'}));
    card.addEventListener('submit',event=>{event.preventDefault();void send(request.kind==='question'?{decision:'answer',answers:Object.fromEntries([...answers].map(([id,input])=>[id,input.value.trim()]))}:{decision:'allow',optionId:request.options?.[0]?.id});});
    actions.append(deny,approve);card.append(message,actions);box.append(card);
  }
}
let versionRequest=0;
async function refreshVersions() {
  if(!state.selectedId)return;const roomId=state.selectedId,request=++versionRequest;
  const data=await api(`/api/rooms/${roomId}/versions`);if(roomId!==state.selectedId || request!==versionRequest)return;
  const box=$('version-list');box.replaceChildren();
  if(!data.versions?.length)box.append(element('p','activity-empty','Nenhuma versão ainda. As capturas começam ao usar Code.'));
  for(const version of data.versions || []) {
    const item=element('details','version-item');item.append(element('summary','',`${version.phase==='before'?'Antes':'Depois'} · ${names[version.agent] || 'Synapse'} · ${dateLabel(version.createdAt)}`));
    item.append(element('p','section-caption',`${version.files.length} arquivos · ${sizeLabel(version.bytes)}${version.partial?' · captura parcial':''}`));
    if(version.omitted?.length)item.append(element('p','section-caption','Não incluídos: '+version.omitted.join(', ')));
    for(const file of version.files) {
      const button=element('button','version-file',file.path);button.type='button';button.title='Baixar esta versão sem substituir o arquivo atual';
      button.addEventListener('click',async()=>{button.disabled=true;try{
        const response=await fetch(`/api/rooms/${roomId}/version-file`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrfToken},body:JSON.stringify({snapshotId:version.id,path:file.path})});
        if(!response.ok)throw new Error('Não foi possível recuperar esta versão.');
        const url=URL.createObjectURL(await response.blob()),link=element('a');link.href=url;link.download=file.path.split('/').at(-1);link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
      }catch(error){showError(error);}finally{button.disabled=false;}});item.append(button);
    }
    box.append(item);
  }
}
$('refresh-versions').addEventListener('click',()=>void refreshVersions().catch(showError));
async function browseFolders(path) {
  const sequence=++folderSequence;
  $('folder-error').hidden=true;$('select-folder').disabled=true;
  try {
    const data=await api('/api/folders',{method:'POST',body:JSON.stringify({path})});
    if(sequence!==folderSequence)return;
    folderState=data;$('folder-path').value=data.path;$('folder-up').disabled=!data.parent;
    const fragment=document.createDocumentFragment();
    for(const folder of data.folders) {
      const button=element('button','folder-row');button.type='button';button.append(element('span','file-glyph','▱'),element('span','file-name',folder.name));
      button.addEventListener('click',()=>browseFolders(folder.path));fragment.append(button);
    }
    if(!data.folders.length) fragment.append(element('p','activity-empty','Esta pasta não tem subpastas. Você pode selecioná-la.'));
    if(data.truncated)fragment.append(element('p','activity-empty','Mostrando as primeiras 1.000 pastas. Digite o caminho para abrir outra.'));
    $('folder-list').replaceChildren(fragment);$('folder-roots').replaceChildren();
    for(const root of data.roots){const button=element('button','text-button',root);button.type='button';button.addEventListener('click',()=>browseFolders(root));$('folder-roots').append(button);}
    $('select-folder').disabled=false;
  }catch(error){if(sequence===folderSequence){$('folder-error').textContent=error.message;$('folder-error').hidden=false;}}
}
$('browse-workspace').addEventListener('click',()=>{$('folder-dialog').showModal();void browseFolders($('workspace-input').value.trim() || undefined);});
$('folder-path-form').addEventListener('submit',event=>{event.preventDefault();void browseFolders($('folder-path').value.trim());});
$('folder-up').addEventListener('click',()=>browseFolders(folderState?.parent));
$('folder-home').addEventListener('click',()=>browseFolders(folderState?.home));
$('select-folder').addEventListener('click',()=>{if(folderState){$('workspace-input').value=folderState.path;$('folder-dialog').close();}});
function sizeLabel(bytes){return bytes<1024?`${bytes} B`:bytes<1048576?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1048576).toFixed(1)} MB`;}
async function refreshFiles(path=state.filePath) {
  if(!state.selectedId)return;
  const roomId=state.selectedId,sequence=++state.fileRequest;
  const data=await api(`/api/rooms/${roomId}/files`,{method:'POST',body:JSON.stringify({path})});
  if(state.selectedId!==roomId || sequence!==state.fileRequest)return;
  state.filePath=data.path;$('files-location').textContent=data.path || '/';$('files-up').disabled=!data.path;
  const fragment=document.createDocumentFragment();
  for(const file of data.files){
    const row=element('button','file-row');row.type='button';row.title=file.name;
    row.append(element('span','file-glyph',file.directory?'▱':'≡'),element('span','file-name',file.name),element('span','file-size',file.directory?'→':sizeLabel(file.size)));
    row.addEventListener('click',()=>{void(file.directory?refreshFiles(file.path):openFile(file.path)).catch(showError);});fragment.append(row);
  }
  if(!data.files.length) fragment.append(element('p','activity-empty','Esta pasta está vazia. Peça aos agentes uma entrega com o acesso Projeto habilitado.'));
  if(data.truncated)fragment.append(element('p','activity-empty','Mostrando os primeiros 1.000 itens.'));
  $('file-list').replaceChildren(fragment);
}
$('refresh-files').addEventListener('click',()=>refreshFiles().catch(showError));
$('files-up').addEventListener('click',()=>refreshFiles(state.filePath.split('/').slice(0,-1).join('/')).catch(showError));
$('workspace-path').addEventListener('click',()=>showPanel('files'));
let previewCode=false;
function renderFile() {
  const file=state.viewedFile;if(!file)return;
  $('file-title').textContent=file.name;
  $('file-info').textContent=`${sizeLabel(file.size)} · ${file.kind==='html'?'Prévia isolada; usa scripts e estilos do próprio HTML. Recursos externos e acesso à Synapse são bloqueados.':file.path}`;
  $('toggle-preview').hidden=file.kind!=='html';$('toggle-preview').textContent=previewCode?'Ver prévia':'Ver código';
  const container=$('file-content');container.replaceChildren();
  if(file.kind==='html'&&!previewCode){const frame=element('iframe');frame.title=`Prévia de ${file.name}`;frame.sandbox='allow-scripts';frame.referrerPolicy='no-referrer';frame.src=file.previewUrl;container.append(frame);}
  else if(file.kind==='image'){const img=element('img');img.alt=file.name;img.src=file.image;container.append(img);}
  else if(file.text!==undefined)container.append(element('pre','',file.text));
  else container.append(element('p','activity-empty','Baixe este arquivo para abri-lo no aplicativo correspondente.'));
}
async function openFile(path) {
  const roomId=state.selectedId;
  const file=await api(`/api/rooms/${roomId}/file`,{method:'POST',body:JSON.stringify({path})});
  if(roomId!==state.selectedId)return;
  state.viewedFile={...file,roomId};previewCode=false;renderFile();$('file-dialog').showModal();
}
$('toggle-preview').addEventListener('click',()=>{previewCode=!previewCode;renderFile();});
$('file-dialog').addEventListener('close',()=>{$('file-content').replaceChildren();state.viewedFile=null;});
$('download-file').addEventListener('click',async()=>{
  const file=state.viewedFile;if(!file)return;
  $('download-file').disabled=true;
  try {
    const response=await fetch(`/api/rooms/${file.roomId}/file`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrfToken},body:JSON.stringify({path:file.path,download:true})});
    if(!response.ok)throw new Error((await response.json()).error || 'Não foi possível baixar o arquivo.');
    const url=URL.createObjectURL(await response.blob()),link=element('a');link.href=url;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
  }catch(error){showError(error);toast(error.message);}finally{$('download-file').disabled=false;}
});

function detalheAprovacao(detalhe) {
  const details=element('details');details.open=true;details.append(element('summary','','Ação solicitada'));
  let dados=null;try{const lido=JSON.parse(detalhe);if(lido&&typeof lido==='object'&&!Array.isArray(lido))dados=lido;}catch{}
  if(!dados){details.append(element('pre','',detalhe));return details;}
  const resto={...dados},alvoChave=['command','file_path','path','url','query','pattern'].find(k=>typeof dados[k]==='string');
  if(typeof dados.description==='string'){details.append(element('p','approval-desc',dados.description));delete resto.description;}
  if(alvoChave){details.append(element('pre','approval-alvo',alvoChave==='command'?`$ ${dados[alvoChave]}`:dados[alvoChave]));delete resto[alvoChave];}
  if(Object.keys(resto).length)details.append(element('pre','',JSON.stringify(resto,null,2)));
  return details;
}

function limitesDoModelo(papel) {
  const model=state.room?.settings?.[`${papel}Model`];
  return (state.agents[papel]?.usage?.windows || []).filter(w=>!w.model || w.model===model || model?.includes(w.model));
}
function estadoAgente(papel) {
  const a = state.agents[papel];
  if (!a || a.loading) return 'verificando';
  if (!(a.available && a.authenticated)) return 'fora';
  if (a.blocked || limitesDoModelo(papel).some((w) => w.usedPercent >= 100)) return 'esgotado';
  return 'livre';
}
function updateParticipants() {
  const job=activeJob(),paused=pausedJob(),vez=job?.status==='running'?agentForJob(job):null;
  const legenda = $('room-subtitle');
  legenda.replaceChildren();
  if (!state.room) { legenda.textContent = 'Crie uma sala para começar.'; return; }
  if (job && job.status === 'queued') { legenda.textContent = 'Rodada na fila.'; return; }
  if (job) {
    if (vez) { const stage = currentStage(job); const nome = element('b', `role-${vez}`, names[vez]); legenda.append(nome, document.createTextNode(`${stage ? ` está ${stageVerb(stage)}` : ' com a vez'}${job.totalSteps > 1 ? ` · fala ${Math.max(1, job.step || 1)} de ${job.totalSteps}` : ''}`)); }
    else legenda.textContent = 'A coordenação está escolhendo quem começa.';
    return;
  }
  if (paused) { legenda.textContent = `${statusText(paused)}.`; return; }
  const livres = providers.filter((p) => estadoAgente(p) === 'livre');
  const esgotados = providers.filter((p) => estadoAgente(p) === 'esgotado');
  if (providers.every((p) => estadoAgente(p) === 'verificando')) { legenda.textContent = 'Verificando os participantes…'; return; }
  let texto = `${livres.length} de 3 participantes disponíveis`;
  if (esgotados.length) {
    const p = esgotados[0], renova = limitesDoModelo(p).filter((w) => w.usedPercent >= 100 && w.resetsAt).map((w) => w.resetsAt).sort()[0];
    texto += ` · ${names[p]} sem capacidade${renova ? ` até ${clock(renova)}` : ''}`;
  }
  legenda.textContent = texto + '.';
}
function renderSteps(job) {
  const box = $('job-steps');
  const total = Math.min(24, Number(job?.totalSteps) || 0);
  const running = job?.status === 'running';
  const feitos = Math.min(total, Number(job?.progress?.completed ?? Math.max(0, (job?.step || 1) - 1)) || 0);
  const signature = `${job?.id}:${total}:${feitos}:${running}`;
  if (signature === state.stepsSignature) return;
  state.stepsSignature = signature;
  box.replaceChildren();
  box.hidden = total < 2;
  for (let i = 0; i < total; i++) box.append(element('span', `passo${i < feitos ? ' feito' : i === feitos && running ? ' atual' : ''}`));
}
function moveInk(ink, alvo) {
  if (!ink || !alvo) return;
  ink.style.width = `${alvo.offsetWidth}px`;
  ink.style.transform = `translateX(${alvo.offsetLeft}px)`;
}
function setDrawer(nome) {
  if (nome) document.body.dataset.drawer = nome; else delete document.body.dataset.drawer;
  $('veu').hidden = !nome;
  $('toggle-details').setAttribute('aria-expanded', String(nome === 'details'));
  $('toggle-rooms').setAttribute('aria-expanded', String(nome === 'rooms'));
}
document.addEventListener('mousemove', (event) => {
  const alvo = event.target.closest?.('.luz');
  if (!alvo || !MOVIMENTO) return;
  const r = alvo.getBoundingClientRect();
  alvo.style.setProperty('--mx', `${event.clientX - r.left}px`);
  alvo.style.setProperty('--my', `${event.clientY - r.top}px`);
});
// ------------------------------------------------ layout: trilho e painel recolhíveis e redimensionáveis
// Fica salvo neste computador. Abaixo de 761 px o trilho vira gaveta; abaixo de 1181 px, o painel.
const LAYOUT_KEY='synapse.layout';
const layout=(()=>{try{const v=JSON.parse(localStorage.getItem(LAYOUT_KEY));return v && typeof v==='object'?v:{};}catch{return {};}})();
const LIMITES={trilho:[200,380],painel:[280,560]};
const painelFixo=()=>matchMedia('(min-width: 1181px)').matches;
function applyLayout() {
  const root=document.documentElement;
  for(const k of ['trilho','painel']) {
    const v=Number(layout[k]);
    if(Number.isFinite(v) && v>=LIMITES[k][0] && v<=LIMITES[k][1])root.style.setProperty('--'+k,v+'px');else root.style.removeProperty('--'+k);
  }
  document.body.classList.toggle('trilho-recolhido',Boolean(layout.recolhido));
  document.body.classList.toggle('painel-recolhido',Boolean(layout.painelRecolhido));
  $('collapse-rooms').setAttribute('aria-expanded',String(!layout.recolhido));
  $('collapse-rooms').title=layout.recolhido?'Expandir salas (Ctrl+B)':'Recolher salas (Ctrl+B)';
  if(painelFixo())$('toggle-details').setAttribute('aria-expanded',String(!layout.painelRecolhido));
  requestAnimationFrame(()=>{moveInk($('panel-ink'),document.querySelector('.panel-tab.active'));moveRoomIndicator();});
}
function saveLayout(){try{localStorage.setItem(LAYOUT_KEY,JSON.stringify(layout));}catch{}applyLayout();}
function abrirPainelProjeto() {
  if(painelFixo()){if(layout.painelRecolhido){layout.painelRecolhido=false;saveLayout();}}
  else setDrawer('details');
  document.querySelector('.panel-tab[data-panel="context"]')?.click();
}
$('collapse-rooms').addEventListener('click',()=>{layout.recolhido=!layout.recolhido;saveLayout();});
document.addEventListener('keydown',e=>{
  if((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase()==='b'){e.preventDefault();layout.recolhido=!layout.recolhido;saveLayout();}
});
for(const alca of document.querySelectorAll('.alca')) {
  const k=alca.dataset.alca;
  const largura=x=>Math.round(Math.min(LIMITES[k][1],Math.max(LIMITES[k][0],k==='trilho'?x:innerWidth-x)));
  alca.addEventListener('pointerdown',e=>{
    if(e.button!==0)return;
    e.preventDefault();alca.setPointerCapture(e.pointerId);document.body.classList.add('arrastando');
    if(k==='trilho')layout.recolhido=false;else layout.painelRecolhido=false;
    const move=ev=>{layout[k]=largura(ev.clientX);applyLayout();};
    const fim=()=>{alca.removeEventListener('pointermove',move);document.body.classList.remove('arrastando');saveLayout();};
    alca.addEventListener('pointermove',move);
    alca.addEventListener('lostpointercapture',fim,{once:true});
  });
  alca.addEventListener('dblclick',()=>{delete layout[k];saveLayout();});
  alca.addEventListener('keydown',e=>{
    if(!['ArrowLeft','ArrowRight'].includes(e.key))return;
    e.preventDefault();
    const atual=Number(layout[k]) || parseFloat(getComputedStyle(document.body).getPropertyValue('--'+k)) || LIMITES[k][0];
    const passo=(e.key==='ArrowRight'?16:-16)*(k==='trilho'?1:-1);
    layout[k]=Math.min(LIMITES[k][1],Math.max(LIMITES[k][0],atual+passo));saveLayout();
  });
}
// Onda de clique nos botões (desligada com movimento reduzido).
document.addEventListener('pointerdown',e=>{
  if(!MOVIMENTO || e.button!==0)return;
  const alvo=e.target.closest?.('button');
  if(!alvo || alvo.disabled || alvo.closest('.message-content, .mention-menu'))return;
  const r=alvo.getBoundingClientRect(),d=Math.max(r.width,r.height)*2.2,onda=document.createElement('span');
  onda.className='onda';onda.setAttribute('aria-hidden','true');
  onda.style.cssText=`width:${d}px;height:${d}px;left:${e.clientX-r.left-d/2}px;top:${e.clientY-r.top-d/2}px`;
  alvo.classList.add('com-onda');if(getComputedStyle(alvo).position==='static')alvo.classList.add('com-onda-pos');
  alvo.append(onda);
  setTimeout(()=>onda.remove(),700);
},{passive:true});
applyLayout();

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    moveInk($('panel-ink'), document.querySelector('.panel-tab.active'));
    moveRoomIndicator();
    if (innerWidth > 1180 || (innerWidth > 760 && document.body.dataset.drawer === 'rooms')) setDrawer(null);
  }, 120);
});

// ------------------------------------------------ menus, arquivar e excluir
let menuRoom=null;
function closeMenus() {
  $('room-menu').hidden=true;menuRoom=null;
  $('mode-menu').hidden=true;$('mode-button').setAttribute('aria-expanded','false');
}
function placeMenu(menu,anchor,event) {
  menu.hidden=false;
  const box=menu.getBoundingClientRect(),ref=anchor.getBoundingClientRect();
  const x=event?.clientX ?? ref.right-box.width, y=event?.clientY ?? ref.bottom+4;
  menu.style.left=`${Math.max(8,Math.min(x,innerWidth-box.width-8))}px`;
  menu.style.top=`${Math.max(8,Math.min(y,innerHeight-box.height-8))}px`;
}
function openRoomMenu(room,anchor,event) {
  closeMenus();menuRoom=room;
  const busy=state.activeJobs.some(j=>j.roomId===room.id && activeStatuses.has(j.status));
  const archive=$('room-menu').querySelector('[data-action="archive"]');
  archive.textContent=room.archivedAt?'Restaurar sala':'Arquivar sala';
  for(const item of $('room-menu').querySelectorAll('[data-action="archive"],[data-action="delete"]')) {item.disabled=busy;item.title=busy?'Disponível quando a rodada terminar.':'';}
  placeMenu($('room-menu'),anchor,event);
  $('room-menu').querySelector('button:not(:disabled)')?.focus();
}
// Reiniciar para atualizar (só no aplicativo de desktop): o botão aparece quando há uma versão nova pronta.
// Com uma rodada em andamento, a atualização fica agendada para o fim dela; clicar de novo cancela.
function iniciarAtualizacao() {
  const ponte=window.synapseApp?.atualizacao;
  if(!ponte || $('app-update')) return;
  const botao=element('button','update-pill');botao.id='app-update';botao.type='button';botao.hidden=true;
  document.querySelector('.header-actions')?.prepend(botao);
  let estado=null;
  const mostrar=novo=>{
    estado=novo || null;botao.hidden=!estado?.versao;
    if(!estado?.versao) return;
    botao.classList.toggle('aguardando',Boolean(estado.aguardando));
    botao.textContent=estado.aguardando?`Atualiza ao fim da rodada · ${estado.versao}`:`Reiniciar para atualizar · ${estado.versao}`;
    botao.title=estado.aguardando?'A Synapse reinicia assim que a rodada em andamento terminar. Clique para cancelar.':`A versão ${estado.versao} está pronta (atual: ${estado.atual}). Conversas, tarefas e arquivos ficam salvos.`;
  };
  botao.addEventListener('click',async()=>{
    try {
      if(estado?.aguardando){mostrar(await ponte.cancelar());toast('Atualização adiada. O botão continua disponível.');return;}
      const visto=estado;
      const ok=await confirmar({titulo:`Atualizar para a versão ${visto?.versao}?`,texto:'A Synapse fecha, instala a versão nova e abre de novo em alguns segundos. Conversas, tarefas, memória e arquivos ficam salvos. Se houver uma rodada em andamento, a atualização espera ela terminar.',acao:'Reiniciar e atualizar',perigo:false});
      if(!ok) return;
      const depois=await ponte.reiniciar(visto?.id);mostrar(depois);
      if(depois?.aguardando)toast('A Synapse vai reiniciar quando a rodada em andamento terminar.');
      else if(depois?.id && depois.id!==visto?.id)toast(`Chegou outra versão (${depois.versao}). Confirme de novo para atualizar.`);
    } catch(error){showError(error);}
  });
  ponte.aoMudar(mostrar);
  ponte.estado().then(mostrar,()=>{});
}
// Sugestões de @menção no compositor: ↑/↓ escolhem, Enter ou Tab inserem, Esc fecha.
let mencaoAtiva=null;
function fecharMencao(){mencaoAtiva=null;$('mention-menu').hidden=true;}
function sugerirMencao(){
  const input=$('message-input'),antes=input.value.slice(0,input.selectionStart),m=antes.match(/(^|\s)@(\w{0,10})$/);
  if(!m||input.selectionStart!==input.selectionEnd){fecharMencao();return;}
  const termo=m[2].toLowerCase(),opcoes=providers.filter(p=>names[p].toLowerCase().startsWith(termo)||(p==='codex'&&'codex'.startsWith(termo)));
  if(!opcoes.length){fecharMencao();return;}
  mencaoAtiva={inicio:antes.length-m[2].length-1,opcoes,indice:Math.min(mencaoAtiva?.indice||0,opcoes.length-1)};
  const menu=$('mention-menu');menu.replaceChildren();
  opcoes.forEach((p,i)=>{
    const item=element('button','mention-item role-'+p);item.type='button';item.setAttribute('role','option');item.setAttribute('aria-selected',String(i===mencaoAtiva.indice));
    item.append(element('span','mention-dot'),element('strong','','@'+names[p]),element('span','mention-hint',state.lane==='code'?'revisa ou responde em seguida':'responde em seguida'));
    item.addEventListener('mousedown',e=>{e.preventDefault();inserirMencao(p);});
    menu.append(item);
  });
  menu.hidden=false;
}
function inserirMencao(p){
  const input=$('message-input');if(!mencaoAtiva)return;
  input.setRangeText('@'+names[p]+' ',mencaoAtiva.inicio,input.selectionStart,'end');
  fecharMencao();resizeComposer();renderControls();input.focus();
}
function teclaDaMencao(event){
  if(!mencaoAtiva||$('mention-menu').hidden)return false;
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const n=mencaoAtiva.opcoes.length;mencaoAtiva.indice=(mencaoAtiva.indice+(event.key==='ArrowDown'?1:n-1))%n;sugerirMencao();return true;}
  if(event.key==='Enter'||event.key==='Tab'){event.preventDefault();inserirMencao(mencaoAtiva.opcoes[mencaoAtiva.indice]);return true;}
  if(event.key==='Escape'){event.preventDefault();fecharMencao();return true;}
  return false;
}
function confirmar({titulo,texto,acao,perigo=true}) {
  $('confirm-title').textContent=titulo;$('confirm-text').textContent=texto;
  $('confirm-submit').textContent=acao;$('confirm-submit').classList.toggle('perigo',perigo);
  $('confirm-dialog').returnValue='';$('confirm-dialog').showModal();
  return new Promise(resolve=>$('confirm-dialog').addEventListener('close',()=>resolve($('confirm-dialog').returnValue==='ok'),{once:true}));
}
async function archiveRoom(room,archived) {
  const {room:updated}=await api(`/api/rooms/${room.id}/archive`,{method:'POST',body:JSON.stringify({archived})});
  state.rooms=state.rooms.map(r=>r.id===updated.id?updated:r);
  if(state.selectedId===updated.id) state.room=updated;
  renderRoom();toast(archived?`“${updated.title}” foi arquivada. Ela fica em Arquivadas.`:`“${updated.title}” voltou para as salas.`);
}
async function deleteRoom(room) {
  const ok=await confirmar({titulo:`Excluir “${room.title}”?`,texto:'A conversa, a memória, as tarefas e as versões desta sala serão removidas da Synapse. Arquivos da pasta própria da sala vão para a lixeira dos dados; uma pasta escolhida por você não é tocada. Não é possível desfazer.',acao:'Excluir sala'});
  if(!ok) return;
  const result=await api(`/api/rooms/${room.id}`,{method:'DELETE'});
  state.rooms=state.rooms.filter(r=>r.id!==room.id);
  if(state.selectedId===room.id) {
    const next=state.rooms.find(r=>!r.archivedAt) || state.rooms[0];
    state.selectedId=null;state.room=null;state.messages=[];state.jobs=[];
    if(next) await selectRoom(next.id); else {state.loading=false;renderRoom();}
  } else renderRooms();
  toast(result.trash?'Sala excluída. Os arquivos dela foram para a lixeira dos dados.':'Sala excluída.');
}
$('room-menu').addEventListener('click',async event=>{
  const action=event.target.closest('[data-action]')?.dataset.action, room=menuRoom;
  if(!action || !room) return;
  closeMenus();
  try {
    if(action==='rename') {if(state.selectedId!==room.id) await selectRoom(room.id); $('edit-brief').click();}
    if(action==='archive') await archiveRoom(room,!room.archivedAt);
    if(action==='delete') await deleteRoom(room);
  } catch(error){showError(error);}
});
$('mode-button').addEventListener('click',event=>{
  event.stopPropagation();
  const open=$('mode-menu').hidden;closeMenus();
  if(open){$('mode-menu').hidden=false;$('mode-button').setAttribute('aria-expanded','true');$('mode-menu').querySelector('[aria-checked="true"]')?.focus();}
});
for(const item of $('mode-menu').querySelectorAll('[data-mode]')) item.addEventListener('click',()=>setLane(item.dataset.mode));
document.addEventListener('click',event=>{if(!event.target.closest('#room-menu,#mode-menu,.room-more,#mode-button'))closeMenus();});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape' && (!$('room-menu').hidden || !$('mode-menu').hidden)) {closeMenus();return;}
  const menu=!$('room-menu').hidden?$('room-menu'):!$('mode-menu').hidden?$('mode-menu'):null;
  if(menu && ['ArrowDown','ArrowUp'].includes(event.key)) {
    event.preventDefault();
    const items=[...menu.querySelectorAll('button:not(:disabled)')],at=items.indexOf(document.activeElement);
    items[(at+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();
  }
});
window.addEventListener('blur',closeMenus);

async function start() {
  iniciarAtualizacao();
  updateParticipants();
  renderControls();
  moveInk($('panel-ink'), $('tab-context'));
  $('room-list').append(element('div', 'skeleton-room'));
  try {
    await refreshBootstrap();
    let remembered;
    try { remembered = localStorage.getItem('mesa-selected-room'); } catch { /* storage may be disabled */ }
    const first = state.rooms.find((room) => room.id === remembered) || state.rooms.find((room) => !room.archivedAt) || state.rooms[0];
    if (first) await selectRoom(first.id);
    else { state.loading = false; renderRoom(); }
    connectEvents();
  } catch (error) {
    state.loading = false;
    renderRooms();
    renderControls();
    updateConnection(false);
    showError(error);
  }
}

// 1.7: tela cheia pelo F11. No aplicativo, o processo principal alterna e avisa; a barra de título própria some junto
// com os botões da janela. No navegador, o próprio F11 do navegador já faz isso.
window.synapseApp?.telaCheia?.aoMudar((cheia)=>{
  document.documentElement.classList.toggle('tela-cheia',cheia);
  if(cheia)toast('Tela cheia · F11 para sair');
});

start();
