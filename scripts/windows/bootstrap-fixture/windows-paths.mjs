// Test-only dependency adapter. Production core modules are not rewritten.
import fs from 'node:fs';
import path from 'node:path';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixture-map.json',import.meta.url),'utf8'));
export function windowsPaths(){return{install:fixture.root,program:fixture.root,data:fixture.cases,host:fixture.helper,node:fixture.node,system:fixture.windows,temporary:fixture.temporary};}
export function sameWindowsPath(a,b){return path.win32.normalize(a).replace(/[\\/]+$/,'').toLowerCase()===path.win32.normalize(b).replace(/[\\/]+$/,'').toLowerCase();}
export function windowsHostEnvironment(){return{SystemRoot:fixture.windows,WINDIR:fixture.windows,SystemDrive:path.win32.parse(fixture.windows).root.replace(/[\\/]+$/,''),PATH:path.win32.join(fixture.windows,'System32'),ProgramFiles:fixture.programFiles,ProgramData:fixture.programData,HOME:fixture.profile,USERPROFILE:fixture.profile,TEMP:fixture.temporary,TMP:fixture.temporary};}
