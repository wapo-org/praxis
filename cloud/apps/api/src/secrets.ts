import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {ApiError} from './service.js';
export function seal(value:string,userId:string,resource:string,key:string|undefined):string{
 if(!key)throw new ApiError(503,'encryption_unconfigured','Secret storage is not configured');
 const bytes=Buffer.from(key,'base64');if(bytes.length!==32)throw new ApiError(503,'encryption_unconfigured','Secret storage is not configured');
 const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',bytes,iv);cipher.setAAD(Buffer.from(`${userId}\0${resource}`));const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return ['v1',iv.toString('base64'),cipher.getAuthTag().toString('base64'),data.toString('base64')].join('.');
}
export function unseal(value:string,userId:string,resource:string,key:string):string{
 const [version,iv,tag,data]=value.split('.');if(version!=='v1'||!iv||!tag||data===undefined)throw new Error('Invalid encrypted value');const cipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'base64'),Buffer.from(iv,'base64'));cipher.setAAD(Buffer.from(`${userId}\0${resource}`));cipher.setAuthTag(Buffer.from(tag,'base64'));return Buffer.concat([cipher.update(Buffer.from(data,'base64')),cipher.final()]).toString('utf8');
}
