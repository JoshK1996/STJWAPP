import { z } from "zod";
import { passwordSchema, staffInput } from "./contracts";

export const pinSchema = z.string().regex(/^\d{6,8}$/, "Use a PIN with 6 to 8 digits.");
const changeRequirements = {
  requirePasswordChange: z.boolean().default(true),
  requirePinChange: z.boolean().default(true),
};
export const initialCredentialsSchema = z.object({ password: passwordSchema, pin: pinSchema, ...changeRequirements }).strict();
export const staffCreateInput = staffInput.extend({ initialCredentials: initialCredentialsSchema.optional() }).strict();
export const staffTemporaryCredentialsInput = initialCredentialsSchema.extend({ commandId: z.uuid(), reason: z.string().trim().min(3).max(1000) }).strict();
export const staffTemporaryCredentialsResult = z.object({ id: z.uuid(), requiresCredentialChange: z.boolean(), replayed: z.boolean(), ...changeRequirements }).strict();
export const staffCreateResultSchema = z.union([
  z.object({ id: z.uuid(), setupUrl: z.url() }).strict(),
  z.object({ id: z.uuid(), requiresCredentialChange: z.boolean(), ...changeRequirements }).strict(),
]);
export const credentialChangeChallengeSchema = z.object({ requiresCredentialChange: z.literal(true),
  challenge: z.string().min(32).max(100), expiresAt: z.iso.datetime(), ...changeRequirements }).strict();
export const completeCredentialsInput = z.object({ challenge: z.string().min(32).max(100), password: passwordSchema.optional(), pin: pinSchema.optional() }).strict();
export const completeCredentialsResultSchema = z.object({ ok: z.literal(true), signInRequired: z.literal(true) }).strict();
export type StaffCreateInput = z.infer<typeof staffCreateInput>;
export type CredentialChangeChallenge = z.infer<typeof credentialChangeChallengeSchema>;
