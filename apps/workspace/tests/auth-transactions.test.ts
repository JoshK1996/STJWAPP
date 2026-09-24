import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import {
  connectDatabase,
  migrate,
  type Database,
  type Queryable,
} from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import {
  digest,
  hashPassword,
  issueSetup,
  opaqueToken,
} from "../server/security";

let db: Database,
  orgId: string,
  passwordHash: string,
  changedHash: string,
  pinHash: string;
const origin = "http://localhost:3000",
  password = "Test!826",
  newPassword = "Next!826";
before(async () => {
  db = await connectDatabase();
  await migrate(db);
  await initialize(db, { demo: false, ownerEmail: "owner@example.test" });
  orgId = (await db.query("SELECT id FROM organizations")).rows[0].id;
  [passwordHash, changedHash, pinHash] = await Promise.all([
    hashPassword(password),
    hashPassword(newPassword),
    hashPassword("782619"),
  ]);
});
after(async () => {
  await db?.close();
});

async function person() {
  const id = randomUUID(),
    email = id + "@stjw.org";
  await db.query(
    "INSERT INTO users(id,org_id,name,email,role,password_hash,pin_hash) VALUES($1,$2,'Synthetic authentication test',$3,'employee',$4,$5)",
    [id, orgId, email, passwordHash, pinHash],
  );
  return { id, org_id: orgId, email };
}
function appFor(
  beforeTransaction?: () => Promise<void>,
  txQuery?: (tx: Queryable, sql: string, params?: any[]) => Promise<any>,
) {
  let armed = !!beforeTransaction;
  const wrapped: Database = {
    ...db,
    transaction: async (fn) => {
      if (armed) {
        armed = false;
        await beforeTransaction!();
      }
      return db.transaction((tx) =>
        fn(txQuery ? { query: (sql, params) => txQuery(tx, sql, params) } : tx),
      );
    },
  };
  return createApp(wrapped, {
    origin,
    production: false,
    staffDomain: "stjw.org",
    demo: true,
  });
}
function login(
  app: ReturnType<typeof createApp>,
  email: string,
  mode = "password",
  credential = password,
) {
  return request(app)
    .post("/api/auth/login")
    .set("Origin", origin)
    .send({ email, mode, credential });
}
async function session(id: string, mode = "password") {
  const token = opaqueToken(),
    csrf = opaqueToken();
  await db.query(
    "INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')",
    [digest(token), orgId, id, mode, csrf],
  );
  return { cookie: "stjw_session=" + token, csrf, hash: digest(token) };
}
async function authState(id: string) {
  return {
    user: (
      await db.query(
        "SELECT password_hash,pin_hash,active FROM users WHERE id=$1",
        [id],
      )
    ).rows[0],
    sessions: (
      await db.query(
        "SELECT token_hash FROM sessions WHERE user_id=$1 ORDER BY token_hash",
        [id],
      )
    ).rows,
    setup: (
      await db.query(
        "SELECT token_hash,consumed_at FROM setup_tokens WHERE user_id=$1 ORDER BY token_hash",
        [id],
      )
    ).rows,
    api: (
      await db.query(
        "SELECT id,revoked_at FROM api_tokens WHERE user_id=$1 ORDER BY id",
        [id],
      )
    ).rows,
    audit: (
      await db.query(
        "SELECT action FROM audit_events WHERE actor_id=$1 ORDER BY id",
        [id],
      )
    ).rows,
  };
}
const auditFailure = async (tx: Queryable, sql: string, params?: any[]) => {
  if (sql.startsWith("INSERT INTO audit_events"))
    throw new Error("Synthetic audit failure");
  return tx.query(sql, params);
};

test("password login rejects a proof computed before a committed password reset", async () => {
  const user = await person();
  const app = appFor(async () => {
    await db.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
      changedHash,
      user.id,
    ]);
  });
  const response = await login(app, user.email);
  assert.equal(response.status, 401);
  assert.equal(response.headers["set-cookie"], undefined);
  const state = await authState(user.id);
  assert.equal(state.sessions.length, 0);
  assert.equal(state.audit.length, 0);
  assert.equal(
    (await login(app, user.email, "password", newPassword)).status,
    200,
  );
});

test("PIN login rejects a proof computed before the PIN was replaced", async () => {
  const user = await person();
  const app = appFor(async () => {
    await db.query("UPDATE users SET pin_hash=$1 WHERE id=$2", [
      changedHash,
      user.id,
    ]);
  });
  assert.equal((await login(app, user.email, "pin", "782619")).status, 401);
  assert.equal((await authState(user.id)).sessions.length, 0);
});

test("account deactivation after password verification cannot create a session", async () => {
  const user = await person();
  const app = appFor(async () => {
    await db.query("UPDATE users SET active=false WHERE id=$1", [user.id]);
  });
  assert.equal((await login(app, user.email)).status, 401);
  assert.equal((await authState(user.id)).sessions.length, 0);
});

test("sign-in audit failure rolls back the session and preserves failed-attempt accounting", async () => {
  const user = await person();
  const response = await login(appFor(undefined, auditFailure), user.email);
  assert.equal(response.status, 500);
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal((await authState(user.id)).sessions.length, 0);
  assert.equal(
    (
      await db.query("SELECT attempts FROM auth_limits WHERE bucket=$1", [
        digest("login:account:" + user.email),
      ])
    ).rows[0].attempts,
    1,
  );
});

test("setup audit failure leaves the password, PIN, setup link and prior credentials unchanged", async () => {
  const user = await person(),
    token = await db.transaction((tx) => issueSetup(tx, user));
  await session(user.id);
  await session(user.id, "pin");
  await db.query(
    "INSERT INTO api_tokens(id,org_id,user_id,name,token_hash,scopes,expires_at) VALUES($1,$2,$3,'Synthetic token',$4,$5,now()+interval '1 hour')",
    [randomUUID(), orgId, user.id, digest(opaqueToken()), ["reports:read"]],
  );
  const before = await authState(user.id);
  const response = await request(appFor(undefined, auditFailure))
    .post("/api/auth/setup")
    .set("Origin", origin)
    .send({ token, password: newPassword });
  assert.equal(response.status, 500);
  assert.equal(response.headers["set-cookie"], undefined);
  assert.deepEqual(await authState(user.id), before);
  const ok = await request(appFor())
    .post("/api/auth/setup")
    .set("Origin", origin)
    .send({ token, password: newPassword });
  assert.equal(ok.status, 200);
  const state = await authState(user.id);
  assert.equal(state.user.pin_hash, null);
  assert.equal(state.sessions.length, 1);
  assert.ok(state.setup[0].consumed_at);
  assert.ok(state.api[0].revoked_at);
  assert.deepEqual(
    state.audit.map((x) => x.action),
    ["auth.password_set"],
  );
});

test("simultaneous use of a private setup link produces one session and one password event", async () => {
  const user = await person(),
    token = await db.transaction((tx) => issueSetup(tx, user)),
    app = appFor();
  const results = await Promise.all(
    [1, 2].map(() =>
      request(app)
        .post("/api/auth/setup")
        .set("Origin", origin)
        .send({ token, password }),
    ),
  );
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 400]);
  const state = await authState(user.id);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.audit.length, 1);
});

test("PIN change rejects a password proof invalidated after verification", async () => {
  const user = await person(),
    auth = await session(user.id);
  const app = appFor(async () => {
    await db.query(
      "UPDATE users SET password_hash=$1,pin_hash=NULL WHERE id=$2",
      [changedHash, user.id],
    );
    await db.query("DELETE FROM sessions WHERE user_id=$1", [user.id]);
  });
  const response = await request(app)
    .post("/api/auth/pin")
    .set("Origin", origin)
    .set("Cookie", auth.cookie)
    .set("X-CSRF-Token", auth.csrf)
    .send({ password, pin: "827364" });
  assert.equal(response.status, 401);
  const state = await authState(user.id);
  assert.equal(state.user.pin_hash, null);
  assert.equal(state.audit.length, 0);
});

test("PIN change rechecks the authenticated session after concurrent revocation", async () => {
  const user = await person(),
    auth = await session(user.id);
  const app = appFor(async () => {
    await db.query("DELETE FROM sessions WHERE token_hash=$1", [auth.hash]);
  });
  const response = await request(app)
    .post("/api/auth/pin")
    .set("Origin", origin)
    .set("Cookie", auth.cookie)
    .set("X-CSRF-Token", auth.csrf)
    .send({ password, pin: "827364" });
  assert.equal(response.status, 401);
  assert.equal((await authState(user.id)).user.pin_hash, pinHash);
});

test("setup issuance locks the account first, supersedes earlier links, and rejects inactive accounts", async () => {
  const user = await person(),
    first = await db.transaction((tx) => issueSetup(tx, user)),
    statements: string[] = [];
  const next = await db.transaction((tx) =>
    issueSetup(
      {
        query: (sql, params) => {
          statements.push(sql);
          return tx.query(sql, params);
        },
      },
      user,
    ),
  );
  assert.match(statements[0], /FROM users.*FOR UPDATE/);
  const app = appFor();
  assert.equal(
    (
      await request(app)
        .post("/api/auth/setup")
        .set("Origin", origin)
        .send({ token: first, password })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/auth/setup")
        .set("Origin", origin)
        .send({ token: next, password })
    ).status,
    200,
  );
  await db.query("UPDATE users SET active=false WHERE id=$1", [user.id]);
  await assert.rejects(
    db.transaction((tx) => issueSetup(tx, user)),
    /active account/,
  );
});
