import { z } from "zod";

export const brandingPaletteIds = ["cobalt", "lagoon", "sunset", "forest", "ocean", "violet", "rose", "amber", "slate"] as const;
export const brandingPaletteSchema = z.enum(brandingPaletteIds);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().min(0).max(2147483647);
const instant = z.string().datetime({ precision: 6 });
const safeLine = (value: string) => !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(value);
const line = (minimum: number, maximum: number) => z.string().min(minimum).max(maximum)
  .refine(safeLine, "Use valid single-line text without control characters.")
  .refine(value => value === value.trim(), "Remove leading and trailing whitespace.");
const inputLine = (minimum: number, maximum: number) => z.string()
  .refine(safeLine, "Use valid single-line text without control characters.").transform(value => value.trim()).pipe(line(minimum, maximum));

export const organizationBrandingSettingsSchema = z.object({
  schemaVersion: z.literal(1), shortName: line(1, 24), displayName: line(2, 120), subtitle: line(0, 120),
  paletteId: brandingPaletteSchema, artwork: z.enum(["full", "subtle", "none"]), depth: z.boolean(),
}).strict();
const settingsInputSchema = organizationBrandingSettingsSchema.extend({
  shortName: inputLine(1, 24), displayName: inputLine(2, 120), subtitle: inputLine(0, 120),
});
export type OrganizationBrandingSettings = z.infer<typeof organizationBrandingSettingsSchema>;
export type BrandingPaletteId = z.infer<typeof brandingPaletteSchema>;
export const unconfiguredBrandingSettings: Readonly<OrganizationBrandingSettings> = Object.freeze({
  schemaVersion: 1, shortName: "STJW", displayName: "St. Joseph the Worker", subtitle: "School, early childhood & parish",
  paletteId: "cobalt", artwork: "full", depth: true,
});
const snapshotObject = z.object({
  schemaVersion: z.literal(1), configured: z.boolean(), version,
  settings: organizationBrandingSettingsSchema, settingsHash: hash, updatedAt: instant.nullable(),
}).strict();
const consistentSnapshot = (value: z.infer<typeof snapshotObject>) => value.configured
  ? value.version > 0 && value.updatedAt !== null : value.version === 0 && value.updatedAt === null;
export const brandingSnapshotSchema = snapshotObject.refine(consistentSnapshot, "Branding publication state is inconsistent.");
export type BrandingSnapshot = z.infer<typeof brandingSnapshotSchema>;
export const organizationBrandingCurrentSchema = snapshotObject.extend({
  allowedActions: z.object({ publish: z.boolean(), history: z.boolean() }).strict(),
}).refine(consistentSnapshot, "Branding publication state is inconsistent.");
export type OrganizationBrandingCurrent = z.infer<typeof organizationBrandingCurrentSchema>;
export const publishOrganizationBrandingSchema = z.object({
  commandId: z.uuid().transform(value => value.toLowerCase()), expectedVersion: version.max(2147483646), reviewed: z.literal(true),
  reason: inputLine(10, 1000), settings: settingsInputSchema,
}).strict();
export type PublishOrganizationBranding = z.infer<typeof publishOrganizationBrandingSchema>;
export const organizationBrandingReceiptSchema = z.object({
  schemaVersion: z.literal(1), commandId: z.uuid(), historyId: z.uuid(), beforeVersion: version.max(2147483646), snapshot: brandingSnapshotSchema,
}).strict().refine(value => value.snapshot.configured && value.snapshot.version === value.beforeVersion + 1, "Branding receipt version is inconsistent.");
export type OrganizationBrandingReceipt = z.infer<typeof organizationBrandingReceiptSchema>;
export const organizationBrandingHistoryRowSchema = z.object({
  id: z.uuid(), commandId: z.uuid(), version: version.min(1), before: brandingSnapshotSchema, after: brandingSnapshotSchema,
  reason: line(10, 1000), actor: z.object({ id: z.uuid(), name: z.string().min(1).max(240) }).strict(), createdAt: instant,
}).strict().refine(value => value.after.configured && value.version === value.after.version && value.before.version === value.version - 1
  && value.createdAt === value.after.updatedAt, "Branding history versions or timestamps are inconsistent.");
export type OrganizationBrandingHistoryRow = z.infer<typeof organizationBrandingHistoryRowSchema>;
export const brandingHistoryQuerySchema = z.object({
  beforeVersion: z.string().regex(/^[1-9]\d{0,9}$/).transform(Number).pipe(z.number().int().min(1).max(2147483647)).optional(),
  limit: z.string().regex(/^[1-9]\d?$/).transform(Number).pipe(z.number().int().min(1).max(50)).default(20),
}).strict();
export const organizationBrandingHistorySchema = z.object({
  rows: z.array(organizationBrandingHistoryRowSchema).max(50), currentVersion: version, nextBeforeVersion: version.min(1).nullable(),
}).strict().refine(value => value.rows.every((row, index) => row.version <= value.currentVersion && (!index || value.rows[index - 1].version > row.version))
  && (value.nextBeforeVersion === null || value.rows.length > 0 && value.nextBeforeVersion === value.rows.at(-1)!.version), "Branding history pagination is inconsistent.");
export type OrganizationBrandingHistory = z.infer<typeof organizationBrandingHistorySchema>;
