import { useEffect, useRef, useState } from 'react';
import { DateTime } from 'luxon';
import { ApiError } from './api';

export type PlanningAccess = { isSessionCurrent: () => boolean; onSessionExpired: () => void };
export function usePlanningAccess({ isSessionCurrent, onSessionExpired }: PlanningAccess) {
  const mounted = useRef(true), denied = useRef(false);
  const callbacks = useRef({ isSessionCurrent, onSessionExpired }); callbacks.current = { isSessionCurrent, onSessionExpired };
  const [accessDenied, setAccessDenied] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && !denied.current && callbacks.current.isSessionCurrent();
  const reject = (cause: unknown) => {
    if (!(cause instanceof ApiError) || ![401, 403].includes(cause.status)) return false;
    denied.current = true; setAccessDenied(true); callbacks.current.onSessionExpired(); return true;
  };
  return { current, reject, accessDenied };
}
export const planningError = (cause: unknown) => cause instanceof Error ? cause.message : 'The schedule could not be loaded. Please try again.';
export const planningDate = (date: string) => DateTime.fromISO(date).toFormat('LLL d, yyyy');
export function planningTime(instant: string, zone: string) {
  const date=DateTime.fromISO(instant).setZone(zone),fraction=(instant.match(/\.(\d+)/)?.[1]??'').replace(/0+$/,'');
  return date.second || fraction ? `${date.toFormat('LLL d, h:mm:ss')}${fraction?`.${fraction}`:''} ${date.toFormat('a')}` : date.toFormat('LLL d, h:mm a');
}
export function planningInstant(value:string) {
  const millis=Date.parse(value);if(!Number.isFinite(millis))throw new Error('Invalid schedule timestamp.');
  const fraction=(value.match(/\.(\d+)/)?.[1]??'').padEnd(6,'0').slice(0,6);
  return BigInt(millis)*1000n+BigInt(fraction.slice(3));
}
export function planningOverlap(a:{startsAt:string;endsAt:string},b:{startsAt:string;endsAt:string}) {
  return planningInstant(a.startsAt)<planningInstant(b.endsAt)&&planningInstant(a.endsAt)>planningInstant(b.startsAt);
}
export function staffHours(microseconds: string | bigint) {
  const value = BigInt(microseconds), sign = value < 0n ? '−' : '', absolute = value < 0n ? -value : value;
  const hundredths = (absolute * 100n + 1800000000n) / 3600000000n;
  return `${sign}${(hundredths / 100n).toLocaleString('en-US')}${hundredths % 100n ? `.${(hundredths % 100n).toString().padStart(2, '0').replace(/0$/, '')}` : ''}`;
}
export function filledPercent(filled: string | bigint, required: string | bigint) {
  const denominator = BigInt(required); return denominator > 0n ? Number(BigInt(filled) * 10000n / denominator) / 100 : 0;
}
export type PlanningRangeMode = 'day' | 'week' | 'month' | 'year' | 'custom';
export function planningRange(anchor: string, mode: PlanningRangeMode) {
  const date = DateTime.fromISO(anchor, { zone: 'UTC' });
  if (!date.isValid) return null;
  if (mode === 'custom') return { start: anchor, end: anchor };
  return { start: date.startOf(mode).toISODate()!, end: date.endOf(mode).toISODate()! };
}
