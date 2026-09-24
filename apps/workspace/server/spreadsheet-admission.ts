import { Problem } from "./security";

let occupied = false;
const accounts = new Set<string>();
/** One shared process-local import/export slot. No cluster-wide quota is claimed. */
export async function withSpreadsheetSlot<T>(accountKey: string, action: () => Promise<T>, message = "Another spreadsheet operation is being prepared. Try again after it finishes."): Promise<T> {
  if (occupied || accounts.has(accountKey)) throw new Problem(429, message);
  occupied = true; accounts.add(accountKey);
  try { return await action(); } finally { accounts.delete(accountKey); occupied = false; }
}
