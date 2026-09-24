// Test processes receive their own synthetic key. This is never imported by the
// application runtime and never reads or replaces a configured deployment key.
import { randomBytes } from 'node:crypto';
if (process.env.STJW_PIN_LOOKUP_SECRET === undefined) {
  process.env.STJW_PIN_LOOKUP_SECRET = randomBytes(32).toString('hex');
}
