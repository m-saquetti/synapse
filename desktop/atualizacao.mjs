// Atualização local da Synapse: "Reiniciar para atualizar", como nos aplicativos oficiais.
// A Synapse procura um instalador de versão maior numa pasta escolhida por você (por exemplo, o dist do
// projeto) e, quando você confirma, executa o instalador oficial no modo de atualização: ele espera a
// Synapse fechar, troca os arquivos e a reabre. Este módulo não importa o Electron para poder ser testado.
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export const ARQUIVO_CONFIGURACAO = 'atualizacao.json';
const INSTALADOR = /^Synapse-Setup-(\d+)\.(\d+)\.(\d+)\.exe$/i;
const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));

export function compararVersoes(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return Math.sign(d); }
  return 0;
}

// SYNAPSE_UPDATE_DIR tem prioridade; senão vale a pasta salva em <dados>/atualizacao.json. Sem pasta, sem atualização.
export async function lerPastaDeAtualizacao(dados, ambiente = process.env) {
  const doAmbiente = ambiente.SYNAPSE_UPDATE_DIR;
  if (doAmbiente) return isAbsolute(doAmbiente) ? doAmbiente : null;
  try {
    const { pasta } = JSON.parse(await readFile(join(dados, ARQUIVO_CONFIGURACAO), 'utf8'));
    return typeof pasta === 'string' && isAbsolute(pasta) ? pasta : null;
  } catch { return null; }
}

export async function salvarPastaDeAtualizacao(dados, pasta) {
  if (typeof pasta !== 'string' || !isAbsolute(pasta)) throw new Error('Escolha uma pasta com caminho completo.');
  await mkdir(dados, { recursive: true });
  await writeFile(join(dados, ARQUIVO_CONFIGURACAO), JSON.stringify({ pasta }, null, 2));
}

// Instalador pronto para uso: o de maior versão acima da atual, começando com "MZ" (executável do Windows) e
// sem alteração recente. Um build em andamento ainda está gravando o arquivo; nesse caso nada é oferecido
// até ele terminar, nem mesmo uma versão menor que já esteja pronta.
export async function procurarAtualizacao(pasta, versaoAtual, { agora = Date.now(), estavelMs = 15000, conferirAposMs = 2000, esperar = pausa } = {}) {
  let nomes;
  try { nomes = await readdir(pasta); } catch { return null; }
  const maior = nomes
    .map((nome) => { const m = nome.match(INSTALADOR); return m && { nome, versao: `${+m[1]}.${+m[2]}.${+m[3]}` }; })
    .filter((c) => c && compararVersoes(c.versao, versaoAtual) > 0)
    .sort((a, b) => compararVersoes(b.versao, a.versao))[0];
  if (!maior) return null;
  const arquivo = join(pasta, maior.nome);
  const antes = await stat(arquivo).catch(() => null);
  if (!antes?.isFile() || antes.size < 1024 * 1024 || agora - antes.mtimeMs < estavelMs) return null;
  if (conferirAposMs) await esperar(conferirAposMs);
  const depois = await stat(arquivo).catch(() => null);
  if (!depois || depois.size !== antes.size || depois.mtimeMs !== antes.mtimeMs) return null;
  const cabecalho = Buffer.alloc(2);
  const leitor = await open(arquivo, 'r');
  try { await leitor.read(cabecalho, 0, 2, 0); } finally { await leitor.close(); }
  if (cabecalho.toString('latin1') !== 'MZ') return null;
  return { versao: maior.versao, arquivo, tamanho: depois.size, mtimeMs: Math.round(depois.mtimeMs) };
}

// Identidade de um pacote: muda se a versão, o tamanho ou a data mudarem (inclusive um rebuild da mesma versão).
export const idDoPacote = (p) => (p ? `${p.versao}:${p.tamanho}:${p.mtimeMs}` : null);

// Agenda do "Reiniciar para atualizar". Regras:
// - a confirmação vale só para o pacote que o usuário viu (id); outro pacote exige nova confirmação;
// - cancelar invalida o pedido em qualquer ponto antes de o servidor aceitar o encerramento;
// - só o servidor decide se a fila está vazia; recusa ou estado desconhecido = continuar esperando.
// Dependências injetadas: procurar() → pacote|null; encerrarServidor() → 'encerrado'|'ocupado';
// instalar(arquivo) → Promise; reabrir() → Promise (servidor encerrado, mas a instalação não seguiu).
export class AgendaDeAtualizacao {
  constructor({ procurar, encerrarServidor, instalar, reabrir = async () => {}, aoMudar = () => {} }) {
    Object.assign(this, { procurar, encerrarServidor, instalar, reabrir, aoMudar });
    this.pacote = null; this.pedido = null; this.sequencia = 0; this.emAndamento = null; this.finalizada = false; this.erro = null;
  }
  estado(versaoAtual) {
    return this.pacote ? { versao: this.pacote.versao, atual: versaoAtual, id: idDoPacote(this.pacote), aguardando: Boolean(this.pedido) } : null;
  }
  // Resultado de uma busca periódica. Um pacote diferente do confirmado desfaz a confirmação.
  oferecer(pacote) {
    if (this.finalizada || idDoPacote(pacote) === idDoPacote(this.pacote)) return;
    this.pacote = pacote || null;
    if (this.pedido && this.pedido.id !== idDoPacote(this.pacote)) this.pedido = null;
    this.aoMudar();
  }
  confirmar(id) {
    if (this.finalizada || !this.pacote || typeof id !== 'string' || id !== idDoPacote(this.pacote)) return false;
    if (!this.pedido) { this.pedido = { n: ++this.sequencia, id }; this.aoMudar(); }
    return true;
  }
  cancelar() { if (this.pedido) { this.pedido = null; this.aoMudar(); } }
  // Uma tentativa por vez: 'sem-pedido' | 'cancelado' | 'pacote-mudou' | 'aguardando' | 'instalando' | 'reaberto' | 'falhou'.
  tentar() {
    this.emAndamento ||= this.#tentar().finally(() => { this.emAndamento = null; });
    return this.emAndamento;
  }
  async #tentar() {
    const pedido = this.pedido;
    if (!pedido || this.finalizada) return 'sem-pedido';
    const vale = () => this.pedido === pedido;
    const pronto = await this.procurar();
    if (!vale()) return 'cancelado';
    if (idDoPacote(pronto) !== pedido.id) {
      this.pedido = null; this.pacote = pronto || null; this.aoMudar();
      return 'pacote-mudou';
    }
    if (!vale()) return 'cancelado';
    const servidor = await this.encerrarServidor();
    if (servidor !== 'encerrado') return vale() ? 'aguardando' : 'cancelado';
    // Daqui em diante o servidor já parou. Cancelado no meio do caminho: reabre sem instalar.
    if (!vale()) { await this.reabrir(); return 'reaberto'; }
    this.finalizada = true;
    try { await this.instalar(pronto.arquivo); return 'instalando'; }
    catch (erro) {
      this.finalizada = false; this.pedido = null; this.erro = erro; this.aoMudar();
      await this.reabrir();
      return 'falhou';
    }
  }
}

// Instalador NSIS do electron-builder: --updated espera a Synapse fechar e preserva os dados,
// /S dispensa telas e --force-run reabre a Synapse no fim.
export function argumentosDoInstalador() { return ['--updated', '/S', '--force-run']; }
