import { connectDatabase,migrate } from '../server/db';
import { readConfig } from '../server/config';
if(readConfig().production)throw new Error('Production migrations use the separately authenticated PostgreSQL maintenance path; see docs/DATABASE-OPERATIONS.md.');
const db=await connectDatabase(process.env.DATABASE_URL,process.env.LOCAL_DATABASE_PATH??'.local/database');
await migrate(db);await db.close();console.log('Database migrations complete.');
