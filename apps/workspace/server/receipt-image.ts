import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { receiptLimits } from '../shared/shopping-receipts';
import { Problem, requireCondition } from './security';
sharp.cache(false);sharp.concurrency(1);
let processing=false;
export const receiptHash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function receiptSource(base64:string){
  requireCondition(base64.length%4===0,400,'Choose a valid photo.');
  const bytes=Buffer.from(base64,'base64');requireCondition(bytes.length<=receiptLimits.sourceBytes,413,'Choose a smaller photo (up to 8 MB).');
  const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255,png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),webp=bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
  requireCondition(jpeg||png||webp,400,'Choose a JPG, PNG or WebP photo, or take a new photo.');return bytes;
}
export async function normalizeReceiptImage(bytes:Buffer){
  requireCondition(!processing,503,'Another receipt photo is saving. Please retry in a moment.');processing=true;
  try{
    const metadata=await sharp(bytes,{limitInputPixels:receiptLimits.pixels,failOn:'error'}).metadata();
    requireCondition((metadata.pages??1)===1,400,'Use a single still photo.');
    const render=(quality:number)=>sharp(bytes,{limitInputPixels:receiptLimits.pixels,failOn:'error'}).rotate().resize({width:2400,height:4000,fit:'inside',withoutEnlargement:true}).jpeg({quality}).toBuffer({resolveWithObject:true});
    let image=await render(90);if(image.data.length>receiptLimits.photoBytes)image=await render(75);
    requireCondition(image.data.length<=receiptLimits.photoBytes,413,'This photo is too large. Try a smaller photo.');
    const thumbnail=await sharp(image.data).resize({width:360,height:540,fit:'inside',withoutEnlargement:true}).jpeg({quality:75}).toBuffer();
    requireCondition(thumbnail.length<=receiptLimits.thumbnailBytes,413,'Try a smaller photo.');
    return {photo:image.data,thumbnail,width:image.info.width,height:image.info.height,photoHash:receiptHash(image.data)};
  }catch(error){if(error instanceof Problem)throw error;throw new Problem(400,'This photo could not be read. Choose a JPG, PNG or WebP photo, or take a new photo.');}finally{processing=false;}
}
