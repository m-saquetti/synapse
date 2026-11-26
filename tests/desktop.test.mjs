// Aplicativo de desktop: empacotamento e migração da Mesa.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARCA_MIGRACAO, migracaoRegistrada } from '../launch.mjs';

const raiz = fileURLToPath(new URL('..', import.meta.url));
const pacote = JSON.parse(await readFile(join(raiz, 'package.json'), 'utf8'));

test('every file the installer packs exists in the project', async () => {
  assert.equal(pacote.main, 'desktop/main.mjs');
  const fixos = pacote.build.files.filter((item) => !item.startsWith('!') && !item.includes('*'));
  for (const arquivo of fixos) assert.ok((await stat(join(raiz, arquivo))).isFile(), `${arquivo} não existe`);
  assert.ok((await stat(join(raiz, pacote.build.afterPack))).isFile());
  assert.ok((await stat(join(raiz, pacote.build.win.icon))).isFile());
});

test('the installer leaves out the bundled Claude binaries and keeps an ASCII install path', () => {
  // A Synapse usa o Claude Code instalado (login da assinatura); o binário do SDK só aumentaria o instalador.
  assert.ok(pacote.build.files.includes('!node_modules/@anthropic-ai/claude-agent-sdk-*{,/**}'));
  assert.match(pacote.build.productName, /^[A-Za-z0-9 _-]+$/);
  assert.equal(pacote.build.win.executableName, 'Synapse');
  assert.equal(pacote.build.nsis.shortcutName, 'Synapse');
  assert.deepEqual(pacote.build.extraResources[0].filter, ['node.exe', 'VERSAO.txt']);
});

test('a migrated Mesa folder is recognised so the old launcher does not fork the history', async (t) => {
  const pasta = await mkdtemp(join(tmpdir(), 'orbita-migracao-'));
  t.after(() => rm(pasta, { recursive: true, force: true }));
  assert.equal(await migracaoRegistrada(pasta), null);
  await writeFile(join(pasta, MARCA_MIGRACAO), JSON.stringify({ destino: 'C:\\dados', em: '2026-11-16T22:00:00.000Z' }));
  assert.deepEqual(await migracaoRegistrada(pasta), { destino: 'C:\\dados', em: '2026-11-16T22:00:00.000Z' });
});

test('the desktop shell never gives the interface Node.js access', async () => {
  const main = await readFile(join(raiz, 'desktop', 'main.mjs'), 'utf8');
  assert.match(main, /contextIsolation: true, sandbox: true, nodeIntegration: false/);
  const preload = (await readFile(join(raiz, 'desktop', 'preload.cjs'), 'utf8')).replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(preload, /require\('(?!electron')|child_process|process\.(env|exit|kill)|shell\./);
  // 1.1.2: a ponte usa o ipcRenderer só em canais fixos de atualização; o objeto nunca é exposto à interface.
  const usos = [...preload.matchAll(/ipcRenderer\.(\w+)\(([^,)]*)/g)].map(([, metodo, canal]) => `${metodo} ${canal.trim()}`);
  assert.equal(usos.length, (preload.match(/ipcRenderer\./g) || []).length, 'todo uso do ipcRenderer tem canal literal');
  assert.deepEqual(new Set(usos), new Set([
    "invoke 'synapse:atualizacao:estado'", "invoke 'synapse:atualizacao:reiniciar'", "invoke 'synapse:atualizacao:cancelar'",
    "on 'synapse:atualizacao'", "removeListener 'synapse:atualizacao'",
    // 1.7: aviso só de ida (processo principal → interface) com um booleano: entrou ou saiu da tela cheia (F11).
    "on 'synapse:tela-cheia'", "removeListener 'synapse:tela-cheia'",
  ]));
  assert.doesNotMatch(preload.replace(/ipcRenderer\.\w+\(/g, ''), /ipcRenderer(?!\s*\}\s*=\s*require)/, 'ipcRenderer não sai da ponte');
  // Cada canal confere a janela de origem antes de agir.
  const handlers = [...main.matchAll(/ipcMain\.handle\('([^']+)',\s*\(evento(?:,\s*id)?\)\s*=>\s*\{?\s*\(?\s*(?:if\s*\()?\s*remetenteValido\(evento\)/g)].map((m) => m[1]);
  assert.deepEqual(handlers.sort(), ['synapse:atualizacao:cancelar', 'synapse:atualizacao:estado', 'synapse:atualizacao:reiniciar']);
  assert.equal((main.match(/ipcMain\.(handle|on)\(/g) || []).length, 3);
});

test('every local module the desktop shell imports is packed in the installer', async () => {
  // Um import fora de build.files só quebra no aplicativo instalado (os testes rodam no projeto).
  const main = await readFile(join(raiz, 'desktop', 'main.mjs'), 'utf8');
  const locais = [...main.matchAll(/from '(\.{1,2}\/[^']+)'/g)].map((m) => join('desktop', m[1]).replaceAll('\\', '/'));
  assert.ok(locais.length >= 2);
  for (const arquivo of locais) assert.ok(pacote.build.files.includes(arquivo), `${arquivo} não está em build.files`);
});
