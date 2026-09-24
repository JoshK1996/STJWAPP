import { mkdir,writeFile } from 'node:fs/promises';
import { connectDatabase,migrate,verifySchema } from '../server/db';
import { readConfig } from '../server/config';
import { initialize } from '../server/seed';
import { audit,issueSetup } from '../server/security';
const config=readConfig();
const db=await connectDatabase(process.env.DATABASE_URL,process.env.LOCAL_DATABASE_PATH??'.local/database');
if(config.production)await verifySchema(db);
else {await migrate(db);await initialize(db,config);}
const owner=(await db.query("SELECT id,org_id FROM users WHERE email=$1 AND role IN ('developer','owner')",[config.ownerEmail.toLowerCase()])).rows[0];
if(!owner)throw new Error('Configured owner not found.');
const actor={id:owner.id,org_id:owner.org_id};
const token=await db.transaction(async tx=>{const token=await issueSetup(tx,actor);await audit(tx,actor,'owner.setup_issued',actor.id);return token;});
await mkdir('.work',{recursive:true});
await writeFile('.work/owner-setup.html',`<!doctype html><meta name="referrer" content="no-referrer"><title>Private STJW setup</title><h1>Private STJW owner setup</h1><p>This link expires in 24 hours and can be used once. Keep this file private.</p><a href="${config.origin}/#setup=${token}">Set your STJW password</a>`,{mode:0o600});
await db.close();console.log('Private setup file saved to .work/owner-setup.html. No password or token was printed.');
