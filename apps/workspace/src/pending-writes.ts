// Counts only pending operations, never request bodies or account information.
let pending = 0;
const listeners = new Set<() => void>();
export const getPendingWriteCount = () => pending;
export function subscribePendingWrites(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function beginWrite(method: string) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return () => {};
  pending++;
  for (const listener of listeners) listener();
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    pending--;
    for (const listener of listeners) listener();
  };
}
