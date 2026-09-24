import type { Queryable, Row } from "./db";
import { requireCondition, type Actor } from "./security";
import { LayoutGrantContention } from "./report-layout-access";
import type { ReportDefinition } from "../shared/report-library";

type SchoolDefinition = Extract<ReportDefinition, { source: "care" | "grades" | "attendance" }>;

async function grants(tx: Queryable, sql: string, values: unknown[]): Promise<Row[]> {
  try { return (await tx.query(sql, values)).rows; }
  catch (error: any) {
    if (error.code === "55P03") throw new LayoutGrantContention();
    throw error;
  }
}

async function office(tx: Queryable, actor: Actor, unitId: string) {
  if (["developer", "owner", "admin"].includes(actor.role)) return true;
  if (!actor.unit_ids.includes(unitId)) return false;
  return (await grants(tx,
    "SELECT unit_id FROM school_office_grants WHERE org_id=$1 AND user_id=$2 AND unit_id=$3 FOR SHARE NOWAIT",
    [actor.org_id, actor.id, unitId])).length > 0;
}

// Save-only authorization. The caller holds the current account UPDATE lock.
// Blocking grant locks can cycle with teacher replacement's user FK check.
// Keep grants NOWAIT and terminal: never acquire academics or source-parent row
// locks here or afterward. Ordinary source identity reads are not row locks.
export async function lockLayoutSchoolSource(tx: Queryable, actor: Actor, definition: SchoolDefinition) {
  requireCondition(actor.mode === "password", 403, "Password sign-in is required for reports.");
  if (definition.source === "care") {
    const program = (await tx.query("SELECT id,unit_id FROM care_programs WHERE id=$1 AND org_id=$2", [definition.programId, actor.org_id])).rows[0];
    requireCondition(program, 404, "Care program not found.");
    if (await office(tx, actor, program.unit_id)) return;
    // Preserve the existing unavailable-program distinction. Care assignment
    // alone never authorizes a report layout; report access requires office.
    const assigned = actor.unit_ids.includes(program.unit_id) && (await tx.query(
      "SELECT user_id FROM care_staff WHERE program_id=$1 AND org_id=$2 AND user_id=$3", [program.id, actor.org_id, actor.id])).rows.length > 0;
    requireCondition(assigned, 404, "Care program not found.");
    requireCondition(false, 403, "School office access to this unit is required.");
  }
  if (definition.source === "grades") {
    const book = (await tx.query("SELECT section_id FROM gradebooks WHERE id=$1 AND org_id=$2", [definition.bookId, actor.org_id])).rows[0];
    requireCondition(book, 404, "Gradebook not found.");
    const section = (await tx.query("SELECT id,unit_id FROM sections WHERE id=$1 AND org_id=$2", [book.section_id, actor.org_id])).rows[0];
    requireCondition(section, 404, "Class not found.");
    if (await office(tx, actor, section.unit_id)) return;
    const assigned = actor.unit_ids.includes(section.unit_id) && (await grants(tx,
      "SELECT section_id FROM section_teachers WHERE org_id=$1 AND user_id=$2 AND section_id=$3 FOR SHARE NOWAIT",
      [actor.org_id, actor.id, section.id])).length > 0;
    requireCondition(assigned, 404, "Class not found.");
    return;
  }
  const year = (await tx.query("SELECT id FROM school_years WHERE id=$1 AND org_id=$2 AND unit_id=$3", [definition.yearId, actor.org_id, definition.unitId])).rows[0];
  requireCondition(year, 404, "School year not found in this unit.");
  const isOffice = await office(tx, actor, definition.unitId);
  const classes = isOffice
    ? (await tx.query("SELECT id FROM sections WHERE org_id=$1 AND unit_id=$2 AND year_id=$3 ORDER BY id LIMIT 1001", [actor.org_id, definition.unitId, definition.yearId])).rows
    : actor.unit_ids.includes(definition.unitId) ? await grants(tx,
      `SELECT t.section_id AS id FROM section_teachers t JOIN sections s ON s.id=t.section_id AND s.org_id=t.org_id
       WHERE t.org_id=$1 AND t.user_id=$2 AND s.unit_id=$3 AND s.year_id=$4
       ORDER BY t.section_id LIMIT 1001 FOR SHARE OF t NOWAIT`, [actor.org_id, actor.id, definition.unitId, definition.yearId]) : [];
  requireCondition(isOffice || classes.length, 403, "School office access or a current teaching assignment is required.");
  requireCondition(classes.length <= 1000, 400, "Choose a smaller school reporting scope.");
  requireCondition(definition.sectionIds.every(id => classes.some(row => row.id === id)), 403, "One or more selected classes are outside your current access.");
}
