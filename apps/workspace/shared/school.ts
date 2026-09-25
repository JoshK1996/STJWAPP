import { z } from "zod";
import { dateOnly } from "./contracts";
const name = z.string().trim().min(2).max(120),
  note = z.string().trim().max(2000),
  uuid = z.uuid(),
  version = z.number().int().positive();
export const schoolYearInput = z
  .object({ unitId: uuid, name, startsOn: dateOnly, endsOn: dateOnly })
  .strict()
  .refine((x) => x.endsOn >= x.startsOn, "End must follow start.");
export const termInput = z
  .object({ yearId: uuid, name, startsOn: dateOnly, endsOn: dateOnly })
  .strict()
  .refine((x) => x.endsOn >= x.startsOn, "End must follow start.");
export const schoolYearUpdateInput = z.object({name,startsOn:dateOnly,endsOn:dateOnly,archived:z.boolean(),version,reason:z.string().trim().min(5).max(1000)}).strict().refine(x=>x.endsOn>=x.startsOn,'End must follow start.');
export const termUpdateInput = z.object({name,startsOn:dateOnly,endsOn:dateOnly,version,reason:z.string().trim().min(5).max(1000)}).strict().refine(x=>x.endsOn>=x.startsOn,'End must follow start.');
export const courseUpdateInput = z.object({code:z.string().trim().min(1).max(30),title:name,description:note,archived:z.boolean(),version,reason:z.string().trim().min(5).max(1000)}).strict();
export const householdInput = z
  .object({
    unitId: uuid,
    name,
    address: z.string().trim().max(500).default(""),
  })
  .strict();
export const householdUpdateInput = z
  .object({
    name,
    address: z.string().trim().max(500),
    archived: z.boolean(),
    version,
  })
  .strict();
export const personInput = z
  .object({
    unitId: uuid,
    name,
    email: z.union([z.literal(""), z.email().max(254)]).default(""),
    phone: z.string().trim().max(40).default(""),
  })
  .strict();
export const personUpdateInput = personInput
  .omit({ unitId: true })
  .extend({ version })
  .strict();
export const studentInput = z
  .object({
    unitId: uuid,
    name,
    studentNumber: z.string().trim().min(1).max(40),
    dateOfBirth: dateOnly.nullable().default(null),
    householdId: uuid.nullable().default(null),
  })
  .strict();
export const studentUpdateInput = z
  .object({
    name,
    studentNumber: z.string().trim().min(1).max(40),
    dateOfBirth: dateOnly.nullable(),
    active: z.boolean(),
    version,
  })
  .strict();
export const enrollmentInput = z
  .object({
    yearId: uuid,
    gradeLevel: z.string().trim().min(1).max(30),
    startsOn: dateOnly,
    endsOn: dateOnly,
    status: z.enum(["enrolled", "withdrawn", "completed"]).default("enrolled"),
  })
  .strict()
  .refine((x) => x.endsOn >= x.startsOn, "End must follow start.");
export const contactInput = z
  .object({
    personId: uuid,
    relationship: z.string().trim().min(2).max(80),
    isGuardian: z.boolean(),
    canCommunicate: z.boolean(),
    canPickup: z.boolean(),
    pickupUntil: dateOnly.nullable().default(null),
    emergencyPriority: z.number().int().min(1).max(20).nullable().default(null),
    restrictionNote: note.default(""),
    version: version.optional(),
  })
  .strict();
export const courseInput = z
  .object({
    unitId: uuid,
    code: z.string().trim().min(1).max(30),
    title: name,
    description: note.default(""),
  })
  .strict();
export const sectionInput = z
  .object({
    unitId: uuid,
    yearId: uuid,
    courseId: uuid.nullable().default(null),
    name,
    homeroom: z.boolean(),
    capacity: z.number().int().min(1).max(200),
    room: z.string().trim().max(100).default(""),
    teacherIds: z
      .array(uuid)
      .max(20)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Choose each teacher once.",
      ),
  })
  .strict();
export const sectionUpdateInput = sectionInput
  .omit({ unitId: true, yearId: true, courseId: true, homeroom: true })
  .extend({ version })
  .strict();
export const rosterInput = z
  .object({
    studentId: uuid,
    startsOn: dateOnly,
    endsOn: dateOnly,
    version: version.optional(),
  })
  .strict()
  .refine((x) => x.endsOn >= x.startsOn, "End must follow start.");
export const curriculumInput = z
  .object({
    title: name,
    content: z.string().trim().min(1).max(20000),
    sortOrder: z.number().int().min(0).max(10000).default(0),
  })
  .strict();
