import { createInterface } from 'node:readline';
const [url,integration]=process.argv.slice(2),token=process.env.MESA_TOOL_GATEWAY_TOKEN;
const target=new URL(url);if(target.protocol!=='http:' || target.hostname!=='127.0.0.1' || target.pathname!=='/rpc' || !token)throw new Error('Conexão local inválida.');
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
for await(const line of createInterface({input:process.stdin})) {
  let m;try{m=JSON.parse(line);}catch{continue;}if(m.id===undefined)continue;
  try {
    let result;
    if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:`mesa_${integration}`,version:'0.3.0'}};
    else if(m.method==='ping')result={};
    else if(['tools/list','tools/call'].includes(m.method)) {
      const r=await fetch(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({integration,method:m.method,params:m.params})});result=await r.json();if(!r.ok)throw new Error(result.error || 'Ferramenta indisponível.');
    } else throw new Error('Método não suportado.');
    send({id:m.id,result});
  }catch(e){send({id:m.id,error:{code:-32603,message:e.message}});}
}
