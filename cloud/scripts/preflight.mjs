import {pathToFileURL} from 'node:url';
import {envArg,loadEnv,validate} from './deploy-config.mjs';
export async function preflight(args=process.argv.slice(2)){
 const errors=validate(await loadEnv(envArg(args)));
 for(const error of errors)console.log(error);
 if(errors.length){console.log('To generate an encryption key locally: openssl rand -base64 32 (save it privately in .env.deploy; never commit it).');return 1;}
 console.log('PASS: deployment configuration is complete; no values printed.');return 0;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)preflight().then(code=>process.exitCode=code).catch(()=>{console.error('Preflight failed: invalid or unreadable env file.');process.exitCode=1;});
