import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isEntryPoint } from './lib/entry.mjs';
import { Store } from './lib/store.mjs';
import { Coordinator } from './lib/coordinator.mjs';
import { Providers } from './lib/providers.mjs';
import { Accounts } from './lib/accounts.mjs';
import { Approvals } from './lib/approvals.mjs';
import { Versions } from './lib/versions.mjs';
import { inspectIntegrations, userMcpServers } from './lib/integrations.mjs';
import { acquireLock } from './lib/lock.mjs';
import { normalizeSettings, MODEL_OPTIONS } from './lib/settings.mjs';
import { normalizeCatalog } from './lib/models.mjs';
import { usageRows } from './lib/analytics.mjs';
import { readFileSync } from 'node:fs';

// Mesma versão do aplicativo: o desktop reconhece um servidor antigo e o substitui.
const APP_VERSION=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8')).version;
import { browseFolders, verifyDirectory, workspaceFor, listFiles, readWorkspaceFile } from './lib/files.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const fail = (message, statusCode = 400) => Object.assign(new Error(message),{statusCode});
const names = {user:'Você',codex:'Codex',claude:'Claude',gemini:'Gemini',system:'Synapse'};

function textField(value, field, max, {optional=false, empty=false}={}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max)
    throw fail(`${field}: informe ${empty ? 'um texto de' : 'entre 1 e'} até ${max} caracteres.`);
  return value.trim();
}
function readBody(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json'))
    return Promise.reject(fail('Use Content-Type: application/json.',415));
  return new Promise((resolveBody,reject) => {
    let size = 0, chunks = [], exceeded = false;
    req.on('data',chunk => {
      size += chunk.length;
      if (size > 100000) { exceeded = true; chunks = []; }
      else if (!exceeded) chunks.push(chunk);
    });
    req.on('error',reject);
    req.on('end',() => {
      if (exceeded) return reject(fail('Mensagem grande demais. Divida o conteúdo em partes.',413));
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolveBody(body);
      } catch { reject(fail('JSON inválido.')); }
    });
  });
}

export async function createApp(options = {}) {
  // O aplicativo de desktop guarda os dados no perfil do usuário (ORBITA_DATA_DIR); o modo de desenvolvimento usa .data.
  const dataDir = resolve(options.dataDir || process.env.SYNAPSE_DATA_DIR || process.env.ORBITA_DATA_DIR || join(root,'.data'));
  await mkdir(dataDir,{recursive:true});
  const releaseLock = await acquireLock(dataDir);
  let store;
  try { store = new Store(join(dataDir,'mesa.sqlite')); store.recoverInterruptedJobs(); }
  catch(error) { await releaseLock(); throw error; }
  if (!store.listRooms().length) store.createRoom('Nossa primeira sala','Uma sala para transformar ideias em projetos, com GPT, Claude e Gemini trabalhando juntos.');
  const csrfToken = randomBytes(32).toString('hex');
  const instanceId = randomUUID();
  const runtimePath = join(dataDir,'runtime.json');
  const streams = new Set();
  const previews = new Map();
  const workspaceRoot=join(dataDir,'workspaces');
  const withWorkspace=room=>({...room,workspacePath:workspaceFor(room,workspaceRoot)});
  // Resposta direta: a mensagem citada precisa existir nesta sala; o trecho é o que o usuário selecionou nela.
  function replyField(value,roomId) {
    if(value===undefined || value===null)return null;
    if(typeof value!=='object' || typeof value.id!=='string')throw fail('Resposta: indique a mensagem respondida.');
    const target=store.getMessage(roomId,value.id);
    if(!target || target.role==='system')throw fail('A mensagem respondida não existe mais nesta sala.',404);
    const quote=value.quote===undefined?undefined:textField(value.quote,'Trecho citado',1200);
    return {id:target.id,role:target.role,...(quote?{quote}:{})};
  }
  async function roomSettings(value,previous) {
    const settings=normalizeSettings(value,previous);
    const changed=['codex','claude','gemini'].filter(agent=>{
      const field=agent+'Model';
      return Object.hasOwn(value,field) && settings[field] && settings[field]!=='auto' && settings[field]!==previous?.[field];
    });
    if(changed.length) {
      const catalog=await agents();
      for(const agent of changed){
        const row=catalog[agent]?.models?.find(m=>m.id===settings[agent+'Model']);
        if(row && ['locked','cooldown'].includes(row.availability))throw fail('Este modelo está bloqueado ou em pausa. Escolha outro no catálogo.',409);
      }
    }
    if (settings.workspace) settings.workspace=await verifyDirectory(settings.workspace);
    return settings;
  }
  let statusCache, statusTime = 0, statusPromise;
  const providers=new Providers({dataDir,store,notify:(event,data)=>{statusTime=0;notify(event,data);}});
  // Botão Conectar/Reconectar (1.6): login pelo cliente oficial de cada participante. Um login concluído invalida
  // o status em cache, então a próxima leitura já mostra a conta conectada.
  const accounts=options.accounts || new Accounts({dataDir,providers,version:APP_VERSION,notify:(event,data)=>{if(event==='update')statusTime=0;notify(event,data);}});
  const approvals=new Approvals(store,notify),versions=new Versions(dataDir);
  const statusProvider = options.getAgentStatus || (opts=>providers.status(opts));
  let integrationsCache;
  const integrations=async()=>integrationsCache ||= options.getAgentStatus?[]:await inspectIntegrations(root);
  async function agents(force = false, fresh = false) {
    if (!force && statusCache && Date.now() - statusTime < 60000) return statusCache;
    if (statusPromise) return statusPromise;
    statusPromise = Promise.resolve().then(() => statusProvider({fresh})).then(value => {
      statusCache = value; statusTime = Date.now(); return value;
    }).finally(() => { statusPromise = null; });
    return statusPromise;
  }
  function notify(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const stream of streams) {
      if (stream.destroyed || stream.writableLength > 1024*1024) { streams.delete(stream); stream.destroy(); }
      else stream.write(payload);
    }
  }
  const orchestrator = new Coordinator({store,runAgent:options.runAgent || (args=>providers.run(args)),approvals,versions,
    getAgentStatus:() => agents(true),workspaceRoot:join(dataDir,'workspaces'),notify,timeoutMs:options.timeoutMs});
  let port, closing;
  const server = createServer(async(req,res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const json = (data,status=200) => { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); };
    try {
      const allowedHosts = [`127.0.0.1:${port}`,`localhost:${port}`];
      if (!allowedHosts.includes(req.headers.host)) throw fail('Host não permitido.',403);
      const origin = req.headers.origin;
      if (origin && !allowedHosts.map(host=>`http://${host}`).includes(origin)) throw fail('Origem não permitida.',403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw fail('Acesso externo não permitido.',403);
      const url = new URL(req.url,'http://127.0.0.1');
      const path = url.pathname;
      if (!['GET','POST','PATCH','DELETE'].includes(req.method)) throw fail('Método não permitido.',405);
      if (req.method !== 'GET') {
        const token = req.headers['x-csrf-token'];
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) ||
          !timingSafeEqual(Buffer.from(token),Buffer.from(csrfToken))) throw fail('Sessão expirada. Atualize a página.',403);
      }
      if (closing) throw fail('A Synapse está encerrando.',503);
      if (req.method === 'GET' && path === '/api/health') return json({ok:true,app:'mesa-central',version:APP_VERSION,instanceId});
      if (req.method==='GET' && path.startsWith('/preview/')) {
        const preview=previews.get(path.slice('/preview/'.length));
        if (!preview || preview.expires<Date.now()) throw fail('Prévia expirada. Abra o arquivo novamente.',404);
        res.removeHeader('X-Frame-Options');
        res.setHeader('Content-Security-Policy',"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); return res.end(preview.html);
      }
      if (req.method === 'POST' && path === '/api/admin/shutdown') {
        const body = await readBody(req);
        if (body.instanceId !== instanceId) throw fail('Esta instância pertence a outra pasta de dados da Synapse.',409);
        // Atualização: o servidor confirma a fila vazia e, no mesmo instante, deixa de aceitar tarefas.
        if (body.onlyIfIdle === true && !orchestrator.drain()) throw Object.assign(fail('Há tarefas em andamento. A atualização espera elas terminarem.',409),{busy:true});
        res.setHeader('Connection','close');
        res.once('finish',() => { void close().catch(error => console.error('[Synapse]',error.message)); });
        return json({status:'encerrando'},202);
      }
      if (req.method === 'GET' && path === '/api/bootstrap') {
        const current=options.getAgentStatus || statusCache ? await agents() : Object.fromEntries(['codex','claude','gemini'].map(id=>[id,{loading:true}]));
        if(!options.getAgentStatus && !statusCache && !statusPromise)void agents().then(()=>notify('update',{type:'providers'}),()=>{});

        const models=Object.fromEntries(['codex','claude','gemini'].map(a=>[a,current[a]?.models?.length?current[a].models:normalizeCatalog(a,MODEL_OPTIONS[a]).map(m=>({...m,unverified:true}))]));
        return json({csrfToken,rooms:store.listRooms().map(withWorkspace),agents:current,activeJobs:store.activeJobs(),models,integrations:await integrations(),accounts:accounts.list()});
      }
      if(req.method==='POST' && path==='/api/agents/gemini/connect') {await readBody(req);return json(await accounts.start('gemini'),202);}
      if(req.method==='GET' && path==='/api/accounts') return json({accounts:accounts.list()});
      // Nomes dos servidores MCP das suas configurações do Claude Code e do Codex (sem comandos, argumentos nem variáveis).
      if(req.method==='GET' && path==='/api/integrations/user-mcp') {
        const roomId=url.searchParams.get('roomId') || '',room=roomId?store.getRoom(roomId):null;
        return json({servers:options.userMcpServers?await options.userMcpServers():await userMcpServers(room?workspaceFor(room,workspaceRoot):undefined)});
      }
      const account=path.match(/^\/api\/accounts\/(codex|claude|gemini)\/(login|code|cancel)$/);
      if(req.method==='POST' && account) {
        const body=await readBody(req),[,agent,action]=account;
        if(action==='login') {
          if(body.method!==undefined && !['browser','device'].includes(body.method))throw fail('Forma de login inválida.');
          return json(await accounts.start(agent,{method:body.method || 'browser',restart:body.restart===true}),202);
        }
        if(action==='code') return json(accounts.submitCode(agent,body.code));
        return json(accounts.cancel(agent));
      }
      const approval=path.match(/^\/api\/approvals\/([a-zA-Z0-9-]+)$/);
      if(req.method==='POST' && approval) {approvals.answer(approval[1],await readBody(req));return json({ok:true});}
      if (req.method==='POST' && path==='/api/folders') {
        const body=await readBody(req);
        return json(await browseFolders(body.path));
      }
      if (req.method === 'GET' && path === '/api/agents') return json({agents:await agents(true, true)});
      if (req.method === 'GET' && path === '/api/analytics') {
        const since=url.searchParams.get('since') || '', roomId=url.searchParams.get('roomId') || '';
        if (since && Number.isNaN(Date.parse(since))) throw fail('Período inválido.');
        return json({rows:usageRows(store.db,{since,roomId}),generatedAt:new Date().toISOString()});
      }
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Connection':'keep-alive','X-Accel-Buffering':'no'});
        res.write(': connected\n\n'); streams.add(res);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'),20000);
        res.on('close',() => { streams.delete(res); clearInterval(heartbeat); });
        return;
      }
      if (req.method === 'POST' && path === '/api/rooms') {
        const body = await readBody(req);
        const settings=await roomSettings(body.settings ?? {});
        const room = store.createRoom(textField(body.title,'Nome da sala',100),textField(body.brief ?? '','Briefing',10000,{empty:true}),settings);
        notify('update',{type:'room',roomId:room.id}); return json({room:withWorkspace(room)},201);
      }
      const match = path.match(/^\/api\/rooms\/([a-zA-Z0-9-]+)(?:\/(messages|export|files|file|versions|version-file|archive))?$/);
      if (match) {
        const room = store.getRoom(match[1]);
        if (!room) throw fail('Sala não encontrada.',404);
        if (req.method==='POST' && match[2]==='archive') {
          const body=await readBody(req);
          if (typeof body.archived!=='boolean') throw fail('Informe se a sala deve ser arquivada.');
          if (store.activeJobs().some(j=>j.roomId===room.id)) throw fail('Aguarde a rodada terminar antes de arquivar a sala.',409);
          const updated=store.setArchived(room.id,body.archived);
          notify('update',{type:'room',roomId:room.id});return json({room:withWorkspace(updated)});
        }
        if (req.method==='DELETE' && !match[2]) {
          if (store.activeJobs().some(j=>j.roomId===room.id)) throw fail('Interrompa a rodada em andamento antes de excluir a sala.',409);
          // Arquivos gerados na pasta padrão da sala e as versões vão para a lixeira dos dados, nunca são apagados
          // de imediato. Pastas escolhidas pelo usuário ficam intocadas.
          const trash=join(dataDir,'lixeira',`${room.id}-${new Date().toISOString().replace(/[:.]/g,'-')}`);
          const moved=[];
          for (const [source,name] of [[room.settings.workspace?null:join(workspaceRoot,room.id),'arquivos'],[join(dataDir,'versions',room.id),'versoes']]) {
            if (!source || !(await stat(source).catch(()=>null))) continue;
            await mkdir(trash,{recursive:true});await rename(source,join(trash,name));moved.push(name);
          }
          store.deleteRoom(room.id);
          notify('update',{type:'room-deleted',roomId:room.id});
          return json({deleted:true,trash:moved.length?trash:null});
        }
        if (req.method === 'GET' && !match[2]) return json({room:withWorkspace(room),messages:store.messages(room.id),jobs:store.jobs(room.id),events:store.events(room.id),sessions:store.sessions(room.id),checkpoints:store.checkpoints(room.id),approvals:store.approvals(room.id)});
        if(req.method==='GET' && match[2]==='versions') return json({versions:await versions.list(room.id)});
        if(req.method==='POST' && match[2]==='version-file') {
          const body=await readBody(req);const file=await versions.file(room.id,body.snapshotId,body.path);
          res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="arquivo"; filename*=UTF-8''${encodeURIComponent(file.name)}`});return res.end(file.data);
        }
        if (req.method==='POST' && match[2]==='files') {
          const body=await readBody(req);
          return json(await listFiles(workspaceFor(room,workspaceRoot),body.path ?? '',{create:!room.settings.workspace}));
        }
        if (req.method==='POST' && match[2]==='file') {
          const body=await readBody(req);
          const file=await readWorkspaceFile(workspaceFor(room,workspaceRoot),body.path);
          if (body.download===true) {
            res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="arquivo"; filename*=UTF-8''${encodeURIComponent(file.name)}`});
            return res.end(file.data);
          }
          if (file.kind==='binary') return json({...file,data:undefined});
          if (file.kind!=='image' && file.size>1024*1024) throw fail('A prévia é limitada a 1 MB. Baixe o arquivo para abri-lo.',413);
          let previewUrl;
          if (file.kind==='html') {
            for (const [key,value] of previews) if(value.expires<Date.now()) previews.delete(key);
            while (previews.size>=12) previews.delete(previews.keys().next().value);
            const token=randomBytes(24).toString('hex');
            previews.set(token,{html:file.data.toString('utf8'),expires:Date.now()+30*60000});
            previewUrl=`/preview/${token}`;
          }
          return json({...file,data:undefined,text:file.kind==='image'?undefined:file.data.toString('utf8'),image:file.kind==='image'?`data:${file.mime};base64,${file.data.toString('base64')}`:undefined,previewUrl});
        }
        if (req.method === 'PATCH' && !match[2]) {
          if (store.activeJobs().some(j=>j.roomId===room.id)) throw fail('Aguarde a rodada terminar antes de editar o briefing.',409);
          const body = await readBody(req);
          const settings=body.settings===undefined?undefined:await roomSettings(body.settings,room.settings);
          if (store.activeJobs().some(j=>j.roomId===room.id)) throw fail('Aguarde a rodada terminar antes de editar o briefing.',409);
          const updated = store.updateRoom(room.id,{title:textField(body.title,'Nome da sala',100,{optional:true}),brief:textField(body.brief,'Briefing',10000,{optional:true,empty:true}),settings});
          notify('update',{type:'room',roomId:room.id}); return json({room:withWorkspace(updated)});
        }
        if (req.method === 'POST' && match[2] === 'messages') {
          const body = await readBody(req);
          if (room.archivedAt) throw fail('Esta sala está arquivada. Restaure-a para continuar a conversa.',409);
          const content = textField(body.content,'Mensagem',24000);
          const reply = replyField(body.replyTo,room.id);
          return json(orchestrator.enqueue(room.id,content,body.target ?? (['chat','code'].includes(body.mode)?'auto':'both'),body.mode ?? 'conversation',reply),202);
        }
        if (req.method === 'GET' && match[2] === 'export') {
          const messages = store.messages(room.id);
          const body = [`# ${room.title}`,`Exportado em ${new Date().toISOString()}.`,`## Briefing`,room.brief || 'Não definido.',...messages.flatMap(m=>[`## ${names[m.role] || m.role} · ${m.createdAt}`,m.content]),'## Execuções',...store.jobs(room.id).map(j=>`- ${j.createdAt}: ${j.mode}, ${j.status}, etapa ${j.step}/${j.totalSteps}${j.error ? ` — ${j.error}` : ''}`)].join('\n\n');
          res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="synapse-${room.id.slice(0,8)}.md"`});
          return res.end(body);
        }
      }
      const steering=path.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)\/steer$/);
      if(req.method==='POST' && steering){
        const body=await readBody(req),content=textField(body.content,'Mensagem',24000);
        const job=store.getJob(steering[1]);
        if(!job)throw fail('Tarefa não encontrada.',404);
        const reply=replyField(body.replyTo,job.roomId);
        const p=job.progress;
        if(!p?.liveDebate || p.stage==='sintese' || p.round?.synthesized || !['queued','running'].includes(job.status) || p.completed+(p.activeAgents?.length || 0)>=job.totalSteps)throw fail('Esta rodada está encerrando. Envie sua mensagem ao terminar.',409);
        const message=store.addMessage(job.roomId,'user',content,{jobId:job.id,reply});
        notify('update',{type:'steering',roomId:job.roomId,jobId:job.id});return json({message},201);
      }
      const resume=path.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)\/resume$/);
      if(req.method==='POST' && resume) {
        const body=await readBody(req),job=store.getJob(resume[1]);if(!job)throw fail('Tarefa não encontrada.',404);
        const content=textField(body.content,'Resposta',24000,{optional:true,empty:true});
        const reply=content?replyField(body.replyTo,job.roomId):null;
        const resumed=orchestrator.resume(job.id);
        if(content)store.addMessage(job.roomId,'user',content,{jobId:job.id,reply});
        return json({job:resumed},202);
      }
      const cancel = path.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)\/cancel$/);
      if (req.method === 'POST' && cancel) {
        await readBody(req);
        const job = orchestrator.cancel(cancel[1]);
        if (!job) throw fail('Rodada não encontrada.',404);
        return json({job});
      }
      const assets = {'/':['index.html','text/html'],'/index.html':['index.html','text/html'],
        '/app.js':['app.js','text/javascript'],'/styles.css':['styles.css','text/css'],'/tema.css':['tema.css','text/css'],'/analises.js':['analises.js','text/javascript'],'/favicon.svg':['favicon.svg','image/svg+xml']};
      if (req.method === 'GET' && assets[path]) {
        const [filename,mime] = assets[path];
        const file = await readFile(join(root,'public',filename));
        res.writeHead(200,{'Content-Type':`${mime}; charset=utf-8`}); return res.end(file);
      }
      throw fail('Recurso não encontrado.',404);
    } catch(error) {
      if (res.headersSent) { res.end(); return; }
      json({error:error.statusCode ? error.message : error.code === 'ENOENT' ? 'Arquivo não encontrado.' : 'Não foi possível concluir esta operação.',...(error.busy?{busy:true}:{})},error.statusCode || (error.code === 'ENOENT' ? 404 : 500));
      if (!error.statusCode && error.code !== 'ENOENT') console.error('[Synapse]',error.message);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  function close() {
    if (closing) return closing;
    closing = (async () => {
      const listenerClosed = new Promise(resolveClose => server.close(resolveClose));
      for (const stream of streams) stream.end();
      streams.clear();
      await orchestrator.stop();
      accounts.close();
      providers.close();
      await listenerClosed;
      await statusPromise?.catch(()=>{});
      store.close();
      try {
        await unlink(runtimePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      } finally { await releaseLock(); }
    })();
    return closing;
  }
  return {server,store,orchestrator,
    async listen(requestedPort=4317) {
      await new Promise((resolveListen,reject) => {
        server.once('error',reject);
        server.listen(requestedPort,'127.0.0.1',() => { server.removeListener('error',reject); port=server.address().port; resolveListen(); });
      });
      const url = `http://127.0.0.1:${port}`;
      const staging = join(dataDir,`runtime-${instanceId}.tmp`);
      await writeFile(staging,JSON.stringify({pid:process.pid,url,instanceId,startedAt:new Date().toISOString()}));
      await rename(staging,runtimePath);
      return url;
    }, close
  };
}

if (isEntryPoint(import.meta.url)) {
  const app = await createApp();
  try {
    const requestedPort = Number(process.env.MESA_PORT || 4317);
    if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) throw new Error('MESA_PORT inválida.');
    const url = await app.listen(requestedPort);
    console.log(`Synapse v${APP_VERSION} • ${url}`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping=true; await app.close(); process.exit(0); };
    process.on('SIGINT',stop); process.on('SIGTERM',stop);
  } catch(error) {
    console.error(error.code === 'EADDRINUSE' ? 'A porta 4317 já está ocupada. Abra a Synapse pelo aplicativo ou defina MESA_PORT.' : error.message);
    await app.close(); process.exitCode=1;
  }
}
