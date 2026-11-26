import { isAbsolute } from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
  access: 'chat', internet: false, workspace: '',
  codexModel: '', claudeModel: '',
  geminiModel: 'auto', effort: 'medium', timeoutMinutes: 15,
  // Esforço por participante; vazio usa o padrão do modelo. "effort" fica só para salas antigas.
  codexEffort: '', claudeEffort: '', geminiEffort: '',
  // Propósito da sala: chat (ideias, GPT lidera) ou code (arquivos, Claude lidera).
  mode: 'chat',
  maxSteps: 8, handoffPercent: 85, autoResume: true,
  // Autonomia: aprova sozinha as ações dos agentes nesta sala (dentro do acesso concedido). Desligada por padrão.
  autoApprove: false,
  // Integração total: cada cliente roda como na interface oficial (skills, plugins, subagentes, MCP, navegador…).
  fullIntegration: false,
  // Contexto incremental: sessão retomada recebe só o que mudou desde a última fala do participante.
  incrementalContext: true,
  // Conversa renovada: quando o contexto de um participante passa deste tamanho (tokens), a próxima fala começa
  // uma conversa nova com o estado consolidado da sala. Toda chamada de ferramenta relê o contexto inteiro. 0 desliga.
  sessionMaxTokens: 140000,
  // Rodadas por fala no AI Studio. Até duas retentativas adicionais compartilham a reserva da fala.
  // Na última, as ferramentas ficam desligadas e ele responde com o que já verificou.
  studioToolRounds: 6,
  // Teto de chamadas de ferramenta por fala do Claude e do GPT (1.6). Ao atingir, a fala não se perde: o participante
  // para de usar ferramentas e responde com o que já fez e verificou. É uma rede de segurança contra falas que releem
  // o contexto dezenas de vezes; 0 desliga.
  toolCallLimit: 80,
  // Servidores MCP das configurações do próprio usuário que esta sala não carrega na integração total (1.6).
  mcpExclude: [],
  reaEnabled: true, browserEnabled: true, githubEnabled: true,
  codePreference: ['claude','codex','gemini'], chatPreference: ['codex','claude','gemini'],
});
export const MODEL_OPTIONS = {
  codex: [{id:'gpt-6-astra',label:'GPT-6 Astra'}],
  claude: [{id:'claude-opus-5-5',label:'Claude Opus 5.5'}],
  gemini: [{id:'auto',label:'Automático do Gemini'}],
};
export function normalizeSettings(value = {}, previous = DEFAULT_SETTINGS) {
  const fail = text => { throw Object.assign(new Error(text), {statusCode:400}); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Configurações inválidas.');
  for (const key of Object.keys(value)) if (!Object.hasOwn(DEFAULT_SETTINGS,key)) fail(`Configuração desconhecida: ${key}`);
  const settings = {...DEFAULT_SETTINGS,...previous,...value};
  if (!['chat','project','computer'].includes(settings.access)) fail('Tipo de acesso inválido.');
  if (typeof settings.internet !== 'boolean') fail('A opção de pesquisa deve ser verdadeira ou falsa.');
  if (typeof settings.workspace !== 'string' || settings.workspace.length > 2048 || /[\x00-\x1f]/.test(settings.workspace)) fail('Caminho da pasta inválido.');
  settings.workspace = settings.workspace.trim();
  if (settings.workspace && !isAbsolute(settings.workspace)) fail('Escolha uma pasta com caminho completo.');
  for (const key of ['codexModel','claudeModel','geminiModel']) {
    if (typeof settings[key] !== 'string' || (settings[key] && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(settings[key]))) fail('Identificador de modelo inválido.');
  }
  if (!['low','medium','high','xhigh','max'].includes(settings.effort)) fail('Nível de raciocínio inválido.');
  for (const key of ['codexEffort','claudeEffort','geminiEffort']) {
    const allowed = ['','minimal','low','medium','high','xhigh','max'];
    if (key === 'codexEffort') allowed.push('none','ultra');
    if (!allowed.includes(settings[key])) fail('Nível de esforço inválido.');
  }
  if (!['chat','code'].includes(settings.mode)) fail('Modo da sala inválido.');
  if (!Number.isInteger(settings.timeoutMinutes) || settings.timeoutMinutes < 1 || settings.timeoutMinutes > 60) fail('Use de 1 a 60 minutos por agente.');
  if (!Number.isInteger(settings.maxSteps) || settings.maxSteps < 2 || settings.maxSteps > 24) fail('Use de 2 a 24 participações por tarefa.');
  if (!Number.isInteger(settings.handoffPercent) || settings.handoffPercent < 50 || settings.handoffPercent > 95) fail('Use um limite preventivo de 50% a 95%.');
  if (typeof settings.autoResume !== 'boolean') fail('Retomada automática inválida.');
  if (typeof settings.autoApprove !== 'boolean') fail('A opção de autonomia deve ser verdadeira ou falsa.');
  if (typeof settings.fullIntegration !== 'boolean') fail('A opção de integração total deve ser verdadeira ou falsa.');
  if (typeof settings.incrementalContext !== 'boolean') fail('A opção de contexto incremental deve ser verdadeira ou falsa.');
  if (!Number.isInteger(settings.sessionMaxTokens) || (settings.sessionMaxTokens !== 0 && (settings.sessionMaxTokens < 40000 || settings.sessionMaxTokens > 1000000))) fail('Use de 40 mil a 1 milhão de tokens para renovar a conversa, ou 0 para desligar.');
  if (!Number.isInteger(settings.studioToolRounds) || settings.studioToolRounds < 2 || settings.studioToolRounds > 20) fail('Use de 2 a 20 rodadas por fala do Gemini no AI Studio.');
  if (!Number.isInteger(settings.toolCallLimit) || (settings.toolCallLimit !== 0 && (settings.toolCallLimit < 10 || settings.toolCallLimit > 300))) fail('Use de 10 a 300 chamadas de ferramenta por fala, ou 0 para desligar o teto.');
  if (!Array.isArray(settings.mcpExclude) || settings.mcpExclude.length > 64 || settings.mcpExclude.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(name))) fail('Lista de servidores MCP inválida.');
  settings.mcpExclude = [...new Set(settings.mcpExclude)].sort();
  for(const key of ['reaEnabled','browserEnabled','githubEnabled'])if(typeof settings[key]!=='boolean')fail('Configuração de ferramenta inválida.');
  for (const key of ['codePreference','chatPreference']) {
    if (!Array.isArray(settings[key]) || settings[key].length!==3 || new Set(settings[key]).size!==3 || settings[key].some(p=>!['codex','claude','gemini'].includes(p))) fail('A preferência deve conter os três participantes, sem repetição.');
    settings[key]=[...settings[key]];
  }
  return settings;
}
