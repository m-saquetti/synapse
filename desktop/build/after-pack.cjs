// Depois do empacotamento: grava ícone e identificação do Windows no Synapse.exe.
// Usa resedit (JavaScript puro), então o instalador pode ser gerado tanto no Windows quanto no Linux.
const { readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

const ICONE = join(__dirname, '..', 'recursos', 'synapse.ico');

module.exports = async function afterPack(contexto) {
  if (contexto.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit');
  const info = contexto.packager.appInfo;
  const exe = join(contexto.appOutDir, `${info.productFilename}.exe`);
  const binario = ResEdit.NtExecutable.from(await readFile(exe), { ignoreCert: true });
  const recursos = ResEdit.NtExecutableResource.from(binario);

  const icone = ResEdit.Data.IconFile.from(await readFile(ICONE));
  const grupos = ResEdit.Resource.IconGroupEntry.fromEntries(recursos.entries);
  const alvo = grupos[0] ?? { id: 1, lang: 1033 };
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(recursos.entries, alvo.id, alvo.lang, icone.icons.map((item) => item.data));

  const [versao] = ResEdit.Resource.VersionInfo.fromEntries(recursos.entries);
  const [a, b, c] = info.version.split('.').map(Number);
  for (const idioma of versao.getAllLanguagesForStringValues()) {
    versao.setStringValues(idioma, {
      ProductName: 'Synapse', FileDescription: 'Synapse', CompanyName: 'Synapse',
      InternalName: 'Synapse', OriginalFilename: 'Synapse.exe', LegalCopyright: '',
      ProductVersion: info.version, FileVersion: info.version,
    });
  }
  versao.setFileVersion(a, b, c, 0);
  versao.setProductVersion(a, b, c, 0);
  versao.outputToResourceEntries(recursos.entries);
  recursos.outputResource(binario);
  await writeFile(exe, Buffer.from(binario.generate()));
};
