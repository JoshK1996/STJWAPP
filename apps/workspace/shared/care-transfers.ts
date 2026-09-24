import { z } from "zod";
const version = z.number().int().positive(),
  reason = z.string().trim().min(5).max(1000);
export const transferRequestInput = z
  .object({
    version,
    programVersion: version,
    observed: z.literal(true),
    reason,
    commandId: z.uuid(),
  })
  .strict();
export const transferDecisionInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("accept"),
      version,
      programVersion: version,
      received: z.literal(true),
      note: z.string().trim().max(1000),
      commandId: z.uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("cancel"),
      version,
      reason,
      commandId: z.uuid(),
    })
    .strict(),
]);
