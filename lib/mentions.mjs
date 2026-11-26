// @menções, como num grupo de mensagens: @GPT (ou @Codex), @Claude e @Gemini.
// Servem ao usuário (escolher quem responde) e aos participantes (chamar um colega para responder em seguida).
const ALIASES = { gpt: 'codex', codex: 'codex', claude: 'claude', gemini: 'gemini' };
export const MENTION_NAMES = Object.freeze({ codex: 'GPT', claude: 'Claude', gemini: 'Gemini' });

// Ignora código (blocos ``` e trechos `entre crases`), e-mails e caminhos, para "@types/node" ou "a@gemini.dev" não contarem.
export function stripCode(text) {
  return String(text || '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
}
// Depois do nome: fim de frase ("@GPT.") vale; ".dev", "/x" ou "-y" indicam endereço ou pacote e não valem.
const MENTION = /(^|[^\w@./\\-])@(gpt|codex|claude|gemini)(?![\w@/\\-]|\.\w)/gi;

// Participantes mencionados, na ordem da primeira menção e sem repetição.
export function parseMentions(text, { exclude } = {}) {
  const found = [];
  for (const match of stripCode(text).matchAll(MENTION)) {
    const agent = ALIASES[match[2].toLowerCase()];
    if (agent && agent !== exclude && !found.includes(agent)) found.push(agent);
  }
  return found;
}
