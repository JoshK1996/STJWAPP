import { z } from "zod";
export const unitKinds = [
  "school",
  "early_childhood",
  "parish",
  "administration",
  "department",
] as const;
export const unitKindLabels: Record<(typeof unitKinds)[number], string> = {
  school: "School",
  early_childhood: "Early childhood",
  parish: "Parish",
  administration: "Administration",
  department: "Department or team",
};
export const unitChangeInput = z
  .object({
    id: z.uuid(),
    expectedVersion: z.number().int().min(0),
    name: z.string().trim().min(2).max(120),
    kind: z.enum(unitKinds),
    parentId: z.uuid().nullable(),
    description: z.string().trim().max(1000),
    reason: z.string().trim().min(5).max(1000),
  })
  .strict();
export const unitSaveInput = unitChangeInput
  .extend({
    structureVersion: z.number().int().min(0),
    previewHash: z.string().regex(/^[a-f0-9]{64}$/),
    commandId: z.uuid(),
    reviewed: z.literal(true),
  })
  .strict();
export type UnitChange = z.infer<typeof unitChangeInput>;
