import { register } from 'node:module';
process.once('uncaughtException',error=>{
 const code=typeof error.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(error.code)?error.code:'FIXTURE_SETUP_FAILED';
 process.stdout.write(JSON.stringify({ok:false,stage:'loader-or-fixture-setup',code,errorType:error.name,syntheticOnly:true,passwordValuesPrinted:false})+'\n',()=>process.exit(1));
});
register(new URL('./loader.mjs', import.meta.url), import.meta.url);
