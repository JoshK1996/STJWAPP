import { beginWrite } from './pending-writes';
let csrf='';
export class ApiError extends Error {
  constructor(message:string,readonly status:number,readonly details?:unknown){super(message);this.name='ApiError';}
}
async function responseError(response:Response,fallback:string):Promise<ApiError> {
  // Preserve authorization status even when an upstream proxy returns HTML or
  // an empty body. Callers must still clear private data on a denied response.
  let message=fallback,details:unknown;
  try {const data=await response.json();details=data;if(typeof data?.error==='string')message=data.error;} catch {}
  return new ApiError(message,response.status,details);
}
export function setCsrf(value:string){csrf=value;}
export async function api<T=any>(path:string,body?:unknown,method=body===undefined?'GET':'POST',signal?:AbortSignal):Promise<T> {
  const finish = beginWrite(method);
  try {
  const response=await fetch(`/api${path}`,{method,credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf},...(body===undefined?{}:{body:JSON.stringify(body)}),...(signal?{signal}:{})});
  if(!response.ok)throw await responseError(response,'Something went wrong. Please try again.');
  return await response.json();
  } finally { finish(); }
}
export function download(path:string,name:string):Promise<void>;
export function download(path:string,name:string,canPublish:()=>boolean):Promise<boolean>;
export async function download(path:string,name:string,canPublish?:()=>boolean):Promise<void|boolean> {
  const mayPublish=canPublish??(()=>true);
  const response=await fetch(`/api${path}`,{credentials:'same-origin'});
  if(!mayPublish())return false;
  if(!response.ok)throw await responseError(response,'Download failed.');
  const blob=await response.blob();
  if(!mayPublish())return false;
  const url=URL.createObjectURL(blob);let published=false;
  try {
    const link=document.createElement('a');link.href=url;link.download=name;
    if(!mayPublish())return false;
    link.click();published=true;return canPublish?true:undefined;
  } finally {
    if(published)setTimeout(()=>URL.revokeObjectURL(url),1000);
    else URL.revokeObjectURL(url);
  }
}

export function downloadPost(path:string,body:unknown,name:string):Promise<void>;
export function downloadPost(path:string,body:unknown,name:string,canPublish:()=>boolean):Promise<boolean>;
export async function downloadPost(path:string,body:unknown,name:string,canPublish?:()=>boolean):Promise<void|boolean> {
 const finish = beginWrite('POST');
 const mayPublish=canPublish??(()=>true);
 try {
 const response=await fetch(`/api${path}`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});
 if(!mayPublish())return false;
 if(!response.ok)throw await responseError(response,'Download failed.');
 const blob=await response.blob();if(!mayPublish())return false;
 const url=URL.createObjectURL(blob);let published=false;
 try {
   const link=document.createElement('a');link.href=url;link.download=name;
   if(!mayPublish())return false;
   link.click();published=true;return canPublish?true:undefined;
 } finally {if(published)setTimeout(()=>URL.revokeObjectURL(url),1000);else URL.revokeObjectURL(url);}
 } finally { finish(); }
}
