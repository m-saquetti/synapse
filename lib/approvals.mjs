import { safeDiagnostic } from './agents.mjs';

// Mesmo com a Autonomia ligada, estas ações continuam pedindo sua confirmação: apagam dados de forma recursiva,
// publicam fora do computador ou mexem no sistema. A lista é curta de propósito e não substitui o seu controle.
export const SEMPRE_PERGUNTAR=[
  [/\bgit\s+push\b/i,'envia commits para um repositório remoto'],
  [/\bgit\s+reset\s+--hard\b/i,'descarta alterações locais de forma irreversível'],
  [/\bgit\s+clean\s+-[a-z]*f/i,'apaga arquivos locais não rastreados'],
  [/\b(npm|pnpm|yarn)\s+publish\b/i,'publica um pacote'],
  [/\bgh\s+(release\s+create|pr\s+merge|repo\s+(delete|create))\b/i,'altera um repositório no GitHub'],
  [/\brm\s+-[a-z]*(r[a-z]*f|f[a-z]*r)/i,'apaga pastas de forma recursiva'],
  [/Remove-Item\b[^\n|;]*-Recurse/i,'apaga pastas de forma recursiva'],
  [/\b(rd|rmdir)\s+\/s\b|\bdel\s+\/s\b/i,'apaga pastas de forma recursiva'],
  [/\bformat(\.com)?\s+[a-z]:|\bdiskpart\b|\bcipher\s+\/w/i,'formata ou apaga um disco'],
  [/\bshutdown(\.exe)?\s+\/[srp]\b|\b(Stop|Restart)-Computer\b/i,'desliga ou reinicia o computador'],
  [/\breg(\.exe)?\s+(delete|add)\b|\b(Remove|Set|New)-ItemProperty\b[^\n]*HK(LM|CU)/i,'altera o registro do Windows'],
];
export function motivoParaPerguntar(request) {
  const texto=`${request?.title || ''}\n${request?.detail || ''}`;
  return SEMPRE_PERGUNTAR.find(([padrao])=>padrao.test(texto))?.[1] || null;
}

export class Approvals {
  constructor(store,notify) {this.store=store;this.notify=notify;this.pending=new Map();}
  // auto: Autonomia ligada na sala. Permissões são aprovadas na hora e ficam registradas; perguntas ao usuário
  // e as ações de SEMPRE_PERGUNTAR continuam esperando sua resposta. aoAprovar avisa a aprovação automática.
  request({roomId,jobId,agent,request,signal,auto=false,aoAprovar}) {
    if(signal?.aborted) return Promise.resolve({decision:'deny'});
    // Persist only reviewable operation details, never credentials or provider request envelopes.
    if(String(request.detail || '').length>48000) return Promise.resolve({decision:'deny',reason:'Solicitação extensa demais para revisão. Divida a ação.'});
    const safe={kind:request.kind || 'permission',title:safeDiagnostic(request.title),detail:safeDiagnostic(request.detail,48000),
      ...(request.questions?{questions:request.questions.map(q=>({id:String(q.id),question:safeDiagnostic(q.question),options:(q.options||[]).map(o=>typeof o==='string'?o:o.label)}))}:{}),
      ...(request.options?{options:request.options.map(o=>({id:String(o.id),label:safeDiagnostic(o.label)}))}:{})};
    const row=this.store.createApproval(roomId,jobId,agent,safe);
    if(auto && !request.requiresUser && safe.kind==='permission' && !motivoParaPerguntar(safe)) {
      const answer={decision:'allow',auto:true,...(safe.options?.length?{optionId:safe.options[0].id}:{})};
      this.store.resolveApproval(row.id,'approved',answer);
      aoAprovar?.(safe);
      this.notify('update',{type:'approval',roomId,jobId});
      return Promise.resolve(answer);
    }
    return new Promise(resolve=>{
      const finish=(answer,status)=>{
        if(!this.pending.delete(row.id)) return;
        signal?.removeEventListener('abort',abort);
        this.store.resolveApproval(row.id,status,answer);
        this.notify('update',{type:'approval',roomId,jobId});resolve(answer);
      };
      const abort=()=>finish({decision:'deny'},'expired');
      this.pending.set(row.id,{roomId,jobId,request:safe,finish});
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted) abort();else this.notify('update',{type:'approval',roomId,jobId});
    });
  }
  answer(id,answer) {
    const item=this.pending.get(id);
    if(!item) throw Object.assign(new Error('Esta solicitação já foi respondida ou expirou.'),{statusCode:409});
    if(!['allow','deny','answer'].includes(answer.decision)) throw Object.assign(new Error('Resposta inválida.'),{statusCode:400});
    if(item.request.kind==='question' && answer.decision==='answer') {
      if(!answer.answers || typeof answer.answers!=='object' || item.request.questions.some(q=>typeof answer.answers[q.id]!=='string' || answer.answers[q.id].length>4000)) throw Object.assign(new Error('Responda às perguntas antes de continuar.'),{statusCode:400});
    } else if(answer.decision==='answer') throw Object.assign(new Error('Resposta inválida para esta permissão.'),{statusCode:400});
    if(answer.decision==='allow' && item.request.options?.length && !item.request.options.some(o=>o.id===answer.optionId)) throw Object.assign(new Error('Selecione uma opção válida.'),{statusCode:400});
    item.finish(answer,answer.decision==='deny'?'denied':'approved');
  }
  close() {for(const item of [...this.pending.values()]) item.finish({decision:'deny'},'expired');}
}
