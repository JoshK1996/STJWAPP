import { createHash } from 'node:crypto';

type StaffRevisionSource = {
  id: string; name: string; email: string; role: string; active: boolean;
  unit_ids: string[]; job_ids: string[];
};
const canonicalIds = (ids: string[]) => [...new Set(ids.map(id => id.toLowerCase()))].sort();

/** Public editable fields only; credential hashes and session state never enter this token. */
export function staffRecordRevision(orgId: string, source: StaffRevisionSource) {
  return createHash('sha256').update(JSON.stringify([
    'staff-record-v1', orgId.toLowerCase(), source.id.toLowerCase(), source.name,
    source.email.toLowerCase(), source.role, source.active,
    canonicalIds(source.unit_ids), canonicalIds(source.job_ids),
  ])).digest('hex');
}
