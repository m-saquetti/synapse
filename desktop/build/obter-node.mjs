// Baixa o Node.js 24 oficial para Windows que a Synapse leva dentro do instalador
// (o servidor roda nele, igual ao que foi validado com o Node instalado no computador).
// Confere o SHA-256 publicado pelo nodejs.org antes de aceitar o arquivo.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const VERSAO = 'v24.22.3';
const destino = join(import.meta.dirname, '..', '..', 'vendor', 'node');
const arquivo = join(destino, 'node.exe');
const base = `https://nodejs.org/dist/${VERSAO}`;

async function baixar(url) {
  const resposta = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180000) });
  if (!resposta.ok) throw new Error(`Falha ao baixar ${url}: HTTP ${resposta.status}`);
  return Buffer.from(await resposta.arrayBuffer());
}

const somas = (await baixar(`${base}/SHASUMS256.txt`)).toString('utf8');
const esperado = somas.split('\n').find((linha) => linha.trim().endsWith(' win-x64/node.exe'))?.split(/\s+/)[0];
if (!esperado) throw new Error('SHASUMS256.txt não lista win-x64/node.exe.');

try {
  const atual = createHash('sha256').update(await readFile(arquivo)).digest('hex');
  if (atual === esperado) { console.log(`Node ${VERSAO} já está em vendor/node.`); process.exit(0); }
} catch {}

const binario = await baixar(`${base}/win-x64/node.exe`);
const obtido = createHash('sha256').update(binario).digest('hex');
if (obtido !== esperado) throw new Error(`SHA-256 diferente do publicado (${obtido}).`);
await mkdir(destino, { recursive: true });
await writeFile(`${arquivo}.tmp`, binario);
await rename(`${arquivo}.tmp`, arquivo);
await writeFile(join(destino, 'VERSAO.txt'), `Node.js ${VERSAO} (win-x64), SHA-256 ${esperado}\nLicença: https://github.com/nodejs/node/blob/${VERSAO}/LICENSE\n`);
console.log(`Node ${VERSAO} conferido e salvo em vendor/node.`);
