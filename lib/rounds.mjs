// Rodada em grupo: um participante fala por vez, como num grupo de conversa.
//
// Chat: o líder (GPT por padrão) abre com uma proposta, cada colega responde em sequência lendo tudo o
// que já foi dito, e o líder fecha com a síntese.
// Code: o líder (Claude por padrão) implementa, os colegas revisam e testam em sequência (podendo aplicar
// correções pontuais), o líder incorpora as críticas, e o ciclo se repete até uma passada de revisão aprovar
// a versão atual dos arquivos.
//
// Este módulo só decide quem fala e em que papel; executar, salvar e lidar com falhas fica no coordenador.

export const STAGES = Object.freeze({
  abertura: { lane: 'chat', phase: 'execute', label: 'Abertura' },
  analise: { lane: 'chat', phase: 'review', label: 'Análise' },
  sintese: { lane: 'chat', phase: 'execute', label: 'Síntese' },
  implementacao: { lane: 'code', phase: 'execute', label: 'Implementação' },
  revisao: { lane: 'code', phase: 'review', label: 'Revisão' },
  refino: { lane: 'code', phase: 'execute', label: 'Refino' },
  verificacao: { lane: 'code', phase: 'review', label: 'Verificação' },
  replica: { lane: 'chat', phase: 'review', label: 'Réplica' },
});

// Chamadas por @menção numa rodada (do usuário e dos participantes, somadas). Limite contra laços de "@X → @Y → @X".
export const MAX_CHAMADAS = 3;

const SPEAKER = { codex: 'GPT', claude: 'Claude', gemini: 'Gemini', user: 'o usuário' };

// quick: o usuário mencionou vários participantes; no Chat cada um responde uma vez, sem síntese.
export function startRound(lane, available, { quick = false } = {}) {
  const order = [...available];
  if (!order.length) return null;
  const base = { lane, lead: order[0], order, turns: [], calls: [], callsUsed: 0, startedAt: new Date().toISOString(), ...(quick ? { quick: true } : {}) };
  return lane === 'code' ? { ...base, lastChange: null, pass: null } : { ...base, spoken: [], synthesized: false };
}

// Enfileira chamadas por @menção. Só quem está na rodada pode ser chamado; ninguém chama a si mesmo.
// reserve: quem passou do limite preventivo de uso. Chamadas de colegas para essa pessoa não são atendidas;
// as do usuário são (é escolha dele).
export function queueCalls(round, agents, from, allowed = round?.order || [], { reserve = [] } = {}) {
  const accepted = [], dropped = [];
  if (!round) return { accepted, dropped };
  round.calls ||= []; round.callsUsed ||= 0;
  for (const agent of agents) {
    if (agent === from) continue;
    const existing = round.calls.findIndex(c => c.agent === agent);
    if (existing >= 0 && (from !== 'user' || round.calls[existing].from === 'user')) continue;
    if (!allowed.includes(agent)) { dropped.push({ agent, reason: 'não está nesta rodada' }); continue; }
    if (from !== 'user' && reserve.includes(agent)) { dropped.push({ agent, reason: 'passou a vez por estar perto do limite de uso' }); continue; }
    if (round.lane === 'code' && agent === round.lastChange?.agent) { dropped.push({ agent, reason: 'a revisão exige outro participante' }); continue; }
    if (round.lane === 'chat' && round.synthesized) { dropped.push({ agent, reason: 'a rodada já terminou' }); continue; }
    if (existing >= 0) round.calls.splice(existing, 1);
    else {
      if (round.callsUsed >= MAX_CHAMADAS) { dropped.push({ agent, reason: `limite de ${MAX_CHAMADAS} chamadas por rodada` }); continue; }
      round.callsUsed++;
    }
    const nextAgentCall = from === 'user' ? round.calls.findIndex(c => c.from !== 'user') : -1;
    round.calls.splice(nextAgentCall < 0 ? round.calls.length : nextAgentCall, 0, { agent, from });
    accepted.push(agent);
  }
  return { accepted, dropped };
}

// Próxima fala: {agent, stage, parentRole, call?} | {done:true} | {wait:true, reason}
// available: quem pode assumir falas agora. userCalls: quem está fora de available só por ter passado do limite
// preventivo, mas ainda pode atender a uma chamada feita pelo usuário com @.
export function planNext(round, available, { userCalls = [] } = {}) {
  if (!round) return { wait: true, reason: 'Nenhum participante disponível para abrir a rodada.' };
  const can = (agent) => available.includes(agent);
  const canCall = (call) => can(call.agent) || (call.from === 'user' && userCalls.includes(call.agent));
  const previous = round.turns.at(-1)?.agent || null;
  if (round.lane === 'chat') {
    if (round.synthesized) return { done: true };
    if (!round.spoken.length) {
      const opener = can(round.lead) ? round.lead : round.order.find(can) || available[0];
      if (!opener) return { wait: true, reason: 'Nenhum participante disponível para abrir a rodada.' };
      if (opener !== round.lead) round.lead = opener;
      return { agent: opener, stage: 'abertura', parentRole: null };
    }
    // Quem foi chamado com @ fala antes da fila: se ainda não falou, a chamada é a análise dele; senão, uma réplica.
    while (round.calls?.length) {
      const call = round.calls[0];
      if (!canCall(call)) { round.calls.shift(); continue; }
      return { agent: call.agent, stage: round.spoken.includes(call.agent) ? 'replica' : 'analise', parentRole: call.from, call: true };
    }
    const critic = [...round.order, ...available].find((agent) => can(agent) && !round.spoken.includes(agent));
    if (critic) return { agent: critic, stage: 'analise', parentRole: previous };
    if (round.quick) return { done: true };
    if (round.spoken.length < 2) return { done: true }; // ninguém mais pôde responder: a abertura é a resposta
    const closer = can(round.lead) ? round.lead : round.spoken.find(can);
    return closer ? { agent: closer, stage: 'sintese', parentRole: previous } : { done: true };
  }
  // Code
  if (!round.lastChange) {
    const implementer = can(round.lead) ? round.lead : round.order.find(can) || available[0];
    if (!implementer) return { wait: true, reason: 'Nenhum participante disponível para implementar.' };
    if (implementer !== round.lead) round.lead = implementer;
    return { agent: implementer, stage: 'implementacao', parentRole: null };
  }
  const pass = round.pass;
  // Code: quem foi chamado com @ passa a ser o próximo revisor da versão atual (o autor dela não revisa a si mesmo).
  while (pass && round.calls?.length) {
    const call = round.calls[0];
    if (canCall(call) && call.agent !== round.lastChange.agent)
      return { agent: call.agent, stage: 'revisao', parentRole: call.from, call: true };
    round.calls.shift();
  }
  if (pass) {
    while (pass.reviewers.length && !can(pass.reviewers[0])) pass.reviewers.shift();
    if (pass.reviewers.length) return { agent: pass.reviewers[0], stage: 'revisao', parentRole: previous };
  }
  if (pass?.issues) {
    const fixer = can(round.lead) ? round.lead : available.find((agent) => agent !== previous) || available[0];
    return fixer ? { agent: fixer, stage: 'refino', parentRole: previous } : { wait: true, reason: 'Aguardando um participante para aplicar as correções.' };
  }
  if (pass?.approvals.length) return { done: true };
  // A última alteração ainda não foi conferida por outra pessoa.
  const checker = [round.lead, ...round.order, ...available].find((agent) => can(agent) && agent !== round.lastChange.agent);
  return checker ? { agent: checker, stage: 'verificacao', parentRole: previous } : { wait: true, reason: 'Aguardando outro participante para revisar a última alteração.' };
}

// Registra uma fala concluída. control vem do bloco <mesa_status>; changed indica arquivos alterados.
// docsOnly: as alterações foram só de documentação ou do número de versão (ver Versions.docsOnly). Elas não
// exigem outra fala de verificação: cada uma custava uma participação inteira, com o contexto relido.
export function recordTurn(round, { agent, stage, control = {}, changed = false, docsOnly = false, comparisonComplete = true, step }) {
  round.turns.push({ agent, stage, step, status: control.status || 'continue', changed: Boolean(changed), ...(changed && docsOnly ? { docsOnly: true } : {}) });
  const codeChanged = Boolean(changed) && !docsOnly;
  if (round.calls?.[0]?.agent === agent) round.calls.shift();
  if (round.lane === 'chat') {
    if (stage === 'sintese') round.synthesized = true;
    else if (!round.spoken.includes(agent)) round.spoken.push(agent);
    return round;
  }
  const others = (author) => [...round.order].filter((a) => a !== author);
  // Refino sem mudança de código, concluído por quem não é o autor da última alteração: essa pessoa acabou de
  // conferir a versão atual, então ela vale como aprovação e a rodada termina sem nova verificação.
  if (stage === 'refino' && comparisonComplete && !codeChanged && control.status === 'complete' && round.lastChange && round.lastChange.agent !== agent) {
    round.pass = { reviewers: [], issues: false, approvals: [agent] };
    return round;
  }
  if (stage === 'implementacao' || stage === 'refino') {
    round.lastChange = { agent, step };
    round.pass = { reviewers: others(agent), issues: false, approvals: [] };
    return round;
  }
  // revisão ou verificação
  const pass = round.pass || (round.pass = { reviewers: [], issues: false, approvals: [] });
  pass.reviewers = pass.reviewers.filter((a) => a !== agent);
  if (codeChanged) {
    // Correção aplicada pelo revisor: quem ainda vai revisar confere a nova versão; aprovações anteriores
    // não cobrem estas mudanças.
    round.lastChange = { agent, step };
    pass.approvals = [];
  }
  if (control.status === 'complete' && !codeChanged) pass.approvals.push(agent);
  else if (control.status !== 'complete') pass.issues = true;
  if (stage === 'verificacao' && control.status !== 'complete') pass.issues = true;
  return round;
}

export function roundDone(round, available) {
  if (!round) return false;
  const copy = structuredClone(round);
  return Boolean(planNext(copy, available).done);
}

// Quem deve falar depois do atual, para mostrar a fila na interface.
export function upcoming(round, available, currentPlan) {
  if (!round) return [];
  if (round.lane === 'chat') {
    const preview = structuredClone(round), nextAgents = [];
    let turn = currentPlan;
    while (turn?.agent && nextAgents.length < 3) {
      recordTurn(preview, turn);
      turn = planNext(preview, available);
      if (turn.agent) nextAgents.push(turn.agent);
    }
    return nextAgents;
  }
  const reviewers = [...(round.calls || []).map(call => call.agent), ...(round.pass?.reviewers || [])];
  return [...new Set(reviewers)].filter(a => available.includes(a) && a !== currentPlan.agent && a !== round.lastChange?.agent).slice(0, 3);
}

// Instruções de cada papel na rodada.
export function stageDirections(stage, { round, agent, parentRole, readOnly = false, called = false }) {
  const lead = SPEAKER[round?.lead] || 'o líder';
  const order = (round?.order || []).map((a) => SPEAKER[a]).join(' → ');
  const parent = parentRole ? SPEAKER[parentRole] : null;
  const porQuem = parentRole === 'user' ? 'pelo usuário' : `por ${parent}`;
  const absent = Object.entries(round?.absent || {}).map(([a, why]) => `${SPEAKER[a] || a} (${why})`).join('; ');
  const group = `RODADA EM GRUPO: um participante fala por vez, na ordem ${order}${round?.lane === 'chat' && !round.quick ? `, e ${lead} fecha com a síntese` : ''}.${absent ? ` Fora desta rodada, segundo a coordenação: ${absent}. Não fale por quem está ausente.` : ''} Você lê tudo o que já foi dito nesta rodada (incluindo orientações que o usuário mandou durante a rodada, que têm prioridade). Dirija-se aos colegas pelo nome quando responder a um ponto deles. Não repita o que já foi dito: acrescente.` +
    ` Para pedir a resposta direta de um colega agora, escreva @GPT, @Claude ou @Gemini no texto: ele fala logo depois de você, fora da fila (até ${MAX_CHAMADAS} chamadas por rodada, somando as do usuário). Use só quando precisar da resposta dele; para apenas citar alguém, escreva o nome sem @.` +
    (called && parent ? ` Você foi chamado com @ ${porQuem}: comece respondendo diretamente ao que ${parentRole === 'user' ? 'ele pediu' : 'foi perguntado ou afirmado'}.` : '');
  const texts = {
    abertura: `Você abre a rodada como líder no Chat. Responda ao pedido com uma proposta concreta e organizada: o que entendeu, a solução que recomenda e por quê, decisões, riscos e o que ainda precisa ser decidido. Os colegas vão analisar sua proposta logo em seguida, então deixe claro o que está em aberto.`,
    analise: `Você analisa a proposta em discussão${parent ? `, respondendo diretamente ${parentRole === 'user' ? 'ao usuário' : `a ${parent}`}` : ''}. Diga onde concorda e por quê (com evidência, não por cortesia), aponte falhas, riscos e casos de borda que ficaram de fora, questione premissas fracas e proponha melhorias concretas que constroem sobre o que já está na mesa. Se discordar de um colega, explique a alternativa. Seja específico e breve.`,
    sintese: `Você fecha a rodada. Consolide a discussão para o usuário: a versão final da proposta incorporando as críticas aceitas, uma linha para cada crítica recusada com o motivo, decisões, pendências e o próximo passo. Se o próximo passo for criar ou alterar arquivos, recomende mudar a sala para o modo Code.`,
    implementacao: `Você lidera a implementação no modo Code. Inspecione o projeto real, implemente a solução pedida dentro das restrições do usuário e execute verificações. Explique o que fez, o que testou e as decisões que os colegas devem revisar. Em seguida eles vão revisar e testar seu trabalho.`,
    revisao: readOnly
      ? `Você revisa em modo somente leitura${parent ? `, depois de ${parent}` : ''}. Leia os arquivos reais, separe o comprovado das hipóteses e relate achados com arquivo, linha, efeito e correção sugerida.`
      : `Você revisa e testa o trabalho real nos arquivos${parent ? `, depois de ${parent}` : ''} (não confie só no relato). Rode verificações, procure falhas, casos de borda e problemas de arquitetura, e leve em conta as revisões anteriores desta rodada. Você pode aplicar diretamente correções pontuais e seguras, descrevendo cada uma; para mudanças maiores, descreva a correção para ${lead} aplicar. Use status complete só se a versão atual atende ao pedido; continue se algo precisa mudar.`,
    refino: `Você incorpora as revisões desta rodada. Leia cada crítica dos colegas, aplique as correções aceitas, explique em uma linha as recusadas e verifique tudo de novo. Os colegas vão revisar a nova versão.`,
    replica: `Você já falou nesta rodada e foi chamado de novo com @${parent ? ` ${porQuem}` : ''}. Responda diretamente ao ponto, em poucas linhas e com evidência. Não refaça a análise completa nem repita o que já disse.`,
    verificacao: `Um colega alterou arquivos depois da última revisão. Confira exatamente essas mudanças nos arquivos reais e rode as verificações. Use status complete se a versão atual está correta; continue (ou corrija) se não estiver.`,
  };
  return `${group}\nSEU PAPEL (${STAGES[stage]?.label || stage}): ${texts[stage] || ''}`;
}
