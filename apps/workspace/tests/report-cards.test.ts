import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { digest, opaqueToken, type Actor } from "../server/security";
import { createStaff } from "../server/workforce";
import { issueReportCard } from "../server/report-cards";
let db: Database,
  owner: Actor,
  auth: any,
  app: ReturnType<typeof createApp>,
  unit: any,
  teacher: any,
  teacherAuth: any;
const origin = "http://localhost:3000",
  reason = "Synthetic report card verification.",
  categoryId = randomUUID();
async function session(actor: Actor, mode = "password") {
  const token = opaqueToken(),
    csrf = opaqueToken();
  await db.query(
    "INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')",
    [digest(token), actor.org_id, actor.id, mode, csrf],
  );
  return { cookie: "stjw_session=" + token, csrf };
}
const get = (path: string, a = auth) =>
  request(app)
    .get("/api" + path)
    .set("Cookie", a.cookie);
const send = (path: string, body: any, a = auth, method = "post") =>
  (request(app) as any)
    [method]("/api" + path)
    .set("Cookie", a.cookie)
    .set("Origin", origin)
    .set("X-CSRF-Token", a.csrf)
    .send(body);
async function ok(path: string, body: any, a = auth, method = "post") {
  const r = await send(path, body, a, method);
  assert.ok(r.status < 300, JSON.stringify(r.body));
  return r.body;
}
const cardPath = (id: string) => "/school/report-cards/" + id;
const issueInput = (card: any, extra = {}) => ({
  version: card.version,
  reviewed: true,
  acknowledgeMissing: false,
  acknowledgeNoGrade: false,
  reason,
  commandId: randomUUID(),
  ...extra,
});
const source = (card: any) => card.source_snapshot;
async function fixture(status = "scored", scale = true) {
  const settings = (await get("/school/grading/settings?unitId=" + unit.id))
    .body;
  await ok(
    "/school/grading/settings",
    {
      unitId: unit.id,
      version: settings.version,
      confirmed: true,
      reason,
      policy: {
        name: "Synthetic report card scale",
        calculation: "total_points",
        missing: "exclude",
        emptyCategories: "renormalize",
        allowExtraCredit: false,
        capAt100: true,
        decimals: 2,
        rounding: "nearest",
        categories: [{ id: categoryId, name: "Synthetic work", weight: 10000 }],
        scale: scale
          ? [
              { label: "A", minimum: 9000 },
              { label: "B", minimum: 8000 },
              { label: "C", minimum: 0 },
            ]
          : [],
      },
    },
    auth,
    "put",
  );
  const year = await ok("/school/years", {
      unitId: unit.id,
      name: "Synthetic report year " + randomUUID(),
      startsOn: "2026-01-01",
      endsOn: "2026-12-31",
    }),
    terms = [];
  for (const [name, startsOn, endsOn] of [
    ["First term", "2026-01-01", "2026-06-30"],
    ["Second term", "2026-07-01", "2026-12-31"],
  ])
    terms.push(
      await ok("/school/terms", { yearId: year.id, name, startsOn, endsOn }),
    );
  const students = [];
  for (const name of ["Synthetic Report Student", "Other Private Classmate"]) {
    const s = await ok("/school/students", {
      unitId: unit.id,
      name,
      studentNumber: randomUUID(),
    });
    await ok("/school/students/" + s.id + "/enrollments", {
      enrollment: {
        yearId: year.id,
        gradeLevel: "Example 3",
        startsOn: "2026-01-01",
        endsOn: "2026-12-31",
      },
    });
    students.push(s);
  }
  const sections = [],
    books = [];
  for (let ci = 0; ci < 2; ci++) {
    const section = await ok("/school/sections", {
      unitId: unit.id,
      yearId: year.id,
      name:
        ["Mathematics", "Language Arts"][ci] + " " + randomUUID().slice(0, 5),
      homeroom: false,
      capacity: 20,
      teacherIds: [teacher.id],
    });
    sections.push(section);
    for (const student of students)
      await ok("/school/sections/" + section.id + "/roster", {
        studentId: student.id,
        startsOn: "2026-01-01",
        endsOn: "2026-12-31",
      });
    for (let ti = 0; ti < terms.length; ti++) {
      const term = terms[ti],
        book = await ok("/school/gradebooks", {
          sectionId: section.id,
          termId: term.id,
        }),
        a = await ok("/school/grade-assignments", {
          bookId: book.id,
          bookVersion: book.version,
          commandId: randomUUID(),
          title: "Synthetic reviewed assessment",
          instructions: "Private assignment instructions",
          categoryId,
          dueOn: ti ? "2026-09-01" : "2026-03-01",
          maxPointsUnits: 10000,
        });
      let detail = (await get("/school/gradebooks/" + book.id)).body;
      await ok(
        "/school/grade-assignments/" + a.id + "/scores",
        {
          bookVersion: detail.book.version,
          version: a.version,
          reason,
          scores: students.map((student, index) => ({
            studentId: student.id,
            status: index ? "scored" : status,
            pointsUnits: index
              ? 6500
              : status === "scored"
                ? 8000 + ti * 1000 + ci * 100
                : null,
            note: index
              ? "Other private classmate note"
              : "Synthetic student score",
          })),
        },
        auth,
        "put",
      );
      for (const action of ["submit", "lock"]) {
        detail = (await get("/school/gradebooks/" + book.id)).body;
        await ok("/school/gradebooks/" + book.id + "/review", {
          version: detail.book.version,
          action,
          reason,
          acknowledgeMissing: true,
          acknowledgeNoGrade: true,
        });
      }
      books.push({
        id: book.id,
        assignmentId: a.id,
        sectionId: section.id,
        termId: term.id,
      });
    }
  }
  const student = students[0],
    card = await ok("/school/report-cards/open", {
      studentId: student.id,
      yearId: year.id,
      termIds: terms.map((t) => t.id),
    });
  return { year, terms, student, students, sections, books, card };
}
before(async () => {
  db = await connectDatabase();
  await migrate(db);
  await initialize(db, {
    demo: false,
    ownerEmail: "report-cards.owner@example.test",
  });
  const u = (await db.query("SELECT * FROM users WHERE role='owner'")).rows[0];
  unit = (await db.query("SELECT * FROM units WHERE kind='school'")).rows[0];
  owner = {
    id: u.id,
    org_id: u.org_id,
    name: u.name,
    email: u.email,
    role: "owner",
    mode: "password",
    unit_ids: [unit.id],
  };
  app = createApp(db, {
    origin,
    production: false,
    staffDomain: "stjw.org",
    demo: true,
  });
  auth = await session(owner);
  const email = randomUUID() + "@stjw.org",
    id = await db.transaction((tx) =>
      createStaff(
        tx,
        owner,
        {
          name: "Synthetic Report Teacher",
          email,
          role: "employee",
          unitIds: [unit.id],
          jobIds: [],
        },
        "stjw.org",
      ),
    );
  teacher = { ...owner, id, email, role: "employee" };
  teacherAuth = await session(teacher);
});
after(async () => {
  await db?.close();
});

test("annual report sources combine exact reviewed term results without disclosing classmates or recalculating grades", async () => {
  const f = await fixture(),
    s = source(f.card);
  assert.equal(s.terms.length, 2);
  assert.equal(s.cells.length, 4);
  assert.ok(s.cells.every((c: any) => !c.problem && c.release.id));
  assert.deepEqual(
    s.cells
      .filter((c: any) => c.sectionId === f.sections[0].id)
      .map((c: any) => c.result.percentage),
    ["80.00", "90.00"],
  );
  const serialized = JSON.stringify(f.card);
  assert.ok(!serialized.includes("Other Private Classmate"));
  assert.ok(!serialized.includes("Other private classmate note"));
  assert.ok(!serialized.includes("date_of_birth"));
  assert.ok(!serialized.includes("Private assignment instructions"));
  const repeat = await ok("/school/report-cards/open", {
    studentId: f.student.id,
    yearId: f.year.id,
    termIds: f.terms.map((t) => t.id).reverse(),
  });
  assert.equal(repeat.id, f.card.id);
  const detail = (await get(cardPath(f.card.id))).body;
  assert.equal(detail.sourceCurrent, true);
  assert.equal(detail.currentSourceHash, f.card.source_hash);
  const issued = await ok(cardPath(f.card.id) + "/issue", issueInput(f.card));
  const exported = await get(
    cardPath(f.card.id) + "/issues/" + issued.issueId + "?format=csv",
  );
  assert.equal(exported.status, 200);
  assert.match(exported.text, /release_id/);
  assert.match(exported.text, /80.00/);
});
test("multi-class reports require current office scope and deny teacher, PIN and cross-unit reads", async () => {
  const f = await fixture();
  assert.equal((await get(cardPath(f.card.id), teacherAuth)).status, 403);
  assert.equal(
    (
      await send(
        cardPath(f.card.id) + "/issue",
        issueInput(f.card),
        teacherAuth,
      )
    ).status,
    403,
  );
  assert.equal(
    (await get(cardPath(f.card.id), await session(owner, "pin"))).status,
    403,
  );
  await ok("/school/office-grants", {
    unitId: unit.id,
    userId: teacher.id,
    enabled: true,
  });
  assert.equal((await get(cardPath(f.card.id), teacherAuth)).status, 200);
  await ok("/school/office-grants", {
    unitId: unit.id,
    userId: teacher.id,
    enabled: false,
  });
  assert.equal((await get(cardPath(f.card.id), teacherAuth)).status, 403);
  const other = (
    await db.query("SELECT id FROM units WHERE id<>$1 LIMIT 1", [unit.id])
  ).rows[0];
  assert.equal(
    (
      await get(
        "/school/report-cards?unitId=" + other.id + "&yearId=" + f.year.id,
        teacherAuth,
      )
    ).status,
    403,
  );
  const issued = await ok(cardPath(f.card.id) + "/issue", issueInput(f.card));
  assert.equal(
    (await get(cardPath(f.card.id) + "/issues/" + issued.issueId, teacherAuth))
      .status,
    403,
  );
});
test("source changes require explicit reconciliation, captured classes cannot be omitted and exclusions need reasons", async () => {
  const f = await fixture(),
    extra = await ok("/school/sections", {
      unitId: unit.id,
      yearId: f.year.id,
      name: "Ungraded synthetic homeroom " + randomUUID(),
      homeroom: true,
      capacity: 20,
      teacherIds: [],
    });
  await ok("/school/sections/" + extra.id + "/roster", {
    studentId: f.student.id,
    startsOn: "2026-01-01",
    endsOn: "2026-12-31",
  });
  assert.equal(
    (await send(cardPath(f.card.id) + "/issue", issueInput(f.card))).status,
    409,
  );
  let detail = (await get(cardPath(f.card.id))).body;
  assert.equal(detail.sourceCurrent, false);
  assert.equal(detail.currentSource.cells.length, 6);
  await ok(cardPath(f.card.id) + "/reconcile", {
    version: f.card.version,
    sourceHash: detail.currentSourceHash,
    reason,
    commandId: randomUUID(),
  });
  detail = (await get(cardPath(f.card.id))).body;
  const payload = {
    version: detail.card.version,
    presentation: detail.card.presentation,
    cells: detail.card.cells.slice(0, -1),
    reason,
    commandId: randomUUID(),
  };
  assert.equal(
    (await send(cardPath(f.card.id) + "/save", payload)).status,
    400,
  );
  payload.cells = detail.card.cells.map((c: any) => ({
    ...c,
    included: c.sectionId !== extra.id,
  }));
  const saved = await ok(cardPath(f.card.id) + "/save", {
    ...payload,
    commandId: randomUUID(),
  });
  assert.equal(
    (await send(cardPath(f.card.id) + "/issue", issueInput(saved))).status,
    409,
  );
  const final = await ok(cardPath(f.card.id) + "/save", {
    ...payload,
    version: saved.version,
    cells: payload.cells.map((c: any) => ({
      ...c,
      exclusionReason: c.included ? "" : "Synthetic homeroom is not graded.",
    })),
    commandId: randomUUID(),
  });
  const issued = await ok(cardPath(f.card.id) + "/issue", issueInput(final));
  assert.equal(issued.number, 1);
  const frozen = (await get(cardPath(f.card.id) + "/issues/" + issued.issueId))
    .body.issue.snapshot;
  assert.equal(frozen.cells.filter((c: any) => !c.included).length, 2);
  assert.ok(
    frozen.cells.every(
      (c: any) => c.included || c.exclusionReason.length >= 10,
    ),
  );
});
test("issued copies stay immutable through reopened gradebooks and corrected report-card revisions", async () => {
  const f = await fixture(),
    first = await ok(cardPath(f.card.id) + "/issue", issueInput(f.card)),
    firstIssue = (await get(cardPath(f.card.id) + "/issues/" + first.issueId))
      .body.issue;
  await assert.rejects(
    () =>
      db.query("UPDATE report_card_issues SET snapshot='{}' WHERE id=$1", [
        first.issueId,
      ]),
    /immutable|append-only/i,
  );
  const reopened = await ok(cardPath(f.card.id) + "/reopen", {
    version: first.version,
    reason,
    commandId: randomUUID(),
  });
  const book = f.books[0];
  let grades = (await get("/school/gradebooks/" + book.id)).body;
  await ok("/school/gradebooks/" + book.id + "/review", {
    version: grades.book.version,
    action: "reopen",
    reason,
  });
  let report = (await get(cardPath(f.card.id))).body;
  await ok(cardPath(f.card.id) + "/reconcile", {
    version: reopened.version,
    sourceHash: report.currentSourceHash,
    reason,
    commandId: randomUUID(),
  });
  report = (await get(cardPath(f.card.id))).body;
  assert.equal(
    (await send(cardPath(f.card.id) + "/issue", issueInput(report.card)))
      .status,
    409,
  );
  grades = (await get("/school/gradebooks/" + book.id)).body;
  await ok(
    "/school/grade-assignments/" + book.assignmentId + "/scores",
    {
      bookVersion: grades.book.version,
      version: grades.assignments[0].version,
      reason,
      scores: grades.scores
        .filter((row: any) => row.assignment_id === book.assignmentId)
        .map((row: any) => ({
          studentId: row.student_id,
          status: row.student_id === f.student.id ? "scored" : row.status,
          pointsUnits:
            row.student_id === f.student.id ? 9900 : row.points_units,
          note:
            row.student_id === f.student.id ? "Synthetic correction" : row.note,
        })),
    },
    auth,
    "put",
  );
  for (const action of ["submit", "lock"]) {
    grades = (await get("/school/gradebooks/" + book.id)).body;
    await ok("/school/gradebooks/" + book.id + "/review", {
      version: grades.book.version,
      action,
      reason,
    });
  }
  report = (await get(cardPath(f.card.id))).body;
  const reconciled = await ok(cardPath(f.card.id) + "/reconcile", {
    version: report.card.version,
    sourceHash: report.currentSourceHash,
    reason,
    commandId: randomUUID(),
  });
  const second = await ok(
    cardPath(f.card.id) + "/issue",
    issueInput(reconciled),
  );
  assert.equal(second.number, 2);
  const old = (await get(cardPath(f.card.id) + "/issues/" + first.issueId))
    .body;
  assert.equal(old.latestNumber, 2);
  assert.equal(old.issue.snapshot_hash, firstIssue.snapshot_hash);
  assert.deepEqual(old.issue.snapshot, firstIssue.snapshot);
  const updated = (await get(cardPath(f.card.id) + "/issues/" + second.issueId))
    .body.issue.snapshot;
  assert.equal(
    updated.source.cells.find(
      (c: any) => c.sectionId === book.sectionId && c.termId === book.termId,
    ).result.percentage,
    "99.00",
  );
});
test("no-grade and missing-work acknowledgments are explicit and a label-only layout cannot hide a percentage", async () => {
  const f = await fixture("missing");
  assert.equal(
    (await send(cardPath(f.card.id) + "/issue", issueInput(f.card))).status,
    409,
  );
  assert.equal(
    (
      await send(
        cardPath(f.card.id) + "/issue",
        issueInput(f.card, { acknowledgeNoGrade: true }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await send(
        cardPath(f.card.id) + "/issue",
        issueInput(f.card, {
          acknowledgeNoGrade: true,
          acknowledgeMissing: true,
        }),
      )
    ).status,
    200,
  );
  const numeric = await fixture("scored", false),
    saved = await ok(cardPath(numeric.card.id) + "/save", {
      version: numeric.card.version,
      presentation: { ...numeric.card.presentation, showPercentage: false },
      cells: numeric.card.cells,
      reason,
      commandId: randomUUID(),
    });
  const denied = await send(
    cardPath(numeric.card.id) + "/issue",
    issueInput(saved),
  );
  assert.equal(denied.status, 409);
  assert.match(denied.body.error, /percentages/);
});
test("concurrent publication retries create one immutable issue and stale drafts cannot overwrite", async () => {
  const f = await fixture(),
    payload = issueInput(f.card),
    [one, two] = await Promise.all([
      send(cardPath(f.card.id) + "/issue", payload),
      send(cardPath(f.card.id) + "/issue", payload),
    ]);
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.equal(one.body.issueId, two.body.issueId);
  assert.equal(
    (
      await db.query("SELECT id FROM report_card_issues WHERE card_id=$1", [
        f.card.id,
      ])
    ).rows.length,
    1,
  );
  assert.equal(
    (
      await send(cardPath(f.card.id) + "/issue", {
        ...payload,
        reason: "Different synthetic command body",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await send(cardPath(f.card.id) + "/issue", {
        ...payload,
        commandId: randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await send(cardPath(f.card.id) + "/save", {
        version: one.body.version,
        presentation: f.card.presentation,
        cells: f.card.cells,
        reason,
        commandId: randomUUID(),
      })
    ).status,
    409,
  );
});
test("publication and evidence roll back together on a history failure", async () => {
  const f = await fixture();
  const faulty: Database = {
    ...db,
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          query: async (sql, params) => {
            if (
              sql.startsWith("INSERT INTO school_history(") &&
              params?.includes("report_card.issued")
            )
              throw new Error("Synthetic report history fault");
            return tx.query(sql, params);
          },
        }),
      ),
  };
  await assert.rejects(
    () => issueReportCard(faulty, owner, f.card.id, issueInput(f.card)),
    /Synthetic report history fault/,
  );
  assert.equal(
    (
      await db.query("SELECT id FROM report_card_issues WHERE card_id=$1", [
        f.card.id,
      ])
    ).rows.length,
    0,
  );
  const detail = (await get(cardPath(f.card.id))).body;
  assert.equal(detail.card.status, "draft");
  assert.equal(detail.card.version, 1);
  assert.equal(detail.card.issue_count, 0);
});
