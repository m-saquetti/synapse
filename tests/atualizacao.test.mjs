// Synapse 1.1.2: "Reiniciar para atualizar" a partir de uma pasta local de instaladores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argumentosDoInstalador, compararVersoes, lerPastaDeAtualizacao, procurarAtualizacao, salvarPastaDeAtualizacao } from '../desktop/atualizacao.mjs';

const MB = 1024 * 1024;
async function pasta(t) {
  const dir = await mkdtemp(join(tmpdir(), 'synapse-atualizacao-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
// Instalador falso: cabeçalho MZ, tamanho real de instalador e data de modificação controlada.
async function instalador(dir, nome, { idadeMs = 60000, cabecalho = 'MZ', tamanho = 2 * MB } = {}) {
  const arquivo = join(dir, nome), dados = Buffer.alloc(tamanho);
  dados.write(cabecalho, 0, 'latin1');
  await writeFile(arquivo, dados);
  const quando = new Date(Date.now() - idadeMs);
  await utimes(arquivo, quando, quando);
  return arquivo;
}
const rapido = { conferirAposMs: 0 };

test('versões são comparadas por número, não por texto', () => {
  assert.equal(compararVersoes('1.1.10', '1.1.9'), 1);
  assert.equal(compararVersoes('1.2.0', '1.10.0'), -1);
  assert.equal(compararVersoes('1.1.2', '1.1.2'), 0);
});

test('oferece o maior instalador acima da versão atual e ignora o resto da pasta', async (t) => {
  const dir = await pasta(t);
  await instalador(dir, 'Synapse-Setup-1.1.1.exe');
  const novo = await instalador(dir, 'Synapse-Setup-1.1.3.exe');
  await instalador(dir, 'Synapse-Setup-1.1.2.exe');
  await writeFile(join(dir, 'Synapse-Setup-9.9.9.exe.blockmap'), 'x');
  await writeFile(join(dir, 'Outro-Setup-9.9.9.exe'), 'MZ');
  const achado = await procurarAtualizacao(dir, '1.1.2', rapido);
  assert.deepEqual({ ...achado, mtimeMs: undefined }, { versao: '1.1.3', arquivo: novo, tamanho: 2 * MB, mtimeMs: undefined });
  assert.ok(Number.isInteger(achado.mtimeMs));
  assert.equal(await procurarAtualizacao(dir, '1.1.3', rapido), null, 'mesma versão não é atualização');
  assert.equal(await procurarAtualizacao(dir, '2.0.0', rapido), null, 'versão menor nunca é oferecida');
});

test('um build ainda gravando o instalador não é oferecido, nem uma versão menor no lugar dele', async (t) => {
  const dir = await pasta(t);
  await instalador(dir, 'Synapse-Setup-1.1.3.exe');
  await instalador(dir, 'Synapse-Setup-1.1.4.exe', { idadeMs: 1000 });
  assert.equal(await procurarAtualizacao(dir, '1.1.2', rapido), null);
  // O arquivo muda entre as duas leituras: ainda está sendo escrito.
  const crescendo = await instalador(dir, 'Synapse-Setup-1.1.5.exe');
  const resultado = await procurarAtualizacao(dir, '1.1.2', { conferirAposMs: 1, esperar: () => writeFile(crescendo, Buffer.alloc(3 * MB)) });
  assert.equal(resultado, null);
});

test('arquivo que não é executável do Windows ou pequeno demais é recusado', async (t) => {
  const dir = await pasta(t);
  await instalador(dir, 'Synapse-Setup-1.1.3.exe', { cabecalho: 'PK' });
  assert.equal(await procurarAtualizacao(dir, '1.1.2', rapido), null);
  const outra = await pasta(t);
  await instalador(outra, 'Synapse-Setup-1.1.3.exe', { tamanho: 1000 });
  assert.equal(await procurarAtualizacao(outra, '1.1.2', rapido), null);
  assert.equal(await procurarAtualizacao(join(outra, 'nao-existe'), '1.1.2', rapido), null);
});

test('a pasta vem do ambiente ou do arquivo de configuração e precisa ser absoluta', async (t) => {
  const dados = await pasta(t);
  assert.equal(await lerPastaDeAtualizacao(dados, {}), null, 'sem pasta, sem atualização');
  await salvarPastaDeAtualizacao(dados, dados);
  assert.equal(await lerPastaDeAtualizacao(dados, {}), dados);
  assert.equal(await lerPastaDeAtualizacao(dados, { SYNAPSE_UPDATE_DIR: tmpdir() }), tmpdir(), 'o ambiente tem prioridade');
  assert.equal(await lerPastaDeAtualizacao(dados, { SYNAPSE_UPDATE_DIR: 'relativa' }), null);
  await assert.rejects(salvarPastaDeAtualizacao(dados, 'relativa'));
});

test('o instalador roda como atualização silenciosa que reabre a Synapse', () => {
  assert.deepEqual(argumentosDoInstalador(), ['--updated', '/S', '--force-run']);
});
