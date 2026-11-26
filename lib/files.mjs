import { mkdir, readdir, realpath, stat, open } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

const fail = (message,statusCode=400) => Object.assign(new Error(message),{statusCode});
export function workspaceFor(room, root) { return room.settings?.workspace || join(root,room.id); }
export async function verifyDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw fail('Escolha uma pasta com caminho completo.');
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw fail('O caminho precisa ser uma pasta.');
  return canonical;
}
export async function browseFolders(path = homedir()) {
  const directory = await verifyDirectory(path || homedir());
  const entries = await readdir(directory,{withFileTypes:true});
  const folders = entries.filter(e=>e.isDirectory() && !e.isSymbolicLink()).map(e=>({name:e.name,path:join(directory,e.name)})).sort((a,b)=>a.name.localeCompare(b.name));
  const roots = process.platform === 'win32'
    ? (await Promise.all('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async letter=>{const p=`${letter}:\\`;return (await stat(p).catch(()=>null))?.isDirectory() ? p : null;}))).filter(Boolean)
    : ['/'];
  return {path:directory,parent:dirname(directory)===directory?null:dirname(directory),home:homedir(),roots,folders:folders.slice(0,1000),truncated:folders.length>1000};
}
export async function confinedPath(root, subpath = '') {
  if (typeof subpath !== 'string' || subpath.length>4096 || /[\x00-\x1f]/.test(subpath) || (subpath && isAbsolute(subpath)) || subpath.includes(':')) throw fail('Caminho de arquivo inválido.');
  const base = await realpath(root);
  const destination = resolve(base,subpath);
  const within = path => {const r=relative(base,path);return r!== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r);};
  if (!within(destination)) throw fail('O arquivo está fora da pasta desta sala.',403);
  const canonical = await realpath(destination);
  if (!within(canonical)) throw fail('O atalho aponta para fora da pasta desta sala.',403);
  return canonical;
}
export async function listFiles(root, subpath='', {create=false}={}) {
  if (create) await mkdir(root,{recursive:true});
  const directory = await confinedPath(root,subpath);
  if (!(await stat(directory)).isDirectory()) throw fail('Selecione uma pasta.');
  const entries = await readdir(directory,{withFileTypes:true});
  const files = await Promise.all(entries.slice(0,1000).map(async entry=>{
    if (entry.isSymbolicLink()) return null;
    const info=await stat(join(directory,entry.name)).catch(()=>null);
    if (!info || (!info.isDirectory() && !info.isFile())) return null;
    return {name:entry.name,path:join(subpath,entry.name).replaceAll('\\','/'),directory:info.isDirectory(),size:info.size,modified:info.mtime.toISOString()};
  }));
  return {root,path:subpath,files:files.filter(Boolean).sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name)),truncated:entries.length>1000};
}
export async function readWorkspaceFile(root,path) {
  const canonical=await confinedPath(root,path);
  const handle=await open(canonical,'r');
  try {
    const info=await handle.stat();
    if (!info.isFile()) throw fail('Selecione um arquivo.');
    if (info.size>20*1024*1024) throw fail('Abra arquivos maiores que 20 MB diretamente na pasta.',413);
    const buffer=Buffer.alloc(Math.min(info.size+1,20*1024*1024+1));
    let bytesRead=0;
    while(bytesRead<buffer.length) {
      const result=await handle.read(buffer,bytesRead,buffer.length-bytesRead,bytesRead);
      if(!result.bytesRead) break;
      bytesRead+=result.bytesRead;
    }
    if (bytesRead>20*1024*1024) throw fail('Arquivo grande demais.',413);
    const data=buffer.subarray(0,bytesRead), ext=extname(canonical).toLowerCase();
    const textExt=['.txt','.md','.json','.js','.mjs','.cjs','.ts','.tsx','.jsx','.html','.htm','.css','.py','.ps1','.sh','.bat','.cmd','.csv','.xml','.svg','.yaml','.yml','.toml','.ini','.log','.sql','.rs','.go','.java','.c','.cpp','.h'];
    const kind=['.html','.htm'].includes(ext)?'html':['.png','.jpg','.jpeg','.gif','.webp'].includes(ext)?'image':textExt.includes(ext)||(!ext&&!data.includes(0))?'text':'binary';
    const mime=({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'})[ext];
    return {name:basename(canonical),path,size:bytesRead,kind,mime,data};
  } finally {await handle.close();}
}
