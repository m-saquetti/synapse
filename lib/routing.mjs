export const PROVIDERS=['codex','claude','gemini'];
export function normalizeLane(mode) {return ['code','build'].includes(mode)?'code':'chat';}
export function quotaPressure(usage,model,now=Date.now()) {
  const values=(usage?.windows||[]).filter(w=>!w.model || w.model===model || model?.includes(w.model))
    .filter(w=>Number.isFinite(w.usedPercent)).map(w=>w.usedPercent);
  return values.length?Math.max(...values):null;
}
export function modelEligible(provider,model) {
  if(!provider?.available || !provider.authenticated || provider.blocked)return false;
  if(!model || model==='auto')return true;
  const selected=provider.models?.find(m=>m.id===model);
  return !['locked','cooldown'].includes(selected?.availability);
}
export function chooseAgent({status,settings,lane,exclude=[],preferDifferent,modelKey=agent=>`${agent}Model`}) {
  const preference=settings[lane==='code'?'codePreference':'chatPreference'];
  const candidates=preference.filter(a=>!exclude.includes(a) && modelEligible(status[a],settings[modelKey(a)]))
    .map(agent=>({agent,pressure:quotaPressure(status[agent].usage,settings[modelKey(agent)])})).filter(c=>c.pressure===null || c.pressure<100);
  const different=candidates.filter(c=>c.agent!==preferDifferent);
  const pool=preferDifferent && different.length?different:candidates;
  const below=pool.filter(c=>c.pressure===null || c.pressure<settings.handoffPercent);
  // Unknown is not zero. Rank known capacity by pressure only when every candidate is near the threshold.
  const selected=below.length?below[0]:[...pool].sort((a,b)=>(a.pressure??100)-(b.pressure??100))[0];
  return selected?{...selected,reason:selected.pressure===null?'Preferência da tarefa; consumo não informado.':`Preferência e capacidade disponível; ${Math.round(selected.pressure)}% usados.`}:null;
}
// Tamanho do contexto da conversa de um participante, pelo uso da última fala dele. null quando o cliente não informa
// ou quando não há conversa a retomar (AI Studio). Claude: a última chamada do turno; Codex: a última requisição;
// Antigravity: a entrada sem cache do turno, que inclui a releitura inicial da conversa.
export function contextTokens(agent,usage) {
  if(!usage || typeof usage!=='object')return null;
  const n=v=>Number.isFinite(v)?v:0;
  if(agent==='claude'){const it=Array.isArray(usage.iterations)?usage.iterations.at(-1):null;return it?n(it.input_tokens)+n(it.cache_read_input_tokens)+n(it.cache_creation_input_tokens):null;}
  if(agent==='codex'){
    if(Number.isFinite(usage.last?.totalTokens))return usage.last.totalTokens;
    return Number.isFinite(usage.last?.inputTokens)?usage.last.inputTokens+n(usage.last.outputTokens):null;
  }
  if(agent==='gemini')return 'promptTokenCount' in usage || !Number.isFinite(usage.inputTokens)?null:usage.inputTokens;
  return null;
}
// Um bloco não pode conter outra abertura: assim uma citação da tag no meio da fala
// (ex.: "regras de `<mesa_status>`") não engole o texto até o bloco real.
const HANDOFF_BLOCK=/<mesa_status>((?:(?!<mesa_status>)[\s\S])*?)<\/mesa_status>/g;
const handoffJson=raw=>{try{const v=JSON.parse(raw.trim());return v && typeof v==='object' && !Array.isArray(v)?v:null;}catch{return null;}};
export function parseHandoff(text) {
  const source=String(text);
  const control={status:'continue',summary:'',decisions:[],next:[],tests:[]};
  const blocks=[...source.matchAll(HANDOFF_BLOCK)].map(m=>({start:m.index,end:m.index+m[0].length,value:handoffJson(m[1])}));
  const v=blocks.filter(b=>b.value).at(-1)?.value;
  if(v) {
    if(['complete','continue','blocked'].includes(v.status)) control.status=v.status;
    if(typeof v.summary==='string') control.summary=v.summary.slice(0,5000);
    for(const k of ['decisions','next','tests']) if(Array.isArray(v[k])) control[k]=v[k].filter(x=>typeof x==='string').slice(0,20).map(x=>x.slice(0,1000));
  }
  // Sai do texto só o que é controle: blocos com JSON válido e o bloco final, mesmo malformado.
  const end=source.trimEnd().length;
  let out=source;
  for(const b of blocks.filter(b=>b.value || b.end===end).reverse()) out=out.slice(0,b.start)+out.slice(b.end);
  return {text:out.trim(),control};
}
