import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  ArrowDownToLine,
  CheckCircle2,
  FileSpreadsheet,
  Upload,
} from "lucide-react";
import { api, ApiError } from "./api";
import WorkbookImport from "./WorkbookImport";
import type { WorkbookConvertResult, WorkbookKind } from "../shared/import-workbooks";
import { Badge, Empty, Panel } from "./components";
import {
  schoolImportCatalog,
  schoolImportKinds,
  schoolImportContext,
  type SchoolImportKind,
} from "../shared/school-imports";
import "./school-imports.css";

// CSV capabilities are independent of the explicitly supported workbook kinds.
const workbookKinds: Partial<Record<SchoolImportKind, WorkbookKind>> = {
  students: "school_students", enrollments: "school_enrollments", roster: "school_roster",
  households: "school_households", household_members: "school_household_members", contacts: "school_contacts",
};
const countsSchema = z.object({ total: z.number().int().nonnegative(), create: z.number().int().nonnegative(), update: z.number().int().nonnegative(), unchanged: z.number().int().nonnegative(), errors: z.number().int().nonnegative() });
const batchEvidenceSchema = z.object({
  id: z.uuid(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), planHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }), hasSource: z.boolean(),
  appliedAt: z.iso.datetime({ offset: true }).nullable(),
  plan: z.object({ context: schoolImportContext, counts: countsSchema, rows: z.array(z.object({ row: z.number().int().min(2), action: z.enum(['create','update','unchanged','error']), input: z.record(z.string(), z.string()), errors: z.array(z.string()), before: z.record(z.string(), z.unknown()).nullable(), after: z.record(z.string(), z.unknown()).nullable() }).passthrough()) }).passthrough(),
  receipt: z.object({ counts: countsSchema, records: z.array(z.object({ row: z.number().int().min(2) }).passthrough()) }).nullable(),
}).passthrough();
function checkedBatch(value: unknown, expected: { id: string; kind: SchoolImportKind; unitId: string; sourceHash?: string; planHash?: string }, applied = false) {
  const result = batchEvidenceSchema.parse(value);
  if (result.id !== expected.id || result.plan.context.kind !== expected.kind || result.plan.context.unitId !== expected.unitId
    || (expected.sourceHash && result.sourceHash !== expected.sourceHash) || (expected.planHash && result.planHash !== expected.planHash)
    || (applied && !result.appliedAt)) throw new Error('The import response did not match the reviewed batch.');
  if (result.appliedAt) {
    if (!result.receipt || !Number.isFinite(Date.parse(result.appliedAt))) throw new Error('The saved import receipt is incomplete.');
    const changes = result.plan.rows.filter(row => row.action === 'create' || row.action === 'update');
    const records = result.receipt.records;
    if (Object.keys(result.plan.counts).some(key => result.receipt!.counts[key as keyof z.infer<typeof countsSchema>] !== result.plan.counts[key as keyof z.infer<typeof countsSchema>])
      || records.length !== changes.length || new Set(records.map(row => row.row)).size !== records.length
      || records.some(row => !changes.some(change => change.row === row.row))) throw new Error('The saved import row evidence is incomplete.');
    for (const record of records) {
      const identity = result.plan.context.kind === 'people' ? { personId: z.uuid(), version: z.number().int().positive() }
        : result.plan.context.kind === 'households' ? { householdId: z.uuid(), version: z.number().int().positive() }
        : result.plan.context.kind === 'household_members' ? { householdId: z.uuid(), personId: z.uuid(), removed: z.boolean() }
        : result.plan.context.kind === 'contacts' ? { studentId: z.uuid(), personId: z.uuid(), version: z.number().int().positive() }
        : { studentId: z.uuid(), version: z.number().int().positive() };
      z.object(identity).passthrough().parse(record);
    }
  } else if (result.receipt !== null) throw new Error('The pending import response contains inconsistent receipt evidence.');
  return result;
}
const fieldNames: Record<string, string> = {
  studentNumber: "Student number",
  name: "Name",
  email: "Email",
  phone: "Phone",
  emailAction: "Email action",
  phoneAction: "Phone action",
  dateOfBirth: "Date of birth",
  gradeLevel: "Grade level",
  startsOn: "Start date",
  endsOn: "End date",
  status: "Status",
  householdId: "Household ID",
  householdVersion: "Household version",
  personId: "Person ID",
  personVersion: "Person version",
  studentId: "Student ID",
  studentVersion: "Student version",
  contactVersion: "Contact version",
  version: "Record version",
  address: "Household address",
  archived: "Archived",
  role: "Household role",
  member: "Membership recorded",
  remove: "Remove this membership",
  relationship: "Relationship to student",
  isGuardian: "Recorded legal guardian",
  canCommunicate: "School communication permission",
  canPickup: "Pickup permission",
  pickupUntil: "Pickup authorization ends",
  pickupExpiry: "Pickup authorization duration",
  pickupUntilAction: "Pickup end-date action",
  emergencyPriority: "Emergency contact priority",
  restrictionNote: "Office-only restrictions and notes",
  restrictionNoteAction: "Restriction-note action",
};
const permissionFields = new Set(["isGuardian", "canCommunicate", "canPickup"]);
function shownValue(key: string, value: unknown) {
  if (key === "emailAction" || key === "phoneAction") return value === "keep" ? "Keep current value" : value === "replace" ? "Replace with entered value" : value === "clear" ? "Clear this field" : String(value ?? "Not entered");
  if (value === null || value === undefined || value === "") return "Not entered";
  if (key === "isGuardian" && typeof value === "boolean") return value ? "Yes — recorded guardian" : "No guardian designation";
  if (key === "canCommunicate" && typeof value === "boolean") return value ? "Communication allowed" : "No communication permission";
  if (key === "canPickup" && typeof value === "boolean") return value ? "Pickup permission recorded" : "No pickup permission";
  if (key === "member" && typeof value === "boolean") return value ? "Member of this household" : "Not a member of this household";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}
function Values({ value, emptyLabel = "New record", actions }: { value: any; emptyLabel?: string; actions?: any }) {
  if (!value) return <span className="muted">{emptyLabel}</span>;
  return (
    <dl className="import-values">
      {Object.entries(value).map(([key, v]) => (
        <div key={key} className={permissionFields.has(key) ? "import-permission-value" : undefined}>
          <dt>{fieldNames[key] ?? key}</dt>
          <dd>{actions?.[key + "Action"] === "clear" ? "Cleared" : shownValue(key, v)}{actions?.[key + "Action"] === "keep" && <small>Keep current value</small>}</dd>
        </div>
      ))}
    </dl>
  );
}
export default function SchoolImports({
  unitId,
  yearId,
  years,
  sections,
  notify,
  onDirty,
  onApplied,
}: {
  unitId: string;
  yearId: string;
  years: any[];
  sections: any[];
  notify: (message: string, error?: boolean) => void;
  onDirty: (value: boolean) => void;
  onApplied: () => Promise<void>;
}) {
  const [kind, setKind] = useState<SchoolImportKind>("students"),
    [sectionId, setSectionId] = useState(""),
    [fileName, setFileName] = useState(""),
    [csv, setCsv] = useState(""),
    [preview, setPreview] = useState<any>(null),
    [history, setHistory] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [reviewed, setReviewed] = useState(false),
    [page, setPage] = useState(0),
    [filter, setFilter] = useState("all"),
    [error, setError] = useState(""),
    [now, setNow] = useState(Date.now()),
    [historyError, setHistoryError] = useState("");
  const [workbookPending, setWorkbookPending] = useState(false),
    [workbookReset, setWorkbookReset] = useState(0),
    [workbookSource, setWorkbookSource] = useState<WorkbookConvertResult | null>(null),
    [applyUncertain, setApplyUncertain] = useState(false),
    [unresolvedAccess, setUnresolvedAccess] = useState(false),
    [refreshNeeded, setRefreshNeeded] = useState(false);
  const generation = useRef(0), historyGeneration = useRef(0), mounted = useRef(true), busyRef = useRef(false);
  const applyAttempt = useRef<{ id: string; kind: SchoolImportKind; body: { sourceHash: string; planHash: string; reviewed: true } } | null>(null);
  const unresolvedBatch = useRef<{ id: string; kind: SchoolImportKind } | null>(null), downloads = useRef(new Set<AbortController>());
  const csvInput = useRef<HTMLInputElement>(null);
  const selected = schoolImportCatalog[kind],
    year = years.find((y) => y.id === yearId);
  const familyKind = ["households", "household_members", "contacts"].includes(kind);
  const peopleKind = kind === "people";
  const classChoices = sections.filter(
    (s) => !s.archived && s.year_id === yearId,
  );
  const ready =
    peopleKind || familyKind || kind === "students" || (!!yearId && (kind !== "roster" || !!sectionId));
  const context =
    peopleKind || familyKind || kind === "students"
      ? { kind, unitId }
      : kind === "enrollments"
        ? { kind, unitId, yearId }
        : { kind, unitId, sectionId };
  const rows =
    preview?.plan.rows.filter(
      (row: any) => filter === "all" || row.action === filter,
    ) ?? [];
  const expired =
    preview &&
    !preview.appliedAt &&
    new Date(preview.expiresAt).getTime() <= now;
  const canApply =
    preview &&
    !preview.appliedAt &&
    (applyUncertain || (!expired && preview.plan.counts.errors === 0 && reviewed)) &&
    !busy;
  const unfinished = workbookPending || ((!preview?.appliedAt) && (!!csv || !!preview)) || unresolvedAccess;
  const sourceLocked = busy || applyUncertain || unresolvedAccess;
  const workbookKind = workbookKinds[kind];
  const workbookKey = JSON.stringify([kind, unitId, yearId, sectionId, workbookReset]);
  useEffect(() => {
    onDirty(unfinished || busy || applyUncertain);
    return () => onDirty(false);
  }, [unfinished, busy, applyUncertain, onDirty]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; historyGeneration.current++; abortDownloads(); };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  function current(version: number) { return mounted.current && generation.current === version; }
  function setWorking(value: boolean) { busyRef.current = value; setBusy(value); }
  function abortDownloads() { for (const controller of downloads.current) controller.abort(); downloads.current.clear(); }
  function clearAccess(status: 401 | 403 | 404) {
    // A denial cannot prove an earlier attempted write did not commit. Keep only
    // its opaque lookup reference; clear source, values, hashes and review data.
    if (applyAttempt.current) unresolvedBatch.current = { id: applyAttempt.current.id, kind: applyAttempt.current.kind };
    setUnresolvedAccess(!!unresolvedBatch.current);
    generation.current++; historyGeneration.current++; applyAttempt.current = null;
    abortDownloads(); setRefreshNeeded(false);
    setWorking(false); setApplyUncertain(false); setWorkbookPending(false); setWorkbookReset(value => value + 1);
    setWorkbookSource(null); setCsv(''); setFileName(''); setPreview(null); setHistory([]); setHistoryError('');
    setReviewed(false); setSectionId(''); setPage(0); setFilter('all'); onDirty(false);
    if (csvInput.current) csvInput.current.value = '';
    setError(status === 401
      ? 'Your sign-in expired or changed. Sign in again to open school imports.'
      : 'Your school import access could not be verified. The file, preview and import history have been cleared.');
  }
  function accessDenied(e: unknown) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404)) { clearAccess(e.status); return true; }
    return false;
  }
  function message(e: unknown) { return e instanceof ApiError ? e.message : 'The connection was interrupted. Try again.'; }
  async function loadHistory() {
    const version = generation.current, historyVersion = ++historyGeneration.current;
    try {
      const result = await api("/school/imports?unitId=" + unitId);
      if (!current(version) || historyVersion !== historyGeneration.current) return;
      setHistory(result.batches);
      setHistoryError("");
    } catch (e) {
      if (!current(version) || historyVersion !== historyGeneration.current || accessDenied(e)) return;
      setHistoryError(message(e));
    }
  }
  useEffect(() => {
    void loadHistory();
  }, [unitId]);
  function reset() {
    generation.current++; applyAttempt.current = null; setApplyUncertain(false);
    abortDownloads(); setRefreshNeeded(false);
    setPreview(null);
    setReviewed(false);
    setPage(0);
    setFilter("all");
    setError("");
  }
  function clearSource() {
    reset(); setCsv(''); setFileName(''); setWorkbookSource(null);
  }
  function clearWorkbook() {
    setWorkbookPending(false); setWorkbookSource(null); setWorkbookReset(value => value + 1);
  }
  function confirmReplace(text: string) { return !unfinished || window.confirm(text); }
  async function chooseFile(file: File | undefined) {
    if (!file || busyRef.current || applyUncertain || unresolvedAccess) return;
    if (file.size > 400000) {
      setError("Choose a CSV file no larger than 400 KB. Your current file and preview have been kept.");
      return;
    }
    const version = generation.current;
    setWorking(true);
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await file.arrayBuffer(),
      );
      if (!current(version)) return;
      if (!text.trim()) throw new Error("The file is empty.");
      if (!confirmReplace("Replace your current file and preview?")) return;
      reset();
      clearWorkbook();
      setCsv(text);
      setFileName(file.name);
      setWorking(false);
    } catch {
      if (current(version)) setError("Choose a nonempty UTF-8 CSV file and try again. Your current file and preview have been kept.");
    } finally {
      if (current(version)) setWorking(false);
    }
  }
  async function makePreview() {
    if (busyRef.current || applyUncertain || unresolvedAccess || workbookPending || !csv || !ready) return;
    const version = generation.current;
    setWorking(true);
    setError("");
    try {
      const result = await api("/school/imports/preview", { context, csv });
      if (!current(version)) return;
      setPreview(result);
      setKind(result.plan.context.kind);
      setSectionId(result.plan.context.sectionId ?? "");
      setReviewed(false);
      setPage(0);
      setFilter("all");
      await loadHistory();
      if (!current(version)) return;
      notify(
        result.plan.counts.errors
          ? "Review the row errors, correct your file, and upload it again."
          : "Preview ready. Review every proposed change before applying.",
        !!result.plan.counts.errors,
      );
    } catch (e) {
      if (current(version) && !accessDenied(e)) setError(message(e));
    } finally {
      if (current(version)) setWorking(false);
    }
  }
  async function apply() {
    if (busyRef.current || !canApply) return;
    const version = generation.current;
    const attempt = applyAttempt.current ?? { id: preview.id, kind: preview.plan.context.kind as SchoolImportKind, body: {
      sourceHash: preview.sourceHash, planHash: preview.planHash, reviewed: true as const,
    } };
    applyAttempt.current = attempt;
    const wasUncertain = applyUncertain;
    setWorking(true);
    setError("");
    try {
      const response = await api("/school/imports/" + attempt.id + "/apply", attempt.body);
      if (!current(version)) return;
      const result = checkedBatch(response, { id: attempt.id, kind: attempt.kind, unitId, sourceHash: attempt.body.sourceHash, planHash: attempt.body.planHash }, true);
      applyAttempt.current = null; unresolvedBatch.current = null; setUnresolvedAccess(false); setApplyUncertain(false); clearWorkbook();
      setPreview(result);
      setReviewed(false);
      setCsv("");
      setFileName('');
      onDirty(false);
      await loadHistory();
      if (!current(version)) return;
      notify("Import saved. The receipt and per-record history are available.");
      await refreshSaved(version);
    } catch (e) {
      if (!current(version) || accessDenied(e)) return;
      if (wasUncertain || !(e instanceof ApiError) || e.status >= 500 || e.status === 408 || e.status === 429) {
        setApplyUncertain(true);
        setError('The save response was not confirmed. This import may already be saved. Retry the same reviewed import to recover its receipt; do not upload it again.');
      } else {
        applyAttempt.current = null; setApplyUncertain(false); setError(message(e)); setReviewed(false);
      }
    } finally {
      if (current(version)) setWorking(false);
    }
  }
  async function openHistory(id: string) {
    if (busyRef.current || applyUncertain || unresolvedAccess) return;
    if (
      unfinished &&
      !window.confirm("Replace this file preview with a saved import?")
    )
      return;
    const version = generation.current;
    setWorking(true);
    setError("");
    try {
      const result = await api("/school/imports/" + id);
      if (!current(version)) return;
      clearWorkbook();
      setRefreshNeeded(false);
      setPreview(result);
      setKind(result.plan.context.kind);
      setSectionId(result.plan.context.sectionId ?? "");
      setCsv("");
      setFileName("");
      setReviewed(false);
      setPage(0);
      setFilter("all");
    } catch (e) {
      if (current(version) && !accessDenied(e)) setError(message(e));
    } finally {
      if (current(version)) setWorking(false);
    }
  }
  async function downloadImport(path: string, name: string) {
    if (busyRef.current) return;
    const version = generation.current;
    setWorking(true);
    const controller = new AbortController(); downloads.current.add(controller);
    try {
      const response = await fetch('/api' + path, { credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) {
        let detail = 'Download failed. Please try again.';
        try { const body = await response.json(); if (typeof body?.error === 'string') detail = body.error; } catch {}
        throw new ApiError(detail, response.status);
      }
      const blob = await response.blob();
      if (!current(version) || controller.signal.aborted) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = name; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    catch (e) { if (current(version) && !accessDenied(e)) setError(message(e)); }
    finally { downloads.current.delete(controller); if (current(version)) setWorking(false); }
  }
  async function refreshSaved(version = generation.current) {
    try { await onApplied(); if (current(version)) setRefreshNeeded(false); }
    catch (e) {
      if (current(version) && !accessDenied(e)) { setRefreshNeeded(true); notify('The import was saved, but the school view could not refresh: ' + message(e), true); }
    }
  }
  async function recoverEarlier() {
    if (busyRef.current || !unresolvedBatch.current) return;
    const version = generation.current; setWorking(true); setError('');
    try {
      const reference = unresolvedBatch.current;
      const response = await api('/school/imports/' + reference.id);
      if (!current(version)) return;
      const result = checkedBatch(response, { ...reference, unitId });
      setPreview(result); setKind(result.plan.context.kind); setSectionId(result.plan.context.kind === 'roster' ? result.plan.context.sectionId : '');
      setReviewed(false); setPage(0); setFilter('all'); setUnresolvedAccess(false);
      if (result.appliedAt) {
        unresolvedBatch.current = null; applyAttempt.current = null; setApplyUncertain(false);
        await loadHistory(); if (current(version)) await refreshSaved(version);
      } else {
        applyAttempt.current = { id: result.id, kind: reference.kind, body: { sourceHash: result.sourceHash, planHash: result.planHash, reviewed: true } };
        setApplyUncertain(true);
        setError('The earlier save is still unresolved. Retry the same reviewed import to recover its result. Do not create another batch.');
      }
    } catch (e) { if (current(version) && !accessDenied(e)) setError(message(e)); }
    finally { if (current(version)) setWorking(false); }
  }
  return (
    <div className="school-imports">
      <Panel
        title="Bring your school records together"
        detail="Download a template, review each change, then apply the whole batch."
      >
        <div className="school-import-body">
          {!preview && error && <p role="alert" className="import-error">{error}</p>}
          {unresolvedAccess && <div className="import-error" role="status"><p>An earlier import save is still unconfirmed. Losing access does not undo a save. Check its result after your access is restored; do not upload those records again.</p><button className="button" disabled={busy} onClick={() => void recoverEarlier()}>Check earlier import result</button></div>}
          <div className="import-steps" aria-label="Import steps">
            <span>
              <b>1</b> Choose a template
            </span>
            <span>
              <b>2</b> Review your records
            </span>
            <span>
              <b>3</b> Apply and keep a receipt
            </span>
          </div>
          <div className="import-template-grid">
            {schoolImportKinds.map((value) => (
              <button
                disabled={sourceLocked}
                key={value}
                className={
                  kind === value ? "import-template active" : "import-template"
                }
                aria-pressed={kind === value}
                onClick={() => {
                  if (value === kind) return;
                  if (
                    unfinished &&
                    !window.confirm(
                      "Discard this file and choose a different template?",
                    )
                  )
                    return;
                  setKind(value);
                  setCsv("");
                  setFileName("");
                  setSectionId("");
                  reset();
                  clearWorkbook();
                }}
              >
                <FileSpreadsheet size={23} />
                <strong>{schoolImportCatalog[value].title}</strong>
                <span>{schoolImportCatalog[value].detail}</span>
              </button>
            ))}
          </div>
          <div className="import-context">
            <Badge tone="outline">
              {peopleKind ? "Profile details · Selected school unit · CSV only" : familyKind ? "Exact IDs and versions · Selected school unit" : kind === "students"
                ? "New identities only"
                : (year?.name ?? "Choose a school year above")}
            </Badge>
            {kind === "roster" && (
              <label>
                Class
                <select
                  aria-label="Import class"
                  value={sectionId}
                  disabled={sourceLocked}
                  onChange={(e) => {
                    if ((workbookPending || workbookSource) && !confirmReplace('Discard this workbook and preview before changing the class?')) return;
                    if (workbookPending || workbookSource) { setCsv(''); setFileName(''); clearWorkbook(); }
                    setSectionId(e.target.value);
                    reset();
                  }}
                >
                  <option value="">Choose a class</option>
                  {classChoices.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <p>
            Use the headers in order. Keep student numbers as text to preserve
            leading zeros. Dates use <strong>YYYY-MM-DD</strong>. Maximum 500
            rows. CSV files allow 400 KB{workbookKind ? '; Excel workbooks allow 256 KiB' : ''}. No existing records are removed by an omitted row.
          </p>
          {peopleKind && <div className="import-family-guidance">
            <h3>Import profile details, with exact identities</h3>
            <p>Create a profile with a blank personId and version 0, or update an exact person ID and its current version. Names, email addresses and phone numbers never match or merge records. Student and admissions-applicant profiles use their own workflows.</p>
            <p>Enter a name on every row. For emailAction and phoneAction, choose keep, replace or clear. Keep and clear require a blank value; replace requires the new value. For a new profile, choose replace or clear, not keep.</p>
            <p>This CSV imports names and contact details only. It does not establish someone’s age, link households, create accounts, or grant guardian, communication or pickup permissions. Use the saved person IDs in the separate relationship workflows when needed.</p>
          </div>}
          {familyKind && <div className="import-family-guidance">
            <h3>Use recorded identities and confirmed permissions</h3>
            <p>Names, surnames and email addresses are never used to match families. Use the exact IDs and versions in the reference download. This import does not create parent accounts or send messages.</p>
            <p>Household membership, including a household role of guardian, grants no student communication or pickup permission. Student contact permissions are recorded separately.</p>
            {String(kind) === "households" && <p>To create a household, leave householdId blank and enter version 0. To update a household, use its exact ID and current version. Enter archived explicitly as true or false.</p>}
            {String(kind) === "household_members" && <p>Use existing household and person IDs with their current versions. Enter role as student, guardian or other, and remove explicitly as true or false. Removing membership does not remove the person's student contact permissions.</p>}
            {String(kind) === "contacts" && <>
              <p>Link an existing adult contact to an existing student using studentId, the exact student number and personId with their current versions. Enter isGuardian, canCommunicate and canPickup explicitly as true or false; blanks do not grant permission.</p>
              <p>For pickupUntilAction and restrictionNoteAction, choose keep, replace or clear. Keep and clear require a blank value; replace requires the new value. Record only permissions confirmed by the school. A recorded pickup permission does not establish identity or authorize a release by itself.</p>
              <p>A new pickup grant also needs an explicit duration: replace with the documented end date, or clear to record no expiry. Keep cannot establish the duration of a new pickup grant.</p>
            </>}
          </div>}
          <details className="import-column-guide"><summary>Template columns and expected values</summary><dl>{selected.columns.map(column => <div key={column}><dt><code>{column}</code></dt><dd>{fieldNames[column] ?? column}</dd></div>)}</dl></details>
          <div className="import-file-row">
            <button
              className="button"
              disabled={sourceLocked}
              onClick={() =>
                void downloadImport(
                  "/school/imports/template/" + kind + "?unitId=" + unitId,
                  "stjw-" + kind + "-template.csv",
                )
              }
            >
              <ArrowDownToLine size={17} />
              {peopleKind ? 'Download blank profile CSV' : 'Download blank CSV template'}
            </button>
            {(familyKind || peopleKind) && <>
              <button className="button" disabled={sourceLocked} onClick={() => void downloadImport("/school/imports/template/" + kind + "?unitId=" + unitId + "&populated=true", "stjw-" + kind + "-current-records.csv")}><ArrowDownToLine size={17}/>{peopleKind ? 'Download current profiles CSV' : 'Download current records CSV template'}</button>
              {familyKind && <button className="button" disabled={sourceLocked} onClick={() => void downloadImport("/school/imports/identities/export?unitId=" + unitId, "stjw-family-identity-references.csv")}><ArrowDownToLine size={17}/>Download identity references CSV</button>}
            </>}
            <label className="import-upload">
              Upload completed CSV
              <input
                aria-label="Upload school CSV"
                ref={csvInput}
                type="file"
                accept=".csv,text/csv"
                disabled={sourceLocked}
                onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; void chooseFile(file); }}
              />
            </label>
            <button
              className="button primary"
              disabled={sourceLocked || workbookPending || !csv || !ready}
              onClick={() => void makePreview()}
            >
              <Upload size={17} />
              {busy ? "Working…" : "Preview import"}
            </button>
          </div>
          {workbookKind && <WorkbookImport key={workbookKey} kind={workbookKind} unitId={unitId} disabled={sourceLocked || !ready}
            beforeReplace={() => confirmReplace('Replace your current file and preview with this workbook?')}
            onPending={setWorkbookPending} onClear={clearSource} onAccessDenied={clearAccess}
            onApply={(result, name) => {
              clearSource(); setCsv(result.csv); setFileName(name + ' · converted CSV'); setWorkbookSource(result);
            }} />}
          {fileName && (
            <p className="muted">
              Selected: {fileName} · {selected.title}
            </p>
          )}
        </div>
      </Panel>
      {preview && (
        <Panel
          title={
            preview.appliedAt ? "Import receipt" : "Review proposed changes"
          }
          detail={
            schoolImportCatalog[preview.plan.context.kind as SchoolImportKind]
              .title +
            " · " +
            (preview.plan.section?.name ??
              preview.plan.year?.name ??
              (preview.plan.context.kind === 'people' ? 'Person profiles' : ["students", "enrollments", "roster"].includes(preview.plan.context.kind) ? "Student directory" : "Families and contacts"))
          }
        >
          <div className="school-import-body">
            {error && <p role="alert" className="import-error">{error} {!preview.appliedAt && !applyUncertain && "If records changed after this preview, create a fresh preview before applying."}</p>}
            <div className="import-summary" aria-live="polite">
              {Object.entries(preview.plan.counts).map(([key, value]) => (
                <div key={key}>
                  <strong>{String(value)}</strong>
                  <span>
                    {key === "create"
                      ? "New"
                      : key === "update"
                        ? "Changes"
                        : key === "errors"
                          ? "Rows to fix"
                          : key === "unchanged"
                            ? "Unchanged"
                            : "Total rows"}
                  </span>
                </div>
              ))}
            </div>
            {preview.appliedAt ? (
              <p className="import-success">
                <CheckCircle2 size={19} />
                Saved {new Date(preview.appliedAt).toLocaleString()}. This
                receipt records the changes applied at that time.
              </p>
            ) : (
              <p>
                {applyUncertain ? 'A save result is unresolved. Retry this same import to find out whether it was saved.' : expired
                  ? "This preview has expired. Upload the file for a fresh preview."
                  : "Nothing has been applied. This preview expires " +
                    new Date(preview.expiresAt).toLocaleString() +
                    "."}{" "}
                {preview.plan.counts.errors > 0 &&
                  "Correct every row error before applying the batch."}
              </p>
            )}
            {preview.appliedAt && refreshNeeded && <div role="status" className="import-recheck"><span>Saved. The school directory still needs to refresh; the import will not be applied again.</span><button className="button" disabled={busy} onClick={() => { if (busyRef.current) return; const version = generation.current; setWorking(true); void refreshSaved(version).finally(() => { if (current(version)) setWorking(false); }); }}>Refresh school directory</button></div>}
            {preview.plan.roster && (
              <p>
                Final roster: peak of{" "}
                <strong>{preview.plan.roster.peak}</strong> students on the same
                day, capacity <strong>{preview.plan.roster.capacity}</strong>.
              </p>
            )}
            <label className="import-filter">
              Show rows
              <select
                aria-label="Filter import rows"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setPage(0);
                }}
              >
                <option value="all">All rows</option>
                <option value="error">Rows to fix</option>
                <option value="create">New records</option>
                <option value="update">Changes</option>
                <option value="unchanged">Unchanged</option>
              </select>
            </label>
            <div className="import-table-scroll">
              <table className="import-preview-table" role="table" aria-label="Import row review">
                <thead role="rowgroup">
                  <tr role="row">
                    <th scope="col">{workbookSource ? 'Source row' : 'CSV row'}</th>
                    <th scope="col">Recorded identity</th>
                    <th scope="col">Before</th>
                    <th scope="col">After</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {rows.slice(page * 25, (page + 1) * 25).map((row: any) => (
                    <tr key={row.row} role="row">
                      <td role="cell" data-label={workbookSource ? 'Source row' : 'CSV row'}>{workbookSource
                        ? <>Worksheet row {workbookSource.rowMap.find(item => item.csvRow === row.row)?.worksheetRow ?? 'Unavailable'}<small>Converted CSV row {row.row}</small></>
                        : row.row}</td>
                      <td role="cell" data-label="Recorded identity">
                        <strong>
                          {row.identity?.label ?? row.input.studentNumber ?? (preview.plan.context.kind === 'people' ? row.input.name || 'Missing profile identity' : "Missing identity")}
                        </strong>
                        <small>
                          {row.identity?.reference ?? row.student?.name ??
                            row.input.name ??
                            (preview.plan.context.kind === 'people' ? 'New profile' : "No matching student")}
                        </small>
                        {preview.plan.context.kind === 'people' && <>
                          <small>Source person ID: {row.source?.person?.id || row.input.personId || 'New profile'}</small>
                          <small>Reviewed version: {row.source?.person?.version ?? row.input.version}</small>
                          {row.input.emailAction && <small>Email: {shownValue('emailAction', row.input.emailAction)}</small>}
                          {row.input.phoneAction && <small>Phone: {shownValue('phoneAction', row.input.phoneAction)}</small>}
                          {preview.appliedAt && (() => {
                            const saved = preview.receipt?.records?.find((record: any) => record.row === row.row);
                            return saved ? <small className="import-saved-identity">Saved person ID: {saved.personId}<br/>Saved version: {saved.version}</small>
                              : row.action === 'unchanged' ? <small>No profile change; reviewed identity and version retained.</small>
                              : <small>Saved identity evidence is unavailable in this receipt.</small>;
                          })()}
                        </>}
                      </td>
                      <td role="cell" data-label="Before">
                        <Values value={row.before} />
                      </td>
                      <td role="cell" data-label="After">
                        <Values value={row.after} emptyLabel="No proposed values" actions={preview.plan.context.kind === 'people' ? row.input : undefined} />
                      </td>
                      <td role="cell" data-label="Result">
                        <Badge
                          tone={
                            row.errors.length
                              ? "warning"
                              : row.action === "unchanged"
                                ? "outline"
                                : "neutral"
                          }
                        >
                          {row.action === "error"
                            ? "Needs correction"
                            : row.action === "create"
                              ? "New"
                              : row.action === "update"
                                ? "Change"
                                : "Unchanged"}
                        </Badge>
                        {row.errors.map((error: string, index: number) => (
                          <p className="import-row-error" key={index}>
                            {error}
                          </p>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!rows.length && (
              <Empty
                title="No rows in this view"
                detail="Choose another row filter to continue reviewing."
              />
            )}
            <div className="import-pagination">
              <span>
                {rows.length
                  ? `${page * 25 + 1}–${Math.min((page + 1) * 25, rows.length)} of ${rows.length} rows`
                  : "0 rows"}
              </span>
              <button
                className="button"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous rows
              </button>
              <button
                className="button"
                disabled={(page + 1) * 25 >= rows.length}
                onClick={() => setPage((p) => p + 1)}
              >
                Next rows
              </button>
            </div>
            {!preview.appliedAt && (
              <div className="import-confirm">
                <label>
                  <input
                    type="checkbox"
                    checked={reviewed}
                    disabled={busy || applyUncertain || expired || preview.plan.counts.errors > 0}
                    onChange={(e) => setReviewed(e.target.checked)}
                  />
                  {preview.plan.context.kind === 'people' ? 'I reviewed the person IDs, versions and name, email and phone changes. This import does not grant student permissions.' : 'I reviewed all rows and the destination shown in this preview.'}
                </label>
                <button
                  className="button primary"
                  disabled={!canApply}
                  onClick={() => void apply()}
                >
                  {busy ? "Saving…" : applyUncertain ? 'Retry same reviewed import' : "Apply reviewed import"}
                </button>
              </div>
            )}
            {!preview.appliedAt && csv && <p className="import-recheck"><button className="button" disabled={sourceLocked || workbookPending || !ready} onClick={() => void makePreview()}>Recheck uploaded file</button><span>Creates a new preview using current records. It does not apply changes.</span></p>}
            <div className="import-receipt-actions">
              <button className="button" disabled={busy} onClick={() => void downloadImport("/school/imports/" + preview.id, "stjw-import-" + preview.id + ".json")}><ArrowDownToLine size={17}/>Download {preview.appliedAt ? "receipt" : "preview"} JSON</button>
              {preview.hasSource ? <button className="button" disabled={busy} onClick={() => void downloadImport("/school/imports/" + preview.id + "/source", "stjw-import-" + preview.id + "-source.txt")}><ArrowDownToLine size={17}/>Download retained CSV as text</button> : <p className="muted">The original source file was not retained for this earlier import. Its reviewed records and fingerprint remain available.</p>}
            </div>
            <details className="import-evidence">
              <summary>Import reference</summary>
              <p>Reference: {preview.id}</p>
              <p>File fingerprint: {preview.sourceHash}</p>
              <p>Preview fingerprint: {preview.planHash}</p>
              {workbookSource && <><p>Current worksheet: {workbookSource.sheetName} · header row {workbookSource.headerRow}</p><p>Current workbook fingerprint: {workbookSource.workbookHash}</p></>}
              <p>Receipts retain the imported CSV.{preview.plan.context.kind === 'people' ? ' New person IDs are recorded in the saved receipt; blank IDs in the original CSV stay blank. No household or student permissions are created.' : ' Original Excel files and worksheet mappings are not retained; keep your workbook separately.'}</p>
              <p>
                Private to your account. Your school-office access is checked
                again when you open or apply it.
              </p>
            </details>
          </div>
        </Panel>
      )}
      <Panel
        title="Your recent imports"
        detail="Your latest 50 previews and receipts in this school unit."
      >
        <div className="school-import-body">
          {historyError ? (
            <p role="alert">{historyError}</p>
          ) : history.length ? (
            <div className="import-history">
              {history.map((batch) => (
                <button
                  disabled={sourceLocked}
                  key={batch.id}
                  onClick={() => void openHistory(batch.id)}
                >
                  <FileSpreadsheet size={19} />
                  <span>
                    <strong>
                      {
                        schoolImportCatalog[
                          batch.context.kind as SchoolImportKind
                        ].title
                      }
                    </strong>
                    <small>
                      {new Date(batch.created_at).toLocaleString()} ·{" "}
                      {batch.counts.total} rows
                    </small>
                  </span>
                  <Badge tone={batch.applied_at ? "neutral" : "outline"}>
                    {batch.applied_at
                      ? "Applied"
                      : new Date(batch.expires_at).getTime() < Date.now()
                        ? "Expired"
                        : "Preview"}
                  </Badge>
                </button>
              ))}
            </div>
          ) : (
            <Empty
              title="Start with a template"
              detail="Your previews and applied import receipts will appear here."
            />
          )}
        </div>
      </Panel>
    </div>
  );
}
