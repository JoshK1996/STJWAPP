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
export async function download(path:string,name:string) {
  const response=await fetch(`/api${path}`,{credentials:'same-origin'});
  if(!response.ok)throw await responseError(response,'Download failed.');
  const url=URL.createObjectURL(await response.blob());const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export async function downloadPost(path:string,body:unknown,name:string) {
 const finish = beginWrite('POST');
 try {
 const response=await fetch(`/api${path}`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});
 if(!response.ok)throw await responseError(response,'Download failed.');
 const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 } finally { finish(); }
}
