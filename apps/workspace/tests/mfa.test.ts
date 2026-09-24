import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import {
  digest,
  hashPassword,
  issueSetup,
  opaqueToken,
} from "../server/security";
import {
  base32,
  decryptFactor,
  encryptFactor,
  matchingCounter,
  totpAt,
} from "../server/totp";
const origin = "http://localhost:3000",
  password = "Test!826";
let db: Database,
  orgId: string,
  passwordHash: string,
  app: ReturnType<typeof createApp>;
const priorKey = process.env.MFA_ENCRYPTION_KEY;
before(async () => {
  process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  db = await connectDatabase();
  await migrate(db);
  await initialize(db, { demo: false, ownerEmail: "owner@example.test" });
  orgId = (await db.query("SELECT id FROM organizations")).rows[0].id;
  passwordHash = await hashPassword(password);
  app = createApp(db, {
    origin,
    production: false,
    staffDomain: "stjw.org",
    demo: true,
  });
});
after(async () => {
  await db?.close();
  if (priorKey === undefined) delete process.env.MFA_ENCRYPTION_KEY;
  else process.env.MFA_ENCRYPTION_KEY = priorKey;
});
type Auth = { cookie: string; csrf: string };
function post(path: string, body: object, auth?: Auth, target = app) {
  return request(target)
    .post("/api" + path)
    .set("Origin", origin)
    .set("Cookie", auth?.cookie ?? "")
    .set("X-CSRF-Token", auth?.csrf ?? "")
    .send(body);
}
async function authFrom(response: any) {
  const cookie = response.headers["set-cookie"][0].split(";")[0];
  return {
    cookie,
    csrf: (await request(app).get("/api/me").set("Cookie", cookie)).body.actor
      .csrf,
  };
}
async function person(role = "employee") {
  const id = randomUUID(),
    email = id + "@stjw.org";
  await db.query(
    "INSERT INTO users(id,org_id,name,email,role,password_hash) VALUES($1,$2,$3,$4,$5,$6)",
    [id, orgId, "Synthetic MFA test", email, role, passwordHash],
  );
  const response = await post("/auth/login", {
    email,
    mode: "password",
    credential: password,
  });
  assert.equal(response.status, 200);
  assert.ok(response.headers["set-cookie"]);
  return { id, org_id: orgId, email, auth: await authFrom(response) };
}
function decode32(value: string) {
  let bits = 0,
    buffer = 0;
  const output: number[] = [];
  for (const char of value) {
    buffer = (buffer << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >>> bits) & 255);
    }
  }
  return Buffer.from(output);
}
async function enrolled() {
  const user = await person();
  const start = await post("/auth/mfa/enroll", { password }, user.auth);
  assert.equal(start.status, 200);
  const secret = decode32(start.body.secret),
    code = totpAt(secret, Date.now());
  const confirmed = await post(
    "/auth/mfa/confirm",
    { id: start.body.id, code },
    user.auth,
  );
  assert.equal(confirmed.status, 200);
  return {
    ...user,
    oldAuth: user.auth,
    auth: await authFrom(confirmed),
    secret,
    codes: confirmed.body.recoveryCodes as string[],
    code,
  };
}
async function challenge(email: string, credential = password) {
  const result = await post("/auth/login", {
    email,
    mode: "password",
    credential,
  });
  assert.equal(result.status, 200);
  assert.ok(result.body.challenge);
  assert.equal(result.headers["set-cookie"], undefined);
  return result.body.challenge as string;
}

test("TOTP matches all RFC 6238 SHA-1 test vectors, including dates beyond 2038", () => {
  const key = Buffer.from("12345678901234567890");
  for (const [seconds, expected] of [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ] as const)
    assert.equal(totpAt(key, seconds * 1000, 8), expected);
  assert.equal(base32(Buffer.from("foobar")), "MZXW6YTBOI");
  const now = 1_234_567_890_000,
    counter = Math.floor(now / 30000),
    code = totpAt(key, now);
  assert.equal(matchingCounter(key, code, counter - 1, now), counter);
  assert.equal(matchingCounter(key, code, counter, now), null);
  assert.equal(matchingCounter(key, totpAt(key, now - 90000), -1, now), null);
});
test("authenticator encryption authenticates both account identity and ciphertext", () => {
  const secret = randomBytes(20),
    encrypted = encryptFactor(secret, "org:user:factor");
  assert.deepEqual(decryptFactor(encrypted, "org:user:factor"), secret);
  assert.throws(
    () => decryptFactor(encrypted, "other:user:factor"),
    /unavailable/,
  );
  const parts = encrypted.split(".");
  parts[2] = (parts[2][0] === "a" ? "b" : "a") + parts[2].slice(1);
  assert.throws(
    () => decryptFactor(parts.join("."), "org:user:factor"),
    /unavailable/,
  );
  assert.notEqual(encrypted, encryptFactor(secret, "org:user:factor"));
});
test("MFA is optional for owner, admin, finance, manager and employee accounts", async () => {
  for (const role of ["owner", "admin", "finance", "manager", "employee"]) {
    const user = await person(role);
    const result = await request(app)
      .get("/api/auth/mfa")
      .set("Cookie", user.auth.cookie);
    assert.equal(result.status, 200);
    assert.equal(result.body.enabled, false);
  }
});
test("enrollment requires the current password and configured encryption; pending setup does not enable MFA", async () => {
  const user = await person();
  assert.equal(
    (await post("/auth/mfa/enroll", { password: "wrong" }, user.auth)).status,
    401,
  );
  const saved = process.env.MFA_ENCRYPTION_KEY;
  delete process.env.MFA_ENCRYPTION_KEY;
  try {
    assert.equal(
      (await post("/auth/mfa/enroll", { password }, user.auth)).status,
      503,
    );
  } finally {
    process.env.MFA_ENCRYPTION_KEY = saved;
  }
  assert.equal(
    (
      await db.query("SELECT user_id FROM mfa_factors WHERE user_id=$1", [
        user.id,
      ])
    ).rows.length,
    0,
  );
  const started = await post("/auth/mfa/enroll", { password }, user.auth);
  assert.equal(started.status, 200);
  assert.match(started.body.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal(
    (
      await post("/auth/login", {
        email: user.email,
        mode: "password",
        credential: password,
      })
    ).body.ok,
    true,
  );
  await db.query(
    "UPDATE mfa_factors SET pending_expires_at=now()-interval '1 minute' WHERE user_id=$1",
    [user.id],
  );
  assert.equal(
    (
      await post(
        "/auth/mfa/confirm",
        {
          id: started.body.id,
          code: totpAt(decode32(started.body.secret), Date.now()),
        },
        user.auth,
      )
    ).status,
    409,
  );
});
test("enabling MFA rotates the browser session, revokes API credentials and stores no plaintext recovery codes", async () => {
  const user = await person(),
    apiHash = digest(opaqueToken());
  await db.query(
    "INSERT INTO api_tokens(id,org_id,user_id,name,token_hash,scopes,expires_at) VALUES($1,$2,$3,'Synthetic MFA token',$4,$5,now()+interval '1 hour')",
    [randomUUID(), orgId, user.id, apiHash, ["reports:read"]],
  );
  const started = await post("/auth/mfa/enroll", { password }, user.auth),
    confirmed = await post(
      "/auth/mfa/confirm",
      {
        id: started.body.id,
        code: totpAt(decode32(started.body.secret), Date.now()),
      },
      user.auth,
    );
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.recoveryCodes.length, 10);
  assert.equal(
    (await request(app).get("/api/me").set("Cookie", user.auth.cookie)).status,
    401,
  );
  assert.ok(
    (
      await db.query("SELECT revoked_at FROM api_tokens WHERE token_hash=$1", [
        apiHash,
      ])
    ).rows[0].revoked_at,
  );
  const stored = JSON.stringify(
    (
      await db.query("SELECT * FROM mfa_recovery_codes WHERE user_id=$1", [
        user.id,
      ])
    ).rows,
  );
  for (const code of confirmed.body.recoveryCodes)
    assert.ok(
      !stored.includes(code) && !stored.includes(code.replaceAll("-", "")),
    );
  const factor = (
    await db.query("SELECT * FROM mfa_factors WHERE user_id=$1", [user.id])
  ).rows[0];
  assert.ok(!factor.secret_cipher.includes(started.body.secret));
  assert.equal(
    (
      await db.query("SELECT mfa_verified FROM sessions WHERE user_id=$1", [
        user.id,
      ])
    ).rows[0].mfa_verified,
    true,
  );
});
test("password login requires a second factor and rejects replay of the enrollment code", async () => {
  const user = await enrolled(),
    pending = await challenge(user.email);
  assert.equal(
    (await post("/auth/mfa/verify", { challenge: pending, code: user.code }))
      .status,
    401,
  );
  const code = totpAt(user.secret, Date.now() + 30000),
    verified = await post("/auth/mfa/verify", { challenge: pending, code });
  assert.equal(verified.status, 200);
  assert.equal(
    (await post("/auth/mfa/verify", { challenge: pending, code })).status,
    401,
  );
  const second = await challenge(user.email);
  assert.equal(
    (await post("/auth/mfa/verify", { challenge: second, code })).status,
    401,
  );
});
test("two concurrent challenges cannot consume the same recovery code twice", async () => {
  const user = await enrolled(),
    a = await challenge(user.email),
    b = await challenge(user.email);
  const results = await Promise.all(
    [a, b].map((c) =>
      post("/auth/mfa/verify", { challenge: c, code: user.codes[0] }),
    ),
  );
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 401]);
  assert.equal(
    (
      await db.query(
        "SELECT code_hash FROM mfa_recovery_codes WHERE user_id=$1 AND used_at IS NOT NULL",
        [user.id],
      )
    ).rows.length,
    1,
  );
  const status = await request(app)
    .get("/api/auth/mfa")
    .set("Cookie", user.auth.cookie);
  assert.equal(status.body.recoveryCodesRemaining, 9);
});
test("password reset preserves MFA and invalidates older sign-in challenges", async () => {
  const user = await enrolled(),
    pending = await challenge(user.email),
    token = await db.transaction((tx) => issueSetup(tx, user));
  const setup = await post("/auth/setup", { token, password: "Next!826" });
  assert.equal(setup.status, 200);
  assert.ok(setup.body.challenge);
  assert.equal(setup.headers["set-cookie"], undefined);
  assert.equal(
    (
      await post("/auth/mfa/verify", {
        challenge: pending,
        code: user.codes[0],
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await post("/auth/mfa/verify", {
        challenge: setup.body.challenge,
        code: user.codes[0],
      })
    ).status,
    200,
  );
  assert.ok(
    (
      await db.query("SELECT enabled_at FROM mfa_factors WHERE user_id=$1", [
        user.id,
      ])
    ).rows[0].enabled_at,
  );
});
test("expired challenges and deactivated accounts fail without consuming recovery codes", async () => {
  const user = await enrolled(),
    pending = await challenge(user.email);
  await db.query(
    "UPDATE mfa_challenges SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
    [digest(pending)],
  );
  assert.equal(
    (
      await post("/auth/mfa/verify", {
        challenge: pending,
        code: user.codes[0],
      })
    ).status,
    401,
  );
  const next = await challenge(user.email);
  await db.query("UPDATE users SET active=false WHERE id=$1", [user.id]);
  assert.equal(
    (await post("/auth/mfa/verify", { challenge: next, code: user.codes[0] }))
      .status,
    401,
  );
  assert.equal(
    (
      await db.query(
        "SELECT code_hash FROM mfa_recovery_codes WHERE user_id=$1 AND used_at IS NOT NULL",
        [user.id],
      )
    ).rows.length,
    0,
  );
});
test("MFA audit failure rolls back recovery consumption, challenge removal and session creation", async () => {
  const user = await enrolled(),
    pending = await challenge(user.email),
    count = (
      await db.query("SELECT token_hash FROM sessions WHERE user_id=$1", [
        user.id,
      ])
    ).rows.length;
  const failing: Database = {
    ...db,
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          query: async (sql, params) => {
            if (sql.startsWith("INSERT INTO audit_events"))
              throw Error("Synthetic MFA audit failure");
            return tx.query(sql, params);
          },
        }),
      ),
  };
  const response = await post(
    "/auth/mfa/verify",
    { challenge: pending, code: user.codes[0] },
    undefined,
    createApp(failing, {
      origin,
      production: false,
      staffDomain: "stjw.org",
      demo: true,
    }),
  );
  assert.equal(response.status, 500);
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(
    (
      await db.query("SELECT token_hash FROM sessions WHERE user_id=$1", [
        user.id,
      ])
    ).rows.length,
    count,
  );
  assert.equal(
    (
      await db.query(
        "SELECT code_hash FROM mfa_recovery_codes WHERE user_id=$1 AND used_at IS NOT NULL",
        [user.id],
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await post("/auth/mfa/verify", {
        challenge: pending,
        code: user.codes[0],
      })
    ).status,
    200,
  );
});
test("replacing recovery codes and disabling MFA require both fresh password and factor evidence", async () => {
  const user = await enrolled();
  assert.equal(
    (
      await post(
        "/auth/mfa/disable",
        { password: "wrong", code: user.codes[0] },
        user.auth,
      )
    ).status,
    401,
  );
  assert.equal(
    (await post("/auth/mfa/disable", { password, code: "000000" }, user.auth))
      .status,
    401,
  );
  const replaced = await post(
    "/auth/mfa/recovery-codes",
    { password, code: user.codes[0] },
    user.auth,
  );
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.recoveryCodes.length, 10);
  assert.equal(
    (await request(app).get("/api/me").set("Cookie", user.auth.cookie)).status,
    401,
  );
  const auth = await authFrom(replaced),
    pending = await challenge(user.email);
  assert.equal(
    (
      await post("/auth/mfa/verify", {
        challenge: pending,
        code: user.codes[1],
      })
    ).status,
    401,
  );
  const disabled = await post(
    "/auth/mfa/disable",
    { password, code: replaced.body.recoveryCodes[0] },
    auth,
  );
  assert.equal(disabled.status, 200);
  assert.equal(
    (
      await db.query("SELECT user_id FROM mfa_factors WHERE user_id=$1", [
        user.id,
      ])
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await db.query(
        "SELECT code_hash FROM mfa_recovery_codes WHERE user_id=$1",
        [user.id],
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await post("/auth/login", {
        email: user.email,
        mode: "password",
        credential: password,
      })
    ).body.ok,
    true,
  );
});
test("PIN remains clock-only and an unverified password session cannot bypass enabled MFA", async () => {
  const user = await enrolled();
  await post("/auth/pin", { password, pin: "782619" }, user.auth);
  const pin = await post("/auth/login", {
    email: user.email,
    mode: "pin",
    credential: "782619",
  });
  assert.equal(pin.status, 200);
  const cookie = pin.headers["set-cookie"][0].split(";")[0];
  assert.equal(
    (await request(app).get("/api/clock").set("Cookie", cookie)).status,
    200,
  );
  assert.equal(
    (await request(app).get("/api/auth/mfa").set("Cookie", cookie)).status,
    403,
  );
  const raw = opaqueToken();
  await db.query(
    "INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,'password',$4,now()+interval '1 hour')",
    [digest(raw), orgId, user.id, opaqueToken()],
  );
  assert.equal(
    (
      await request(app)
        .get("/api/me")
        .set("Cookie", "stjw_session=" + raw)
    ).status,
    401,
  );
});
