// Análises de uso: normaliza o consumo de tokens que cada cliente oficial informa por fala.
// Somente leitura. Os três formatos são diferentes, e a interface precisa compará-los na mesma escala:
//   novos  = entrada processada sem cache (o que mais pesa na cota)
//   cache  = entrada relida do cache
//   saida  = texto e raciocínio gerados (pensamento é a parte de raciocínio, quando o cliente informa)
const num = (v) => (Number.isFinite(v) ? v : 0);

function codexCounts(t) {
  return { novos: Math.max(0, num(t.inputTokens) - num(t.cachedInputTokens)), cache: num(t.cachedInputTokens),
    saida: num(t.outputTokens), pensamento: num(t.reasoningOutputTokens) };
}

/** Uso de uma fala na escala comum. `anterior` é o total da conversa do Codex na fala anterior (mesma sala e modo). */
export function normalizeUsage(role, u, anterior) {
  if (!u || typeof u !== 'object') return null;
  if (role === 'claude') {
    const ultima = Array.isArray(u.iterations) && u.iterations.length ? u.iterations.at(-1) : null;
    return { novos: num(u.input_tokens) + num(u.cache_creation_input_tokens), cache: num(u.cache_read_input_tokens),
      saida: num(u.output_tokens), pensamento: num(u.output_tokens_details?.thinking_tokens),
      contexto: ultima ? num(ultima.input_tokens) + num(ultima.cache_read_input_tokens) + num(ultima.cache_creation_input_tokens) : null };
  }
  if (role === 'codex') {
    const contexto = u.last ? num(u.last.inputTokens) : null;
    // 1.4.1+: a própria fala é medida na captura (u.turn). Antes, só existia o total acumulado da conversa.
    if (u.turn) return { ...codexCounts(u.turn), contexto };
    const total = u.total || {};
    // A diferença só pode ser da mesma conversa se cobre pelo menos a última requisição,
    // inclusive nos contadores de saída e cache.
    if (anterior && Object.entries(total).every(([k,v])=>v-num(anterior[k])>=num(u.last?.[k]))) {
      const delta = Object.fromEntries(Object.keys(total).map((k) => [k, Math.max(0, num(total[k]) - num(anterior[k]))]));
      return { ...codexCounts(delta), contexto, estimado: true };
    }
    return { ...codexCounts(total), contexto, estimado: true };
  }
  if (u.studioRequestsByModel && !('promptTokenCount' in u || 'inputTokens' in u || 'outputTokens' in u || 'totalTokenCount' in u)) return null;
  if ('promptTokenCount' in u || 'totalTokenCount' in u && u.studioRequestsByModel) {
    return { novos: Math.max(0, num(u.promptTokenCount) - num(u.cachedContentTokenCount)), cache: num(u.cachedContentTokenCount),
      saida: num(u.candidatesTokenCount) + num(u.thoughtsTokenCount), pensamento: num(u.thoughtsTokenCount),
      requisicoes: u.requests || 1, contexto: null };
  }
  return { novos: num(u.inputTokens), cache: num(u.cachedReadTokens), saida: num(u.outputTokens),
    pensamento: num(u.thoughtTokens), contexto: null }; // Antigravity soma as requisições da fala: não mede o tamanho da conversa.
}

/** Uma linha por fala concluída com uso informado. Filtra por período (ISO) e, se informado, por sala. */
export function usageRows(db, { since = '', roomId = '' } = {}) {
  const linhas = db.prepare(`SELECT m.id, m.roomId, r.title AS sala, m.role, m.status, m.model, m.usage, m.createdAt, j.mode, j.settings
    FROM messages m LEFT JOIN jobs j ON j.id = m.jobId LEFT JOIN rooms r ON r.id = m.roomId
    WHERE m.role IN ('codex','claude','gemini') AND m.status IN ('completed','interrupted') AND m.usage IS NOT NULL
    ORDER BY m.createdAt, m.rowid`).all();
  const totalCodex = new Map();
  const saida = [];
  for (const l of linhas) {
    let u; try { u = JSON.parse(l.usage); } catch { continue; }
    if(l.status==='interrupted' && !u?.partialUsage)continue;
    const chave = `${l.roomId}|${l.mode || ''}`;
    const n = normalizeUsage(l.role, u, l.role === 'codex' ? totalCodex.get(chave) : undefined);
    if (l.role === 'codex' && u?.total) totalCodex.set(chave, u.total);
    if (!n || l.createdAt < since || (roomId && l.roomId !== roomId)) continue;
    let ajustes = {}; try { ajustes = JSON.parse(l.settings || '{}'); } catch {}
    saida.push({ id: l.id, roomId: l.roomId, sala: l.sala || '', role: l.role, model: l.model || '', at: l.createdAt,
      mode: l.mode || '', effort: ajustes[`${l.role}Effort`] || '', ...n, ...(u.partialUsage?{interrompida:true}:{}) });
  }
  return saida;
}

// A cota diária do AI Studio renova à meia-noite do horário do Pacífico (a pausa gravada em 22/11 ia até 07:59:59Z).
export function pacificMidnight(now = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(now)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  for (const offset of [7, 8]) {
    const candidate = Date.UTC(parts.year, parts.month - 1, parts.day, offset);
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(new Date(candidate)));
    if (hour === 0 && candidate <= now) return new Date(candidate).toISOString();
  }
  return new Date(now - 86400000).toISOString();
}

/** Requisições ao AI Studio contadas pela Synapse desde `since`, por modelo (falas concluídas ou interrompidas com uso). */
export function studioRequests(db, since) {
  const linhas = db.prepare(`SELECT model, usage FROM messages WHERE role = 'gemini' AND status IN ('completed','interrupted') AND usage IS NOT NULL AND createdAt >= ?`).all(since);
  const porModelo = new Map();
  for (const l of linhas) {
    let u; try { u = JSON.parse(l.usage); } catch { continue; }
    if (!u) continue;
    const legacyModel = String(l.model || 'gemini').replace(/^api:/, '').replace(/^models\//, '');
    const counts = u.studioRequestsByModel ?? ('promptTokenCount' in u ? { [legacyModel]: u.requests ?? 1 } : {});
    for(const [model, requests] of Object.entries(counts)){
      if(!Number.isFinite(requests) || requests<=0)continue;
      const atual = porModelo.get(model) || { model, requests: 0, falas: 0 };
      atual.requests += requests; atual.falas += 1;
      porModelo.set(model, atual);
    }
  }
  return [...porModelo.values()].sort((a, b) => b.requests - a.requests);
}
