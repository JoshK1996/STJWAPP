import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, CircleAlert, LoaderCircle, Plus, RefreshCw } from 'lucide-react';
import { api, ApiError, download } from './api';
import { parseAmount, formatAmount, type AccountingWorkspace } from '../shared/accounting';

export const AccountingAccessContext = createContext<() => void>(() => {});

export type AccountingContext = {
  workspace: AccountingWorkspace;
  notify: (message: string, error?: boolean) => void;
  onDirty: (dirty: boolean) => void;
  refresh: () => void;
  guardNavigation?: () => boolean;
};

// Formatting keeps source decimals intact. Only chart proportions use Number.
export function accountingMoney(value: string | number | null | undefined, currency = '', precision = 2): string {
  if (value === null || value === undefined) return '—';
  const raw = String(value), match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return raw;
  const fraction = (match[3] || '').padEnd(precision + 1, '0');
  let scaled = BigInt(match[2]) * 10n ** BigInt(precision) + BigInt(fraction.slice(0, precision) || '0');
  if (Number(fraction[precision]) >= 5) scaled++;
  const digits = scaled.toString().padStart(precision + 1, '0');
  const whole = (precision ? digits.slice(0, -precision) : digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${match[1] && scaled !== 0n ? '−' : ''}${whole}${precision ? '.' + digits.slice(-precision) : ''}${currency ? ' ' + currency : ''}`;
}
export function accountingUnits(value: string, precision = 2): bigint {
  return value.startsWith('-') ? -parseAmount(value.slice(1), precision) : parseAmount(value, precision);
}
export function accountingDecimal(value: bigint, precision = 2): string {
  return formatAmount(value, precision);
}
export function accountingDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value.length === 10 ? value + 'T12:00:00Z' : value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date);
}
export function localToday(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function rowsOf<T = any>(result: any): T[] { return Array.isArray(result) ? result : result?.rows ?? []; }
export function useAccountingCommands() {
  const commands=useRef(new Map<string,string>());
  return (action:string,body:unknown) => { const key=action+':'+JSON.stringify(body);let command=commands.current.get(key);if(!command){command=crypto.randomUUID();commands.current.set(key,command);}return command; };
}
export function useAccountingResource<T>(path: string | null, revision: unknown = 0) {
  const onDenied = useContext(AccountingAccessContext);
  const [record,setRecord]=useState<{key:string;data:T|null}|null>(null), [loading, setLoading] = useState(false), [error, setError] = useState(''), [tick, setTick] = useState(0);
  const key=JSON.stringify([path,revision,tick]);
  const setData=(data:T|null)=>setRecord({key,data});
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    setData(null); setError('');
    if (!path) { setLoading(false); return () => { current = false; controller.abort(); }; }
    setLoading(true);
    api<T>(path, undefined, 'GET', controller.signal).then(result => { if (current) setData(result); }).catch(caught => {
      if (current && caught?.name !== 'AbortError') { setData(null); setError(caught instanceof Error ? caught.message : 'Unable to load this accounting view.'); if(caught instanceof ApiError && [401,403].includes(caught.status))onDenied(); }
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; controller.abort(); };
  }, [path, revision, tick]);
  const reload = useCallback(() => setTick(value => value + 1), []);
  return { data:record?.key===key?record.data:null, loading:loading||Boolean(path&&record?.key!==key&&!error), error, reload, setData };
}
export function useAccountingAction(notify: AccountingContext['notify']) {
  const onDenied = useContext(AccountingAccessContext);
  const mounted = useRef(true), running = useRef(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function run<T>(work: () => Promise<T>, message?: string): Promise<T | undefined> {
    if (running.current) return undefined;
    running.current = true; setBusy(true); setError('');
    try {
      const result = await work();
      if (!mounted.current) return undefined;
      if (message) notify(message);
      return result;
    } catch (caught) {
      if (!mounted.current) return undefined;
      const message = caught instanceof Error ? caught.message : 'This action could not be completed.';
      setError(message); notify(message, true);
      // Existing read data is refreshed by callers after successful writes. A
      // revoked session must also stop stale downloads from this mounted panel.
      if (caught instanceof ApiError && (caught.status === 401 || caught.status === 403)) onDenied();
      return undefined;
    } finally { running.current = false; if (mounted.current) setBusy(false); }
  }
  async function exportFile(path: string, name: string, canPublish:()=>boolean=()=>true) { return run(() => download(path, name, () => mounted.current&&canPublish())); }
  return { run, exportFile, busy, error, clearError: () => setError('') };
}
export function AccountingNotice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'success' | 'warning' | 'error' }) {
  return <div className={'accounting-notice ' + tone} role={tone === 'error' ? 'alert' : undefined}>{tone === 'success' ? <CheckCircle2 size={19}/> : <CircleAlert size={19}/>}<div>{children}</div></div>;
}
export function AccountingLoad({ loading, error, retry }: { loading: boolean; error?: string; retry?: () => void }) {
  if (loading) return <div className="accounting-loading" role="status"><LoaderCircle size={21} className="accounting-spin"/>Loading accounting records…</div>;
  if (error) return <AccountingNotice tone="error">{error}{retry && <button type="button" onClick={retry}><RefreshCw size={16}/>Try again</button>}</AccountingNotice>;
  return null;
}
export function AccountingSection({ title, detail, children, actions }: { title: string; detail?: string; children: ReactNode; actions?: ReactNode }) {
  return <section className="accounting-section"><header><div><h3>{title}</h3>{detail && <p>{detail}</p>}</div>{actions && <div className="accounting-actions">{actions}</div>}</header>{children}</section>;
}
export function AccountingEmpty({ title, detail, onCreate, createLabel }: { title: string; detail: string; onCreate?: () => void; createLabel?: string }) {
  return <div className="accounting-empty"><div aria-hidden="true"><Plus size={28}/></div><h4>{title}</h4><p>{detail}</p>{onCreate && <button type="button" onClick={onCreate}>{createLabel || 'Get started'}</button>}</div>;
}
export function AccountingAmount({ value, workspace }: { value: string | number | null | undefined; workspace: any }) {
  const config = workspace?.config ?? workspace;
  return <span className="accounting-amount" title={value == null ? undefined : 'Exact amount: ' + value}>{accountingMoney(value, config?.currency ?? '', config?.precision ?? 2)}</span>;
}
export function AccountingTable({ label, children }: { label: string; children: ReactNode }) { return <div><div className="accounting-table-scroll" role="region" aria-label={label} tabIndex={0}><table className="accounting-table">{children}</table></div><p className="accounting-table-hint">Swipe sideways to see every column.</p></div>; }
