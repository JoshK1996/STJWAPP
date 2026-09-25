import WorkforceImport from "./WorkforceImport";
import StaffCredentials, { TemporaryCredentialFields } from "./StaffCredentials";
import { EmployeeClockPolicy } from "./ScheduledClock";
import StaffImport from "./StaffImport";
import Compensation from "./Compensation";
import { JobManagement, JobForm } from "./JobManagement";
import {
  useEffect,
  useState,
  useCallback,
  useRef,
  lazy,
  Suspense,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { DateTime } from "luxon";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Church,
  Clock3,
  Coffee,
  FileBarChart2,
  FileClock,
  HeartHandshake,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Mail,
  GraduationCap,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { api, ApiError, setCsrf, download } from "./api";
import {
  Avatar,
  Badge,
  Empty,
  Modal,
  Panel,
  TextLink,
  shortName,
} from "./components";
import Auth from "./Auth";
import ClockCard from "./ClockCard";
import {ReadableWorkforceDuration} from './ExactWorkforceTime';
import {formatWorkforceDuration,workforceBarPercent,workforceChartScale} from '../shared/workforce-display';
import {workforceReportV2Schema,type WorkforceReportV2,type WorkforceBucketV2} from '../shared/workforce-reports-v2';
import Reports from "./Reports";
import WorkforceDashboard from "./WorkforceDashboard";
import Payroll from "./Payroll";
import "./workforce-shell.css";
import {WorkspaceTools,type TeamBoardState} from "./WorkspaceTools";
import "./experience-polish.css";
import Settings from "./Settings";
import { InstallEntry, InstallExperience, useInstallExperience } from './InstallExperience';
import { createUpdateMonitor, type UpdateState } from './pwa-runtime';
import { getPendingWriteCount, subscribePendingWrites } from './pending-writes';
import { updateBlockReason } from '../shared/update-safety';
const Calendar = lazy(() => import("./Calendar"));
const Messages = lazy(() => import("./Messages"));
const School = lazy(() => import("./School"));
const Care = lazy(() => import("./Care"));
const Dismissal = lazy(() => import("./Dismissal"));
const TimeRecords = lazy(() => import("./TimeRecords"));
import StaffSchedule from "./StaffSchedule";
import ScheduleRequests from "./ScheduleRequests";
import { normalizePreferences } from "../shared/preferences";
import { applyAppearance } from "./appearance";
import { WorkspaceArt, WorkspaceHero } from "./WorkspaceArt";
import "./accessibility.css";
import { MIN_PASSWORD_LENGTH, isOwnerRole } from "../shared/contracts";
import { staffCreateResultSchema } from "../shared/temporary-credentials";
import { organizationBrandingCurrentSchema, unconfiguredBrandingSettings } from '../shared/organization-branding';
import type { BrandingState } from './OrganizationBranding';
type Page =
  | "overview"
  | "clock"
  | "time-records"
  | "payroll"
  | "staff"
  | "schedule"
  | "calendar"
  | "messages"
  | "school"
  | "care"
  | "dismissal"
  | "requests"
  | "reports"
  | "audit"
  | "workspace"
  | "settings";
const zone = "America/New_York";
const day = () => DateTime.now().setZone(zone);
const nav = [
  ["overview", "Overview", LayoutDashboard],
  ["clock", "My time clock", Clock3],
  ["time-records", "Time records", History],
  ["payroll", "Payroll", Wallet],
  ["staff", "People & jobs", Users],
  ["schedule", "Schedule", CalendarDays],
  ["calendar", "Calendar", CalendarDays],
  ["messages", "Messages", Mail],
  ["requests", "Requests", FileClock],
  ["reports", "Reports & imports", FileBarChart2],
] as const;
const organizationNav = [
  ["school", "School records", GraduationCap],
  ["care", "Childcare", HeartHandshake],
  ["dismissal", "Dismissal", ShieldCheck],
  ["workspace", "School & community", BookOpen],
  ["audit", "Activity log", ShieldCheck],
  ["settings", "Settings", Settings2],
] as const;
const dateText = (value: string) =>
  DateTime.fromISO(value).setZone(zone).toFormat("LLL d, h:mm a");
const dateOnly = (value: string) => value.slice(0, 10);
export default function App() {
  const installExperience = useInstallExperience();
  const [appUpdate, setAppUpdate] = useState<UpdateState>({ available: false, checking: false, error: null, latestVersion: null });
  const updateMonitor = useRef<ReturnType<typeof createUpdateMonitor> | null>(null);
  const pendingWrites = useSyncExternalStore(subscribePendingWrites, getPendingWriteCount, getPendingWriteCount);
  useEffect(() => {
    const monitor = createUpdateMonitor({ onChange: setAppUpdate });
    updateMonitor.current = monitor;
    return () => { monitor.dispose(); updateMonitor.current = null; };
  }, []);
  const sessionEpoch = useRef(0);
  const workspaceEpoch = sessionEpoch.current;
  const sidebarRef = useRef<HTMLElement>(null), navigationToggleRef = useRef<HTMLButtonElement>(null), mainRef = useRef<HTMLElement>(null);
  const focusDestination = useRef(false);
  const [smallScreen, setSmallScreen] = useState(() => matchMedia("(max-width: 720px)").matches);
  const [compactClock, setCompactClock] = useState(() => matchMedia("(max-width: 720px), (max-width: 1024px) and (max-height: 500px)").matches);
  const [unsavedChanges, setUnsavedChanges] = useState(false);
  const [showPersonalCards, setShowPersonalCards] = useState(false);
  const [moreTools, setMoreTools] = useState(false);
  const [staffTool, setStaffTool] = useState<{kind: "rates"|"credentials"|"clock"|"import"|"jobs-import"|"schedules-import"; person?: any}|null>(null);
  const [boardState,setBoardState]=useState<TeamBoardState>({receivedAt:null,unavailable:false});
  const [clockPending, setClockPending] = useState(false);
  const clockPendingRef = useRef(false);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (unsavedChanges || clockPending) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [unsavedChanges, clockPending]);
  const [me, setMe] = useState<any>(null),
    [loading, setLoading] = useState(true),
    [page, setPage] = useState<Page>("overview"),
    [mobile, setMobile] = useState(false);
  const [branding, setBranding] = useState<BrandingState>({ status: 'loading', current: null, error: '' });
  const brandingGeneration = useRef(0), brandingAbort = useRef<AbortController | null>(null);
  const settingsRefreshGeneration = useRef(0);
  const [clock, setClock] = useState<any>(null),
    [reportResult, setReport] = useState<WorkforceReportV2|null>(null),
    [board, setBoard] = useState<any[]>([]),
    [staff, setStaff] = useState<any[]>([]),
    [jobs, setJobs] = useState<any[]>([]),
    [requests, setRequests] = useState<any[]>([]),
    [schedules, setSchedules] = useState<any[]>([]),
    [audit, setAudit] = useState<any[]>([]);
  const [scope, setScope] = useState(""),
    [search, setSearch] = useState(""),
    [includeInactiveStaff, setIncludeInactiveStaff] = useState(false),
    [toast, setToast] = useState<{ text: string; error: boolean } | null>(null),
    [dialog, setDialog] = useState<any>(null),
    [dialogError, setDialogError] = useState(""),
    [busy, setBusy] = useState(false),
    [privateLink, setPrivateLink] = useState("");
  useEffect(() => { setDialogError(""); }, [dialog]);
  const reportGeneration = useRef(0), currentReportScope = useRef(scope);
  currentReportScope.current = scope;
  const [reportState,setReportState] = useState<{scope:string;status:'loading'|'unavailable'}>({scope:'',status:'loading'});
  const report = reportResult?.query.unitId === (scope || undefined) ? reportResult : null;
  const reportPlaceholder = <span className="exact-workforce-loading" role="status">{reportState.scope === scope && reportState.status === 'unavailable' ? 'Time report unavailable' : 'Loading recorded time…'}</span>;
  const [scheduleWeek, setScheduleWeek] = useState(
    day().startOf("week").toISODate()!,
  );
  const [scheduleRequestTarget, setScheduleRequestTarget] = useState<{ scheduleId?: string; requestId?: string } | null>(null);
  useEffect(() => { if (page !== "requests") setScheduleRequestTarget(null); }, [page]);
  useEffect(() => {
    const clockMedia = matchMedia("(max-width: 720px), (max-width: 1024px) and (max-height: 500px)");
    const updateClock = () => setCompactClock(clockMedia.matches);
    clockMedia.addEventListener("change", updateClock);
    const media = matchMedia("(max-width: 720px)");
    const update = () => { setSmallScreen(media.matches); if (!media.matches) setMobile(false); };
    media.addEventListener("change", update);
    return () => { media.removeEventListener("change", update); clockMedia.removeEventListener("change", updateClock); };
  }, []);
  useEffect(() => {
    if (focusDestination.current) { focusDestination.current = false; mainRef.current?.focus({ preventScroll: true }); }
  }, [page]);
  useEffect(() => {
    if (!smallScreen || !mobile || !me) return;
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const controls = () => Array.from(sidebar.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,[tabindex]'))
      .filter(element => element.tabIndex >= 0 && !element.matches(":disabled") && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
    controls()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setMobile(false); }
      if (event.key !== "Tab") return;
      const choices = controls(), first = choices[0], last = choices.at(-1);
      if (!first || !last) { event.preventDefault(); sidebar.focus(); return; }
      if (!sidebar.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      queueMicrotask(() => {
        if (document.activeElement !== document.body && !sidebar.contains(document.activeElement)) return;
        const target = matchMedia("(max-width: 720px)").matches ? navigationToggleRef.current : mainRef.current;
        if (target?.isConnected) target.focus({ preventScroll: true });
      });
    };
  }, [smallScreen, mobile, me?.actor.id]);
  const [setupToken, setSetupToken] = useState(() => {
    const match = location.hash.match(/^#setup=([A-Za-z0-9_-]{32,100})$/);
    if (match) history.replaceState(null, "", location.pathname);
    return match?.[1] ?? "";
  });
  const clearWorkspace = useCallback((expectedEpoch: number) => {
    if (sessionEpoch.current !== expectedEpoch) return;
    sessionEpoch.current += 1;
    setCsrf("");
    setMe(null); setClock(null); setReport(null);
    brandingGeneration.current++; brandingAbort.current?.abort(); brandingAbort.current = null;
    settingsRefreshGeneration.current++;
    setBranding({ status: 'loading', current: null, error: '' });
    reportGeneration.current += 1; setReportState({scope:'',status:'loading'});
    setStaff([]); setBoard([]); setBoardState({receivedAt:null,unavailable:false}); setRequests([]); setJobs([]); setSchedules([]); setAudit([]);
    setDialog(null); setStaffTool(null); setMoreTools(false); setPrivateLink(""); setScheduleRequestTarget(null);
    setUnsavedChanges(false); setBusy(false); setToast(null); setMobile(false);
    clockPendingRef.current = false; setClockPending(false);
    setScope(""); setSearch(""); setIncludeInactiveStaff(false);
    setScheduleWeek(day().startOf("week").toISODate()!);
    setPage("overview"); setSetupToken(""); setLoading(false);
    focusDestination.current = false;
  }, []);
  const sessionExpired = useCallback(() => clearWorkspace(workspaceEpoch), [clearWorkspace, workspaceEpoch]);
  const isSessionCurrent = useCallback(() => sessionEpoch.current === workspaceEpoch, [workspaceEpoch]);
  const reloadBranding = useCallback(async () => {
    if (!me || me.actor.mode === 'pin' || sessionEpoch.current !== workspaceEpoch) return null;
    const generation = ++brandingGeneration.current;
    brandingAbort.current?.abort(); const controller = new AbortController(); brandingAbort.current = controller;
    const owns = () => sessionEpoch.current === workspaceEpoch && brandingGeneration.current === generation;
    setBranding({ status: 'loading', current: null, error: '' });
    try {
      const current = organizationBrandingCurrentSchema.parse(await api('/organization/branding', undefined, 'GET', controller.signal));
      if (!owns()) return null;
      setBranding({ status: 'ready', current, error: '' }); return current;
    } catch (error) {
      if (!owns()) return null;
      if (error instanceof ApiError && [401, 403].includes(error.status)) sessionExpired();
      else setBranding({ status: 'unavailable', current: null, error: error instanceof ApiError ? error.message : 'Organization style could not be loaded. Retry when the connection is ready.' });
      throw error;
    }
  }, [me?.actor.id, me?.actor.mode, workspaceEpoch, sessionExpired]);
  useEffect(() => {
    if (me && me.actor.mode !== 'pin') void reloadBranding().catch(() => {});
    return () => { brandingGeneration.current++; brandingAbort.current?.abort(); };
  }, [reloadBranding]);
  const workspaceDirty = useCallback((value: boolean) => {
    if (sessionEpoch.current === workspaceEpoch) setUnsavedChanges(value);
  }, [workspaceEpoch]);
  const clockPendingChanged = useCallback((pending: boolean) => {
    if (sessionEpoch.current !== workspaceEpoch) return;
    clockPendingRef.current = pending; setClockPending(pending);
  }, [workspaceEpoch]);
  const notify = useCallback(
    (text: string, error = false) => {
      if (sessionEpoch.current === workspaceEpoch) setToast({ text, error });
    },
    [workspaceEpoch],
  );
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 7000);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  async function loadMe() {
    const epoch = ++sessionEpoch.current;
    try {
      const data = await api("/me");
      if (sessionEpoch.current !== epoch) return;
      setCsrf(data.actor.csrf);
      setMe(data);
      setPage(
        data.actor.mode === "pin" || matchMedia("(max-width: 720px), (pointer: coarse)").matches
          ? "clock"
          : (data.actor.preferences?.home ?? "overview"),
      );
    } catch {
      clearWorkspace(epoch);
    } finally {
      if (sessionEpoch.current === epoch) setLoading(false);
    }
  }
  useEffect(() => {
    if (setupToken) setLoading(false);
    else void loadMe();
  }, []);
  useEffect(() => {
    if (me) window.scrollTo({ top: 0, behavior: "instant" });
  }, [me?.actor.id, me?.actor.mode]);
  const refresh = useCallback(async () => {
    if (!me || sessionEpoch.current !== workspaceEpoch) return;
    const reportRun = currentReportScope.current === scope ? ++reportGeneration.current : null;
    const ownsReport = () => reportRun !== null && reportGeneration.current === reportRun && currentReportScope.current === scope && sessionEpoch.current === workspaceEpoch;
    if (me.actor.mode !== 'pin' && ownsReport()) {setReport(null);setReportState({scope,status:'loading'});}
    try {
    const state = await api("/clock");
    if (sessionEpoch.current !== workspaceEpoch) return;
    setClock(state);
    if (me.actor.mode === "pin") return;
    const reportToday=DateTime.now().setZone(me.organization.timezone);
    const start = reportToday.startOf("week").toISODate(),
      end = reportToday.toISODate();
    const scheduleStart = DateTime.fromISO(scheduleWeek, { zone });
    const common = await Promise.all([
      api(
        `/reports/v2?start=${start}&end=${end}&group=day${scope ? "&unitId=" + scope : ""}`,
      ).then(value=>workforceReportV2Schema.parse(value)),
      api("/requests"),
      api("/jobs"),
      api(
        `/schedules?start=${encodeURIComponent(scheduleStart.toUTC().toISO()!)}&end=${encodeURIComponent(scheduleStart.plus({ days: 7 }).toUTC().toISO()!)}&includeCancelled=true`,
      ),
    ]);
    if (sessionEpoch.current !== workspaceEpoch) return;
    if (ownsReport()) setReport(common[0]);
    setRequests(common[1].rows);
    setJobs(common[2].rows);
    setSchedules(common[3].rows);
    if (me.permissions.report) {
      const privileged = await Promise.all([api("/board"), api("/staff")]);
      if (sessionEpoch.current !== workspaceEpoch) return;
      if(ownsReport()){setBoard(privileged[0].rows);setBoardState({receivedAt:new Date().toISOString(),unavailable:false,asOf:privileged[0].asOf});}
      setStaff(privileged[1].rows);
    }
    } catch (error) {
      if (sessionEpoch.current !== workspaceEpoch) return;
      if (ownsReport()) {setReport(null);setReportState({scope,status:'unavailable'});setBoard([]);setBoardState({receivedAt:null,unavailable:true});}
      if (error instanceof ApiError && error.status === 401) sessionExpired();
      else throw error;
    }
  }, [me, scope, scheduleWeek, workspaceEpoch, sessionExpired]);
  useEffect(() => {
    void refresh().catch((e) => notify(e.message, true));
    const timer = setInterval(() => {
      void refresh().catch((e) => notify(e.message, true));
    }, 30000);
    return () => clearInterval(timer);
  }, [refresh, notify]);
  useEffect(() => {
    if (page === "audit")
      void api("/audit")
        .then((x) => { if (sessionEpoch.current === workspaceEpoch) setAudit(x.rows); })
        .catch((e) => notify(e.message, true));
  }, [page, notify, workspaceEpoch]);
  const preferences = normalizePreferences(me?.actor.preferences);
  useEffect(() => {
    // The mounted personal editor owns its unsaved preview. Reapplying saved
    // preferences on an unrelated account refresh would overwrite that preview.
    if (me && me.actor.mode !== 'pin' && page === 'settings') return;
    const current = normalizePreferences(me?.actor.preferences);
    applyAppearance(current);
    const system = matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyAppearance(current);
    system.addEventListener("change", update);
    return () => system.removeEventListener("change", update);
  }, [me, page]);
  async function run(fn: () => Promise<void>) {
    if (busy || sessionEpoch.current !== workspaceEpoch) return;
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      if (sessionEpoch.current !== workspaceEpoch) return;
      if (dialog) setDialogError((error as Error).message);
      notify((error as Error).message, true);
    } finally {
      if (sessionEpoch.current === workspaceEpoch) setBusy(false);
    }
  }
  function reloadForUpdate(): string | void {
    // Recheck at the click boundary; an action may have begun since the last render.
    const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('form input,form textarea,form select'));
    const formHasChanges = controls.some(control => {
      if (control instanceof HTMLInputElement) {
        if (['hidden', 'submit', 'button', 'reset'].includes(control.type)) return false;
        if (['checkbox', 'radio'].includes(control.type)) return control.checked !== control.defaultChecked;
        return control.closest('.auth-layout') ? control.value !== '' : control.value !== control.defaultValue;
      }
      if (control instanceof HTMLTextAreaElement) return control.value !== control.defaultValue;
      const defaults = Array.from(control.options).filter(option => option.defaultSelected);
      const expected = defaults.length ? defaults.map(option => option.value) : control.multiple ? [] : [control.options[0]?.value];
      return JSON.stringify(Array.from(control.selectedOptions).map(option => option.value)) !== JSON.stringify(expected);
    });
    const workflowOpen = Array.from(document.querySelectorAll('dialog[open],[aria-modal="true"]')).some(dialog => !dialog.querySelector('.install-guide'));
    const reason = updateBlockReason({ pendingWrites: getPendingWriteCount(), clockPending: clockPendingRef.current, unsavedChanges, busy, workflowOpen, formHasChanges, accountSetup: Boolean(document.querySelector('.auth-layout[data-account-workflow="true"]')) });
    if (reason) return reason;
    if (!navigator.onLine) return 'Reconnect to the internet before updating.';
    if (!appUpdate.available) return 'Check for updates again before reloading.';
    window.location.reload();
  }
  const updateNotice = <InstallExperience compact={Boolean(me && compactClock && page === "clock")} experience={installExperience} update={appUpdate} onReload={reloadForUpdate} onCheckForUpdate={() => { void updateMonitor.current?.check(); }} reloadBlockedReason={updateBlockReason({ pendingWrites, clockPending, unsavedChanges, busy, workflowOpen: false, formHasChanges: false, accountSetup: false })} />;
  function go(next: Page) {
    if (next === page) { if (mobile) setMobile(false); return true; }
    if (clockPendingRef.current) {
      notify("Resolve the clock request using Retry or Refresh before leaving this screen.", true);
      return false;
    }
    if (
      unsavedChanges &&
      !window.confirm("Discard unsaved changes?")
    )
      return false;
    setUnsavedChanges(false);
    focusDestination.current = document.activeElement?.tagName === "BUTTON";
    setPage(next);
    setMobile(false);
    setSearch("");
    window.scrollTo({ top: 0, behavior: "instant" });
    return true;
  }
  const scopedBoard = board.filter((x) => !scope || x.unit_id === scope);
  const pending = requests.filter((x) => x.status === "pending");
  const scopedPending = pending.filter((x) => !scope || x.unit_id === scope);
  const scopedSchedules = schedules.filter(
    (x) => x.status !== "cancelled" && (!scope || x.unit_id === scope),
  );
  const includedStaff = staff.filter((person) => includeInactiveStaff || person.active);
  const visibleStaff = includedStaff.filter((person) =>
    `${person.name} ${person.email} ${person.role}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const canManagePerson = (person: any) => me?.permissions.manage && person.id !== me.actor.id &&
    (me.actor.role === 'developer' || (me.actor.role === 'owner' && !['developer','owner'].includes(person.role)) ||
     (me.actor.role === 'admin' && !['developer','owner','admin'].includes(person.role)) ||
     (me.actor.role === 'manager' && person.role === 'employee' && person.unit_ids.every((id: string) => me.actor.unit_ids.includes(id))));
  function closeStaffTool() {
    if (pendingWrites > 0) return;
    if (unsavedChanges && !window.confirm('Discard unsaved changes in this editor?')) return;
    setStaffTool(null); setUnsavedChanges(false);
  }
  function closeManagementDialog() {
    if (busy) return;
    if (unsavedChanges && !window.confirm("Discard the changes in this editor?")) return;
    setDialog(null); setDialogError(""); setUnsavedChanges(false);
  }
  async function reloadManagementDialog() {
    if (busy || !dialog) return;
    if (unsavedChanges && !window.confirm("Replace your unsaved fields with the latest saved values?")) return;
    await run(async () => {
      const kind = dialog.job ? "job" : dialog.staff ? "staff" : "request";
      const collection = kind === "job" ? "jobs" : kind === "staff" ? "staff" : "requests";
      const result = await api(`/${collection}`);
      if (sessionEpoch.current !== workspaceEpoch) return;
      const saved = result.rows.find((row: any) => row.id === dialog[kind].id);
      if (!saved) throw new Error("This record is no longer available. Close the editor and refresh the workspace.");
      if (kind === "job") setJobs(result.rows);
      if (kind === "staff") setStaff(result.rows);
      if (kind === "request") setRequests(result.rows);
      if (kind === "request" && saved.status !== "pending") throw new Error("This request has already been reviewed or withdrawn. Close this editor and view its recorded decision.");
      setDialog({ ...dialog, [kind]: saved, reloadKey: (dialog.reloadKey ?? 0) + 1 }); setUnsavedChanges(false); setDialogError("");
    });
  }
  async function submitDialog(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await run(async () => {
      if (dialog.type === "staff") {
        const input = {
          name: form.get("name"),
          email: form.get("email"),
          role: form.get("role"),
          unitIds: form.getAll("unitIds"),
          jobIds: form.getAll("jobIds"),
        };
        if (dialog.staff) {
          await api(
            `/staff/${dialog.staff.id}`,
            { ...input, active: form.get("active") === "on" },
            "PATCH",
          );
          notify("Staff account updated. Existing sessions were signed out.");
        } else {
          const temporary = form.get("onboarding") === "temporary";
          if (temporary && (form.get('temporaryPassword') !== form.get('temporaryPasswordConfirmation') || form.get('temporaryPin') !== form.get('temporaryPinConfirmation'))) throw new Error('The confirmation fields must match.');
          const result = staffCreateResultSchema.parse(await api("/staff", {
            ...input, ...(temporary ? { initialCredentials: { password: form.get("temporaryPassword"), pin: form.get("temporaryPin") } } : {}),
          }));
          if (sessionEpoch.current !== workspaceEpoch) return;
          if ("setupUrl" in result) {
            setPrivateLink(result.setupUrl);
            notify("Account created. Share the private setup link with the employee.");
          } else {
            setPrivateLink("");
            notify("Account created. The employee must replace the temporary password and PIN at first sign-in.");
          }
        }
      } else if (dialog.type === "job") {
        const input = { unitId: form.get("unitId"), title: form.get("title"), description: form.get("description") };
        if (dialog.job) {
          await api(`/jobs/${dialog.job.id}`, { ...input, active: form.get("active") === "on", expectedVersion: dialog.job.version, reason: form.get("reason") }, "PATCH");
          notify("Job updated. Historical time records and change history are retained.");
        } else {
          await api("/jobs", input);
          notify("Job created. Assign it to staff from their account.");
        }
      } else if (dialog.type === "request") {
        const input = { kind: form.get("kind"), unitId: form.get("unitId"), startsOn: form.get("startsOn"), endsOn: form.get("endsOn"), note: form.get("note") };
        await api(dialog.request ? `/requests/${dialog.request.id}` : "/requests", { ...input, ...(dialog.request ? { expectedVersion: dialog.request.version } : {}) }, dialog.request ? "PATCH" : "POST");
        notify(dialog.request ? "Your pending request was updated." : "Your request is ready for review.");
      } else if (dialog.type === "withdraw") {
        await api(`/requests/${dialog.request.id}/withdraw`, { expectedVersion: dialog.request.version, reason: form.get("reason") });
        notify("Request withdrawn. Its history is retained.");
      } else if (dialog.type === "review") {
        await api(`/requests/${dialog.request.id}/review`, {
          expectedVersion: dialog.request.version,
          status: form.get("status"),
          note: form.get("note"),
        });
        notify(
          "Decision recorded. Approved requests do not automatically alter time records or payroll.",
        );
      }
      if (sessionEpoch.current !== workspaceEpoch) return;
      setDialog(null);
      setUnsavedChanges(false);
      await refresh();
    });
  }
  if (loading)
    return (
      <div className="loading">
        <Church />
        <p>Opening your workspace…</p>
      </div>
    );
  if (!me)
    return (
      <>
      <Auth
        setupToken={setupToken}
        appEntry={<InstallEntry experience={installExperience} />}
        onSignedIn={() => {
          setSetupToken("");
          void loadMe();
        }}
      />
      {updateNotice}
      </>
    );
  const firstName = me.actor.name.split(" ")[0];
  const workspaceIdentity = me.actor.mode !== 'pin' && branding.status === 'ready' && branding.current ? branding.current.settings : unconfiguredBrandingSettings;
  const title = (
    {
      overview: `Good ${day().hour < 12 ? "morning" : day().hour < 17 ? "afternoon" : "evening"}, ${firstName}.`,
      clock: "Your time. All in one place.",
      "time-records": "Every hour, with its history.",
      payroll: "Your payroll workspace.",
      staff: "The people behind our community.",
      schedule: "A clear view of the week.",
      calendar: "Bring your days together.",
      messages: "Keep the conversation close.",
      school: "A connected school day.",
      care: "Every arrival. Every handoff.",
      dismissal: "Every child has a next stop.",
      requests: "A little planning goes a long way.",
      reports: "The details, beautifully clear.",
      audit: "Every change has a story.",
      workspace: "One community. Room to grow.",
      settings: "Make this space yours.",
    } as const
  )[page];
  const subtitles = {
    school: "Students, families, classrooms and the people who support them.",
    care: "Care programs, verified pickups, and a clear record of time together.",
    dismissal: "Observed arrivals, reviewed plans, and accountable school handoffs.",
    calendar: "Personal plans and shared events, across your community.",
    messages: "Reach your colleagues, save a draft, and keep track of replies.",
    overview: "Here’s what’s happening across your community today.",
    clock: "Clock in, take a break, or move seamlessly between your jobs.",
    "time-records":
      "Review recorded shifts and resolve corrections with a clear approval trail.",
    payroll: "Understand the hours, review the details, and prepare your accountant’s exports.",
    staff:
      "Manage accounts, responsibilities, and the work each person can access.",
    schedule:
      "Coordinate people and jobs across your school, early childhood program, and parish.",
    requests:
      "Time off, schedule changes, and corrections—with a clear review history.",
    reports:
      "Explore recorded hours, choose your columns, and take your data with you.",
    audit:
      "A chronological record of account, timekeeping, and administrative actions.",
    workspace:
      "A connected foundation, with a deliberate path to your complete school system.",
    settings:
      "Personal preferences, account security, and tools for connected workflows.",
  };
  const toastNotice = toast && (
        <div
          role={toast.error ? "alert" : "status"}
          className={`toast ${toast.error ? "is-error" : ""}${compactClock && page === "clock" ? " clock-inline-notice" : ""}`}
        >
          {toast.error ? <X size={19} /> : <Check size={19} />}
          <span>{toast.text}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            <X size={16} />
          </button>
        </div>
      );
  const workforceNavigation = me.actor.mode !== "pin" && me.permissions.report && ["overview","clock","time-records","payroll"].includes(page) && <nav className="workforce-workflow-nav" aria-label="Workforce workspace">
            <button className={page === "overview" ? "active" : ""} onClick={() => go("overview")}><LayoutDashboard size={18}/><span>Workforce overview</span></button>
            <button className={page === "clock" ? "active" : ""} onClick={() => go("clock")}><Clock3 size={18}/><span>My time clock</span></button>
            <button className={page === "time-records" ? "active" : ""} onClick={() => go("time-records")}><History size={18}/><span>Time records</span></button>
            <button className={page === "payroll" ? "active" : ""} onClick={() => go("payroll")}><Wallet size={18}/><span>Payroll</span></button>
          </nav>;
  return (
    <div className="app-shell" data-page={page}>
      {!(smallScreen && mobile) && <a className="workspace-skip" href="#workspace-main" onClick={event => { event.preventDefault(); mainRef.current?.focus(); }}>Skip to main content</a>}
      {smallScreen && mobile && (
        <div
          className="sidebar-backdrop"
          aria-hidden="true"
          onClick={() => setMobile(false)}
        />
      )}
      <aside ref={sidebarRef} id="workspace-navigation" className={`sidebar ${mobile ? "open" : ""}`} inert={smallScreen && !mobile}
        role={smallScreen && mobile ? "dialog" : undefined} aria-modal={smallScreen && mobile ? true : undefined} aria-label="Workspace navigation" tabIndex={-1}>
        {smallScreen && <button className="icon-button navigation-close" aria-label="Close navigation" onClick={() => setMobile(false)}><X size={20}/></button>}
        <button
          className="brand"
          aria-label={`${workspaceIdentity.shortName} overview`}
          title={`${workspaceIdentity.shortName} overview`}
          onClick={() => go("overview")}
        >
          <span className="brand-mark">
            <Church size={24} />
          </span>
          <span className="workspace-brand-name">
            <strong>
              {workspaceIdentity.shortName}<span className="brand-dot">.</span>
            </strong>
            <small>COMMUNITY WORKSPACE</small>
          </span>
        </button>
        <div className="org-label">
          <span className="org-icon">
            <HeartHandshake size={19} />
          </span>
          <span className="workspace-identity" title={[workspaceIdentity.displayName, workspaceIdentity.subtitle].filter(Boolean).join(' · ')}>
            <span>{workspaceIdentity.displayName}</span><small>{workspaceIdentity.subtitle}</small>
          </span>
        </div>
        <span className="nav-label">YOUR WORKSPACE</span>
        <nav aria-label="Main navigation">
          {nav
            .filter(
              ([id]) =>
                !(me.actor.mode === "pin" && id !== "clock") &&
                (moreTools || !["calendar", "messages", "reports"].includes(id) || page === id) &&
                 !(["staff", "payroll"].includes(id) && !me.permissions.report),
             )
            .sort((a, b) => preferences.workspaceNavOrder.indexOf(a[0]) - preferences.workspaceNavOrder.indexOf(b[0]))
             .map(([id, label, Icon]) => (
              <button
                key={id}
                aria-label={label}
                title={label}
                onClick={() => go(id)}
                className={page === id ? "active" : ""}
                aria-current={page === id ? "page" : undefined}
              >
                <Icon size={19} />
                <span>{label}</span>
                {id === "requests" && pending.length > 0 && (
                  <span className="nav-count">{pending.length}</span>
                )}
                {page === id && <span className="nav-active-dot" />}
              </button>
            ))}
        </nav>
        {me.actor.mode !== "pin" && (
          <>
            <nav aria-label="Additional tools"><button onClick={() => setMoreTools(value => !value)} aria-expanded={moreTools}><MoreHorizontal size={19}/><span>{moreTools ? "Fewer tools" : "More tools"}</span><ChevronDown size={16}/></button></nav>
            <nav aria-label="Organization navigation">
              {organizationNav
                .filter(([id]) => (moreTools || id === "settings" || page === id) && (id !== "audit" || ["developer", "owner", "admin", "finance"].includes(me.actor.role)))
                .sort((a, b) => preferences.organizationNavOrder.indexOf(a[0]) - preferences.organizationNavOrder.indexOf(b[0]))
                .map(([id, label, Icon]) => (
                <button
                  key={id}
                  aria-label={label}
                  title={label}
                  onClick={() => go(id)}
                  className={page === id ? "active" : ""}
                  aria-current={page === id ? "page" : undefined}
                >
                  <Icon size={19} />
                  <span>{label}</span>
                  {id === "workspace" && <span className="soon-dot" />}
                </button>
              ))}
            </nav>

          </>
        )}
        <div className="profile">
          <Avatar name={me.actor.name} />
          <button
            onClick={() => go("settings")}
            disabled={me.actor.mode === "pin"}
          >
            <strong>{me.actor.name}</strong>
            <small>
              {me.actor.mode === "pin" ? `${me.actor.role} · clock session` : me.actor.role === "developer" ? "Developer · full access" : me.actor.role}
            </small>
          </button>
          <button
            aria-label="Sign out"
            className="icon-button"
            onClick={() =>
              void run(async () => {
                const warning = clockPendingRef.current
                  ? `Your clock request may already be recorded. ${unsavedChanges ? "Other unsaved changes will be discarded. " : ""}Sign out and check your clock after signing in again?`
                  : unsavedChanges ? "Discard unsaved changes and sign out?" : "";
                if (warning && !window.confirm(warning)) return;
                try { await api("/auth/logout", {}); }
                catch (error) {
                  if (!(error instanceof ApiError && error.status === 401)) throw error;
                }
                clearWorkspace(workspaceEpoch);
              })
            }
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <div className="workspace" inert={smallScreen && mobile}>
        <header className="topbar">
          <div className="breadcrumb">
            <button
              ref={navigationToggleRef}
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              aria-controls="workspace-navigation"
              aria-expanded={smallScreen && mobile}
              onClick={() => setMobile(true)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong className="breadcrumb-current">
              {nav.find((x) => x[0] === page)?.[1] ??
                (
                  {
                    workspace: "School & community",
                    school: "School records",
                    care: "Childcare",
                    dismissal: "Dismissal",
                    "time-records": "Time records",
                    audit: "Activity log",
                    settings: "Settings",
                  } as any
                )[page]}
            </strong>
            {page !== "clock" && <button type="button" className="mobile-clock-shortcut" aria-label="Open my time clock" onClick={() => go("clock")}><Clock3 size={18}/><span>Clock</span></button>}
          </div>
          <div className="top-actions">
            <WorkspaceTools key={`${me.actor.org_id}:${me.actor.id}:${me.actor.mode}`} me={me} onNavigate={go}/>
            <InstallEntry experience={installExperience} compact />
            {me.permissions.report && (
              <label className="search">
                <Search size={16} />
                <input
                  aria-label="Find a staff member"
                  placeholder="Find a person…"
                  value={search}
                  onChange={(e) => {
                    if (!go("staff")) return;
                    setSearch(e.target.value);
                  }}
                />
                <span>⌕</span>
              </label>
            )}
            <span className="top-divider" />
            <button
              className="icon-button notification"
              aria-label={`${pending.length} pending requests`}
              onClick={() => go("requests")}
              disabled={me.actor.mode === "pin"}
            >
              <Bell size={19} />
              {pending.length > 0 && <i />}
            </button>
            <Avatar name={me.actor.name} />
          </div>
        </header>
        {me.organization.demo && (
          <div className="demo-banner">
            <span className="demo-dot" /> Demonstration workspace{" "}
            <span className="demo-long">
              · Synthetic staff and activity. Ready for your review.
            </span>
            <Badge tone="outline">PREVIEW</Badge>
          </div>
        )}
        <main id="workspace-main" ref={mainRef} tabIndex={-1} aria-labelledby={page === "overview" && me.permissions.report ? "workforce-heading" : "workspace-heading"}>
          {!(page === "overview" && me.permissions.report) && <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span className="day-line" />
                {day().toFormat("cccc, LLLL d, yyyy")}
              </div>
              <h1 id="workspace-heading">{page === "clock" && compactClock ? "My time clock" : page === "overview" && me.permissions.report ? "Your workforce, in focus." : title}</h1>
              {page === "clock" && <p className="clock-account-label">{me.actor.name}</p>}
              <p>{page === "overview" && me.permissions.report ? "Hours, people and patterns. Everything you need to see the working day clearly." : subtitles[page]}</p>
            </div>
            {page === "overview" && me.permissions.report && showPersonalCards ? (
              <label className="scope-select">
                <Church size={16} />
                <select
                  aria-label="Community filter"
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                >
                  <option value="">All communities</option>
                  {me.units.map((u: any) => (
                    <option value={u.id} key={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : ["staff", "requests"].includes(page) &&
              (me.permissions.manage || page === "requests") ? (
              <button
                className="button primary"
                onClick={() =>
                  setDialog({
                    type:
                      page === "staff" ? "staff" : "request",
                  })
                }
              >
                <Plus size={17} />
                {page === "staff" ? "Add person" : "New general request"}
              </button>
            ) : null}
            {page === "overview" && (
              <button
                className="button secondary customize-button"
                onClick={() => go("settings")}
              >
                <SlidersHorizontal size={17} />
                Customize workspace
              </button>
            )}
          </div>}
          {!(page === "overview" && me.permissions.report) && !(compactClock && page === "clock") && workforceNavigation}
          {((page === "overview" && !me.permissions.report) || page === "school") && (
            <WorkspaceHero
              school={page === "school"}
              onCustomize={() => go("settings")}
            />
          )}
          {page === "overview" && me.permissions.report && <>
            <WorkforceDashboard key={me.actor.id} me={me} board={board} boardState={boardState} onNavigate={go} onRefresh={refresh}/>
            <button className="workforce-personal-toggle" onClick={() => setShowPersonalCards(value => !value)} aria-expanded={showPersonalCards}><SlidersHorizontal size={17}/>{showPersonalCards ? "Hide personal workspace cards" : "Show personal workspace cards"}<ChevronDown size={17}/></button>
          </>}
          {page === "overview" && (!me.permissions.report || showPersonalCards) && (
            <div className="personal-dashboard">
              {preferences.widgetOrder
                .filter((id) => !preferences.hiddenWidgets.includes(id))
                .map((id) => (
                  <div key={id} className="dashboard-widget" data-widget={id}>
                    {
                      {
                        metrics: (
                          <div className="stats-grid">
                            <Stat
                              label={
                                me.permissions.report
                                  ? "On the clock"
                                  : "My work this week"
                              }
                              value={
                                me.permissions.report
                                  ? scopedBoard.length
                                  : report ? <ReadableWorkforceDuration value={report.workMicroseconds}/> : reportPlaceholder
                              }
                              detail={
                                me.permissions.report
                                  ? `${scopedBoard.filter((x) => x.kind === "break").length} currently on a break`
                                  : "Recorded work, excluding breaks · 2 decimal places"
                              }
                              icon={<Clock3 size={19} />}
                              tone="green"
                            />
                            <Stat
                              label="Recorded work this week"
                              value={
                                <>
                                  {report ? <ReadableWorkforceDuration value={report.workMicroseconds}/> : reportPlaceholder}
                                </>
                              }
                              detail="Monday through today"
                              icon={<FileBarChart2 size={19} />}
                              tone="tan"
                            />
                            <Stat
                              label="Awaiting review"
                              value={scopedPending.length}
                              detail="Time off, schedules & corrections"
                              icon={<FileClock size={19} />}
                              tone="rose"
                            />
                            <Stat
                              label="Scheduled this week"
                              value={scopedSchedules.length}
                              detail="Upcoming & recorded schedule entries"
                              icon={<CalendarDays size={19} />}
                              tone="blue"
                            />
                          </div>
                        ),
                        clock: (
                          <ClockCard
                            state={clock}
                            onChange={refresh}
                            notify={notify}
                            onSessionExpired={sessionExpired}
                            onPendingChange={clockPendingChanged}
                          />
                        ),
                        people: (
                          <Panel
                            title={
                              me.permissions.report
                                ? "Your community, right now"
                                : "Your work this week"
                            }
                            detail={
                              me.permissions.report
                                ? "Current clock status · refreshes every 30 seconds"
                                : "Recorded work by local calendar day"
                            }
                            action={
                              <TextLink
                                onClick={() =>
                                  go(me.permissions.report ? "staff" : "clock")
                                }
                              >
                                {me.permissions.report
                                  ? "View people"
                                  : "View my time"}
                              </TextLink>
                            }
                          >
                            {me.permissions.report ? (
                              <Board rows={scopedBoard} />
                            ) : (
                              report ? <MiniChart buckets={report.buckets} /> : reportPlaceholder
                            )}
                          </Panel>
                        ),
                        requests: (
                          <Panel
                            title="A few things to review"
                            detail="The next steps that keep things moving"
                            action={
                              <Badge tone="warm">
                                {scopedPending.length} pending
                              </Badge>
                            }
                          >
                            {scopedPending.length ? (
                              <div className="request-preview">
                                {scopedPending
                                  .slice(0, 3)
                                  .map((r: any, i: number) => (
                                    <button
                                      key={r.id}
                                      onClick={() => go("requests")}
                                    >
                                      <span
                                        className={`request-icon tone-${i}`}
                                      >
                                        <FileClock size={19} />
                                      </span>
                                      <span>
                                        <strong>
                                          {r.kind === "pto"
                                            ? "Time off request"
                                            : r.kind === "schedule"
                                              ? "Scheduling question"
                                              : "Time correction"}
                                        </strong>
                                        <small>
                                          {shortName(r.employee_name)} ·{" "}
                                          {DateTime.fromISO(
                                            dateOnly(r.starts_on),
                                          ).toFormat("LLL d")}
                                        </small>
                                      </span>
                                      <ChevronRight size={16} />
                                    </button>
                                  ))}
                              </div>
                            ) : (
                              <Empty
                                title="You’re all caught up"
                                detail="New requests will appear here."
                              />
                            )}
                            <div className="panel-footer">
                              <TextLink onClick={() => go("requests")}>
                                Open requests
                              </TextLink>
                            </div>
                          </Panel>
                        ),
                        hours: (
                          <Panel
                            title="The week at a glance"
                            detail={`Exact recorded work · ${report?.timezone??me.organization.timezone}`}
                            action={
                              <TextLink
                                onClick={() =>
                                  go(
                                    me.permissions.report ? "reports" : "clock",
                                  )
                                }
                              >
                                Explore hours
                              </TextLink>
                            }
                          >
                            {report ? <MiniChart buckets={report.buckets} /> : reportPlaceholder}
                            <div className="chart-legend">
                              <span />
                              <span>Work time</span>
                              <small>Breaks tracked separately</small>
                            </div>
                          </Panel>
                        ),
                        community: (
                          <section className="community-card">
                            <WorkspaceArt
                              scene="community"
                              className="community-card-art"
                            />
                            <span className="eyebrow">BETTER TOGETHER</span>
                            <h2>
                              A shared space.
                              <br />
                              An extraordinary community.
                            </h2>
                            <p>
                              Your school, early childhood program, and
                              parish—connected through the people at the heart
                              of it all.
                            </p>
                            <button onClick={() => go("workspace")}>
                              See what we’re building <ArrowUpRight size={17} />
                            </button>
                          </section>
                        ),
                      }[id]
                    }
                  </div>
                ))}
            </div>
          )}
          {page === "clock" && (
            <>
              <ClockCard
                state={clock}
                onChange={refresh}
                notify={notify}
                onSessionExpired={sessionExpired}
                onPendingChange={clockPendingChanged}
                large
              />
              {compactClock && toastNotice}
              {compactClock && workforceNavigation}
              {me.actor.mode === "pin" && <p className="panel-note" role="status"><ShieldCheck size={16} /> PIN session · Time clock only. Sign out and use Password to open your full workspace.</p>}
              {me.actor.mode !== "pin" && (
                <div className="two-columns">
                  <Panel
                    title="Your work this week"
                    detail="Recorded hours rounded to two places. Hover for exact time."
                  >
                    <div className="big-hours">
                      {report ? <ReadableWorkforceDuration value={report.staff.find(x=>x.userId===me.actor.id)?.workMicroseconds??(me.permissions.report?'0':report.workMicroseconds)}/> : reportPlaceholder}
                      <span>recorded work</span>
                    </div>
                    <p className="panel-note">
                      Open Time records to report missing time, request a reviewed clock-out, or propose a correction. Break
                      compensation and overtime policies are awaiting
                      organization configuration.
                    </p>
                  </Panel>
                  <Panel
                    title="Need an adjustment?"
                    detail="Keep the right people in the loop."
                  >
                    <div className="action-list">
                      {[
                        ["pto", "Request time off"],
                        ["schedule", "Request a schedule change"],
                        ["correction", "Review or correct recorded time"],
                      ].map(([kind, label]) => (
                        <button
                          key={kind}
                          onClick={() => kind === "schedule" ? go("schedule") : kind === "correction" ? go("time-records") : setDialog({ type: "request", kind })}
                        >
                          <FileClock size={18} />
                          {label}
                          <ArrowRight size={16} />
                        </button>
                      ))}
                    </div>
                  </Panel>
                </div>
              )}
            </>
          )}
          {page === "staff" && (
            <>
              <Panel
                title="Staff directory"
                className="staff-directory"
                detail={`Showing ${visibleStaff.length} of ${includedStaff.length} ${includeInactiveStaff ? "accounts, including inactive," : "active accounts"} in your permitted scope`}

              >
                <div className="table-toolbar">
                  {me.permissions.manage && <button className="button secondary small" onClick={() => setStaffTool({kind:"import"})}><ArrowDownToLine size={16}/>Import employees</button>}
                  <label className="search in-panel">
                    <Search size={16} />
                    <input
                      aria-label="Search directory"
                      placeholder="Search by name, email, or role"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                  <label className="check-label staff-inactive-filter">
                    <input
                      type="checkbox"
                      checked={includeInactiveStaff}
                      onChange={(e) => setIncludeInactiveStaff(e.target.checked)}
                    />
                    Include inactive accounts
                  </label>
                  <Badge>
                    {jobs.filter((x) => x.active).length} available jobs
                  </Badge>
                </div>
                <p className="staff-scroll-hint">Swipe or scroll the table to see roles, status and account actions.</p>
                <div className="table-scroll" tabIndex={0} role="region" aria-label="Staff directory details">
                  <table>
                    <thead>
                      <tr>
                        <th>Person</th>
                        <th>Community</th>
                        <th>Access role</th>
                        <th>Status</th>
                        <th>
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleStaff.map((person: any, i: number) => (
                          <tr key={person.id}>
                            <td>
                              <div className="person-cell">
                                <Avatar name={person.name} index={i} />
                                <span>
                                  <strong>{shortName(person.name)}</strong>
                                  <small>{person.email}</small>
                                </span>
                              </div>
                            </td>
                            <td>
                              {me.units
                                .filter((u: any) =>
                                  person.unit_ids.includes(u.id),
                                )
                                .map((u: any) => u.name)
                                .join(", ")}
                            </td>
                            <td>
                              <Badge>{person.role}</Badge>
                            </td>
                            <td>
                              <span
                                className={`status-text ${person.active && !person.requires_credential_change ? "green" : "muted"}`}
                              >
                                <i />
                                {!person.active
                                  ? "Inactive"
                                  : person.requires_credential_change
                                    ? "Needs credential update"
                                  : person.setup_complete
                                    ? "Active"
                                    : "Awaiting setup"}
                              </span>
                            </td>
                            <td>
                              <div className="row-actions staff-account-actions">
                                {canManagePerson(person) && <>
                                  <button className="text-link" onClick={() => setDialog({type:'staff',staff:person})}>Edit account</button>
                                  <button className="text-link" onClick={() => setStaffTool({kind:'clock',person})}>Clock rules</button>
                                  {['developer','owner','admin'].includes(me.actor.role) && <button className="text-link" onClick={() => setStaffTool({kind:'credentials',person})}>Reset sign-in</button>}
                                  {!person.requires_credential_change && <button className="text-link" onClick={() => void run(async () => {
                                    const result = await api(`/staff/${person.id}/setup-link`, {});
                                    if (sessionEpoch.current === workspaceEpoch) setPrivateLink(result.setupUrl);
                                  })}>Setup link</button>}
                                </>}
                                {['developer','owner','admin','finance'].includes(me.actor.role) && <button className="text-link" onClick={() => setStaffTool({kind:'rates',person})}>Pay rates</button>}
                              </div>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                {!visibleStaff.length && (
                  <Empty
                    title="No accounts match these filters"
                    detail={includeInactiveStaff ? "Try another name, email, or role." : "Try another search or include inactive accounts."}
                  />
                )}
              </Panel>
              {me.permissions.manage && <button className="button secondary workforce-import-entry" onClick={() => setStaffTool({kind:"jobs-import"})}><ArrowDownToLine size={17}/>Import jobs</button>}
              <JobManagement key={me.actor.id} me={me} jobs={jobs} onEdit={(job) => setDialog({ type: "job", job })} isSessionCurrent={isSessionCurrent} />
            </>
          )}
          {page === "schedule" && <>
            {me.permissions.manage && <button className="button secondary workforce-import-entry" onClick={() => setStaffTool({kind:"schedules-import"})}><ArrowDownToLine size={17}/>Import scheduled shifts</button>}
            <StaffSchedule me={me} staff={staff} jobs={jobs} rows={schedules} week={scheduleWeek} zone={zone}
            onWeek={setScheduleWeek} onChanged={refresh} notify={notify} onDirty={workspaceDirty}
            onRequests={(scheduleId, requestId) => { setScheduleRequestTarget({ scheduleId, requestId }); go("requests"); }}/></>}
          {page === "requests" && (
            <><ScheduleRequests me={me} zone={zone} target={scheduleRequestTarget} onChanged={refresh} notify={notify} onDirty={workspaceDirty}
              onSchedule={date => { if (go("schedule") && date) setScheduleWeek(DateTime.fromISO(date).setZone(zone).startOf("week").toISODate()!); }}/>
            <Panel
              title="General requests & decisions"
              detail="Edit or withdraw your own pending requests. Reviewed decisions are retained; submit a new request for further changes. Linked shift requests apply schedule changes; Time records handles clock corrections."
              action={
                <button
                  className="button secondary small"
                  onClick={() => go("time-records")}
                >
                  Review time corrections
                  <ArrowRight size={16} />
                </button>
              }
            >
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Request</th>
                      <th>Dates</th>
                      <th>Details</th>
                      <th>Status</th>
                      <th>Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requests.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <strong>{shortName(r.employee_name)}</strong>
                          <small className="block muted">{r.unit_name}</small>
                        </td>
                        <td>
                          {r.kind === "pto"
                            ? "Paid time off"
                            : r.kind === "schedule"
                              ? "Scheduling question"
                              : r.kind === "correction"
                                ? "Time correction"
                                : "Other adjustment"}
                        </td>
                        <td className="nowrap">
                          {dateOnly(r.starts_on)}
                          <br />
                          {dateOnly(r.ends_on)}
                        </td>
                        <td className="request-note">
                          {r.note}
                          {r.review_note && (
                            <small className="block muted">
                              Review: {r.review_note}
                            </small>
                          )}
                        </td>
                        <td>
                          <Badge
                            tone={
                              r.status === "approved"
                                ? "green"
                                : r.status === "pending"
                                  ? "warm"
                                  : "neutral"
                            }
                          >
                            {r.status}
                          </Badge>
                        </td>
                        <td>
                          {r.user_id === me.actor.id && r.status === "pending" ? <div className="row-actions"><button className="button secondary small" onClick={() => setDialog({ type: "request", request: r })}>Edit request</button><button className="button ghost small" onClick={() => setDialog({ type: "withdraw", request: r })}>Withdraw</button></div> : me.permissions.manage &&
                          r.status === "pending" &&
                          r.user_id !== me.actor.id ? (
                            <button
                              className="button secondary small"
                              onClick={() =>
                                setDialog({ type: "review", request: r })
                              }
                            >
                              Review
                            </button>
                          ) : r.reviewed_at ? (
                            <small>{dateText(r.reviewed_at)}</small>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!requests.length && (
                <Empty
                  title="No requests yet"
                  detail="Create a general request for time off, a scheduling question, or another adjustment."
                />
              )}
            </Panel></>
          )}
          <Suspense
            fallback={
              <p className="community-loading">Opening your workspace…</p>
            }
          >
            {page === "calendar" && <Calendar me={me} notify={notify} onDirty={workspaceDirty} />}
            {page === "school" && (
              <School me={me} notify={notify} onDirty={workspaceDirty} />
            )}
            {page === "care" && (
              <Care me={me} notify={notify} onDirty={workspaceDirty} />
            )}
            {page === "dismissal" && <Dismissal me={me} notify={notify} onDirty={workspaceDirty}/>}
            {page === "messages" && <Messages me={me} notify={notify} />}
          </Suspense>
          {page === "reports" && (
            <Reports me={me} jobs={jobs} notify={notify} onChange={refresh} onDirty={workspaceDirty} />
          )}
          {page === "time-records" && (
            <TimeRecords me={me} notify={notify} onChanged={refresh} onDirty={workspaceDirty} onNavigatePayroll={me.permissions.report ? () => go("payroll") : undefined}/>
          )}
          {page === "payroll" && me.actor.mode !== "pin" && me.permissions.report && <Payroll me={me} staff={staff} notify={notify} onDirty={workspaceDirty} onNavigateRecords={() => go("time-records")}/>} 
          {page === "audit" && (
            <Panel
              title="Activity log"
              detail="The latest 100 events. Audit records cannot be edited or deleted through the app."
              action={
                <button
                  className="button secondary small"
                  onClick={() =>
                    void run(async () => {
                      const result = await api("/audit");
                      if (sessionEpoch.current === workspaceEpoch) setAudit(result.rows);
                    })
                  }
                >
                  Refresh
                </button>
              }
            >
              <div className="audit-list">
                {audit.map((event) => (
                  <div key={event.id}>
                    <span className="audit-icon">
                      <ShieldCheck size={17} />
                    </span>
                    <div>
                      <strong>
                        {event.action
                          .replaceAll(".", " · ")
                          .replaceAll("_", " ")}
                      </strong>
                      <p>
                        {event.actor_name ?? "System"}
                        <span> · </span>
                        {dateText(event.created_at)}
                      </p>
                      <small>
                        {Object.entries(event.detail)
                          .filter(
                            ([k]) =>
                              !["query", "jobIds", "unitIds"].includes(k),
                          )
                          .map(
                            ([k, v]) =>
                              `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`,
                          )
                          .join(" · ")}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          )}
          {page === "workspace" && (
            <>
              <div className="roadmap-intro">
                <span className="small-icon">
                  <HeartHandshake size={27} />
                </span>
                <div>
                  <h2>One foundation. Thoughtfully connected.</h2>
                  <p>
                    Staff and timekeeping lead the first release. Each new
                    school module will share the same people, organizational
                    structure, permissions, and audit history.
                  </p>
                </div>
              </div>
              <div className="module-grid">
                {me.modules.map((module: any, i: number) => (
                  <section className="panel module-card" key={module.id}>
                    <span className={`module-icon tone-${i % 5}`}>
                      {i === 0 ? (
                        <Clock3 />
                      ) : i === 6 ? (
                        <Wallet />
                      ) : i === 4 ? (
                        <HeartHandshake />
                      ) : (
                        <BookOpen />
                      )}
                    </span>
                    <Badge tone={i === 0 ? "green" : "neutral"}>
                      {module.status}
                    </Badge>
                    <h2>{module.name}</h2>
                    <p>{module.detail}</p>
                    {i === 0 && (
                      <TextLink onClick={() => go("clock")}>
                        Open my time clock
                      </TextLink>
                    )}
                  </section>
                ))}
              </div>
              <p className="panel-note">
                Planned modules are not live integrations. The feature
                comparison and delivery gates are documented in the project
                plan.
              </p>
            </>
          )}
          {page === "settings" && (
            <Settings
              me={me}
              appEntry={<InstallEntry experience={installExperience} />}
              notify={notify}
              branding={branding}
              reloadBranding={reloadBranding}
              onSessionExpired={sessionExpired}
              isSessionCurrent={isSessionCurrent}
              onDirty={workspaceDirty}
              onChange={async (savedPreferences) => {
                if (sessionEpoch.current !== workspaceEpoch) return;
                const generation = ++settingsRefreshGeneration.current;
                if (savedPreferences) setMe((current: any) => current && current.actor.id === me.actor.id ? { ...current, actor: { ...current.actor, preferences: savedPreferences } } : current);
                const result = await api("/me");
                if (sessionEpoch.current !== workspaceEpoch || settingsRefreshGeneration.current !== generation) return;
                if (result.actor.id !== me.actor.id || result.actor.mode !== me.actor.mode) { sessionExpired(); return; }
                setMe(result);
                setCsrf(result.actor.csrf);
              }}
            />
          )}
          <footer className="workspace-footer">
            <span>
              {workspaceIdentity.shortName} <span className="footer-dot">·</span> Built for our community
            </span>
            <span>
              <ShieldCheck size={13} /> Organization-scoped access
            </span>
          </footer>
        </main>
      </div>
      {updateNotice}
      {!(compactClock && page === "clock") && toastNotice}
      {staffTool?.kind === 'credentials' && <StaffCredentials key={staffTool.person.id} person={staffTool.person} onClose={() => { setStaffTool(null); setUnsavedChanges(false); }} onSaved={refresh} notify={notify} isSessionCurrent={isSessionCurrent} onSessionExpired={sessionExpired} onDirty={workspaceDirty}/>}
      {staffTool && staffTool.kind !== 'credentials' && <Modal title={staffTool.kind === 'jobs-import' ? 'Import jobs' : staffTool.kind === 'schedules-import' ? 'Import scheduled shifts' : staffTool.kind === 'import' ? 'Import employees' : `${staffTool.person.name} · ${staffTool.kind === 'rates' ? 'Pay rates' : 'Clock rules'}`} onClose={closeStaffTool}>
        <div className="staff-tool-content">
          {(staffTool.kind === 'jobs-import' || staffTool.kind === 'schedules-import') && <WorkforceImport key={me.actor.id+staffTool.kind} kind={staffTool.kind === 'jobs-import' ? 'jobs' : 'schedules'} onChange={refresh} notify={notify} onDirty={workspaceDirty} isSessionCurrent={isSessionCurrent} onSessionExpired={sessionExpired}/>}
          {staffTool.kind === 'rates' && <Compensation key={staffTool.person.id} initialUserId={staffTool.person.id} notify={notify} onDirty={workspaceDirty}/>}
          {staffTool.kind === 'clock' && <EmployeeClockPolicy key={staffTool.person.id} userId={staffTool.person.id} notify={notify} onDirty={workspaceDirty}/>}
          {staffTool.kind === 'import' && <StaffImport me={me} jobs={jobs} notify={notify} onChange={refresh} onDirty={workspaceDirty}/>}
        </div>
      </Modal>}
      {dialog && (
        <Modal
          title={
            (
              {
                staff: dialog.staff
                  ? "Edit staff account"
                  : "Welcome someone new",
                job: dialog.job ? "Edit job" : "Create a job",
                request: dialog.request ? "Edit pending request" : "Create a request",
                withdraw: "Withdraw pending request",
                review: "Review request",
              } as Record<string, string>
            )[dialog.type] ?? ""
          }
          onClose={closeManagementDialog}
        >
          <form className="management-editor-form" key={dialog.reloadKey ?? 0} onSubmit={submitDialog} inert={busy} aria-busy={busy} onChange={() => { setUnsavedChanges(true); setDialogError(""); }}>
            {dialog.type === "staff" ? (
              <StaffForm me={me} jobs={jobs} person={dialog.staff} busy={busy} />
            ) : dialog.type === "job" ? (
              <JobForm me={me} job={dialog.job} />
            ) : dialog.type === "request" ? (
              <>
                <p className="panel-note">This general request records a decision only. To change a planned shift, open your Schedule and choose Request a change.</p>
                <label>
                  Request type
                  <select name="kind" defaultValue={dialog.request?.kind ?? dialog.kind ?? "pto"}>
                    <option value="pto">Paid time off</option>
                    {dialog.request?.kind === "correction" && <option value="correction">Time correction (retained request)</option>}
                    <option value="schedule">Scheduling question (decision only)</option>
                    <option value="other">Other adjustment</option>
                  </select>
                </label>
                <label>
                  Community
                  <select name="unitId" defaultValue={dialog.request?.unit_id}>
                    {me.units
                      .filter((u: any) => me.actor.unit_ids.includes(u.id))
                      .map((u: any) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                  </select>
                </label>
                <div className="form-row">
                  <label>
                    From
                    <input
                      name="startsOn"
                      type="date"
                      defaultValue={dialog.request?.starts_on?.slice(0,10) ?? day().toISODate()!}
                      required
                    />
                  </label>
                  <label>
                    Through
                    <input
                      name="endsOn"
                      type="date"
                      defaultValue={dialog.request?.ends_on?.slice(0,10) ?? day().toISODate()!}
                      required
                    />
                  </label>
                </div>
                <label>
                  What do we need to know?
                  <textarea
                    name="note"
                    defaultValue={dialog.request?.note}
                    minLength={5}
                    maxLength={2000}
                    rows={4}
                    placeholder="Include the relevant dates, times, and requested adjustment."
                    required
                  />
                </label>
              </>
            ) : dialog.type === "withdraw" ? (
              <><p>Withdraw this pending request without removing its history. A reviewed decision cannot be edited here.</p><label>Reason for withdrawal<textarea name="reason" required minLength={3} maxLength={1000} rows={3}/></label></>
            ) : dialog.type === "review" ? (
              <>
                <div className="review-summary">
                  <strong>{dialog.request.employee_name}</strong>
                  <p>{dialog.request.note}</p>
                </div>
                <label>
                  Decision
                  <select name="status">
                    <option value="approved">Approve</option>
                    <option value="declined">Decline</option>
                  </select>
                </label>
                <label>
                  Review note
                  <textarea
                    name="note"
                    minLength={3}
                    maxLength={1000}
                    required
                    rows={3}
                  />
                </label>
                <p className="panel-note">
                  This records your decision. It does not change pay balances,
                  clock records, or scheduled shifts automatically.
                </p>
              </>
            ) : null}
            {dialogError && <p className="error" role="alert">{dialogError}</p>}
            <div className="dialog-actions">
              {(dialog.job || dialog.staff || dialog.request) && <button type="button" className="button secondary" disabled={busy} onClick={() => void reloadManagementDialog()}>Reload saved values</button>}
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={closeManagementDialog}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? "Saving…" : "Save"}
                <Check size={16} />
              </button>
            </div>
          </form>
        </Modal>
      )}
      {privateLink && (
        <Modal
          title="Private account setup link"
          onClose={() => setPrivateLink("")}
        >
          <p>
            Share this link privately with the intended employee. It can be used
            once and expires in 24 hours.
          </p>
          <input aria-label="Private setup link" readOnly value={privateLink} />
          <div className="dialog-actions">
            <button
              className="button primary"
              onClick={() =>
                void navigator.clipboard
                  .writeText(privateLink)
                  .then(() => notify("Private link copied."))
                  .catch(() =>
                    notify("Select the link and copy it manually.", true),
                  )
              }
            >
              Copy link
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function KeyIcon() {
  return <ShieldCheck size={16} />;
}
function Stat({
  label,
  value,
  detail,
  icon,
  tone,
}: {
  label: string;
  value: any;
  detail: string;
  icon: any;
  tone: string;
}) {
  return (
    <section className="stat">
      <div>
        <span>{label}</span>
        <span className={`stat-icon ${tone}`}>{icon}</span>
      </div>
      <strong>{value}</strong>
      <p>{detail}</p>
    </section>
  );
}
function Board({ rows }: { rows: any[] }) {
  return rows.length ? (
    <div className="table-scroll">
      <table className="board-table">
        <thead>
          <tr>
            <th>Team member</th>
            <th>Community</th>
            <th>Status</th>
            <th>Since</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 7).map((row, i) => (
            <tr key={row.user_id}>
              <td>
                <div className="person-cell">
                  <Avatar name={row.name} index={i} />
                  <span>
                    <strong>{shortName(row.name)}</strong>
                    <small>{row.job_title}</small>
                  </span>
                </div>
              </td>
              <td>
                <span className="unit-label">{row.unit_name}</span>
              </td>
              <td>
                <Badge tone={row.kind === "break" ? "warm" : "green"}>
                  <span className="badge-dot" />
                  {row.kind === "break" ? "On break" : "Working"}
                </Badge>
              </td>
              <td>
                {DateTime.fromISO(row.segment_started_at)
                  .setZone(zone)
                  .toFormat("h:mm a")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 7 && (
        <p className="panel-note">Showing 7 of {rows.length} active staff.</p>
      )}
    </div>
  ) : (
    <Empty
      title="A quiet moment"
      detail="Staff will appear here as they clock in."
    />
  );
}
export function MiniChart({ buckets }: { buckets: WorkforceBucketV2[] }) {
  const scale=workforceChartScale(buckets.map(bucket=>bucket.workMicroseconds));
  return (
    <div
      className="mini-chart exact-workforce-chart"
      role="img"
      aria-label={
        buckets.length
          ? 'Recorded work. Bar heights are approximate; duration labels are exact. '+buckets
              .map((x) => `${x.label}: ${formatWorkforceDuration(x.workMicroseconds,true)} recorded work`)
              .join("; ")
          : "No recorded time for this range"
      }
    >
      <div className="chart-y">
        {scale.ticks.map((value) => (
          <span key={value}>{formatWorkforceDuration(value)}</span>
        ))}
      </div>
      <div className="exact-workforce-plot-scroll"><div className="chart-plot" style={{minWidth:Math.max(100,buckets.length*32)}}>
        <div className="chart-gridlines">
          {[0, 1, 2, 3, 4].map((i) => (
            <i key={i} />
          ))}
        </div>
        <div className="chart-bars">
          {buckets.map((x, i) => (
            <div className="chart-column" key={x.key}>
              <span
                className={`chart-bar ${i === buckets.length - 1 ? "last" : ""}`}
                style={{ height: `${x.workMicroseconds==='0'?0:Math.max(0.7,workforceBarPercent(x.workMicroseconds,scale.maximum))}%`,minHeight:x.workMicroseconds==='0'?0:undefined }}
                title={`${x.label}: ${formatWorkforceDuration(x.workMicroseconds)} recorded work`}
              >
                <small>{formatWorkforceDuration(x.workMicroseconds)}</small>
              </span>
              <span className="bar-label">{x.label}</span>
            </div>
          ))}
        </div>
      </div></div>
    </div>
  );
}
function StaffForm({
  me,
  jobs,
  person,
  busy,
}: {
  me: any;
  jobs: any[];
  person?: any;
  busy: boolean;
}) {
  const [unitIds, setUnitIds] = useState<string[]>(
    person?.unit_ids ?? [me.units[0]?.id].filter(Boolean),
  );
  const [onboarding, setOnboarding] = useState("temporary");
  return (
    <>
      <div className="form-row">
        <label>
          Full name
          <input
            name="name"
            defaultValue={person?.name}
            required
            minLength={2}
            maxLength={100}
          />
        </label>
        <label>
          Work email
          <input
            name="email"
            type="email"
            defaultValue={person?.email}
            placeholder="you@stjw.org"
            required
          />
        </label>
      </div>
      <label>
        Access role
        <select name="role" defaultValue={person?.role ?? "employee"}>
          {(isOwnerRole(me.actor.role)
            ? ["employee", "manager", "finance", "admin", ...(me.actor.role === "developer" && person?.role === "owner" ? ["owner"] : []), ...(me.actor.role === "developer" && person?.role === "developer" ? ["developer"] : [])]
            : me.actor.role === "admin"
              ? ["employee", "manager", "finance"]
              : ["employee"]
          ).map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <small>
          Employee access focuses on personal time, schedule, and requests.
        </small>
      </label>
      {!person && ["developer", "owner", "admin"].includes(me.actor.role) && <fieldset className="temporary-staff-onboarding" disabled={busy}>
        <legend>First sign-in</legend>
        <label>Account setup method<select name="onboarding" aria-label="Account setup method" value={onboarding} onChange={event => setOnboarding(event.target.value)}>
          <option value="private">Private setup link</option><option value="temporary">Temporary password and PIN</option>
        </select></label>
        {onboarding === "private" ? <p>The employee chooses a private password using a one-time setup link.</p> : <>
          <p>Share these details privately. For first sign-in, choose Password and enter the work email and temporary password. The employee must then choose their own password and unique PIN. A shared temporary PIN cannot identify an account.</p>
          <TemporaryCredentialFields busy={busy}/>
        </>}
      </fieldset>}
      <fieldset>
        <legend>Communities</legend>
        {me.units.map((u: any) => (
          <label className="check-label" key={u.id}>
            <input
              type="checkbox"
              name="unitIds"
              value={u.id}
              checked={unitIds.includes(u.id)}
              onChange={(e) =>
                setUnitIds(
                  e.target.checked
                    ? [...unitIds, u.id]
                    : unitIds.filter((x) => x !== u.id),
                )
              }
            />
            {u.name}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Assigned jobs</legend>
        {jobs
          .filter((j) => unitIds.includes(j.unit_id) && (j.active || person?.job_ids.includes(j.id)))
          .map((j) => (
            <label className="check-label" key={j.id}>
              <input
                type="checkbox"
                name="jobIds"
                value={j.id}
                defaultChecked={person?.job_ids.includes(j.id)}
              />
              {j.title}{!j.active && " (archived — retained assignment)"}
              <small>{j.unit_name}</small>
            </label>
          ))}
      </fieldset>
      {person && (
        <label className="check-label">
          <input name="active" type="checkbox" defaultChecked={person.active} />
          Account active
        </label>
      )}
    </>
  );
}
