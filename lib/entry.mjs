import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export function isEntryPoint(url,argument=process.argv[1],platform=process.platform) {
  if(!argument)return false;
  const target=pathToFileURL(resolve(argument)).href;
  return platform==='win32'?url.toLowerCase()===target.toLowerCase():url===target;
}
