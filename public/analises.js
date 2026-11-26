/* Synapse · aba Análises: consumo de tokens por participante, horário, esforço e modo.
   Gráficos em SVG próprios (a CSP só permite scripts locais). Todo texto entra por textContent.
   Usa do app.js: api, state, names, effortLabel, element, EFFORT_ORDER, MOVIMENTO. */
'use strict';
const Analises = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const PAPEIS = ['codex', 'claude', 'gemini'];
  const MEDIDAS = { novos: 'tokens novos', cache: 'tokens lidos do cache', saida: 'tokens de saída', pensamento: 'tokens de raciocínio', total: 'tokens no total' };
  // Partes de uma fala na composição: a saída aparece sem o raciocínio, que é uma parte dela.
  const PARTES = [['novos', 'Novos'], ['cache', 'Cache'], ['texto', 'Saída (texto)'], ['pensamento', 'Raciocínio']];
  const HORA = 3600e3, DIA = 24 * HORA;
  const PERIODOS = { '24h': DIA, '7d': 7 * DIA, '30d': 30 * DIA, tudo: 0 };
  const CHAVE = 'synapse.analises';
  const filtro = { periodo: '7d', escopo: 'todas', medida: 'novos', ocultos: [] };
  try { Object.assign(filtro, JSON.parse(localStorage.getItem(CHAVE)) || {}); } catch {}
  if (!MEDIDAS[filtro.medida]) filtro.medida = 'novos';
  if (!Array.isArray(filtro.ocultos)) filtro.ocultos = [];
  const salvarFiltro = () => { try { localStorage.setItem(CHAVE, JSON.stringify(filtro)); } catch {} };
  // Participantes escondidos pela legenda (clique). Valem para todos os gráficos, os indicadores e a tabela.
  const visiveis = (rows) => rows.filter((r) => !filtro.ocultos.includes(r.role));
  let linhas = [], pedido = 0, carregadoPara = '', ultimaLeitura = '', timer = null, ativo = false;
  const compacto = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
  const inteiro = new Intl.NumberFormat('pt-BR');
  const fmt = (v) => compacto.format(Math.round(v || 0));
  const valor = (r, m = filtro.medida) => (m === 'total' ? r.novos + r.cache + r.saida : r[m] || 0);
  const $a = (id) => document.getElementById(id);
  const quando = (t) => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  function svg(tag, attrs = {}, pai) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (pai) pai.append(n);
    return n;
  }
  // Barra com o topo arredondado (4 px) e a base reta, apoiada na linha de base.
  function barraTopo(x, y, w, h, r = 4) {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  function escala(max) {
    if (max <= 0) return { topo: 1, passos: [0, 1] };
    const bruto = max / 4, mag = 10 ** Math.floor(Math.log10(bruto)), n = bruto / mag;
    const passo = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
    const topo = Math.ceil(max / passo) * passo;
    return { topo, passos: Array.from({ length: Math.round(topo / passo) + 1 }, (_, i) => i * passo) };
  }

  // ------------------------------------------------------------------ dica flutuante
  function dica(alvo, titulo, itens) {
    alvo.addEventListener('pointerenter', () => mostrarDica(alvo, titulo, itens));
    alvo.addEventListener('pointermove', (e) => posicionarDica(e));
    alvo.addEventListener('pointerleave', () => { $a('av-tip').hidden = true; alvo.classList.remove('av-foco'); });
  }
  function mostrarDica(alvo, titulo, itens) {
    const tip = $a('av-tip');
    tip.replaceChildren(element('strong', '', titulo));
    // papel '-' = linha simples (sem ponto e sem separador); '' = linha de total, com separador.
    for (const [papel, rotulo, v] of itens) {
      const linha = element('span', `av-tip-linha ${papel === '-' ? 'simples' : papel ? 'role-' + papel : ''}`);
      if (papel && papel !== '-') linha.append(element('i', 'av-ponto'));
      linha.append(element('em', '', rotulo), element('b', '', v));
      tip.append(linha);
    }
    tip.hidden = false; alvo.classList.add('av-foco');
  }
  function posicionarDica(e) {
    const tip = $a('av-tip'), caixa = $a('analytics-view').getBoundingClientRect();
    const x = Math.min(e.clientX - caixa.left + 14, caixa.width - tip.offsetWidth - 8);
    const y = e.clientY - caixa.top + $a('analytics-view').scrollTop - tip.offsetHeight - 12;
    tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8 + $a('analytics-view').scrollTop, y)}px)`;
  }

  // ------------------------------------------------------------------ dados
  function desde() {
    const dur = PERIODOS[filtro.periodo];
    return dur ? new Date(Date.now() - dur).toISOString() : '';
  }
  async function carregar(forcar = false) {
    const sala = filtro.escopo === 'sala' ? state.selectedId || '' : '';
    const assinatura = `${filtro.periodo}|${sala}`;
    const meu = ++pedido;
    if (!forcar && assinatura === carregadoPara) {
      $a('analytics-view').classList.remove('carregando');
      $a('av-estado').textContent=ultimaLeitura;
      return renderizar();
    }
    $a('av-estado').textContent = 'Atualizando…';
    $a('analytics-view').classList.add('carregando');
    try {
      const q = new URLSearchParams({ since: desde(), roomId: sala });
      const dados = await api(`/api/analytics?${q}`);
      if (meu !== pedido) return;
      linhas = dados.rows || []; carregadoPara = assinatura;
      ultimaLeitura = `Atualizado às ${new Date(dados.generatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
      $a('av-estado').textContent = ultimaLeitura;
      renderizar(true);
    } catch (erro) {
      if (meu === pedido) $a('av-estado').textContent = erro.message;
    } finally { if (meu === pedido) $a('analytics-view').classList.remove('carregando'); }
  }

  // ------------------------------------------------------------------ indicadores
  function contar(no, alvo) {
    if (!MOVIMENTO) { no.textContent = fmt(alvo); return; }
    const de = Number(no.dataset.v || 0), t0 = performance.now();
    no.dataset.v = alvo;
    const passo = (t) => {
      const p = Math.min(1, (t - t0) / 800), e = 1 - (1 - p) ** 3;
      no.textContent = fmt(de + (alvo - de) * e);
      if (p < 1) requestAnimationFrame(passo);
    };
    requestAnimationFrame(passo);
  }
  function renderKpis(rows) {
    const soma = (m) => rows.reduce((s, r) => s + valor(r, m), 0);
    const porHora = new Map();
    for (const r of rows) { const h = Math.floor(Date.parse(r.at) / HORA) * HORA; porHora.set(h, (porHora.get(h) || 0) + valor(r)); }
    const pico = [...porHora].sort((a, b) => b[1] - a[1])[0];
    const totalFala = rows.length ? soma('total') / rows.length : 0;
    const entrada = soma('novos') + soma('cache'), aproveitamento = entrada ? (100 * soma('cache')) / entrada : 0;
    const kpis = [
      { id: 'falas', rotulo: 'Falas medidas', v: rows.length, inteiro: true, sub: `${PAPEIS.filter((p) => rows.some((r) => r.role === p)).length} participantes` },
      { id: 'novos', rotulo: 'Tokens novos', v: soma('novos'), sub: 'entrada processada sem cache', neon: true },
      { id: 'cache', rotulo: 'Lidos do cache', v: soma('cache'), sub: 'contexto relido a cada ferramenta' },
      { id: 'saida', rotulo: 'Saída', v: soma('saida'), sub: 'texto e raciocínio gerados' },
      { id: 'pensamento', rotulo: 'Raciocínio', v: soma('pensamento'), sub: 'parte da saída, quando o cliente informa' },
      { id: 'aproveitamento', rotulo: 'Entrada via cache', texto: rows.length ? `${aproveitamento.toFixed(1).replace('.', ',')}%` : '—', sub: 'da entrada veio do cache (contexto relido)' },
      { id: 'media', rotulo: 'Média por fala', v: totalFala, sub: 'novos + cache + saída' },
      { id: 'pico', rotulo: 'Hora de pico', texto: pico ? new Date(pico[0]).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit' }) + 'h' : '—', sub: pico ? `${fmt(pico[1])} ${MEDIDAS[filtro.medida]}` : 'sem dados' },
    ];
    const caixa = $a('av-kpis');
    if (caixa.children.length !== kpis.length) {
      caixa.replaceChildren(...kpis.map((k, i) => {
        const card = element('div', `av-kpi${k.neon ? ' neon' : ''}`); card.style.setProperty('--i', i);
        card.append(element('span', 'av-kpi-rotulo', k.rotulo), element('strong', 'av-kpi-valor'), element('small', 'av-kpi-sub'));
        card.dataset.id = k.id; return card;
      }));
    }
    kpis.forEach((k, i) => {
      const card = caixa.children[i], alvo = card.querySelector('strong');
      if (k.texto !== undefined) alvo.textContent = k.texto;
      else if (k.inteiro) alvo.textContent = inteiro.format(k.v);
      else { contar(alvo, k.v); alvo.title = `${inteiro.format(Math.round(k.v))} tokens`; }
      card.querySelector('small').textContent = k.sub;
    });
  }

  // ------------------------------------------------------------------ consumo ao longo do tempo (barras empilhadas)
  function baldes(rows) {
    const fim = Date.now(), dur = PERIODOS[filtro.periodo];
    let passo = dur === DIA ? HORA : dur === 7 * DIA ? 6 * HORA : DIA;
    let inicio = dur ? fim - dur : rows.length ? Date.parse(rows[0].at) : fim - DIA;
    if (!dur && (fim - inicio) / DIA > 45) passo = 7 * DIA;
    const fuso = new Date().getTimezoneOffset() * 60e3;
    inicio = Math.floor((inicio - fuso) / passo) * passo + fuso;
    const n = Math.max(1, Math.ceil((fim - inicio) / passo));
    const lista = Array.from({ length: n }, (_, i) => ({ t: inicio + i * passo, v: { codex: 0, claude: 0, gemini: 0 }, falas: 0 }));
    for (const r of rows) {
      const i = Math.floor((Date.parse(r.at) - inicio) / passo);
      if (lista[i]) { lista[i].v[r.role] += valor(r); lista[i].falas++; }
    }
    return { lista, passo };
  }
  function rotuloBalde(t, passo) {
    const d = new Date(t);
    if (passo < DIA) return passo === HORA ? `${String(d.getHours()).padStart(2, '0')}h` : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit' }) + ` ${String(d.getHours()).padStart(2, '0')}h`;
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }
  function renderTempo(rows) {
    const caixa = $a('av-tempo');
    const W = Math.max(320, caixa.clientWidth || 640), H = 230, m = { t: 12, r: 8, b: 26, l: 52 };
    const { lista, passo } = baldes(rows);
    const max = Math.max(0, ...lista.map((b) => PAPEIS.reduce((s, p) => s + b.v[p], 0)));
    const { topo, passos } = escala(max);
    const area = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'av-svg', role: 'img', 'aria-label': `Consumo de ${MEDIDAS[filtro.medida]} ao longo do tempo` });
    const y = (v) => m.t + (H - m.t - m.b) * (1 - v / topo);
    for (const p of passos) {
      svg('line', { x1: m.l, x2: W - m.r, y1: y(p), y2: y(p), class: p ? 'av-grade-linha' : 'av-base' }, area);
      svg('text', { x: m.l - 8, y: y(p) + 3.5, class: 'av-eixo', 'text-anchor': 'end' }, area).textContent = fmt(p);
    }
    const larg = (W - m.l - m.r) / lista.length, w = Math.max(2, Math.min(28, larg * 0.68));
    const cada = Math.ceil(lista.length / Math.max(2, Math.floor((W - m.l) / 64)));
    lista.forEach((b, i) => {
      const x = m.l + i * larg + (larg - w) / 2;
      let base = y(0);
      const ativos = PAPEIS.filter((p) => b.v[p] > 0);
      const g = svg('g', { class: 'av-coluna', style: `--i:${i}` }, area);
      ativos.forEach((p, k) => {
        const bruto = Math.max(1.5, y(0) - y(b.v[p]));
        const h = k ? Math.max(1, bruto - 2) : bruto; // 2 px de respiro entre segmentos, sem mudar a altura total
        const topoSeg = base - h;
        if (k === ativos.length - 1) svg('path', { d: barraTopo(x, topoSeg, w, h), class: `av-barra role-${p}` }, g);
        else svg('rect', { x, y: topoSeg, width: w, height: h, class: `av-barra role-${p}` }, g);
        base = topoSeg - 2;
      });
      if (i % cada === 0) svg('text', { x: x + w / 2, y: H - 8, class: 'av-eixo', 'text-anchor': 'middle' }, area).textContent = rotuloBalde(b.t, passo);
      const alvo = svg('rect', { x: m.l + i * larg, y: m.t, width: larg, height: H - m.t - m.b, class: 'av-alvo' }, g);
      const total = PAPEIS.reduce((s, p) => s + b.v[p], 0);
      dica(alvo, `${rotuloBalde(b.t, passo)} · ${b.falas} ${b.falas === 1 ? 'fala' : 'falas'}`,
        [...PAPEIS.filter((p) => b.v[p]).map((p) => [p, names[p], fmt(b.v[p])]), ['', 'Total', fmt(total)]]);
    });
    caixa.replaceChildren(area);
    $a('av-tempo-sub').textContent = `${MEDIDAS[filtro.medida][0].toUpperCase()}${MEDIDAS[filtro.medida].slice(1)} por ${passo === HORA ? 'hora' : passo === 6 * HORA ? 'período de 6 horas' : passo === DIA ? 'dia' : 'semana'}, empilhados por participante`;
  }

  // ------------------------------------------------------------------ horários (mapa de calor 3 × 24)
  function renderHoras(rows) {
    const caixa = $a('av-horas');
    const W = Math.max(300, caixa.clientWidth || 420), rotulo = 58, celula = (W - rotulo) / 24, alto = 26, H = alto * 3 + 26;
    const v = Object.fromEntries(PAPEIS.map((p) => [p, Array(24).fill(0)])), n = Object.fromEntries(PAPEIS.map((p) => [p, Array(24).fill(0)]));
    for (const r of rows) { const h = new Date(r.at).getHours(); v[r.role][h] += valor(r); n[r.role][h]++; }
    const max = Math.max(1, ...PAPEIS.flatMap((p) => v[p]));
    const area = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'av-svg', role: 'img', 'aria-label': 'Uso por hora do dia' });
    PAPEIS.forEach((p, linha) => {
      svg('text', { x: 0, y: linha * alto + alto / 2 + 4, class: 'av-eixo forte' }, area).textContent = names[p];
      for (let h = 0; h < 24; h++) {
        const c = svg('rect', { x: rotulo + h * celula + 1, y: linha * alto + 1, width: celula - 2, height: alto - 2, rx: 3,
          class: `av-celula role-${p}${v[p][h] ? '' : ' vazia'}`, style: `--a:${v[p][h] ? (0.14 + 0.86 * (v[p][h] / max)).toFixed(3) : 0};--i:${h + linha * 4}` }, area);
        dica(c, `${names[p]} · ${String(h).padStart(2, '0')}h–${String((h + 1) % 24).padStart(2, '0')}h`, [[p, `${n[p][h]} ${n[p][h] === 1 ? 'fala' : 'falas'}`, fmt(v[p][h])]]);
      }
    });
    for (let h = 0; h < 24; h += 3) svg('text', { x: rotulo + h * celula + celula / 2, y: H - 6, class: 'av-eixo', 'text-anchor': 'middle' }, area).textContent = `${h}h`;
    caixa.replaceChildren(area);
    const somaHora = Array.from({ length: 24 }, (_, h) => PAPEIS.reduce((s, p) => s + v[p][h], 0));
    const pico = somaHora.indexOf(Math.max(...somaHora));
    $a('av-horas-sub').textContent = rows.length ? `Hora do dia em que cada participante mais consome. Pico às ${pico}h.` : 'Hora do dia em que cada participante mais consome.';
  }

  // ------------------------------------------------------------------ barras horizontais reutilizáveis
  function barraH(rotulo, sub, papel, v, max, direita, i) {
    const item = element('div', `av-hbar role-${papel}`); item.style.setProperty('--i', i);
    const topo = element('div', 'av-hbar-topo');
    const nome = element('span', 'av-hbar-nome'); nome.append(element('i', 'av-ponto'), element('b', '', rotulo));
    if (sub) nome.append(element('small', '', sub));
    topo.append(nome, element('span', 'av-hbar-valor', direita));
    const trilho = element('div', 'av-hbar-trilho'), preenchido = element('span');
    preenchido.style.setProperty('--w', `${Math.max(1.5, (v / Math.max(1, max)) * 100).toFixed(2)}%`);
    trilho.append(preenchido); item.append(topo, trilho);
    return item;
  }
  function renderEsforco(rows) {
    const grupos = new Map();
    for (const r of rows) {
      const k = `${r.role}|${r.effort || 'padrao'}`;
      const g = grupos.get(k) || { papel: r.role, nivel: r.effort, soma: 0, n: 0 };
      g.soma += valor(r); g.n++; grupos.set(k, g);
    }
    const ordem = (n) => (n ? EFFORT_ORDER.indexOf(n) : -1);
    const lista = [...grupos.values()].sort((a, b) => PAPEIS.indexOf(a.papel) - PAPEIS.indexOf(b.papel) || ordem(a.nivel) - ordem(b.nivel));
    const max = Math.max(1, ...lista.map((g) => g.soma / g.n));
    $a('av-esforco').replaceChildren(...(lista.length ? lista.map((g, i) => barraH(`${names[g.papel]} · ${g.nivel ? effortLabel(g.papel, g.nivel) : 'Padrão'}`,
      `${g.n} ${g.n === 1 ? 'fala' : 'falas'}`, g.papel, g.soma / g.n, max, `${fmt(g.soma / g.n)} / fala`, i)) : [vazio()]));
  }
  function renderTop(rows) {
    const top = [...rows].sort((a, b) => valor(b) - valor(a)).slice(0, 6);
    const max = top.length ? valor(top[0]) : 1;
    $a('av-top').replaceChildren(...(top.length ? top.map((r, i) => barraH(`${names[r.role]} · ${r.mode === 'code' ? 'Code' : 'Chat'}${r.effort ? ' · ' + effortLabel(r.role, r.effort) : ''}`,
      `${quando(r.at)} · ${r.sala}`, r.role, valor(r), max, fmt(valor(r)), i)) : [vazio()]));
  }
  function vazio(texto = 'Nenhuma fala com uso informado neste período.') { return element('p', 'av-vazio', texto); }

  // ------------------------------------------------------------------ séries por fala (custo de cada fala e tamanho da conversa)
  // Cada fala é um ponto; a linha liga as falas do mesmo participante. A mira acompanha o ponteiro e a dica mostra
  // todos os parâmetros da fala mais próxima. Clique num ponto fixa a dica até o próximo clique.
  function detalhesFala(r) {
    const sala = r.sala && r.sala.length > 34 ? r.sala.slice(0, 33) + '…' : r.sala;
    const itens = [['-', 'Sala', sala || '—'], ['-', 'Modo', `${r.mode === 'code' ? 'Code' : r.mode === 'chat' ? 'Chat' : '—'}${r.effort ? ' · ' + effortLabel(r.role, r.effort) : ''}`],
      [r.role, 'Novos', fmt(r.novos)], [r.role, 'Cache', fmt(r.cache)], [r.role, 'Saída', fmt(r.saida)]];
    if (r.pensamento) itens.push([r.role, 'Raciocínio', fmt(r.pensamento)]);
    if (r.contexto) itens.push([r.role, 'Tamanho da conversa', fmt(r.contexto)]);
    if (r.requisicoes > 1) itens.push([r.role, 'Requisições', inteiro.format(r.requisicoes)]);
    itens.push(['', 'Total', fmt(r.novos + r.cache + r.saida)]);
    return itens;
  }
  function eixoTempo(t0, span) {
    const curto = span <= 10 * DIA; // até 10 dias, a hora evita datas repetidas no eixo
    return (t) => { const d = new Date(t); return curto ? `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${String(d.getHours()).padStart(2, '0')}h` : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }); };
  }
  function renderSerie(caixa, rows, ler, { rotulo, limite = 0, rotuloLimite = '' } = {}) {
    const pts = rows.map((r) => ({ r, t: Date.parse(r.at), v: ler(r) })).filter((p) => Number.isFinite(p.v) && p.v > 0);
    if (!pts.length) { caixa.replaceChildren(vazio(rotulo === 'contexto' ? 'O tamanho da conversa só é informado pelo Claude Code e pelo Codex.' : undefined)); return; }
    const W = Math.max(320, caixa.clientWidth || 640), H = 220, m = { t: 14, r: 14, b: 26, l: 52 };
    const t0 = Math.min(...pts.map((p) => p.t)), t1 = Math.max(...pts.map((p) => p.t)), span = Math.max(HORA, t1 - t0);
    const { topo, passos } = escala(Math.max(limite, ...pts.map((p) => p.v)));
    const x = (t) => m.l + (W - m.l - m.r) * ((t - t0) / span), y = (v) => m.t + (H - m.t - m.b) * (1 - v / topo);
    const area = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'av-svg av-serie', role: 'img', 'aria-label': rotulo === 'contexto' ? 'Tamanho da conversa por fala' : `Custo de cada fala em ${MEDIDAS[filtro.medida]}` });
    for (const p of passos) {
      svg('line', { x1: m.l, x2: W - m.r, y1: y(p), y2: y(p), class: p ? 'av-grade-linha' : 'av-base' }, area);
      svg('text', { x: m.l - 8, y: y(p) + 3.5, class: 'av-eixo', 'text-anchor': 'end' }, area).textContent = fmt(p);
    }
    const rotuloT = eixoTempo(t0, span), marcas = Math.max(2, Math.min(6, Math.floor((W - m.l) / 110)));
    for (let i = 0; i <= marcas; i++) {
      const t = t0 + (span * i) / marcas;
      svg('text', { x: x(t), y: H - 8, class: 'av-eixo', 'text-anchor': i === 0 ? 'start' : i === marcas ? 'end' : 'middle' }, area).textContent = rotuloT(t);
    }
    if (limite) {
      svg('line', { x1: m.l, x2: W - m.r, y1: y(limite), y2: y(limite), class: 'av-limite' }, area);
      svg('text', { x: W - m.r, y: y(limite) - 6, class: 'av-eixo av-limite-rotulo', 'text-anchor': 'end' }, area).textContent = rotuloLimite;
    }
    const pontos = [];
    PAPEIS.forEach((papel, k) => {
      const seq = pts.filter((p) => p.r.role === papel);
      if (seq.length > 1) svg('path', { d: seq.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(''), class: `av-linha role-${papel}`, pathLength: 1, style: `--i:${k}` }, area);
      seq.forEach((p, i) => pontos.push({ ...p, no: svg('circle', { cx: x(p.t), cy: y(p.v), r: 4, class: `av-marca role-${papel}`, style: `--i:${Math.min(i, 40)}` }, area) }));
    });
    const mira = svg('line', { y1: m.t, y2: H - m.b, class: 'av-mira' }, area);
    const alvo = svg('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, class: 'av-alvo av-sonda' }, area);
    let atual = null, fixo = false;
    const focar = (e) => {
      const caixaSvg = area.getBoundingClientRect(), px = ((e.clientX - caixaSvg.left) / caixaSvg.width) * W, py = ((e.clientY - caixaSvg.top) / caixaSvg.height) * H;
      let melhor = null, dist = Infinity;
      for (const p of pontos) { const d = Math.abs(x(p.t) - px) * 3 + Math.abs(y(p.v) - py); if (d < dist) { dist = d; melhor = p; } }
      if (!melhor) return;
      if (atual !== melhor) {
        atual?.no.classList.remove('av-foco');
        atual = melhor;
        mira.setAttribute('x1', x(melhor.t)); mira.setAttribute('x2', x(melhor.t)); area.classList.add('mirando');
        mostrarDica(melhor.no, `${names[melhor.r.role]} · ${quando(melhor.r.at)}`, detalhesFala(melhor.r));
      }
      posicionarDica(e);
    };
    alvo.addEventListener('pointermove', (e) => { if (!fixo) focar(e); });
    alvo.addEventListener('click', (e) => { fixo = !fixo; if (!fixo) focar(e); area.classList.toggle('fixo', fixo); });
    alvo.addEventListener('pointerleave', () => { if (fixo) return; $a('av-tip').hidden = true; atual?.no.classList.remove('av-foco'); atual = null; area.classList.remove('mirando'); });
    caixa.replaceChildren(area);
  }

  // ------------------------------------------------------------------ composição dos tokens por participante (100 %)
  function renderComposicao(rows) {
    const grupos = PAPEIS.map((p) => {
      const rs = rows.filter((r) => r.role === p), s = (f) => rs.reduce((t, r) => t + f(r), 0);
      return { p, n: rs.length, novos: s((r) => r.novos), cache: s((r) => r.cache), texto: s((r) => Math.max(0, r.saida - (r.pensamento || 0))), pensamento: s((r) => r.pensamento || 0) };
    }).filter((g) => g.n);
    if (!grupos.length) { $a('av-composicao').replaceChildren(vazio()); return; }
    $a('av-composicao').replaceChildren(...grupos.map((g, i) => {
      const total = PARTES.reduce((t, [k]) => t + g[k], 0) || 1;
      const item = element('div', `av-comp role-${g.p}`); item.style.setProperty('--i', i);
      const topo = element('div', 'av-hbar-topo'), nome = element('span', 'av-hbar-nome');
      nome.append(element('i', 'av-ponto'), element('b', '', names[g.p]), element('small', '', `${g.n} ${g.n === 1 ? 'fala' : 'falas'}`));
      topo.append(nome, element('span', 'av-hbar-valor', fmt(total)));
      const trilho = element('div', 'av-comp-trilho');
      PARTES.forEach(([k, rotulo], j) => {
        if (!g[k]) return;
        const pct = (100 * g[k]) / total, seg = element('span', `av-seg-${k}`);
        seg.style.setProperty('--w', `${pct.toFixed(3)}%`); seg.style.setProperty('--j', j);
        if (pct >= 9) seg.textContent = `${Math.round(pct)}%`;
        dica(seg, `${names[g.p]} · ${rotulo}`, [[g.p, rotulo, fmt(g[k])], ['-', 'Parte do total', `${pct.toFixed(1).replace('.', ',')}%`], ['-', 'Média por fala', fmt(g[k] / g.n)]]);
        trilho.append(seg);
      });
      item.append(topo, trilho);
      return item;
    }));
  }

  // ------------------------------------------------------------------ tabela (também é a leitura acessível dos gráficos)
  function renderTabela(rows) {
    const grupos = new Map();
    for (const r of rows) {
      const k = `${r.role}|${r.model}|${r.mode}`;
      const g = grupos.get(k) || { papel: r.role, modelo: r.model, modo: r.mode, n: 0, novos: 0, cache: 0, saida: 0 };
      g.n++; g.novos += r.novos; g.cache += r.cache; g.saida += r.saida; grupos.set(k, g);
    }
    const lista = [...grupos.values()].sort((a, b) => valor(b) - valor(a));
    const tabela = element('table');
    const cab = element('tr');
    for (const t of ['Participante', 'Modelo', 'Modo', 'Falas', 'Novos', 'Cache', 'Saída', 'Média por fala']) cab.append(element('th', '', t));
    tabela.append(element('thead')); tabela.tHead.append(cab);
    const corpo = element('tbody');
    for (const g of lista) {
      const tr = element('tr', `role-${g.papel}`);
      const nome = element('td'); nome.append(element('i', 'av-ponto'), document.createTextNode(names[g.papel]));
      tr.append(nome, element('td', 'mono', g.modelo || '—'), element('td', '', g.modo === 'code' ? 'Code' : g.modo === 'chat' ? 'Chat' : '—'),
        element('td', 'num', inteiro.format(g.n)), element('td', 'num', fmt(g.novos)), element('td', 'num', fmt(g.cache)), element('td', 'num', fmt(g.saida)),
        element('td', 'num forte', fmt(valor(g) / g.n)));
      corpo.append(tr);
    }
    tabela.append(corpo);
    $a('av-tabela').replaceChildren(lista.length ? tabela : vazio());
  }
  // Legenda interativa: clicar num participante esconde ou mostra as falas dele em toda a aba.
  function renderLegenda(rows) {
    const lista = () => PAPEIS.filter((p) => rows.some((r) => r.role === p)).map((p) => {
      const oculto = filtro.ocultos.includes(p);
      const item = element('button', `av-leg role-${p}${oculto ? ' oculto' : ''}`); item.type = 'button';
      item.setAttribute('aria-pressed', String(!oculto)); item.title = oculto ? `Mostrar ${names[p]}` : `Esconder ${names[p]}`;
      item.append(element('i', 'av-ponto'), document.createTextNode(names[p]));
      item.addEventListener('click', () => {
        filtro.ocultos = oculto ? filtro.ocultos.filter((x) => x !== p) : [...filtro.ocultos, p];
        salvarFiltro(); renderizar(true);
      });
      return item;
    });
    for (const caixa of document.querySelectorAll('.av-legenda-papeis')) caixa.replaceChildren(...lista());
  }
  function limiteConversa() {
    const v = Number(state.room?.settings?.sessionMaxTokens ?? 140000);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }
  function renderSeries(rows) {
    renderSerie($a('av-falas'), rows, (r) => valor(r));
    $a('av-falas-sub').textContent = `${MEDIDAS[filtro.medida][0].toUpperCase()}${MEDIDAS[filtro.medida].slice(1)} de cada fala. Passe o ponteiro para ver todos os parâmetros; clique para fixar.`;
    const limite = limiteConversa();
    renderSerie($a('av-contexto'), rows, (r) => r.contexto, { rotulo: 'contexto', limite, rotuloLimite: limite ? `renovação · ${fmt(limite)}` : '' });
  }

  function renderizar(animar = false) {
    const vista = $a('analytics-view');
    if (!ativo) return;
    vista.classList.toggle('anima', animar && MOVIMENTO);
    for (const grupo of vista.querySelectorAll('[data-filtro]'))
      for (const b of grupo.querySelectorAll('button')) b.setAttribute('aria-pressed', String(filtro[grupo.dataset.filtro] === b.dataset.v));
    $a('av-tip').hidden = true;
    const rows = visiveis(linhas);
    renderKpis(rows); renderLegenda(linhas); renderTempo(rows); renderSeries(rows); renderHoras(rows); renderComposicao(rows); renderEsforco(rows); renderTop(rows); renderTabela(rows);
    const notas=[];
    if(linhas.some(r=>r.estimado))notas.push('O uso de falas antigas do GPT é estimado pelos totais da conversa.');
    if(linhas.some(r=>r.interrompida))notas.push('Os totais incluem os tokens informados pelo AI Studio antes de uma interrupção. Requisições sem medição podem consumir cota adicional.');
    $a('av-nota').textContent=notas.join(' ');
  }

  function definirVista(nome, salvar = true) {
    ativo = nome === 'analises';
    document.body.classList.toggle('vista-analises', ativo);
    $a('analytics-view').hidden = !ativo;
    for (const b of document.querySelectorAll('.vista-tab')) {
      const sel = b.dataset.vista === nome;
      b.classList.toggle('active', sel); b.setAttribute('aria-selected', String(sel)); b.tabIndex = sel ? 0 : -1;
    }
    const tinta = document.querySelector('.vista-tinta'), alvo = document.querySelector('.vista-tab.active');
    if (tinta && alvo) { tinta.style.width = `${alvo.offsetWidth}px`; tinta.style.transform = `translateX(${alvo.offsetLeft - 3}px)`; }
    if (salvar) try { localStorage.setItem('synapse.vista', nome); } catch {}
    if (ativo) carregar(); else $a('av-tip').hidden = true;
  }

  function iniciar() {
    for (const b of document.querySelectorAll('.vista-tab')) b.addEventListener('click', () => definirVista(b.dataset.vista));
    document.querySelector('.vista-tabs')?.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const prox = ativo ? 'interface' : 'analises'; definirVista(prox); document.querySelector(`.vista-tab[data-vista="${prox}"]`).focus();
    });
    for (const grupo of document.querySelectorAll('#analytics-view [data-filtro]')) {
      grupo.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]'); if (!b) return;
        filtro[grupo.dataset.filtro] = b.dataset.v;
        salvarFiltro();
        grupo.dataset.filtro === 'medida' ? renderizar(true) : carregar();
      });
    }
    let largura = 0;
    new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width);
      if (ativo && w !== largura) { largura = w; const rows = visiveis(linhas); renderTempo(rows); renderSeries(rows); renderHoras(rows); }
    }).observe($a('analytics-view'));
    document.addEventListener('keydown', (e) => {
      if (e.altKey && !e.ctrlKey && (e.key === '1' || e.key === '2')) { e.preventDefault(); definirVista(e.key === '1' ? 'interface' : 'analises'); }
    });
    let salvo = 'interface'; try { salvo = localStorage.getItem('synapse.vista') || 'interface'; } catch {}
    requestAnimationFrame(() => definirVista(salvo === 'analises' ? 'analises' : 'interface', false));
  }

  // Chamado pelo app.js a cada atualização da central: novas falas entram sem recarregar a página.
  function aoAtualizar() {
    if (!ativo) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const sala = filtro.escopo === 'sala' ? state.selectedId || '' : '';
      carregar(`${filtro.periodo}|${sala}` === carregadoPara);
    }, 1200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
  return { aoAtualizar, definirVista };
})();
