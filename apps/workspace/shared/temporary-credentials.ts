import { z } from "zod";
import { passwordSchema, staffInput } from "./contracts";

export const pinSchema = z.string().regex(/^\d{6,8}$/, "Use a PIN with 6 to 8 digits.");
export const initialCredentialsSchema = z.object({ password: passwordSchema, pin: pinSchema }).strict();
export const staffCreateInput = staffInput.extend({ initialCredentials: initialCredentialsSchema.optional() }).strict();
export const staffTemporaryCredentialsInput = initialCredentialsSchema.extend({ commandId: z.uuid(), reason: z.string().trim().min(3).max(1000) }).strict();
export const staffTemporaryCredentialsResult = z.object({ id: z.uuid(), requiresCredentialChange: z.boolean(), replayed: z.boolean() }).strict();
export const staffCreateResultSchema = z.union([
  z.object({ id: z.uuid(), setupUrl: z.url() }).strict(),
  z.object({ id: z.uuid(), requiresCredentialChange: z.literal(true) }).strict(),
]);
export const credentialChangeChallengeSchema = z.object({ requiresCredentialChange: z.literal(true),
  challenge: z.string().min(32).max(100), expiresAt: z.iso.datetime() }).strict();
export const completeCredentialsInput = initialCredentialsSchema.extend({ challenge: z.string().min(32).max(100) }).strict();
export const completeCredentialsResultSchema = z.object({ ok: z.literal(true), signInRequired: z.literal(true) }).strict();
export type StaffCreateInput = z.infer<typeof staffCreateInput>;
export type CredentialChangeChallenge = z.infer<typeof credentialChangeChallengeSchema>;
