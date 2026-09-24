import { z } from "zod";
export const eventInput = z
  .object({
    title: z.string().trim().min(2).max(140),
    description: z.string().trim().max(6000).default(""),
    location: z.string().trim().max(200).default(""),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    timezone: z.string().min(1).max(80),
    audience: z.enum(["personal", "unit", "organization"]),
    unitId: z.uuid().nullable().default(null),
  })
  .strict()
  .refine(
    (x) => new Date(x.endsAt) > new Date(x.startsAt),
    "End must follow start.",
  )
  .refine(
    (x) => (x.audience === "unit") === (x.unitId !== null),
    "Choose a unit only for unit events.",
  );
export const eventCreateInput = z
  .object({
    event: eventInput,
    repeat: z
      .object({
        frequency: z.enum(["none", "daily", "weekly"]),
        interval: z.number().int().min(1).max(12),
        count: z.number().int().min(1).max(52),
      })
      .strict()
      .default({ frequency: "none", interval: 1, count: 1 }),
  })
  .strict();
export const eventUpdateInput = z
  .object({ event: eventInput, version: z.number().int().positive() })
  .strict();
export const messageInput = z
  .object({
    subject: z.string().trim().min(2).max(160),
    body: z.string().trim().min(1).max(12000),
    recipientIds: z
      .array(z.uuid())
      .min(1)
      .max(50)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Choose each recipient once.",
      ),
    replyTo: z.uuid().nullable().default(null),
  })
  .strict();
export const messageUpdateInput = z
  .object({ message: messageInput, version: z.number().int().positive() })
  .strict();
