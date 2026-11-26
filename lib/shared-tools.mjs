// A small MCP server for public GitHub source inspection. Authentication remains with official clients.
import { createInterface } from 'node:readline';
const tool={name:'github_read',description:'Leia metadados, árvore ou um arquivo de um repositório público do GitHub. Para código-fonte, prefira esta inspeção normal a engenharia reversa de binários. Sem acesso a repositórios privados ou publicação.',inputSchema:{type:'object',properties:{repository:{type:'string',description:'owner/repository'},operation:{enum:['repository','tree','file']},path:{type:'string'},ref:{type:'string',description:'Branch, tag ou commit. Para tree/file, use a branch informada nos metadados.'}},required:['repository','operation'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}};
export async function githubRead(input) {
  if(!/^[\w.-]+\/[\w.-]+$/.test(input.repository||''))throw new Error('Use owner/repository.');
  if(!['repository','tree','file'].includes(input.operation))throw new Error('Operação inválida.');
  const base=`https://api.github.com/repos/${input.repository}`;
  const ref=String(input.ref||'HEAD');if(ref.length>200)throw new Error('Referência grande demais.');
  const path=String(input.path||'');if(path.length>1000 || path.split('/').includes('..') || /[\x00-\x1f]/.test(path))throw new Error('Caminho inválido.');
  const url=input.operation==='repository'?base:input.operation==='tree'?`${base}/git/trees/${encodeURIComponent(ref)}?recursive=1`:`${base}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
  const response=await fetch(url,{headers:{Accept:'application/vnd.github+json','User-Agent':'Orbita-Local/0.4'},signal:AbortSignal.timeout(20000),redirect:'error'});
  if(!response.ok)throw new Error(`GitHub respondeu ${response.status}. Acesso somente público; verifique o repositório e os limites do GitHub.`);
  let bytes=0,chunks=[];for await(const chunk of response.body){bytes+=chunk.length;if(bytes>4*1024*1024)throw new Error('Resposta muito grande. Solicite um caminho mais específico.');chunks.push(chunk);}
  const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const meta={source:url,remainingRequests:response.headers.get('x-ratelimit-remaining')};
  if(input.operation==='repository')return {...meta,name:value.full_name,description:value.description,defaultBranch:value.default_branch,url:value.html_url,language:value.language};
  if(input.operation==='tree')return {...meta,truncated:value.truncated || value.tree?.length>2000,entries:value.tree?.slice(0,2000).map(v=>({path:v.path,type:v.type,size:v.size}))};
  if(Array.isArray(value))return {...meta,entries:value.slice(0,1000).map(v=>({path:v.path,type:v.type,size:v.size}))};
  if(value.encoding!=='base64' || value.size>1024*1024)throw new Error('Arquivo indisponível ou maior que 1 MB.');
  return {...meta,path:value.path,content:Buffer.from(value.content,'base64').toString('utf8')};
}
if(process.argv.includes('--stdio')) {
  const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
  for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
    let message;try{message=JSON.parse(line);}catch{continue;}
    if(!Object.hasOwn(message,'id'))continue;
    try {
      let result;
      if(message.method==='initialize')result={protocolVersion:message.params?.protocolVersion || '2024-11-05',capabilities:{tools:{}},serverInfo:{name:'mesa-shared',version:'0.3.0'}};
      else if(message.method==='tools/list')result={tools:[tool]};
      else if(message.method==='ping')result={};
      else if(message.method==='tools/call' && message.params?.name===tool.name) {
        try{result={content:[{type:'text',text:JSON.stringify(await githubRead(message.params.arguments||{}))}]};}
        catch(error){result={isError:true,content:[{type:'text',text:error.message}]};}
      } else {send({id:message.id,error:{code:-32601,message:'Método não suportado'}});continue;}
      send({id:message.id,result});
    }catch(error){send({id:message.id,error:{code:-32603,message:error.message}});}
  }
}
