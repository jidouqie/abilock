import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixture-map.json',import.meta.url),'utf8'));
const target=pathToFileURL(fixture.windowsPathsModule).href;
export async function resolve(specifier,context,nextResolve){
 const resolved=await nextResolve(specifier,context);
 if(resolved.url===target)return{url:new URL('./windows-paths.mjs',import.meta.url).href,shortCircuit:true};
 return resolved;
}
