import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  FileBarChart2,
  FileSpreadsheet,
  Plus,
  Printer,
  Upload,
  Archive,
  RefreshCw,
  Search,
  Layers3,
  Coins,
} from "lucide-react";
import { api, ApiError, download, downloadPost } from "./api";
import FinanceReportStudio, { FinanceViewTable } from './FinanceReportStudio';
import { financeBasisLabel, financeDefaultView, financeFilename, financeKindLabels, financeMagnitudePercent, financePeriod, financeRowKindLabels, financeSelectionSummary, financeUnits, financeViewQuery, financeVisibleLines, formatFinanceAmount, type FinanceViewOptions } from '../shared/finance-presentation';
import { createPortal } from 'react-dom';
import { Panel, Badge, Empty } from "./components";
import WorkbookImport from './WorkbookImport';
import "./finance.css";
type Props = {
  me: any;
  notify: (message: string, error?: boolean) => void;
  onDirty: (dirty: boolean) => void;
};
const blankMetadata = {
  title: "",
  sourceName: "",
  currency: "",
  kind: "",
  basis: "",
  from: "",
  to: "",
  note: "",
};
const basisLabel = financeBasisLabel;
function Amount({
  value,
  currency = "",
}: {
  value: string | null;
  currency?: string;
}) {
  return (
    <span className="finance-amount" title={value===null?'Not present in this source':'Exact source amount: '+value}>
      {formatFinanceAmount(value, currency)}
    </span>
  );
}
function Lines({ rows, currency }: { rows: any[]; currency: string }) {
  return (
    <table className="finance-table">
      <thead>
        <tr>
          <th>Code / line</th>
          <th>Group</th>
          <th>Kind</th>
          <th>Amount · {currency}</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.lineCode}>
            <td>
              <strong>{row.lineLabel}</strong>
              <small>Source code: {row.lineCode}</small>
            </td>
            <td>{row.group || "—"}</td>
            <td>{financeRowKindLabels[row.rowKind]}</td>
            <td>
              <Amount value={row.amount} />
            </td>
            <td>{row.note || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
function ComparisonTable({ rows }: { rows: any[] }) {
  return (
    <table className="finance-table">
      <thead>
        <tr>
          <th>Report line</th>
          <th>Baseline</th>
          <th>Compared report</th>
          <th>Difference</th>
          <th>Change %</th>
          <th>Matching</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.lineCode}>
            <td>
              <strong>{row.rightLabel ?? row.leftLabel}</strong>
              <small>Source code: {row.lineCode}</small>
              {row.labelChanged && (
                <small>Earlier label: {row.leftLabel}</small>
              )}
              {row.groupChanged && (
                <small>
                  Group changed: {row.leftGroup || "none"} →{" "}
                  {row.rightGroup || "none"}
                </small>
              )}
            </td>
            <td>
              <Amount value={row.leftAmount} />
            </td>
            <td>
              <Amount value={row.rightAmount} />
            </td>
            <td>
              <Amount value={row.delta} />
            </td>
            <td>{row.percent === null ? "—" : row.percent + "%"}</td>
            <td>{row.status.replaceAll("_", " ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
function ComparisonChart({
  rows,
  currency,
}: {
  rows: any[];
  currency: string;
}) {
  const shown = rows
      .filter((x) => x.leftKind === "detail" || x.rightKind === "detail")
      .slice(0, 16),
    largest = shown.flatMap(row=>[financeUnits(row.leftAmount??'0'),financeUnits(row.rightAmount??'0')]).reduce((largest,value)=>{const absolute=value<0n?-value:value;return absolute>largest?absolute:largest;},0n);
  return (
    <figure
      className="finance-chart"
      aria-label="Comparison of report detail amounts"
    >
      <figcaption>
        First {shown.length} detail lines · bar length shows magnitude ·{" "}
        {currency}
      </figcaption>
      <div className="finance-chart-legend">
        <span>Baseline report</span>
        <span>Compared report</span>
      </div>
      {shown.map((row) => (
        <div className="finance-chart-row" key={row.lineCode}>
          <strong>
            {row.rightLabel ?? row.leftLabel}
          </strong>
          {(["left", "right"] as const).map((side) => (
            <div className={"finance-chart-series " + side} key={side}>
              <span
                style={{
                  width:
                    financeMagnitudePercent(financeUnits(row[side+'Amount']??'0'),largest)+'%',
                }}
              />
              <small>
                {row[side + "Amount"] === null
                  ? "Missing"
                  : formatFinanceAmount(row[side + "Amount"])}
              </small>
            </div>
          ))}
        </div>
      ))}
      <p>
        Negative signs remain in the labels. The table includes every line and
        its exact difference.
      </p>
    </figure>
  );
}
export default function Finance(props: Props) {
  const actor=props.me.actor;
  return <FinanceWorkspace key={`${actor.org_id}:${actor.id}:${actor.mode}:${actor.role}:${actor.csrf}:${JSON.stringify(actor.unit_ids??[])}`} {...props}/>;
}
function FinanceWorkspace({ me, notify, onDirty }: Props) {
  const [unitId, setUnitId] = useState(me.units[0]?.id ?? ""),
    [archived, setArchived] = useState(false),
    [reports, setReports] = useState<any[]>([]),
    [mode, setMode] = useState<"list" | "import" | "detail" | "compare">(
      "list",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [librarySearch,setLibrarySearch]=useState(''),[libraryKind,setLibraryKind]=useState(''),[libraryCurrency,setLibraryCurrency]=useState(''),[libraryOrder,setLibraryOrder]=useState('latest'),[listLoading,setListLoading]=useState(true);
  const [reportView,setReportView]=useState<FinanceViewOptions>(financeDefaultView),[printView,setPrintView]=useState(false);
  const [metadata, setMetadata] = useState<any>({ ...blankMetadata }),
    [reportId, setReportId] = useState(""),
    [expectedVersion, setExpectedVersion] = useState(0),
    [csv, setCsv] = useState(""),
    [fileName, setFileName] = useState(""),
    [reason, setReason] = useState(""),
    [preview, setPreview] = useState<any>(null),
    [reviewed, setReviewed] = useState(false),
    [page, setPage] = useState(0);
  const [workbookPending, setWorkbookPending] = useState(false), [workbookReset, setWorkbookReset] = useState(0);
  const fileGeneration = useRef(0);
  const [detail, setDetail] = useState<any>(null),
    [record, setRecord] = useState<any>(null),
    [history, setHistory] = useState<any[]>([]),
    [archiveReason, setArchiveReason] = useState("");
  const [leftId, setLeftId] = useState(""),
    [rightId, setRightId] = useState(""),
    [leftVersion, setLeftVersion] = useState(0),
    [rightVersion, setRightVersion] = useState(0),
    [leftOptions, setLeftOptions] = useState<any[]>([]),
    [rightOptions, setRightOptions] = useState<any[]>([]),
    [periodsReviewed, setPeriodsReviewed] = useState(false),
    [comparison, setComparison] = useState<any>(null);
  const requestGeneration = useRef(0),
    comparisonGeneration = useRef(0),
    accessGeneration = useRef(0);
  const mounted=useRef(true), libraryKey=unitId+':'+archived, libraryKeyRef=useRef(libraryKey);
  libraryKeyRef.current=libraryKey;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;accessGeneration.current++;requestGeneration.current++;comparisonGeneration.current++;fileGeneration.current++;};},[]);
  const dirty =
    mode === "import" &&
    (!!csv || !!metadata.title || !!metadata.sourceName || !!reason || workbookPending);
  const draftKey = JSON.stringify({
    unitId,
    reportId,
    expectedVersion,
    metadata,
    csv,
    reason,
  });
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    let current = true;
    const generation = accessGeneration.current;
    setReports([]);
    setListLoading(true);
    void api(
      "/finance/reports?" +
        new URLSearchParams({ unitId, archived: String(archived) }),
    )
      .then((result) => {
        if (current && generation === accessGeneration.current) setReports(result.rows);
      })
      .catch((e) => {
        if (current && generation === accessGeneration.current) {
          if(e instanceof ApiError&&(e.status===401||e.status===403))clearFinanceAccess(e.status);else setError(e.message);
        }
      }).finally(()=>{if(current&&mounted.current&&generation===accessGeneration.current)setListLoading(false);});
    return () => {
      current = false;
    };
  }, [unitId, archived]);
  useEffect(() => {
    let current = true;
    const generation = accessGeneration.current;
    setLeftOptions([]);
    setLeftVersion(0);
    if (leftId)
      void api("/finance/reports/" + leftId)
        .then((r) => {
          if (current && generation === accessGeneration.current) {
            setLeftOptions(r.versions);
            setLeftVersion(r.report.version);
          }
        })
        .catch((e) => {
          if (current && generation === accessGeneration.current) {if(e instanceof ApiError&&(e.status===401||e.status===403))clearFinanceAccess(e.status);else setError(e.message);}
        });
    return () => {
      current = false;
    };
  }, [leftId]);
  useEffect(() => {
    let current = true;
    const generation = accessGeneration.current;
    setRightOptions([]);
    setRightVersion(0);
    if (rightId)
      void api("/finance/reports/" + rightId)
        .then((r) => {
          if (current && generation === accessGeneration.current) {
            setRightOptions(r.versions);
            setRightVersion(r.report.version);
          }
        })
        .catch((e) => {
          if (current && generation === accessGeneration.current) {if(e instanceof ApiError&&(e.status===401||e.status===403))clearFinanceAccess(e.status);else setError(e.message);}
        });
    return () => {
      current = false;
    };
  }, [rightId]);
  const compareInput = {
      leftId,
      leftVersion,
      rightId,
      rightVersion,
      differentPeriodsReviewed: periodsReviewed,
    },
    compareKey = JSON.stringify(compareInput),
    comparisonFresh = comparison && comparison.inputKey === compareKey;
  useEffect(() => {
    comparisonGeneration.current++;
  }, [compareKey]);
  function clearFinanceAccess(status: 401 | 403) {
    accessGeneration.current++;
    requestGeneration.current++; comparisonGeneration.current++; fileGeneration.current++;
    draftKeyRef.current = '';
    setWorkbookPending(false); setWorkbookReset(value => value + 1);
    setCsv(''); setFileName(''); setMetadata({ ...blankMetadata }); setReason('');
    setReportId(''); setExpectedVersion(0); setPreview(null); setReviewed(false);
    setReports([]); setDetail(null); setRecord(null); setHistory([]); setArchiveReason('');
    setComparison(null); setLeftId(''); setRightId(''); setLeftVersion(0); setRightVersion(0);
    setLeftOptions([]); setRightOptions([]); setPeriodsReviewed(false);
    setPage(0); setBusy(false); setListLoading(false); setMode('list'); onDirty(false);
    setError(status === 401
      ? 'Your sign-in expired or changed. Sign in again to open financial reports.'
      : 'Your access to financial reports changed. Financial data and the import draft have been cleared.');
  }
  async function perform(action: () => Promise<void>) {
    const generation = accessGeneration.current;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (generation === accessGeneration.current) {
        if(e instanceof ApiError&&(e.status===401||e.status===403))clearFinanceAccess(e.status);else setError((e as Error).message);
      }
    } finally {
      if (generation === accessGeneration.current) setBusy(false);
    }
  }
  async function financeDownload(path:string,name:string){const current=accessGeneration.current;await download(path,name,()=>mounted.current&&accessGeneration.current===current);}
  async function financeDownloadPost(path:string,body:unknown,name:string){const current=accessGeneration.current;await downloadPost(path,body,name,()=>mounted.current&&accessGeneration.current===current);}
  function printReport(filtered:boolean){setPrintView(filtered);}
  useEffect(()=>{if(printView){window.print();setPrintView(false);}},[printView]);
  function leave(next: typeof mode) {
    if (dirty && !window.confirm("Discard this unsaved financial import?"))
      return;
    requestGeneration.current++;
    fileGeneration.current++;
    setMode(next);
    setPage(0);
    setError("");
  }
  async function refresh() {
    const generation = accessGeneration.current, requestedLibrary=libraryKey;
    const result = await api(
      "/finance/reports?" +
        new URLSearchParams({ unitId, archived: String(archived) }),
    );
    if (generation === accessGeneration.current && requestedLibrary===libraryKeyRef.current) setReports(result.rows);
  }
  function beginRevision(source?: any) {
    fileGeneration.current++;
    setWorkbookReset(value => value + 1);
    setWorkbookPending(false);
    setReportId(source?.report_id ?? crypto.randomUUID());
    setExpectedVersion(source?.version ?? 0);
    setMetadata(source ? { ...source.metadata } : { ...blankMetadata });
    setCsv("");
    setFileName("");
    setReason("");
    setPreview(null);
    setReviewed(false);
    setPage(0);
    setMode("import");
    setError("");
  }
  async function openReport(id: string, version?: number) {
    const generation = ++requestGeneration.current;
    await perform(async () => {
      const info = await api("/finance/reports/" + id);
      const [source, events] = await Promise.all([
        api(
          "/finance/reports/" +
            id +
            "/versions/" +
            (version ?? info.report.version),
        ),
        api("/finance/reports/" + id + "/history"),
      ]);
      if (generation !== requestGeneration.current) return;
      setDetail(info);
      setRecord(source);
      setReportView(financeDefaultView());
      setHistory(events.rows);
      setArchiveReason("");
      setPage(0);
      setMode("detail");
    });
  }
  async function chooseFile(file: File | undefined) {
    if (!file) return;
    const generation = ++fileGeneration.current;
    setWorkbookReset(value => value + 1);
    setWorkbookPending(false);
    setCsv(""); setFileName(""); setPreview(null); setReviewed(false);
    if (file.size > 400000) {
      setError("Use a CSV file no larger than 400,000 bytes.");
      return;
    }
    await perform(async () => {
      const contents = await file.text();
      if (fileGeneration.current !== generation) return;
      setCsv(contents);
      setFileName(file.name);
      setPreview(null);
      setReviewed(false);
      setMetadata((previous: any) =>
        previous.sourceName
          ? previous
          : {
              ...previous,
              sourceName: file.name,
            },
      );
    });
  }
  function edit(field: string, value: string) {
    setMetadata((previous: any) => ({ ...previous, [field]: value }));
    setPreview(null);
    setReviewed(false);
  }
  async function previewImport(e: FormEvent) {
    e.preventDefault();
    if (workbookPending) return;
    const requestedKey = draftKey;
    const generation = accessGeneration.current;
    await perform(async () => {
      const result = await api("/finance/previews", {
        unitId,
        reportId,
        expectedVersion,
        metadata,
        csv,
        reason,
      });
      if (generation !== accessGeneration.current) return;
      if (draftKeyRef.current !== requestedKey) {
        notify("The source changed while previewing. Preview it again.");
        return;
      }
      setPreview(result);
      setReviewed(false);
      setPage(0);
    });
  }
  async function publish() {
    const generation = accessGeneration.current;
    await perform(async () => {
      const receipt = await api(
        "/finance/previews/" + preview.id + "/publish",
        {
          sourceHash: preview.sourceHash,
          fingerprint: preview.fingerprint,
          reviewed: true,
        },
      );
      if (generation !== accessGeneration.current) return;
      setCsv("");
      setMetadata({ ...blankMetadata });
      setReason("");
      setPreview(null);
      setMode("list");
      onDirty(false);
      await refresh();
      if (generation !== accessGeneration.current) return;
      notify(
        "Financial report version " +
          receipt.version +
          " published. Earlier versions are preserved.",
      );
      await openReport(receipt.reportId, receipt.version);
    });
  }
  async function runComparison() {
    const generation = ++comparisonGeneration.current,
      request = { ...compareInput },
      key = JSON.stringify(request);
    await perform(async () => {
      const result = await api("/finance/compare", request);
      if (generation === comparisonGeneration.current) {
        setComparison({ ...result, input: request, inputKey: key });
        setPage(0);
      }
    });
  }
  const rows =
      mode === "detail"
        ? (record?financeVisibleLines(record.lines,reportView):[])
        : mode === "import"
          ? preview?.lines
          : comparison?.rows,
    totalPages = Math.ceil((rows?.length ?? 0) / 50),
    pageRows = (rows ?? []).slice(page * 50, (page + 1) * 50),
    community = me.units.find((x: any) => x.id === unitId)?.name ?? "";
  const libraryRows=reports.filter(item=>(!libraryKind||item.metadata.kind===libraryKind)&&(!libraryCurrency||item.metadata.currency===libraryCurrency)&&[item.metadata.title,item.metadata.sourceName,item.metadata.from,item.metadata.to].some(value=>String(value).toLocaleLowerCase().includes(librarySearch.trim().toLocaleLowerCase()))).sort((a,b)=>libraryOrder==='title'?a.metadata.title.localeCompare(b.metadata.title):libraryOrder==='period'?b.metadata.to.localeCompare(a.metadata.to):0);
  const libraryCurrencies=[...new Set(reports.map(item=>item.metadata.currency))] as string[];
  const pagination = totalPages > 1 && (
    <div className="finance-pagination">
      <span>
        Lines {page * 50 + 1}–{Math.min((page + 1) * 50, rows.length)} of{" "}
        {rows.length}
      </span>
      <button
        className="button"
        disabled={!page}
        onClick={() => setPage(page - 1)}
      >
        Previous
      </button>
      <button
        className="button"
        disabled={page + 1 >= totalPages}
        onClick={() => setPage(page + 1)}
      >
        Next
      </button>
    </div>
  );
  return (
    <div className="finance-workspace">
      <header className="finance-header">
        <div>
          <span className="eyebrow">FINANCIAL REPORTS</span>
          <h2>See the story in your numbers.</h2>
          <p>
            Preserve source reports, review changes and compare exact amounts.
          </p>
        </div>
        <div className="finance-header-art" aria-hidden="true">
          <FileBarChart2 size={42} />
          <span />
          <span />
          <span />
        </div>
      </header>
      <div className="finance-toolbar">
        <label>
          Financial community
          <select
            aria-label="Financial community"
            value={unitId}
            disabled={busy || dirty}
            onChange={(e) => {
              requestGeneration.current++;
              setUnitId(e.target.value);
              setMode("list");
              setLeftId("");
              setRightId("");
              setComparison(null);
              setRecord(null);
            }}
          >
            {me.units.map((unit: any) => (
              <option key={unit.id} value={unit.id}>
                {unit.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button"
          onClick={() => leave("list")}
          disabled={busy}
        >
          Source reports
        </button>
        <button
          className="button"
          onClick={() => leave("compare")}
          disabled={busy}
        >
          Compare reports
        </button>
        {mode !== "import" && (
          <button
            className="button primary"
            onClick={() => beginRevision()}
            disabled={busy}
          >
            <Plus size={16} />
            Import report
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="finance-scope">
        Imported report amounts for analysis. Billing, payments and accounting
        postings are not performed here.
      </p>
      {mode === "list" && (
        <Panel
          title="Source report library"
          detail="Every published revision retains its original source and review reason."
        >
          <div className="finance-library-overview" aria-label="Source library overview"><article><FileBarChart2 size={22}/><div><strong>{reports.length}</strong><span>{archived?'Archived':'Active'} source reports</span></div></article><article><Layers3 size={22}/><div><strong>{reports.filter(item=>item.metadata.kind==='actual').length}</strong><span>Actual report sources</span></div></article><article><Coins size={22}/><div><strong>{libraryCurrencies.length?libraryCurrencies.join(' · '):'—'}</strong><span>Currencies kept separate</span></div></article></div>
          <div className="finance-library-filters"><label>Find a source<span><Search size={16}/><input aria-label="Find a financial source report" value={librarySearch} maxLength={160} placeholder="Report name, source or dates" onChange={event=>setLibrarySearch(event.target.value)}/></span></label><label>Report type<select value={libraryKind} onChange={event=>setLibraryKind(event.target.value)}><option value="">All report types</option>{Object.entries(financeKindLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>Currency<select value={libraryCurrency} onChange={event=>setLibraryCurrency(event.target.value)}><option value="">All currencies</option>{libraryCurrencies.map(value=><option key={value}>{value}</option>)}</select></label><label>Order<select value={libraryOrder} onChange={event=>setLibraryOrder(event.target.value)}><option value="latest">Recently updated</option><option value="title">Report name</option><option value="period">Latest report period</option></select></label></div>
          <div className="finance-list-toolbar">
            <label className="finance-check">
              <input
                type="checkbox"
                checked={archived}
                onChange={(e) => setArchived(e.target.checked)}
              />
              Show archived reports only
            </label>
            <button
              className="button ghost"
              onClick={() => void perform(refresh)}
            >
              <RefreshCw size={16} />
              Refresh
            </button>
          </div>
          {listLoading?<p className="finance-library-state" role="status">Loading source reports…</p>:!reports.length ? (
            <Empty
              title="Start with a source report"
              detail="Download the template, enter your report lines, then preview the data before publishing."
            />
          ) : (
            <div className="finance-report-grid">
              {libraryRows.map((item) => (
                <button
                  className={'finance-report-card kind-'+item.metadata.kind}
                  key={item.id}
                  onClick={() => void openReport(item.id)}
                  disabled={busy}
                >
                  <span>
                    <FileBarChart2 size={22} />
                    <Badge>{financeKindLabels[item.metadata.kind]}{item.archived?' · archived':''}</Badge>
                  </span>
                  <h3>{item.metadata.title}</h3>
                  <p>{item.metadata.sourceName}</p>
                  <small>
                    {financePeriod(item.metadata)}
                  </small>
                  <strong>
                    {item.metadata.currency} · {item.line_count} lines · Version{" "}
                    {item.version}
                  </strong>
                  <small>{basisLabel(item.metadata.basis)}</small>
                </button>
              ))}
            </div>
          )}
          {!listLoading&&reports.length>0&&<p className="finance-library-state" role="status">{libraryRows.length?`${libraryRows.length} of ${reports.length} reports match this view.`:'No reports match these filters.'} <button type="button" onClick={()=>{setLibrarySearch('');setLibraryKind('');setLibraryCurrency('');setLibraryOrder('latest');}}>Reset library filters</button></p>}
          <div className="finance-footer">
            <button
              className="button"
              onClick={() =>
                void perform(() =>
                  financeDownload(
                    "/finance/template",
                    "financial-report-template.csv",
                  ),
                )
              }
            >
              <ArrowDownToLine size={16} />
              Download blank template
            </button>
          </div>
        </Panel>
      )}
      {mode === "import" && (
        <>
          <Panel
            title={
              expectedVersion
                ? "Import a corrected source"
                : "Import a financial report"
            }
            detail="Choose the report context explicitly. Amounts support four decimal places; line codes are exact identifiers."
          >
            <form className="finance-import-form" onSubmit={previewImport}>
              <div className="finance-form-grid">
                <label>
                  Report title
                  <input
                    value={metadata.title}
                    required
                    minLength={2}
                    maxLength={160}
                    onChange={(e) => edit("title", e.target.value)}
                  />
                </label>
                <label>
                  Source name
                  <input
                    value={metadata.sourceName}
                    required
                    minLength={2}
                    maxLength={160}
                    onChange={(e) => edit("sourceName", e.target.value)}
                  />
                </label>
                <label>
                  Currency code
                  <input
                    value={metadata.currency}
                    required
                    pattern="[A-Z]{3}"
                    minLength={3}
                    maxLength={3}
                    placeholder="Three-letter code"
                    onChange={(e) =>
                      edit("currency", e.target.value.toUpperCase())
                    }
                  />
                </label>
                <label>
                  Report kind
                  <select
                    aria-label="Report kind"
                    value={metadata.kind}
                    required
                    onChange={(e) => edit("kind", e.target.value)}
                  >
                    <option value="">Choose a kind</option>
                    {["actual", "budget", "forecast", "other"].map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Period type
                  <select
                    aria-label="Period type"
                    value={metadata.basis}
                    required
                    onChange={(e) => edit("basis", e.target.value)}
                  >
                    <option value="">Choose how these dates apply</option>
                    {["period_activity", "as_of_balance", "other"].map((x) => (
                      <option key={x} value={x}>
                        {basisLabel(x)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Report from
                  <input
                    type="date"
                    value={metadata.from}
                    required
                    onChange={(e) => edit("from", e.target.value)}
                  />
                </label>
                <label>
                  Report through
                  <input
                    type="date"
                    value={metadata.to}
                    required
                    min={metadata.from}
                    onChange={(e) => edit("to", e.target.value)}
                  />
                </label>
              </div>
              <label>
                Report context note
                <textarea
                  value={metadata.note}
                  maxLength={2000}
                  onChange={(e) => edit("note", e.target.value)}
                />
              </label>
              <label>
                Reason for this version
                <textarea
                  value={reason}
                  minLength={3}
                  maxLength={1000}
                  required
                  onChange={(e) => {
                    setReason(e.target.value);
                    setPreview(null);
                    setReviewed(false);
                  }}
                />
              </label>
              <div className="finance-source-picker">
                <label>
                  <Upload size={20} />
                  Choose source CSV
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    disabled={busy}
                    onChange={(e) => void chooseFile(e.target.files?.[0])}
                  />
                </label>
                <span>{fileName || "No source selected"}</span>
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    void perform(() =>
                      financeDownload(
                        "/finance/template",
                        "financial-report-template.csv",
                      ),
                    )
                  }
                >
                  Blank template
                </button>
              </div>
              <WorkbookImport key={workbookReset} disabled={busy} onPending={setWorkbookPending}
                onAccessDenied={clearFinanceAccess}
                onClear={() => { fileGeneration.current++; setCsv(''); setFileName(''); setPreview(null); setReviewed(false); }}
                onApply={(result, name) => {
                  fileGeneration.current++; setCsv(result.csv); setFileName(name + ' · converted CSV'); setPreview(null); setReviewed(false);
                  setMetadata((previous: any) => previous.sourceName ? previous : { ...previous, sourceName: name });
                }} />
              <p>
                Use one unique line code per row. Mark each row as detail,
                subtotal or total. Only detail rows are included in the detail
                sum.
              </p>
              <div className="finance-actions">
                <button className="button primary" disabled={busy || !csv || workbookPending}>
                  Preview report
                </button>
                <button
                  type="button"
                  className="button ghost"
                  onClick={() => leave("list")}
                >
                  Cancel import
                </button>
              </div>
            </form>
          </Panel>
          {preview && (
            <Panel
              title="Review before publishing"
              detail={
                "Version " +
                (preview.expectedVersion + 1) +
                " · " +
                preview.lines.length +
                " lines · private preview expires in 24 hours"
              }
            >
              <div className="finance-metrics">
                <div>
                  <small>Full source detail sum</small>
                  <strong>
                    <Amount
                      value={preview.totals.detailSum}
                      currency={preview.metadata.currency}
                    />
                  </strong>
                </div>
                <div>
                  <small>Detail / subtotal / total rows</small>
                  <strong>
                    {preview.totals.details} / {preview.totals.subtotals} /{" "}
                    {preview.totals.totals}
                  </strong>
                </div>
              </div>
              <p className="finance-table-hint">Scroll the table sideways to see all columns.</p><div className="finance-table-scroll" tabIndex={0} role="region" aria-label="Financial data table">
                <Lines rows={pageRows} currency={preview.metadata.currency} />
              </div>
              {pagination}
              <div className="finance-footer">
                <label className="finance-check">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    onChange={(e) => setReviewed(e.target.checked)}
                  />
                  I reviewed the source, context, line kinds and amounts.
                </label>
                <button
                  className="button primary"
                  disabled={busy || !reviewed}
                  onClick={() => void publish()}
                >
                  Publish report version
                </button>
              </div>
            </Panel>
          )}
        </>
      )}
      {mode === "detail" && record && (
        <Panel
          title={record.metadata.title}
          detail={record.metadata.sourceName + " · " + community}
        >
          <div className="finance-detail-toolbar">
            <label>
              Report version
              <select
                aria-label="Report version"
                value={record.version}
                disabled={busy}
                onChange={(e) =>
                  void openReport(record.report_id, Number(e.target.value))
                }
              >
                {detail.versions.map((item: any) => (
                  <option key={item.version} value={item.version}>
                    Version {item.version} ·{" "}
                    {new Date(item.created_at).toLocaleDateString()}
                  </option>
                ))}
              </select>
            </label>
            <Badge>{financeKindLabels[record.metadata.kind]}</Badge>
            <span>
              {financePeriod(record.metadata)} ·{" "}
              {basisLabel(record.metadata.basis)}
            </span>
          </div>
          <div className="finance-metrics">
            <div>
              <small>Full source detail sum</small>
              <strong>
                <Amount
                  value={record.totals.detailSum}
                  currency={record.metadata.currency}
                />
              </strong>
            </div>
            <div>
              <small>Source lines</small>
              <strong>{record.lines.length}</strong>
            </div>
          </div>
          <p className="finance-description">
            {record.reason}
            {record.metadata.note && " · " + record.metadata.note}
          </p>
          <p className="finance-description">Currency: {record.metadata.currency}. The period type describes the source dates; cash or accrual accounting method is not recorded by this import.</p>
          <FinanceReportStudio lines={record.lines} currency={record.metadata.currency} view={reportView} onChange={value=>{setReportView(value);setPage(0);}}/>
          <div className="finance-actions finance-view-downloads"><button type="button" className="button primary" disabled={busy} onClick={()=>void perform(()=>financeDownload('/finance/reports/'+record.report_id+'/versions/'+record.version+'?'+financeViewQuery(reportView),financeFilename(record.metadata.title,record.version)))}><ArrowDownToLine size={16}/>Download this view CSV</button><button type="button" className="button" disabled={busy} onClick={()=>printReport(true)}><Printer size={16}/>Print this view</button><span>{rows?.length??0} selected lines · chosen column order · {reportView.decimalPlaces} decimal places</span></div>
          <div className="finance-actions">
            <button
              className="button"
              onClick={() =>
                void perform(() =>
                  financeDownload(
                    "/finance/reports/" +
                      record.report_id +
                      "/versions/" +
                      record.version +
                      "?format=csv",
                    "financial-report.csv",
                  ),
                )
              }
            >
              <ArrowDownToLine size={16} />
              Full source CSV
            </button>
            <button
              className="button"
              onClick={() =>
                void perform(() =>
                  financeDownload(
                    "/finance/reports/" +
                      record.report_id +
                      "/versions/" +
                      record.version,
                    "financial-report.json",
                  ),
                )
              }
            >
              Full source JSON
            </button>
            <button
              className="button"
              onClick={() =>
                void perform(() =>
                  financeDownload(
                    "/finance/reports/" +
                      record.report_id +
                      "/versions/" +
                      record.version +
                      "?format=source",
                    "financial-report-original-source.txt",
                  ),
                )
              }
            >
              Original source text
            </button>
            <button className="button" onClick={() => window.print()}>
              <Printer size={16} />
              Print full report
            </button>
            {!detail.report.archived &&
              record.version === detail.report.version && (
                <button
                  className="button primary"
                  onClick={() => beginRevision(record)}
                >
                  Import correction
                </button>
              )}
          </div>
          <p className="finance-table-hint">Scroll the table sideways to see all columns.</p><div className="finance-table-scroll" tabIndex={0} role="region" aria-label="Financial data table">
            <FinanceViewTable rows={pageRows} currency={record.metadata.currency} columns={reportView.columns} decimalPlaces={reportView.decimalPlaces}/>
          </div>
          {!rows?.length&&<p className="finance-library-state">No lines match this view. Reset the view or adjust its filters.</p>}
          {pagination}
          <details className="finance-provenance">
            <summary>Source and revision history</summary>
            <p>
              Source SHA256: <code>{record.source_hash}</code>
            </p>
            <p>
              Reviewed content: <code>{record.fingerprint}</code>
            </p>
            {detail.versions.map((version: any) => (
              <p key={version.version}>
                Version {version.version} · {version.reason}
              </p>
            ))}
            {history.map((event) => (
              <p key={event.id}>
                {event.action} · {event.detail.reason}
              </p>
            ))}
          </details>
          <form
            className="finance-archive"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                await api("/finance/reports/" + record.report_id + "/archive", {
                  stateVersion: detail.report.state_version,
                  archived: !detail.report.archived,
                  reason: archiveReason,
                });
                await refresh();
                await openReport(record.report_id, record.version);
                notify(
                  detail.report.archived
                    ? "Report restored."
                    : "Report archived; source versions are retained.",
                );
              });
            }}
          >
            <label>
              {detail.report.archived ? "Restoration reason" : "Archive reason"}
              <input
                value={archiveReason}
                required
                minLength={3}
                maxLength={1000}
                onChange={(e) => setArchiveReason(e.target.value)}
              />
            </label>
            <button className="button" disabled={busy}>
              <Archive size={16} />
              {detail.report.archived ? "Restore report" : "Archive report"}
            </button>
          </form>
        </Panel>
      )}
      {mode === "compare" && (
        <>
          <Panel
            title="Compare two report versions"
            detail="Choose explicit sources. Missing lines stay missing; different line kinds cannot produce a difference."
          >
            <div className="finance-compare-form">
              {(["left", "right"] as const).map((side) => (
                <fieldset key={side}>
                  <legend>
                    {side === "left" ? "Left · baseline" : "Right · comparison"}
                  </legend>
                  <label>
                    {side === "left" ? "Left report" : "Right report"}
                    <select
                      aria-label={side==='left'?'Left report':'Right report'}
                      value={side === "left" ? leftId : rightId}
                      onChange={(e) => {
                        (side === "left" ? setLeftId : setRightId)(
                          e.target.value,
                        );
                        setPage(0);
                      }}
                    >
                      <option value="">Choose a report</option>
                      {reports.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.metadata.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {side === "left" ? "Left version" : "Right version"}
                    <select
                      aria-label={side==='left'?'Left version':'Right version'}
                      value={side === "left" ? leftVersion : rightVersion}
                      onChange={(e) =>
                        (side === "left" ? setLeftVersion : setRightVersion)(
                          Number(e.target.value),
                        )
                      }
                    >
                      <option value={0}>Choose a version</option>
                      {(side === "left" ? leftOptions : rightOptions).map(
                        (item) => (
                          <option key={item.version} value={item.version}>
                            Version {item.version} · {item.metadata.from}–
                            {item.metadata.to}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                </fieldset>
              ))}
            </div>
            <div className="finance-footer">
              <label className="finance-check">
                <input
                  type="checkbox"
                  checked={periodsReviewed}
                  onChange={(e) => setPeriodsReviewed(e.target.checked)}
                />
                I reviewed any differences in the reporting periods.
              </label>
              <button
                className="button primary"
                disabled={busy || !leftVersion || !rightVersion}
                onClick={() => void runComparison()}
              >
                Run comparison
              </button>
            </div>
          </Panel>
          {comparison && (
            <Panel
              title="Comparison results"
              detail={
                comparison.left.metadata.title +
                " → " +
                comparison.right.metadata.title
              }
            >
              {!comparisonFresh && (
                <p className="finance-stale" role="status">
                  Selections changed. Run the comparison again before exporting.
                </p>
              )}
              <div className="finance-metrics">
                <div>
                  <small>Baseline detail sum · {comparison.currency}</small>
                  <strong>
                    <Amount value={comparison.leftTotals.detailSum} />
                  </strong>
                </div>
                <div>
                  <small>Compared detail sum · {comparison.currency}</small>
                  <strong>
                    <Amount value={comparison.rightTotals.detailSum} />
                  </strong>
                </div>
                <div>
                  <small>Matched / unmatched lines</small>
                  <strong>
                    {comparison.matched} / {comparison.unmatched}
                  </strong>
                </div>
              </div>
              <p className="finance-description">{comparison.notice}</p>
              <div className="finance-comparison-sources">{(['left','right'] as const).map(side=><article key={side}><small>{side==='left'?'Baseline':'Compared report'} · version {comparison[side].version}</small><strong>{comparison[side].metadata.title}</strong><span>{financePeriod(comparison[side].metadata)} · {basisLabel(comparison[side].metadata.basis)} · {comparison.currency}</span></article>)}</div>
              <div className="finance-actions">
                <button
                  className="button"
                  disabled={!comparisonFresh || busy}
                  onClick={() =>
                    void perform(() =>
                      financeDownloadPost(
                        "/finance/compare/export",
                        comparison.input,
                        "financial-comparison.csv",
                      ),
                    )
                  }
                >
                  Comparison CSV
                </button>
                <button
                  className="button"
                  disabled={!comparisonFresh || busy}
                  onClick={() =>
                    void perform(() =>
                      financeDownloadPost(
                        "/finance/compare/export?format=json",
                        comparison.input,
                        "financial-comparison.json",
                      ),
                    )
                  }
                >
                  Comparison JSON
                </button>
                <button
                  className="button"
                  disabled={!comparisonFresh}
                  onClick={() => window.print()}
                >
                  <Printer size={16} />
                  Print comparison
                </button>
              </div>
              <ComparisonChart
                rows={comparison.rows}
                currency={comparison.currency}
              />
              <p className="finance-table-hint">Scroll the table sideways to see all columns.</p><div className="finance-table-scroll" tabIndex={0} role="region" aria-label="Financial data table">
                <ComparisonTable rows={pageRows} />
              </div>
              {pagination}
            </Panel>
          )}
        </>
      )}
      {createPortal(<section className="finance-print-area">
        {mode === "detail" && record ? (
          <>
            <h1>{record.metadata.title}</h1>
            <p>
              {community} · {record.metadata.currency} · {record.metadata.from}–
              {record.metadata.to} · Version {record.version}
            </p>
            <p>
              {record.metadata.sourceName} · {record.reason}
            </p>
            {printView?<><p>Customized view · {rows?.length??0} of {record.lines.length} lines · {basisLabel(record.metadata.basis)}. Cash/accrual method is not recorded.</p><p>{financeSelectionSummary(reportView)}</p><FinanceViewTable rows={rows??[]} currency={record.metadata.currency} columns={reportView.columns} decimalPlaces={reportView.decimalPlaces}/></>:<Lines rows={record.lines} currency={record.metadata.currency}/>}
            {!printView&&<p>Source SHA256: {record.source_hash}</p>}
          </>
        ) : mode === "compare" && comparisonFresh ? (
          <>
            <h1>Financial report comparison</h1>
            <p>
              {community} · {comparison.currency}
            </p>
            <p>
              {comparison.left.metadata.title} (v{comparison.left.version}) →{" "}
              {comparison.right.metadata.title} (v{comparison.right.version})
            </p>
            <p>{comparison.notice}</p>
            <ComparisonTable rows={comparison.rows} />
            <p>Sources SHA256: {comparison.sourceHash}</p>
          </>
        ) : null}
      </section>,document.body)}
    </div>
  );
}
