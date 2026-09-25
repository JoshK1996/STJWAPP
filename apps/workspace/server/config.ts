import { existsSync } from 'node:fs';
if(existsSync('.env'))process.loadEnvFile('.env');
export function readConfig() {
  const production=process.env.NODE_ENV==='production';
  const origin=process.env.APP_ORIGIN??'http://localhost:3000';
  const parsed=new URL(origin);
  if(parsed.origin!==origin || (production && parsed.protocol!=='https:'))throw new Error('APP_ORIGIN must be an exact HTTPS origin in production.');
  if(production && !process.env.DATABASE_URL)throw new Error('DATABASE_URL is required in production.');
  return {origin,production,staffDomain:process.env.STAFF_EMAIL_DOMAIN??'stjw.org',demo:process.env.DEMO_MODE==='true'||(!production&&process.env.DEMO_MODE!=='false'),ownerEmail:process.env.OWNER_EMAIL??'owner@example.test'};
}
