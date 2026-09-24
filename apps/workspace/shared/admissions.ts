import { z } from "zod";
import { dateOnly } from "./contracts";
import { personInput } from "./school";
const version = z.number().int().positive(),
  reason = z.string().trim().min(5).max(2000);
export const admissionStages = [
  "inquiry",
  "application",
  "review",
  "offered",
  "accepted",
  "enrolled",
  "declined",
  "withdrawn",
] as const;
export const admissionTransitions: Record<string, string[]> = {
  inquiry: ["application", "withdrawn"],
  application: ["review", "withdrawn"],
  review: ["offered", "declined", "withdrawn"],
  offered: ["accepted", "declined", "withdrawn"],
  accepted: ["withdrawn"],
  enrolled: [],
  declined: ["review"],
  withdrawn: ["inquiry"],
};
export const admissionSettingsInput = z
  .object({
    unitId: z.uuid(),
    version: z.number().int().nonnegative(),
    confirmed: z.boolean(),
    reason,
    requirements: z
      .array(
        z
          .object({
            id: z.uuid(),
            title: z.string().trim().min(3).max(150),
            required: z.boolean(),
          })
          .strict(),
      )
      .max(50)
      .refine(
        (items) => new Set(items.map((item) => item.id)).size === items.length,
        "Checklist identifiers must be unique.",
      ),
  })
  .strict();
export const admissionCreateInput = z
  .object({
    unitId: z.uuid(),
    yearId: z.uuid(),
    commandId: z.uuid(),
    newContact: personInput.omit({ unitId: true }).nullable().default(null),
    existingStudentId: z.uuid().nullable().default(null),
    name: z.string().trim().min(2).max(120),
    dateOfBirth: dateOnly.nullable().default(null),
    primaryContactId: z.uuid().nullable().default(null),
    gradeLevel: z.string().trim().min(1).max(30),
    notes: z.string().trim().max(4000).default(""),
  })
  .strict()
  .refine(
    (input) => !input.primaryContactId || !input.newContact,
    "Choose an existing contact or enter a new one.",
  );
export const admissionEditInput = z
  .object({
    version,
    gradeLevel: z.string().trim().min(1).max(30),
    primaryContactId: z.uuid().nullable(),
    notes: z.string().trim().max(4000),
    reason,
  })
  .strict();
export const admissionStageInput = z
  .object({
    version,
    status: z.enum(admissionStages),
    reason: z.string().trim().min(10).max(2000),
  })
  .strict();
export const admissionChecklistInput = z
  .object({
    version,
    itemId: z.uuid(),
    status: z.enum(["pending", "complete", "waived"]),
    evidence: z.string().trim().max(2000),
  })
  .strict()
  .refine(
    (input) => input.status === "pending" || input.evidence.length >= 5,
    "Record where the item was reviewed, or why it was waived.",
  );
export const admissionEnrollInput = z
  .object({
    version,
    studentNumber: z.string().trim().min(1).max(40),
    startsOn: dateOnly,
    endsOn: dateOnly,
    householdId: z.uuid().nullable().default(null),
    contactCanCommunicate: z.boolean(),
    reason: z.string().trim().min(10).max(2000),
  })
  .strict()
  .refine(
    (input) => input.endsOn >= input.startsOn,
    "Enrollment end must follow start.",
  );
