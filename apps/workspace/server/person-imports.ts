import { z } from "zod";
import type { Queryable } from "./db";
import { requireCondition, type Actor } from "./security";
import { personImportRowSchema, type PersonImportContext } from "../shared/school-imports";
import { personInput, personUpdateInput } from "../shared/school";
import { createPersonTransaction, updatePersonTransaction } from "./school-people";

type Profile = { name: string; email: string; phone: string };
export type PersonImportRow = {
  row: number; input: Record<string, string>; student: null;
  before: Profile | null; after: Profile | null;
  identity: { label: string; reference: string };
  action: "create" | "update" | "unchanged" | "error";
  errors: string[];
  source: null | {
    person: Profile & { id: string; unitId: string; version: number };
    studentLinked: boolean; applicantLinked: boolean;
  };
};

const uuid = (value: unknown) => z.uuid().safeParse(value).success;
// Restore only the exact current identified field's spreadsheet protection.
// New/changed values and literal apostrophes are never heuristically unescaped.
function retainedText(value: string, current: string) {
  return /^[\s]*[=+@\-\t\r\0]/.test(current) && value === "'" + current ? current : value;
}
const profile = (value: Profile): Profile => ({ name: value.name, email: value.email, phone: value.phone });
const issues = (error: z.ZodError) => error.issues.map(issue => (issue.path.join(".") || "row") + ": " + issue.message);

/** Caller owns current exact-unit office/password authority and transaction.
 * Applying callers must retain the full plan comparison before any mutation.
 * NOWAIT prevents a bulk person set from waiting in the opposite order to care's
 * name-ordered SHARE locks. Let55P03 abort the transaction; map it outside.
 */
export async function buildPersonPlan(
  tx: Queryable, actor: Actor, context: PersonImportContext,
  inputs: Record<string, string>[], lock: boolean,
) {
  const ids = [...new Set(inputs.map(row => row.personId).filter(uuid).map(id => id.toLowerCase()))].sort();
  const people = (await tx.query(
    `SELECT id,unit_id,name,email,phone,version FROM school_people
     WHERE org_id=$1 AND unit_id=$2 AND id=ANY($3::uuid[]) ORDER BY id${lock ? " FOR UPDATE NOWAIT" : ""}`,
    [actor.org_id, context.unitId, ids],
  )).rows;
  // Classify only returned/held identities. A later unlocked requery must never
  // admit a previously missing person. No student/application parent locks here.
  const heldIds = people.map(person => person.id as string);
  const students = new Set((await tx.query(
    "SELECT person_id FROM students WHERE org_id=$1 AND person_id=ANY($2::uuid[])",
    [actor.org_id, heldIds],
  )).rows.map(row => row.person_id as string));
  const applicants = new Set((await tx.query(
    "SELECT DISTINCT applicant_id FROM admission_applications WHERE org_id=$1 AND applicant_id=ANY($2::uuid[])",
    [actor.org_id, heldIds],
  )).rows.map(row => row.applicant_id as string));
  const byId = new Map(people.map(person => [person.id as string, person]));
  const occurrences = new Map<string, number>();
  for (const row of inputs) if (row.personId) {
    const key = row.personId.toLowerCase();
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
  }
  const rows: PersonImportRow[] = inputs.map((raw, index) => {
    const input = { ...raw };
    if (uuid(input.personId)) input.personId = input.personId.toLowerCase();
    const existing = byId.get(input.personId);
    if (existing) for (const field of ["name", "email", "phone"] as const)
      input[field] = retainedText(input[field], existing[field]);
    const checked = personImportRowSchema.safeParse(input);
    const errors = checked.success ? [] : issues(checked.error);
    const before = existing ? profile(existing as Profile) : null;
    const source: PersonImportRow["source"] = existing ? {
      person: { id: existing.id, unitId: existing.unit_id, version: existing.version, ...before! },
      studentLinked: students.has(existing.id), applicantLinked: applicants.has(existing.id),
    } : null;
    const identity = {
      label: existing?.name ?? input.name ?? "Person profile",
      reference: existing ? `${existing.id} · version ${existing.version}` : input.personId || "New person — identity assigned on apply",
    };
    if (input.personId && (occurrences.get(input.personId.toLowerCase()) ?? 0) > 1)
      errors.push("This exact person appears more than once in the file.");
    if (input.personId && !existing) errors.push("Exact person ID not found in this unit.");
    if (source?.studentLinked) errors.push("Student profiles use the student workflow.");
    if (source?.applicantLinked) errors.push("Admissions-applicant profiles use the admissions workflow.");
    let after: Profile | null = null;
    if (checked.success) {
      if (!input.personId && input.version !== "0") errors.push("A new profile requires a blank person ID and version 0.");
      if (input.personId && Number(input.version) < 1) errors.push("An existing profile requires its current positive version.");
      if (existing && Number(input.version) !== existing.version) errors.push("Person version changed. Download current records again.");
      const resolved: Profile = { name: input.name, email: "", phone: "" };
      for (const field of ["email", "phone"] as const) {
        const action = input[field + "Action"], value = input[field];
        if (action !== "replace" && value !== "") errors.push(field + ": keep or clear requires a blank value.");
        if (action === "replace" && !value.trim()) errors.push(field + ": replace requires a nonblank value.");
        if (action === "keep" && !existing) errors.push(field + ": keep requires an existing profile.");
        resolved[field] = action === "keep" ? existing?.[field] ?? "" : action === "clear" ? "" : value;
      }
      const validProfile = personInput.safeParse({ unitId: context.unitId, ...resolved });
      if (validProfile.success) after = profile(validProfile.data);
      else errors.push(...issues(validProfile.error));
    }
    const action: PersonImportRow["action"] = errors.length ? "error" : !existing ? "create"
      : JSON.stringify(before) === JSON.stringify(after) ? "unchanged" : "update";
    return { row: index + 2, input, student: null, before, after, identity, action, errors, source };
  });
  return { context, year: null, section: null, roster: null, rows, counts: {
    total: rows.length, create: rows.filter(row => row.action === "create").length,
    update: rows.filter(row => row.action === "update").length,
    unchanged: rows.filter(row => row.action === "unchanged").length,
    errors: rows.filter(row => row.errors.length).length,
  } };
}

/** Current authority, complete source locks and hash equality are caller-owned.
 * No new parent locks may be introduced after the target people are held.
 */
export async function applyPersonRows(
  tx: Queryable, actor: Actor, context: PersonImportContext, rows: PersonImportRow[],
) {
  const records: Array<{ row: number; personId: string; version: number }> = [];
  for (const row of rows) {
    requireCondition(row.after && !row.errors.length && row.action !== "error", 409, "Person row no longer passes validation.");
    if (row.action === "unchanged") continue;
    let saved;
    if (row.action === "create") {
      requireCondition(!row.source && row.input.personId === "" && row.input.version === "0", 409, "New person identity is inconsistent.");
      saved = await createPersonTransaction(tx, actor, personInput.parse({ unitId: context.unitId, ...row.after }));
    } else {
      const source = row.source;
      requireCondition(source && !source.studentLinked && !source.applicantLinked
        && source.person.unitId.toLowerCase() === context.unitId.toLowerCase() && source.person.id === row.input.personId
        && source.person.version === Number(row.input.version), 409, "Person source is inconsistent.");
      saved = await updatePersonTransaction(tx, actor, source!.person.id,
        personUpdateInput.parse({ ...row.after, version: source!.person.version }));
    }
    records.push({ row: row.row, personId: saved.id, version: saved.version });
  }
  return records;
}

/** A complete bounded template, never the silently truncated directory list. */
export async function personTemplateRows(tx: Queryable, actor: Actor, context: PersonImportContext) {
  const people = (await tx.query(
    `SELECT p.id,p.version,p.name,p.email,p.phone FROM school_people p
     WHERE p.org_id=$1 AND p.unit_id=$2
       AND NOT EXISTS(SELECT 1 FROM students s WHERE s.org_id=p.org_id AND s.person_id=p.id)
       AND NOT EXISTS(SELECT 1 FROM admission_applications a WHERE a.org_id=p.org_id AND a.applicant_id=p.id)
     ORDER BY p.id LIMIT 501`, [actor.org_id, context.unitId],
  )).rows;
  requireCondition(people.length <= 500, 400, "More than 500 eligible profiles exist in this unit. Use a blank template and exact recorded person IDs for a smaller batch.");
  return people.map(person => ({
    personId: String(person.id), version: String(person.version), name: String(person.name),
    emailAction: person.email ? "replace" : "clear", email: String(person.email),
    phoneAction: person.phone ? "replace" : "clear", phone: String(person.phone),
  }));
}
