import { z } from "zod";
import { passwordSchema } from "./contracts";

export const changePasswordInput = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
}).strict();
