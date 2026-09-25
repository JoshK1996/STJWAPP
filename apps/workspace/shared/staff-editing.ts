import { z } from 'zod';
import { staffInput } from './contracts';

export const staffUpdateInput = staffInput.extend({
  active: z.boolean(),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/, 'Reload the employee before saving.'),
}).strict();
