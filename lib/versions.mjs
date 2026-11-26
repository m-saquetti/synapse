import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, lstat, readFile, writeFile, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';

const skippedDirs=new Set(['node_modules','.git','.data','.venv','venv','.next','dist','build','__pycache__']);
const privateName=name=>/^\.env(?:\.|$)|^(?:credentials|secrets|oauth_creds|auth)\.json$|\.(?:pem|key|p12|pfx)$/i.test(name);
export class Versions {
  constructor(dataDir){this.root=join(dataDir,'versions');}
  async capture(roomId,workspace,{jobId,agent,phase}={}) {
    const directory=join(this.root,roomId),blobDir=join(directory,'blobs');await mkdir(blobDir,{recursive:true});
    const canonical=await realpath(workspace),files=[],omitted=[];let bytes=0,visited=0;
    const inside=path=>{const r=relative(canonical,path);return r!=='' && !isAbsolute(r) && r!=='..' && !r.startsWith('..\\') && !r.startsWith('../');};
    const walk=async(dir,depth)=>{
      if(depth>25) {omitted.push('Profundidade máxima');return;}
      for(const entry of await readdir(dir,{withFileTypes:true})) {
        if(++visited>5000){omitted.push('Limite de 5.000 entradas');return;}
        const path=join(dir,entry.name),rel=relative(canonical,path).replaceAll('\\','/');
        if(entry.isSymbolicLink() || privateName(entry.name)) {omitted.push(rel);continue;}
        if(entry.isDirectory()) {if(!skippedDirs.has(entry.name)) await walk(path,depth+1);continue;}
        if(!entry.isFile()) continue;
        const stat=await lstat(path).catch(()=>null);if(!stat || stat.isSymbolicLink()) {omitted.push(rel);continue;}
        if(stat.size>5*1024*1024 || bytes+stat.size>50*1024*1024) {omitted.push(rel);continue;}
        const real=await realpath(path).catch(()=>null);if(!real || !inside(real)){omitted.push(rel);continue;}
        const data=await readFile(real).catch(()=>null);if(!data || data.length>5*1024*1024 || bytes+data.length>50*1024*1024) {omitted.push(rel);continue;}
        const hash=createHash('sha256').update(data).digest('hex');
        await writeFile(join(blobDir,hash),data,{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
        bytes+=data.length;files.push({path:rel,hash,size:data.length});
      }
    };
    await walk(canonical,0);
    const snapshot={id:randomUUID(),roomId,workspace:canonical,jobId,agent,phase,createdAt:new Date().toISOString(),files,bytes,omitted:omitted.slice(0,100),partial:omitted.length>0};
    await writeFile(join(directory,`${snapshot.id}.json`),JSON.stringify(snapshot));
    // Impressão digital do conteúdo: compara capturas antes/depois para saber se alguém alterou arquivos.
    const fingerprint=createHash('sha256').update(files.map(f=>f.path+':'+f.hash).sort().join('\n')).digest('hex');
    return {id:snapshot.id,files:files.length,bytes,partial:snapshot.partial,fingerprint,manifest:new Map(files.map(f=>[f.path,f.hash]))};
  }
  // Mudança só de documentação ou de versão: textos (.md, .txt, .log), capturas de tela e manifestos do npm
  // em que só o campo "version" mudou. Uma revisão disso não precisa de nova fala de verificação.
  async docsOnly(roomId,before,after) {
    if(!before?.manifest || !after?.manifest || before.partial || after.partial)return false;
    const paths=new Set([...before.manifest.keys(),...after.manifest.keys()]),changed=[];
    for(const path of paths)if(before.manifest.get(path)!==after.manifest.get(path))changed.push(path);
    if(!changed.length)return false;
    const blob=hash=>hash?readFile(join(this.root,roomId,'blobs',hash),'utf8'):Promise.resolve(null);
    for(const path of changed) {
      // Um PNG em public/, um prompt Markdown ou requirements.txt alteram o produto.
      if(/(?:^|\/)(?:readme|changelog|contributing|project_context)(?:\.(?:md|markdown|txt))?$/i.test(path))continue;
      if(/(?:^|\/)docs\//i.test(path) && /\.(?:md|markdown|txt|png|jpe?g|webp|gif)$/i.test(path) && !/(?:^|\/)(?:agents|skill|claude|gemini)\.md$/i.test(path))continue;
      if(!/(?:^|\/)package(?:-lock)?\.json$/.test(path))return false;
      try {
        const [a,b]=await Promise.all([blob(before.manifest.get(path)),blob(after.manifest.get(path))]);
        if(a===null || b===null)return false;
        const strip=text=>{const v=JSON.parse(text);delete v.version;if(v.packages?.[''])delete v.packages[''].version;return JSON.stringify(v);};
        if(strip(a)!==strip(b))return false;
      } catch {return false;}
    }
    return true;
  }
  async list(roomId) {
    const entries=await readdir(join(this.root,roomId)).catch(()=>[]),snapshots=[];
    for(const name of entries) if(/^[a-f0-9-]{36}\.json$/.test(name)) {
      try{snapshots.push(JSON.parse(await readFile(join(this.root,roomId,name),'utf8')));}catch{}
    }
    return snapshots.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,60);
  }
  async file(roomId,snapshotId,path) {
    if(!/^[a-f0-9-]{36}$/.test(snapshotId)) throw Object.assign(new Error('Versão inválida.'),{statusCode:400});
    const manifest=JSON.parse(await readFile(join(this.root,roomId,`${snapshotId}.json`),'utf8'));
    const entry=manifest.files.find(f=>f.path===path);if(!entry || !/^[a-f0-9]{64}$/.test(entry.hash)) throw Object.assign(new Error('Arquivo não encontrado nesta versão.'),{statusCode:404});
    const data=await readFile(join(this.root,roomId,'blobs',entry.hash));
    if(createHash('sha256').update(data).digest('hex')!==entry.hash) throw new Error('Falha na integridade da versão.');
    return {data,name:entry.path.split('/').at(-1)};
  }
}
