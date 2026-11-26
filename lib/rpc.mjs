import { spawn } from 'node:child_process';
import { AgentError, safeDiagnostic, stopProcessTree, subscriptionEnvironment } from './agents.mjs';

export class StdioRpc {
  static LIMITE=16*1024*1024;
  constructor(file,args,{cwd,env,signal,onNotification=()=>{},onRequest=async()=>{throw new Error('Solicitação não suportada.');},jsonrpc=false}={}) {
    this.pending=new Map();this.sequence=0;this.closed=false;this.stderr='';this.jsonrpc=jsonrpc;
    this.child=spawn(file,args,{cwd,env:env || subscriptionEnvironment(),shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    this.child.stdin.on('error',()=>{});
    let buffer='',descartando=false;this.descartadas=0;
    this.child.stdout.setEncoding('utf8');this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data',chunk=>{
      buffer+=chunk;
      let end;
      while((end=buffer.indexOf('\n'))!==-1) {
        const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        if(descartando){descartando=false;continue;} // fim de uma mensagem grande demais, já descartada
        if(line.length>StdioRpc.LIMITE){this.descartar(line.slice(0,400));continue;}
        let message;try{message=JSON.parse(line);}catch{continue;}
        if(message.method && Object.hasOwn(message,'id')) {
          Promise.resolve().then(()=>onRequest(message.method,message.params)).then(result=>this.send({id:message.id,result}),error=>this.send({id:message.id,error:{code:-32603,message:safeDiagnostic(error.message)}}));
        } else if(message.method) {
          try{onNotification(message.method,message.params);}catch(error){this.close(error);}
        } else if(Object.hasOwn(message,'id')) {
          const pending=this.pending.get(message.id);if(!pending) continue;
          this.pending.delete(message.id);clearTimeout(pending.timer);
          if(message.error) pending.reject(Object.assign(new Error(safeDiagnostic(message.error.message)),{rpcCode:message.error.code}));else pending.resolve(message.result);
        }
      }
      // Uma única mensagem acima do limite (ex.: catálogo de plugins com ícones) é descartada sem derrubar o canal.
      if(!descartando && buffer.length>StdioRpc.LIMITE) {descartando=true;this.descartar(buffer.slice(0,400));buffer='';}
      else if(descartando) buffer='';
    });
    this.child.stderr.on('data',data=>{this.stderr=(this.stderr+data).slice(-12000);});
    this.child.on('error',error=>this.close(new AgentError(safeDiagnostic(error.message),'UNAVAILABLE')));
    this.child.on('close',()=>this.close(new AgentError(safeDiagnostic(this.stderr)||'O cliente foi encerrado.','CLIENT_EXIT')));
    this.abort=()=>this.close(new AgentError('Execução interrompida.','CANCELLED'));
    this.signal=signal;signal?.addEventListener('abort',this.abort,{once:true});
    if(signal?.aborted) this.abort();
  }
  // A mensagem descartada era resposta a um pedido nosso: ele falha já, em vez de esperar o tempo esgotar.
  // Era um pedido do cliente: ele recebe um erro. Notificação: só é contada.
  descartar(inicio) {
    this.descartadas++;
    const id=Number(inicio.match(/"id"\s*:\s*(\d+)/)?.[1]),pedidoDoCliente=/"method"\s*:/.test(inicio);
    const erro=new AgentError('Uma resposta do cliente excedeu o limite de tamanho da Synapse e foi descartada.','OUTPUT_LIMIT');
    if(Number.isFinite(id) && pedidoDoCliente) this.send({id,error:{code:-32603,message:erro.message}});
    else if(Number.isFinite(id) && this.pending.has(id)) {const p=this.pending.get(id);this.pending.delete(id);clearTimeout(p.timer);p.reject(erro);}
  }
  send(message) {if(!this.closed) this.child.stdin.write(JSON.stringify(this.jsonrpc?{jsonrpc:'2.0',...message}:message)+'\n');}
  notify(method,params={}) {this.send({method,params});}
  call(method,params={},timeoutMs=30000) {
    if(this.closed) return Promise.reject(this.error || new Error('Cliente encerrado.'));
    return new Promise((resolve,reject)=>{
      const id=++this.sequence;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new AgentError(`O cliente demorou a responder: ${method}.`,'TIMEOUT'));},timeoutMs);
      this.pending.set(id,{resolve,reject,timer});this.send({id,method,params});
    });
  }
  close(error=new AgentError('Cliente encerrado.','CANCELLED')) {
    if(this.closed) return;this.closed=true;this.error=error;
    this.signal?.removeEventListener('abort',this.abort);
    for(const item of this.pending.values()) {clearTimeout(item.timer);item.reject(error);}this.pending.clear();
    this.child.stdin.end();stopProcessTree(this.child);this.onClose?.(error);
  }
}
