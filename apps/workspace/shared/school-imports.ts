import { z } from "zod";
import { dateOnly } from "./contracts";

export const schoolImportKinds = ["students", "enrollments", "roster", "households", "household_members", "contacts", "people"] as const;
export type SchoolImportKind = (typeof schoolImportKinds)[number];
export const schoolImportCatalog = {
  people: {
    title: "Person profiles",
    columns: ["personId", "version", "name", "emailAction", "email", "phoneAction", "phone"],
    detail: "Create a profile with a blank person ID and version 0, or update an exact profile ID and current version. Choose keep, replace or clear for email and phone. Student and admissions-applicant profiles use their own workflows. This import grants no household or student permissions.",
  },
  students: {
    title: "New students",
    columns: ["studentNumber", "name", "dateOfBirth"],
    detail:
      "Create student profiles. Existing student numbers are never replaced. Leave dateOfBirth blank if unknown.",
  },
  enrollments: {
    title: "School-year enrollment",
    columns: ["studentNumber", "gradeLevel", "startsOn", "endsOn", "status"],
    detail:
      "Add or update enrollment for existing students in the selected year. Status must be enrolled, withdrawn, or completed.",
  },
  roster: {
    title: "Class roster",
    columns: ["studentNumber", "startsOn", "endsOn"],
    detail:
      "Add students or change their dates in one class. Students must already be enrolled for those dates. Omitted students remain in the class.",
  },
  households: {
    title: "Households",
    columns: ["householdId","version","name","address","archived"],
    detail: "Create households with a blank ID and version 0, or update an exact household ID and version. archived must be true or false. Names never match or merge households.",
  },
  household_members: {
    title: "Household membership",
    columns: ["householdId","householdVersion","personId","personVersion","role","remove"],
    detail: "Link existing people to exact households. Enter student, guardian or other as the role, and true or false for remove. Membership never grants student contact, communication or pickup permission.",
  },
  contacts: {
    title: "Student contact permissions",
    columns: ["studentId","studentNumber","studentVersion","personId","personVersion","contactVersion","relationship","isGuardian","canCommunicate","canPickup","pickupUntilAction","pickupUntil","emergencyPriority","restrictionNoteAction","restrictionNote"],
    detail: "Use an exact student number and existing adult person ID with their versions. Enter each permission as true or false. Date/restriction actions must explicitly keep, replace or clear; granting pickup requires an explicit expiry or no-expiry choice. No permission is inferred from family membership.",
  },
} satisfies Record<
  SchoolImportKind,
  { title: string; columns: string[]; detail: string }
>;
export const schoolImportContext = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("people"), unitId: z.uuid() }).strict(),
  z.object({ kind: z.literal("students"), unitId: z.uuid() }).strict(),
  z.object({ kind: z.literal("households"), unitId: z.uuid() }).strict(),
  z.object({ kind: z.literal("household_members"), unitId: z.uuid() }).strict(),
  z.object({ kind: z.literal("contacts"), unitId: z.uuid() }).strict(),
  z
    .object({
      kind: z.literal("enrollments"),
      unitId: z.uuid(),
      yearId: z.uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("roster"),
      unitId: z.uuid(),
      sectionId: z.uuid(),
    })
    .strict(),
]);
export type SchoolImportContext = z.infer<typeof schoolImportContext>;
export type PersonImportContext = Extract<SchoolImportContext, { kind: "people" }>;
export function isPersonImport(context: SchoolImportContext): context is PersonImportContext {
  return context.kind === "people";
}
export type FamilyImportContext = Extract<SchoolImportContext, {kind:"households"|"household_members"|"contacts"}>;
export function isFamilyImport(context: SchoolImportContext): context is FamilyImportContext {
  return context.kind === "households" || context.kind === "household_members" || context.kind === "contacts";
}
const versionText = z.string().regex(/^(0|[1-9]\d*)$/).refine(x=>Number(x)<=2147483646,"Version is too large.");
const existingVersion = versionText.refine(x=>Number(x)>0,"Use the current positive version.");
const explicitBoolean = z.enum(["true","false"]);
const fieldAction = z.enum(["keep","replace","clear"]);
// Field-action meaning and protected-profile eligibility are checked against
// exact current source by the person import planner, not inferred from blanks.
export const personImportRowSchema = z.object({
  personId: z.union([z.uuid(), z.literal("")]), version: versionText,
  name: z.string().min(1).max(4096),
  emailAction: fieldAction, email: z.string().max(4096),
  phoneAction: fieldAction, phone: z.string().max(4096),
}).strict();
export const familyImportRowSchemas = {
  households:z.object({householdId:z.union([z.uuid(),z.literal("")]),version:versionText,name:z.string().trim().min(2).max(120),address:z.string().trim().max(500),archived:explicitBoolean}).strict(),
  household_members:z.object({householdId:z.uuid(),householdVersion:existingVersion,personId:z.uuid(),personVersion:existingVersion,role:z.enum(["student","guardian","other"]),remove:explicitBoolean}).strict(),
  contacts:z.object({studentId:z.uuid(),studentNumber:z.string().trim().min(1).max(40),studentVersion:existingVersion,personId:z.uuid(),personVersion:existingVersion,contactVersion:versionText,relationship:z.string().trim().min(2).max(80),isGuardian:explicitBoolean,canCommunicate:explicitBoolean,canPickup:explicitBoolean,pickupUntilAction:fieldAction,pickupUntil:z.union([dateOnly,z.literal("")]),emergencyPriority:z.union([z.string().regex(/^([1-9]|1\d|20)$/),z.literal("")]),restrictionNoteAction:fieldAction,restrictionNote:z.string().trim().max(2000)}).strict(),
};
const studentNumber = z.string().trim().min(1).max(40);
export const schoolImportRowSchemas = {
  students: z
    .object({
      studentNumber,
      name: z.string().trim().min(2).max(120),
      dateOfBirth: z.union([dateOnly, z.literal("")]),
    })
    .strict(),
  enrollments: z
    .object({
      studentNumber,
      gradeLevel: z.string().trim().min(1).max(30),
      startsOn: dateOnly,
      endsOn: dateOnly,
      status: z.enum(["enrolled", "withdrawn", "completed"]),
    })
    .strict()
    .refine((row) => row.endsOn >= row.startsOn, "End must follow start."),
  roster: z
    .object({ studentNumber, startsOn: dateOnly, endsOn: dateOnly })
    .strict()
    .refine((row) => row.endsOn >= row.startsOn, "End must follow start."),
};
export const previewSchoolImportInput = z
  .object({ context: schoolImportContext, csv: z.string().min(1).max(400000) })
  .strict();
export const applySchoolImportInput = z
  .object({
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    reviewed: z.literal(true),
  })
  .strict();
