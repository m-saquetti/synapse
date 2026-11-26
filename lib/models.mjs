// Nomes oficiais e níveis de esforço dos modelos, independentes do jeito que cada cliente local os informa.
// Os catálogos chegam do Codex (OpenAI), do Claude Code (Anthropic), do AI Studio e do Antigravity (Google)
// com identificadores, apelidos e variantes; aqui viram uma lista limpa por provedor.

export const PROVIDER_INFO = Object.freeze({
  codex: { name: 'GPT', company: 'OpenAI', client: 'Codex' },
  claude: { name: 'Claude', company: 'Anthropic', client: 'Claude Code' },
  gemini: { name: 'Gemini', company: 'Google', client: 'Google' },
});

// Ordem do menor para o maior raciocínio; serve para escolher o nível suportado mais próximo.
export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const EFFORT_LABELS = Object.freeze({ none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max', ultra: 'Ultra' });
// Nome que o cliente oficial de cada participante mostra, quando difere do padrão. Claude Code: o seletor de
// esforço chama xhigh de "Extra" (conferido no binário do Claude Code instalado em 23/11).
export const EFFORT_NAMES = Object.freeze({ codex: Object.freeze({ xhigh: 'Extra high' }), claude: Object.freeze({ xhigh: 'Extra' }) });
export const effortLabel = (provider, level) => EFFORT_NAMES[provider]?.[level] || EFFORT_LABELS[level] || level;
// Níveis que cada provedor expõe quando o catálogo não informa os do modelo.
export const PROVIDER_EFFORTS = Object.freeze({
  codex: ['low', 'medium', 'high'],
  claude: ['low', 'medium', 'high'],
  gemini: ['low', 'high'],
});
export const STUDIO_EFFORTS = ['minimal', 'low', 'medium', 'high'];
export function studioEfforts(id) {
  return ['auto','gemini-4-hydrogen','api:gemini-4-hydrogen'].includes(id) ? ['low','medium','high','xhigh'] : STUDIO_EFFORTS;
}

const EFFORT_SUFFIX = /-(minimal|low|medium|high|xhigh|max)$/i;
const titleWord = (word) => {
  const lower = word.toLowerCase();
  if (['mini', 'nano'].includes(lower)) return lower;
  if (lower === 'lite') return 'Lite';
  if (/^\d/.test(word)) return word;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
};
const cleanText = (text) => String(text || '').replace(/\s+/g, ' ').trim();
const unique = (values) => [...new Set(values.filter(Boolean))];
export function sortEfforts(values = []) {
  return unique(values.map((v) => String(v).toLowerCase())).filter((v) => EFFORT_ORDER.includes(v))
    .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
}

// ---------------------------------------------------------------- OpenAI
export function openaiName(id, displayName) {
  const shown = cleanText(displayName);
  if (shown && shown.toLowerCase() !== String(id).toLowerCase() && /^(gpt|o\d|codex)/i.test(shown)) return shown.replace(/^gpt/i, 'GPT');
  const raw = String(id || '').trim();
  const gpt = raw.match(/^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ' ' + gpt[2].split('-').map(titleWord).join(' ') : ''}`;
  if (/^o\d/i.test(raw)) return raw.toLowerCase().split('-').map((w, i) => (i ? titleWord(w) : w)).join(' ');
  return shown || raw;
}

// ---------------------------------------------------------------- Anthropic
const CLAUDE_ID = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i;
export function claudeName(id, displayName = '', description = '') {
  for (const text of [id, displayName, description]) {
    const match = String(text || '').trim().match(CLAUDE_ID);
    if (match) {
      const family = titleWord(match[1]);
      return `Claude ${family} ${match[2]}${match[3] ? '.' + match[3] : ''}${match[4] ? ' · 1M de contexto' : ''}`;
    }
  }
  // Rótulos de apelido do cliente ("Default (recommended)", "Opus", "Sonnet (1M context)").
  const shown = cleanText(displayName).replace(/\s*\((?:recommended|recomendado)\)\s*/i, '');
  const described = cleanText(description).match(/\b(Opus|Sonnet|Haiku|Fable|Mythos)\s+(\d+(?:\.\d+)?)/i);
  if (described) return `Claude ${titleWord(described[1])} ${described[2]}`;
  if (/^default$/i.test(shown) || /^default$/i.test(String(id))) return 'Claude · padrão da conta';
  if (/^(opus|sonnet|haiku|fable|mythos)\b/i.test(shown)) return `Claude ${shown.replace(/^(\w+)/, (w) => titleWord(w))}`;
  return shown.startsWith('Claude') ? shown : shown ? `Claude ${shown}` : String(id);
}

// ---------------------------------------------------------------- Google
export function geminiBase(id) {
  const raw = String(id || '').replace(/^api:/, '');
  const match = raw.match(EFFORT_SUFFIX);
  return { base: match ? raw.slice(0, -match[0].length) : raw, effort: match ? match[1].toLowerCase() : '' };
}
export function geminiName(id, displayName = '') {
  const { base } = geminiBase(id);
  const shown = cleanText(displayName);
  if (shown && !/^gemini-/i.test(shown) && /^gemini\b/i.test(shown) && !EFFORT_SUFFIX.test(shown.replace(/\s+/g, '-'))) return shown.replace(/\s*\((?:high|low|medium|xhigh)\)$/i, '');
  const parts = base.split('-');
  if (parts[0]?.toLowerCase() !== 'gemini') return shown || base;
  let preview = false;
  const words = [];
  for (const part of parts.slice(1)) {
    if (/^(preview|exp|experimental)$/i.test(part)) { preview = true; continue; }
    if (/^\d{2,}$/.test(part) && words.length > 1) continue; // datas de prévia
    words.push(titleWord(part));
  }
  const name = `Gemini ${words.join(' ')}`.replace(/Flash Lite/, 'Flash-Lite');
  return preview ? `${name} (prévia)` : name;
}

// ---------------------------------------------------------------- catálogo
// Converte as linhas de cada cliente em {id, label, efforts, defaultEffort, ...} sem duplicatas.
export function normalizeCatalog(provider, rows = []) {
  if (provider === 'gemini') return normalizeGemini(rows);
  const seen = new Map();
  for (const row of rows) {
    if (!row?.id) continue;
    const label = provider === 'codex' ? openaiName(row.id, row.label) : claudeName(row.id, row.label, row.description);
    const entry = { ...row, label, efforts: sortEfforts(row.efforts || []), group: provider === 'codex' ? 'OpenAI' : 'Anthropic' };
    if (!entry.efforts.length) delete entry.efforts;
    if (!seen.has(row.id)) seen.set(row.id, entry);
  }
  return [...seen.values()];
}

function normalizeGemini(rows) {
  // Variantes do mesmo modelo por nível de raciocínio (ex.: -low, -high, -xhigh no Antigravity)
  // viram um único item com seletor de esforço.
  const groups = new Map();
  for (const row of rows) {
    if (!row?.id) continue;
    const studio = String(row.id).startsWith('api:');
    const { base, effort } = geminiBase(row.id);
    const key = (studio ? 'api:' : '') + base;
    const group = groups.get(key) || {
      ...row, id: key, label: geminiName(row.id, row.label), route: studio ? 'studio' : 'native',
      group: studio ? 'Google AI Studio · chave de API' : 'Conta Google · Antigravity', variants: { ...row.variants },
    };
    if (effort) group.variants[effort] = row.id;
    else if (!row.variants || row.baseId) group.baseId = row.baseId || row.id;
    // Disponibilidade do grupo: a melhor entre as variantes.
    const rank = { available: 0, listed: 1, unknown: 2, cooldown: 3, locked: 4 };
    if ((rank[row.availability] ?? 2) < (rank[group.availability] ?? 2)) group.availability = row.availability;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const variantEfforts = sortEfforts(Object.keys(group.variants));
    const efforts = variantEfforts.length ? variantEfforts : group.route === 'studio' ? studioEfforts(group.id) : [];
    const entry = { ...group, efforts };
    if (!efforts.length) delete entry.efforts;
    if (!variantEfforts.length) delete entry.variants;
    // Sem a variante "pura", o padrão do grupo é a primeira variante que o cliente listou.
    if (variantEfforts.length && !group.baseId) entry.defaultEffort = Object.keys(group.variants)[0].toLowerCase();
    return entry;
  });
}

// Encontra a linha do catálogo para o modelo salvo na sala (aceita IDs antigos com sufixo de esforço).
export function findModel(provider, catalog = [], id) {
  if (!id) return null;
  const direct = catalog.find((m) => m.id === id);
  if (direct || provider !== 'gemini') return direct || null;
  const studio = String(id).startsWith('api:');
  const { base } = geminiBase(id);
  return catalog.find((m) => m.id === (studio ? 'api:' : '') + base) || null;
}

// Nível realmente enviado: o pedido, se o modelo aceita; senão o mais próximo suportado.
export function resolveEffort(requested, model) {
  const wanted = String(requested || '').toLowerCase();
  if (!wanted || model?.supportsEffort === false) return { effort: undefined, adjusted: false };
  const supported = model?.efforts;
  if (!supported?.length) return { effort: wanted, adjusted: false };
  if (supported.includes(wanted)) return { effort: wanted, adjusted: false };
  const target = EFFORT_ORDER.indexOf(wanted);
  const nearest = [...supported].sort((a, b) => Math.abs(EFFORT_ORDER.indexOf(a) - target) - Math.abs(EFFORT_ORDER.indexOf(b) - target) || EFFORT_ORDER.indexOf(b) - EFFORT_ORDER.indexOf(a))[0];
  return { effort: nearest, adjusted: true, requested: wanted };
}

// ID que o Antigravity deve receber: a variante do esforço escolhido, quando o modelo tem variantes.
export function geminiVariant(model, savedId, effort) {
  if (!model?.variants) return model?.baseId || savedId;
  if (effort && model.variants[effort]) return model.variants[effort];
  const fromSaved = geminiBase(savedId).effort; // salas antigas guardavam a variante no próprio ID
  if (fromSaved && model.variants[fromSaved]) return model.variants[fromSaved];
  return model.baseId || model.variants[model.defaultEffort] || Object.values(model.variants)[0];
}

export function displayModel(provider, catalog, id) {
  if (!id || id === 'auto') return provider === 'gemini' ? 'Automático' : 'Padrão da conta';
  const model = findModel(provider, catalog, id);
  if (model) return model.label;
  return provider === 'codex' ? openaiName(id) : provider === 'claude' ? claudeName(id) : geminiName(id);
}
