// Command bridge for clients whose custom-agent tool registry excludes MCP tools.
import { readFile } from 'node:fs/promises';
const [integration,name,input='{}',encoded]=process.argv.slice(2);
const json=input==='--json-base64'?Buffer.from(encoded || '','base64').toString('utf8'):input.startsWith('@')?await readFile(input.slice(1),'utf8'):input;
const url=process.env.MESA_TOOL_GATEWAY_URL,token=process.env.MESA_TOOL_GATEWAY_TOKEN;
if(!url || !token)throw new Error('Esta ferramenta só funciona durante a participação autorizada na Synapse.');
const target=new URL(url);if(target.protocol!=='http:' || target.hostname!=='127.0.0.1' || target.pathname!=='/rpc')throw new Error('Conexão inválida.');
const r=await fetch(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({integration,method:name==='--list'?'tools/list':'tools/call',params:name==='--list'?{}:{name,arguments:JSON.parse(json)}})});
const body=await r.json();console.log(JSON.stringify(body));if(!r.ok || body.isError)process.exitCode=1;
