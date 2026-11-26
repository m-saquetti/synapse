import { createInterface } from 'node:readline';
import { appendFile } from 'node:fs/promises';
const lines=createInterface({input:process.stdin});
for await(const line of lines){
  const m=JSON.parse(line);if(m.id===undefined)continue;
  let result={};
  if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}};
  if(m.method==='tools/list')result={tools:[{name:'echo',inputSchema:{type:'object'}}]};
  if(m.method==='tools/call'){await appendFile(process.argv[2],JSON.stringify(m.params));result={content:[{type:'text',text:m.params.arguments.value}]};}
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
}
