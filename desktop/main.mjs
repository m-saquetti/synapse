// Synapse — aplicativo de desktop.
// O processo principal do Electron cuida só da janela, da bandeja e do ciclo de vida.
// O servidor da Synapse continua sendo o mesmo server.mjs validado nos testes, executado por um
// Node.js 24 próprio (empacotado em resources/node), com os dados no perfil do usuário.
import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, session, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { access, cp, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARCA_MIGRACAO, runningInstance, stopMesa } from '../launch.mjs';
import { AgendaDeAtualizacao, argumentosDoInstalador, lerPastaDeAtualizacao, procurarAtualizacao, salvarPastaDeAtualizacao } from './atualizacao.mjs';

const NOME = 'Synapse';
const COR_FUNDO = '#000000';
const PORTA_PADRAO = 4317;
const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const recursos = join(raiz, 'desktop', 'recursos');
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Pasta de dados sem acento (alguns clientes de linha de comando lidam mal com caminhos acentuados).
app.setName(NOME);
app.setPath('userData', join(app.getPath('appData'), 'Synapse'));
if (process.platform === 'win32') app.setAppUserModelId('com.orbita.desktop');
const dados = process.env.SYNAPSE_DATA_DIR || process.env.ORBITA_DATA_DIR || (existsSync(join(app.getPath('appData'), 'Orbita', 'dados', 'mesa.sqlite')) ? join(app.getPath('appData'), 'Orbita','dados') : join(app.getPath('userData'), 'dados'));

let janela = null;
let bandeja = null;
let servidor = null;
let endereco = null;
let saindo = false;
let avisouBandeja = false;

// ---------------------------------------------------------------- servidor
function nodeExecutavel() {
  if (process.env.ORBITA_NODE) return process.env.ORBITA_NODE;
  const embutido = join(process.resourcesPath, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
  if (app.isPackaged && existsSync(embutido)) return embutido;
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

function portaLivre(preferida) {
  const tentar = (porta) => new Promise((ok, falha) => {
    const teste = createServer();
    teste.once('error', falha);
    teste.listen(porta, '127.0.0.1', () => { const escolhida = teste.address().port; teste.close(() => ok(escolhida)); });
  });
  return tentar(preferida).catch(() => tentar(0));
}

async function instanciaAtiva() {
  try { return await runningInstance(dados); }
  catch { return null; } // runtime.json antigo ou porta usada por outro programa: o servidor novo resolve pela trava.
}

async function ultimasLinhasDoLog() {
  try { return (await readFile(join(dados, 'server.log'), 'utf8')).trim().split(/\r?\n/).slice(-8).join('\n'); }
  catch { return ''; }
}

async function iniciarServidor() {
  const existente = await instanciaAtiva();
  // Servidor de uma versão anterior (atualização instalada com ele aberto): encerra e abre o atual.
  if (existente && existente.version !== app.getVersion()) await stopMesa(dados).catch(() => {});
  else if (existente) return existente.url;
  await mkdir(dados, { recursive: true });
  const porta = await portaLivre(Number(process.env.MESA_PORT) || PORTA_PADRAO);
  const ambiente = { ...process.env, SYNAPSE_DATA_DIR: dados, MESA_PORT: String(porta) };
  for (const chave of Object.keys(ambiente)) if (/^ELECTRON_/i.test(chave)) delete ambiente[chave];
  // O Node embutido entra no fim do PATH: se o computador já tem Node, os agentes continuam usando o dele;
  // se não tem, comandos como `node ...` (ponte de ferramentas do Gemini) ainda funcionam.
  const node = nodeExecutavel();
  if (node.includes('\\') || node.includes('/')) {
    const chavePath = Object.keys(ambiente).find((chave) => chave.toUpperCase() === 'PATH') || 'PATH';
    ambiente[chavePath] = [ambiente[chavePath], dirname(node)].filter(Boolean).join(delimiter);
  }
  const log = await open(join(dados, 'server.log'), 'a');
  try {
    servidor = spawn(node, [join(raiz, 'server.mjs')], {
      cwd: raiz, env: ambiente, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
    });
  } finally { await log.close(); }
  let saiu = null;
  servidor.once('error', (erro) => { saiu = erro.message; });
  servidor.once('exit', (codigo) => {
    saiu ??= `código ${codigo}`;
    servidor = null;
    if (!saindo && endereco) void servidorCaiu();
  });
  for (let tentativa = 0; tentativa < 120; tentativa++) {
    const instancia = await instanciaAtiva();
    if (instancia) return instancia.url;
    if (saiu) break;
    await esperar(250);
  }
  throw new Error(`O servidor da Synapse não iniciou (${saiu || 'tempo esgotado'}).\n\n${await ultimasLinhasDoLog()}`);
}

async function servidorCaiu() {
  endereco = null;
  const { response } = await dialog.showMessageBox(janela ?? undefined, {
    type: 'error', title: NOME, message: 'O servidor da Synapse parou.',
    detail: `As salas e as tarefas ficaram salvas.\n\n${await ultimasLinhasDoLog()}`,
    buttons: ['Reiniciar', 'Abrir pasta de dados', 'Fechar a Synapse'], defaultId: 0, cancelId: 2, noLink: true,
  });
  if (response === 1) await shell.openPath(dados);
  if (response === 2) return sair(true);
  await abrirInterface();
}

// Tarefas na fila ou em andamento; null quando o servidor não respondeu ou a resposta veio incompleta.
async function contarTarefas() {
  if (!endereco) return null;
  try {
    const resposta = await fetch(`${endereco}/api/bootstrap`, { redirect: 'error', signal: AbortSignal.timeout(2000) });
    const corpo = resposta.ok ? await resposta.json() : null;
    return Array.isArray(corpo?.activeJobs) ? corpo.activeJobs.length : null;
  } catch { return null; }
}
// Fechar a janela ou sair: na dúvida, trata como sem tarefas (o histórico já fica salvo de qualquer forma).
async function tarefasAtivas() { return (await contarTarefas()) ?? 0; }

// ---------------------------------------------------------------- atualização (reiniciar para atualizar)
let avisoDeVersao = null;
async function procurarPacote() {
  const pasta = await lerPastaDeAtualizacao(dados);
  return pasta ? procurarAtualizacao(pasta, app.getVersion()) : null;
}
// Pede ao servidor para encerrar só se a fila estiver vazia. Recusa, falta de resposta ou estado desconhecido = 'ocupado'.
async function encerrarServidorParaAtualizar() {
  let aceito = false;
  try {
    await stopMesa(dados, { somenteSemTarefas: true, aoAceitar: () => { aceito = true; saindo = true; } });
  } catch {
    if (aceito && servidor) servidor.kill();
  }
  if (!aceito) return 'ocupado';
  endereco = null;
  return 'encerrado';
}
function iniciarInstalador(arquivo) {
  return new Promise((ok, falha) => {
    const instalador = spawn(arquivo, argumentosDoInstalador(), { detached: true, stdio: 'ignore' });
    instalador.once('error', falha);
    instalador.once('spawn', () => { instalador.unref(); ok(); });
  });
}
const agenda = new AgendaDeAtualizacao({
  procurar: procurarPacote,
  encerrarServidor: encerrarServidorParaAtualizar,
  instalar: iniciarInstalador,
  reabrir: async () => { saindo = false; endereco = null; await abrirInterface(); },
  aoMudar: () => avisarAtualizacao(),
});
const estadoAtualizacao = () => agenda.estado(app.getVersion());
function avisarAtualizacao() {
  if (janela && !janela.isDestroyed()) janela.webContents.send('synapse:atualizacao', estadoAtualizacao());
  montarMenuDaBandeja();
}

async function verificarAtualizacao() {
  if (saindo) return;
  try {
    const pacote = await procurarPacote();
    agenda.oferecer(pacote);
    if (pacote && avisoDeVersao !== pacote.versao && !janela?.isVisible()) {
      avisoDeVersao = pacote.versao;
      bandeja?.displayBalloon?.({ title: NOME, content: `A versão ${pacote.versao} está pronta. Use “Reiniciar para atualizar”.`, iconType: 'info' });
    }
  } catch {}
}

// Executa o pedido confirmado. Com tarefa em andamento, o pedido continua agendado e é tentado a cada 5 s.
async function executarAtualizacao() {
  if (saindo && !agenda.pedido) return estadoAtualizacao();
  const resultado = await agenda.tentar();
  if (resultado === 'instalando') {
    guardarEstadoDaJanela();
    if (janela && !janela.isDestroyed()) janela.destroy();
    bandeja?.destroy();
    app.exit(0);
    return null;
  }
  if (resultado === 'falhou') {
    await dialog.showMessageBox(janela ?? undefined, { type: 'error', title: NOME, message: 'Não foi possível iniciar a atualização.', detail: `${agenda.erro?.message || ''}

A Synapse continua na versão ${app.getVersion()}.` });
  }
  avisarAtualizacao();
  return estadoAtualizacao();
}
async function confirmarAtualizacao(id) {
  if (!agenda.confirmar(id)) { avisarAtualizacao(); return estadoAtualizacao(); }
  return executarAtualizacao();
}

async function escolherPastaDeAtualizacao() {
  const atual = await lerPastaDeAtualizacao(dados);
  const escolha = await dialog.showOpenDialog(janela?.isVisible() ? janela : undefined, {
    title: 'Pasta onde ficam os instaladores da Synapse', properties: ['openDirectory'], defaultPath: atual || app.getPath('documents'),
  });
  if (escolha.canceled || !escolha.filePaths[0]) return;
  await salvarPastaDeAtualizacao(dados, escolha.filePaths[0]);
  await verificarAtualizacao();
  if (!agenda.pacote) await dialog.showMessageBox(janela?.isVisible() ? janela : undefined, { type: 'info', title: NOME, message: 'Nenhuma versão nova nessa pasta por enquanto.', detail: `A Synapse ${app.getVersion()} vai conferir a pasta a cada minuto e avisar quando um instalador mais novo estiver pronto.` });
}

// A interface só fala com estes canais, e só a partir da janela principal servida pela própria Synapse.
function remetenteValido(evento) {
  return Boolean(janela && !janela.isDestroyed() && evento.sender === janela.webContents
    && evento.senderFrame && evento.senderFrame === janela.webContents.mainFrame && mesmaOrigem(evento.senderFrame.url));
}
function registrarCanais() {
  ipcMain.handle('synapse:atualizacao:estado', (evento) => (remetenteValido(evento) ? estadoAtualizacao() : null));
  ipcMain.handle('synapse:atualizacao:reiniciar', (evento, id) => (remetenteValido(evento) ? confirmarAtualizacao(id) : null));
  ipcMain.handle('synapse:atualizacao:cancelar', (evento) => {
    if (remetenteValido(evento)) agenda.cancelar();
    return estadoAtualizacao();
  });
}

// ---------------------------------------------------------------- importação da Mesa
async function existe(caminho) { return access(caminho).then(() => true, () => false); }

async function procurarMesa() {
  const candidatos = [];
  if (process.env.ORBITA_IMPORTAR_DE) candidatos.push(process.env.ORBITA_IMPORTAR_DE);
  // O Codex cria os projetos em Documentos\Codex\<data>\<id>\outputs\mesa-central.
  // Documentos pode estar no OneDrive, então as duas localizações são verificadas.
  const pastasCodex = new Set([join(app.getPath('documents'), 'Codex'), join(app.getPath('home'), 'Documents', 'Codex')]);
  for (const codex of pastasCodex) {
    for (const data of await readdir(codex).catch(() => [])) {
      for (const id of await readdir(join(codex, data)).catch(() => [])) {
        candidatos.push(join(codex, data, id, 'outputs', 'mesa-central', '.data'));
      }
    }
  }
  const validos = [];
  for (const pasta of candidatos) {
    const banco = join(pasta, 'mesa.sqlite');
    if (await existe(banco) && !(await existe(join(pasta, MARCA_MIGRACAO)))) validos.push({ pasta, quando: (await stat(banco)).mtimeMs });
  }
  return validos.sort((a, b) => b.quando - a.quando)[0]?.pasta ?? null;
}

function pastaDeDadosDaMesa(escolhida) {
  return basename(escolhida) === '.data' ? escolhida : join(escolhida, '.data');
}

async function importarMesa(origem) {
  // Encerra a Mesa antiga para copiar um banco consistente; a pasta original não é alterada além da marca.
  await stopMesa(origem);
  const ignorar = /^(runtime.*\.json|instance\.lock|server\.log|.*\.tmp|MOVIDA-PARA-ORBITA\.json)$/i;
  await mkdir(dados, { recursive: true });
  await cp(origem, dados, { recursive: true, errorOnExist: false, force: false, filter: (caminho) => !ignorar.test(basename(caminho)) });
  await writeFile(join(origem, MARCA_MIGRACAO), JSON.stringify({ destino: dados, em: new Date().toISOString() }, null, 2));
}

async function primeiraExecucao() {
  if (await existe(join(dados, 'mesa.sqlite'))) return;
  if (process.env.ORBITA_IMPORTACAO === 'nunca') return;
  let origem = await procurarMesa();
  if (process.env.ORBITA_IMPORTACAO !== 'auto') {
    const botoes = origem ? ['Trazer as salas', 'Escolher outra pasta', 'Começar do zero'] : ['Escolher a pasta da Mesa', 'Começar do zero'];
    const { response } = await dialog.showMessageBox(janela, {
      type: 'question', title: NOME, noLink: true, defaultId: 0, cancelId: botoes.length - 1, buttons: botoes,
      message: origem ? 'Trazer suas salas da Mesa para a Synapse?' : 'Você tem salas da Mesa para trazer?',
      detail: origem
        ? `Encontrei as salas em:\n${origem}\n\nA Mesa será encerrada durante a cópia. A pasta original continua intacta.`
        : 'Escolha a pasta mesa-central para trazer conversas, memória e versões. A pasta original continua intacta.',
    });
    if (response === botoes.length - 1) return;
    if (!origem || response === 1) {
      const escolha = await dialog.showOpenDialog(janela, { title: 'Pasta da Mesa', properties: ['openDirectory'], defaultPath: app.getPath('documents') });
      if (escolha.canceled || !escolha.filePaths[0]) return;
      origem = pastaDeDadosDaMesa(escolha.filePaths[0]);
      if (!(await existe(join(origem, 'mesa.sqlite')))) {
        await dialog.showMessageBox(janela, { type: 'warning', title: NOME, message: 'Essa pasta não tem salas da Mesa.', detail: 'A Synapse vai começar do zero. Você pode reinstalar e importar depois.' });
        return;
      }
    }
  }
  if (!origem) return;
  try { await importarMesa(origem); }
  catch (erro) {
    await dialog.showMessageBox(janela, { type: 'error', title: NOME, message: 'Não foi possível trazer as salas da Mesa.', detail: `${erro.message}\n\nA Synapse vai abrir sem elas; a Mesa original não foi alterada.` });
  }
}

// ---------------------------------------------------------------- janela
async function estadoDaJanela() {
  try { return JSON.parse(await readFile(join(app.getPath('userData'), 'janela.json'), 'utf8')); }
  catch { return { width: 1440, height: 900 }; }
}

function guardarEstadoDaJanela() {
  if (!janela || janela.isDestroyed()) return;
  const estado = { ...janela.getNormalBounds(), maximizada: janela.isMaximized() };
  void writeFile(join(app.getPath('userData'), 'janela.json'), JSON.stringify(estado)).catch(() => {});
}

const mesmaOrigem = (url) => { try { return endereco && new URL(url).origin === new URL(endereco).origin; } catch { return false; } };
const abrirFora = (url) => { if (/^https?:\/\//i.test(url) && !mesmaOrigem(url)) void shell.openExternal(url); };

async function criarJanela() {
  const estado = await estadoDaJanela();
  janela = new BrowserWindow({
    x: estado.x, y: estado.y, width: estado.width || 1440, height: estado.height || 900,
    minWidth: 960, minHeight: 620, show: false, title: NOME, backgroundColor: COR_FUNDO,
    icon: join(recursos, process.platform === 'win32' ? 'synapse.ico' : 'synapse.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: COR_FUNDO, symbolColor: '#B4B4BC', height: 36 },
    webPreferences: {
      preload: join(raiz, 'desktop', 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
    },
  });
  if (estado.maximizada) janela.maximize();
  janela.once('ready-to-show', () => janela.show());
  for (const evento of ['resize', 'move', 'maximize', 'unmaximize']) janela.on(evento, guardarEstadoDaJanela);
  // A interface esconde a barra de título própria em tela cheia (os botões da janela somem junto).
  for (const [evento, cheia] of [['enter-full-screen', true], ['leave-full-screen', false]])
    janela.on(evento, () => { if (!janela.isDestroyed()) janela.webContents.send('synapse:tela-cheia', cheia); });
  janela.webContents.on('did-finish-load', () => { if (janela.isFullScreen()) janela.webContents.send('synapse:tela-cheia', true); });

  const conteudo = janela.webContents;
  conteudo.setWindowOpenHandler(({ url }) => {
    if (mesmaOrigem(url)) return { action: 'allow', overrideBrowserWindowOptions: { backgroundColor: COR_FUNDO, autoHideMenuBar: true, icon: join(recursos, 'synapse.png') } };
    abrirFora(url);
    return { action: 'deny' };
  });
  conteudo.on('will-navigate', (evento, url) => { if (!mesmaOrigem(url) && !url.startsWith('file:')) { evento.preventDefault(); abrirFora(url); } });
  conteudo.on('before-input-event', (evento, tecla) => {
    if (tecla.type !== 'keyDown') return;
    const ctrl = tecla.control || tecla.meta;
    // 1.7: F11 alterna a tela cheia (sem menu de aplicativo, o Electron não traz esse atalho por padrão).
    if (tecla.key === 'F11' && !ctrl && !tecla.alt) { evento.preventDefault(); janela.setFullScreen(!janela.isFullScreen()); }
    else if (tecla.key === 'F5' || (ctrl && tecla.key.toLowerCase() === 'r')) { evento.preventDefault(); conteudo.reload(); }
    else if (ctrl && tecla.shift && tecla.key.toLowerCase() === 'i') { evento.preventDefault(); conteudo.toggleDevTools(); }
    else if (ctrl && (tecla.key === '=' || tecla.key === '+')) { evento.preventDefault(); conteudo.setZoomLevel(Math.min(conteudo.getZoomLevel() + .5, 3)); }
    else if (ctrl && tecla.key === '-') { evento.preventDefault(); conteudo.setZoomLevel(Math.max(conteudo.getZoomLevel() - .5, -3)); }
    else if (ctrl && tecla.key === '0') { evento.preventDefault(); conteudo.setZoomLevel(0); }
  });

  janela.on('close', (evento) => {
    if (saindo) return;
    evento.preventDefault();
    void (async () => {
      // Fechar com tarefa em andamento mantém a equipe trabalhando; sem tarefas, fecha de verdade.
      if (await tarefasAtivas()) {
        janela.hide();
        if (!avisouBandeja && bandeja) {
          avisouBandeja = true;
          bandeja.displayBalloon?.({ title: NOME, content: 'A equipe continua trabalhando. A Synapse está aqui na bandeja.', iconType: 'info' });
        }
      } else await sair(true);
    })();
  });
  await janela.loadFile(join(raiz, 'desktop', 'abrindo.html'));
}

async function abrirInterface() {
  try {
    await primeiraExecucao();
    endereco = await iniciarServidor();
    await janela.loadURL(endereco);
  } catch (erro) {
    const { response } = await dialog.showMessageBox(janela, {
      type: 'error', title: NOME, message: 'A Synapse não conseguiu abrir.', detail: erro.message,
      buttons: ['Tentar de novo', 'Abrir pasta de dados', 'Fechar'], defaultId: 0, cancelId: 2, noLink: true,
    });
    if (response === 0) return abrirInterface();
    if (response === 1) await shell.openPath(dados);
    await sair(true);
  }
}

function mostrar() {
  if (!janela) return;
  if (janela.isMinimized()) janela.restore();
  janela.show();
  janela.focus();
}

// ---------------------------------------------------------------- bandeja e saída
function criarBandeja() {
  const icone = nativeImage.createFromPath(join(recursos, 'bandeja.png')).resize({ width: 16, height: 16 });
  bandeja = new Tray(icone);
  bandeja.setToolTip(NOME);
  montarMenuDaBandeja();
  bandeja.on('click', mostrar);
}

function montarMenuDaBandeja() {
  if (!bandeja || bandeja.isDestroyed()) return;
  const estado = estadoAtualizacao();
  bandeja.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir a Synapse', click: mostrar },
    { label: 'Abrir no navegador', click: () => endereco && shell.openExternal(endereco) },
    { label: 'Pasta de dados', click: () => shell.openPath(dados) },
    { type: 'separator' },
    ...(estado ? [{
      label: estado.aguardando ? `Cancelar atualização ${estado.versao} agendada` : `Reiniciar para atualizar (${estado.versao})`,
      click: () => { if (estado.aguardando) agenda.cancelar(); else void confirmarAtualizacao(estado.id); },
    }] : []),
    { label: 'Pasta de atualizações…', click: () => void escolherPastaDeAtualizacao() },
    { type: 'separator' },
    { label: 'Encerrar a Synapse', click: () => sair(false) },
  ]));
}

async function sair(confirmado) {
  if (saindo) return;
  const ativas = confirmado ? 0 : await tarefasAtivas();
  if (ativas) {
    const { response } = await dialog.showMessageBox(janela?.isVisible() ? janela : undefined, {
      type: 'warning', title: NOME, noLink: true, defaultId: 1, cancelId: 1, buttons: ['Encerrar mesmo assim', 'Continuar trabalhando'],
      message: ativas === 1 ? 'Há uma tarefa em andamento.' : `Há ${ativas} tarefas em andamento.`,
      detail: 'O que já foi feito fica salvo. Para seguir depois, abra a sala e use Continuar.',
    });
    if (response !== 0) return;
  }
  saindo = true;
  agenda.cancelar();
  guardarEstadoDaJanela();
  // Fecha a janela já: a conexão ao vivo da interface sai junto e o servidor encerra mais rápido.
  if (janela && !janela.isDestroyed()) janela.destroy();
  try { if (endereco || servidor) await Promise.race([stopMesa(dados), esperar(12000)]); } catch {}
  if (servidor) servidor.kill();
  bandeja?.destroy();
  app.exit(0);
}

// ---------------------------------------------------------------- início
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', mostrar);
  app.on('window-all-closed', () => {}); // a saída é decidida em sair()
  app.on('before-quit', (evento) => { if (!saindo) { evento.preventDefault(); void sair(false); } });
  // Windows desligando ou saindo da conta: encerra sem perguntar; as tarefas ficam salvas.
  app.on('session-end', () => { void sair(true); });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_conteudo, permissao, responder) => {
      responder(['clipboard-sanitized-write', 'fullscreen'].includes(permissao));
    });
    registrarCanais();
    criarBandeja();
    await criarJanela();
    await abrirInterface();
    // Procura instaladores novos ao abrir e a cada minuto (uma leitura de pasta; sem rede).
    void verificarAtualizacao();
    setInterval(() => void verificarAtualizacao(), 60000);
    // Pedido confirmado e ainda esperando a fila esvaziar: nova tentativa a cada 5 s (o servidor decide).
    setInterval(() => { if (agenda.pedido && !agenda.emAndamento) void executarAtualizacao(); }, 5000);
  });
}
