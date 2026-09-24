import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import type { Database } from "./db";
import { audit } from "./security";
export async function initializeSchoolDemo(db: Database, enabled: boolean) {
  if (!enabled) return;
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(78239103)");
    const org = (
      await tx.query(
        "SELECT id,timezone FROM organizations WHERE demo=true ORDER BY created_at LIMIT 1",
      )
    ).rows[0];
    if (!org) return;
    if (
      (
        await tx.query(
          "SELECT name FROM demo_fixtures WHERE org_id=$1 AND name='school_core_v1'",
          [org.id],
        )
      ).rows.length
    )
      return;
    const unit = (
      await tx.query(
        "SELECT id FROM units WHERE org_id=$1 AND kind='school' ORDER BY name LIMIT 1",
        [org.id],
      )
    ).rows[0];
    if (!unit) return;
    const owner = (
      await tx.query(
        "SELECT id FROM users WHERE org_id=$1 AND role='owner' AND active ORDER BY created_at LIMIT 1",
        [org.id],
      )
    ).rows[0];
    if (!owner) return;
    const teachers = (
      await tx.query(
        "SELECT u.id FROM users u JOIN user_units n ON n.user_id=u.id WHERE u.org_id=$1 AND n.unit_id=$2 AND u.email LIKE 'demo.%@stjw.org' AND u.active ORDER BY u.email LIMIT 2",
        [org.id, unit.id],
      )
    ).rows;
    const year = DateTime.now().setZone(org.timezone).year,
      starts = `${year}-01-01`,
      ends = `${year}-12-31`,
      yearId = randomUUID();
    await tx.query(
      "INSERT INTO school_years(id,org_id,unit_id,name,starts_on,ends_on) VALUES($1,$2,$3,$4,$5,$6)",
      [
        yearId,
        org.id,
        unit.id,
        `Synthetic ${year} — example dates`,
        starts,
        ends,
      ],
    );
    const sections: string[] = [];
    for (let index = 0; index < 2; index++) {
      const courseId = randomUUID(),
        sectionId = randomUUID();
      sections.push(sectionId);
      await tx.query(
        "INSERT INTO courses(id,org_id,unit_id,code,title,description) VALUES($1,$2,$3,$4,$5,$6)",
        [
          courseId,
          org.id,
          unit.id,
          "DEMO-" + (index + 3),
          `Sample grade ${index + 3} homeroom`,
          "Synthetic example course; replace with school-approved configuration.",
        ],
      );
      await tx.query(
        "INSERT INTO sections(id,org_id,unit_id,year_id,course_id,name,homeroom,capacity,room) VALUES($1,$2,$3,$4,$5,$6,true,24,$7)",
        [
          sectionId,
          org.id,
          unit.id,
          yearId,
          courseId,
          `Sample grade ${index + 3} · ${index ? "Maple" : "Oak"}`,
          "Demo room " + (index + 1),
        ],
      );
      if (teachers[index])
        await tx.query(
          "INSERT INTO section_teachers(org_id,unit_id,section_id,user_id) VALUES($1,$2,$3,$4)",
          [org.id, unit.id, sectionId, teachers[index].id],
        );
      await tx.query(
        "INSERT INTO curriculum_items(id,org_id,unit_id,section_id,title,content) VALUES($1,$2,$3,$4,$5,$6)",
        [
          randomUUID(),
          org.id,
          unit.id,
          sectionId,
          "Sample unit: Community and service",
          "Synthetic curriculum example. Add the approved learning goals, materials, activities and assessments for your class here.",
        ],
      );
    }
    for (let index = 0; index < 12; index++) {
      const number = String(index + 1).padStart(2, "0"),
        householdId = randomUUID(),
        guardianId = randomUUID();
      await tx.query(
        "INSERT INTO households(id,org_id,unit_id,name,address) VALUES($1,$2,$3,$4,$5)",
        [
          householdId,
          org.id,
          unit.id,
          `Sample household ${number}`,
          "Synthetic address — no real family data",
        ],
      );
      await tx.query(
        "INSERT INTO school_people(id,org_id,unit_id,name,email,phone) VALUES($1,$2,$3,$4,$5,$6)",
        [
          guardianId,
          org.id,
          unit.id,
          `Sample guardian ${number}`,
          `guardian${number}@example.invalid`,
          "555-01" + number,
        ],
      );
      await tx.query(
        "INSERT INTO household_members(org_id,unit_id,household_id,person_id,role) VALUES($1,$2,$3,$4,'guardian')",
        [org.id, unit.id, householdId, guardianId],
      );
      for (let group = 0; group < 2; group++) {
        const personId = randomUUID(),
          studentId = randomUUID(),
          studentNumber = String(index + 1 + group * 12).padStart(2, "0");
        await tx.query(
          "INSERT INTO school_people(id,org_id,unit_id,name) VALUES($1,$2,$3,$4)",
          [personId, org.id, unit.id, `Sample student ${studentNumber}`],
        );
        await tx.query(
          "INSERT INTO students(id,org_id,unit_id,person_id,student_number) VALUES($1,$2,$3,$4,$5)",
          [studentId, org.id, unit.id, personId, "DEMO-" + studentNumber],
        );
        await tx.query(
          "INSERT INTO household_members(org_id,unit_id,household_id,person_id,role) VALUES($1,$2,$3,$4,'student')",
          [org.id, unit.id, householdId, personId],
        );
        await tx.query(
          "INSERT INTO student_contacts(org_id,unit_id,student_id,person_id,relationship,is_guardian,can_communicate,can_pickup) VALUES($1,$2,$3,$4,'Sample guardian',true,true,false)",
          [org.id, unit.id, studentId, guardianId],
        );
        await tx.query(
          "INSERT INTO student_enrollments(id,org_id,unit_id,student_id,year_id,grade_level,starts_on,ends_on) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            randomUUID(),
            org.id,
            unit.id,
            studentId,
            yearId,
            String(group + 3),
            starts,
            ends,
          ],
        );
        await tx.query(
          "INSERT INTO section_students(org_id,unit_id,section_id,student_id,starts_on,ends_on) VALUES($1,$2,$3,$4,$5,$6)",
          [org.id, unit.id, sections[group], studentId, starts, ends],
        );
      }
    }
    await tx.query(
      "INSERT INTO demo_fixtures(org_id,name) VALUES($1,'school_core_v1')",
      [org.id],
    );
    await audit(
      tx,
      { id: owner.id, org_id: org.id },
      "demo.school_seeded",
      yearId,
      {
        synthetic: true,
        students: 24,
        households: 12,
        sections: 2,
        policyConfirmed: false,
      },
    );
  });
}
