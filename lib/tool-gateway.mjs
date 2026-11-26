import { createServer } from 'node:http';
import { randomBytes,timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StdioRpc } from './rpc.mjs';

// An agent's MCP client can skip its own prompts. This gateway owns approval
// before forwarding tools/call, so external tools cannot bypass the Mesa queue.
export async function createToolGateway(integrations,requestApproval,signal) {
  const token=randomBytes(32).toString('hex'),clients=new Map();let closed=false;
  async function client(id) {
    if(clients.has(id))return clients.get(id);
    const spec=integrations.find(i=>i.id===id);if(!spec)throw new Error('Ferramenta desconhecida.');
    const promise=(async()=>{const rpc=new StdioRpc(spec.command,spec.args,{signal,jsonrpc:true});try{await rpc.call('initialize',{protocolVersion:'2024-11-05',clientInfo:{name:'mesa-approval-gateway',version:'0.3.0'},capabilities:{}},30000);rpc.notify('notifications/initialized');return rpc;}catch(e){rpc.close();throw e;}})();
    clients.set(id,promise);return promise;
  }
  const server=createServer(async(req,res)=>{
    const auth=String(req.headers.authorization || '').replace(/^Bearer /,'');
    if(req.method!=='POST' || req.url!=='/rpc' || req.headers.origin || !/^[a-f0-9]{64}$/.test(auth) || !timingSafeEqual(Buffer.from(auth),Buffer.from(token))) {res.writeHead(403);res.end();return;}
    try {
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>60000)throw new Error('Solicitação extensa demais.');}
      const {integration,method,params={}}=JSON.parse(raw);
      if(!['tools/list','tools/call'].includes(method))throw new Error('Método não permitido.');
      if(!integrations.some(i=>i.id===integration))throw new Error('Ferramenta não habilitada nesta participação.');
      if(method==='tools/call') {
        const reply=await requestApproval({kind:'permission',title:`Gemini · ${integration} · ${params.name}`,detail:JSON.stringify(params.arguments || {})});
        if(reply.decision!=='allow' || signal?.aborted || closed){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({content:[{type:'text',text:'Ação recusada na Synapse. Não tente contornar.'}],isError:true}));return;}
      }
      const result=await (await client(integration)).call(method,params,120000);
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
    }catch(error){if(!res.headersSent)res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
  });
  await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
  const url=`http://127.0.0.1:${server.address().port}/rpc`;
  const close=()=>{if(closed)return;closed=true;signal?.removeEventListener('abort',close);server.close();server.closeAllConnections();for(const promise of clients.values())promise.then(c=>c.close(),()=>{});};
  signal?.addEventListener('abort',close,{once:true});if(signal?.aborted)close();
  return {close,environment:{MESA_TOOL_GATEWAY_URL:url,MESA_TOOL_GATEWAY_TOKEN:token},command:fileURLToPath(new URL('./tool-invoke.mjs',import.meta.url)),servers:integrations.map(i=>({name:`mesa_${i.id}`,command:process.execPath,args:[fileURLToPath(new URL('./tool-proxy.mjs',import.meta.url)),url,i.id],env:[{name:'MESA_TOOL_GATEWAY_TOKEN',value:token}]}))};
}
