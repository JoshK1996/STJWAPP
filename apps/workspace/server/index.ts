import { startScheduledClockWorker } from "./scheduled-clock";
import { createApp } from "./app";
import { connectDatabase, migrate, verifySchema } from "./db";
import { assertRuntimeAccess } from "./runtime-access";
import { initialize } from "./seed";
import { initializeSchoolDemo } from "./school-seed";
import { initializeAttendanceDemo } from "./attendance-seed";
import { readConfig } from "./config";
import { mfaKeyAvailable } from "./totp";
const config = readConfig();
const db = await connectDatabase(
  process.env.DATABASE_URL,
  process.env.LOCAL_DATABASE_PATH ?? ".local/database",
);
if (config.production) {
  await verifySchema(db);
  await assertRuntimeAccess(db);
  if (!(await db.query("SELECT id FROM organizations LIMIT 1")).rows.length)
    throw new Error(
      "Workspace must be provisioned through the maintenance path before production startup.",
    );
} else {
  await migrate(db);
  await initialize(db, config);
  await initializeSchoolDemo(db, config.demo);
  await initializeAttendanceDemo(db, config.demo);
}
if (
  (await db.query("SELECT user_id FROM mfa_factors LIMIT 1")).rows.length &&
  !mfaKeyAvailable()
)
  throw new Error(
    "MFA_ENCRYPTION_KEY is required for existing authenticator records.",
  );
// Only a hash enters hosting configuration. The private setup link remains with its owner.
if (!config.production && process.env.OWNER_SETUP_TOKEN_HASH) {
  if (!/^[a-f0-9]{64}$/.test(process.env.OWNER_SETUP_TOKEN_HASH))
    throw new Error("Invalid setup token hash.");
  await db.query(
    `INSERT INTO setup_tokens(token_hash,org_id,user_id,expires_at)
    SELECT $1,org_id,id,now()+interval '24 hours' FROM users WHERE email=$2 AND role='owner' AND password_hash IS NULL
    ON CONFLICT(token_hash) DO NOTHING`,
    [process.env.OWNER_SETUP_TOKEN_HASH, config.ownerEmail.toLowerCase()],
  );
}
const stopScheduledClockWorker = startScheduledClockWorker(db);
const server = createApp(db, config).listen(
  Number(process.env.PORT ?? 3000),
  "0.0.0.0",
  () => console.log("STJW workspace listening; database ready."),
);
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close(async () => {
    await stopScheduledClockWorker();
    await db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
