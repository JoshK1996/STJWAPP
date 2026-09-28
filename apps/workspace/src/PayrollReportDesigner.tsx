import { Check, Eye, FileSpreadsheet, Layers3, Save, SlidersHorizontal } from 'lucide-react';
import { DateTime } from 'luxon';
import type { PayrollHoursReport } from '../shared/payroll-hours';
import { buildPayrollPresentationTable, defaultPayrollPresentationOptions, payrollPresentationColumns, payrollPresentationLabels, payrollPresentationOptionsSchema, type PayrollPresentationOptions } from '../shared/payroll-presentation';
import './payroll-report-designer.css';

type Props = { report: PayrollHoursReport; options: PayrollPresentationOptions; onChange: (options: PayrollPresentationOptions) => void; busy: boolean; onExport: (format: 'csv'|'xlsx') => void; onSaveDefaults: () => void; savingDefaults: boolean; defaultsSaved: boolean };
export default function PayrollReportDesigner({report,options,onChange,busy,onExport,onSaveDefaults,savingDefaults,defaultsSaved}:Props) {
  const parsed=payrollPresentationOptionsSchema.safeParse(options);
  const table=buildPayrollPresentationTable(report,parsed.success?parsed.data:{...options,title:'Employee hours report'});
  const change=(patch:Partial<PayrollPresentationOptions>)=>onChange({...options,...patch});
  const date=(value:string)=>DateTime.fromISO(value).toFormat('LLL d, yyyy');
  return <section className="payroll-report-designer" aria-label="Customize payroll export">
    <div className="report-designer-heading"><span className="report-designer-icon"><SlidersHorizontal size={25}/></span><div><span className="eyebrow">REPORT SETUP</span><h3>A report that works for you.</h3><p>Pick a layout, check the preview, then download.</p></div></div>
    <fieldset className="report-designer-presets" disabled={busy}><legend>1 · Choose a layout</legend>
      <button type="button" aria-pressed={options.grouping==='employees'&&!options.includeAudit} onClick={()=>onChange({...defaultPayrollPresentationOptions})}><FileSpreadsheet size={19}/><span><strong>Accountant summary</strong><small>One row per employee</small></span></button>
      <button type="button" aria-pressed={options.grouping==='jobs'&&!options.includeAudit} onClick={()=>onChange({...defaultPayrollPresentationOptions,title:'Employee hours by job',grouping:'jobs'})}><Layers3 size={19}/><span><strong>Job breakdown</strong><small>Jobs and communities</small></span></button>
      <button type="button" aria-pressed={options.includeAudit} onClick={()=>onChange({...defaultPayrollPresentationOptions,title:'Hours review with audit evidence',includeAudit:true})}><Eye size={19}/><span><strong>Detailed review</strong><small>Summary + exact Excel sheets</small></span></button>
    </fieldset>
    <div className="report-designer-selection" role="status"><Check size={17}/><span>{options.grouping==='jobs'?'One row per employee and job':'One row per employee'} · {table.columns.length} columns · {options.decimalPlaces} decimal places</span></div>
    <details className="report-designer-options"><summary><SlidersHorizontal size={17}/><span>Adjust columns, title & Excel sections<small>Optional — this layout is ready to download.</small></span></summary>
    <fieldset className="report-designer-settings" disabled={busy}><legend className="sr-only">Report appearance</legend>
      <label className="report-designer-title">Report title<input value={options.title} maxLength={100} onChange={e=>change({title:e.target.value})}/></label>
      <label>Rows<select aria-label="Rows" value={options.grouping} onChange={e=>change({grouping:e.target.value as PayrollPresentationOptions['grouping']})}><option value="employees">Employee</option><option value="jobs">Employee + job</option></select></label>
      <label>Order<select aria-label="Order" value={options.sortBy} onChange={e=>change({sortBy:e.target.value as PayrollPresentationOptions['sortBy']})}><option value="name">Employee name</option><option value="work_hours">Most work hours</option></select></label>
      <label>Decimal places<select aria-label="Decimal places" value={options.decimalPlaces} onChange={e=>change({decimalPlaces:Number(e.target.value) as 2|3|4})}><option value={2}>2 — 12.50 hours</option><option value={3}>3 — 12.500 hours</option><option value={4}>4 — 12.5000 hours</option></select></label>
    </fieldset>
    <fieldset className="report-designer-columns" disabled={busy}><legend>Columns to include</legend>{payrollPresentationColumns.map(column=><label key={column}><input type="checkbox" checked={options.columns.includes(column)} disabled={column==='workHours'} onChange={e=>change({columns:e.target.checked?[...options.columns,column]:options.columns.filter(item=>item!==column)})}/><span>{payrollPresentationLabels[column]}{column==='workHours'&&<small>Always included</small>}</span></label>)}</fieldset>
    <fieldset className="report-designer-sections" disabled={busy}><legend>Excel sections</legend>
    <label className="report-designer-audit"><input type="checkbox" checked={options.includeOverview} onChange={e=>change({includeOverview:e.target.checked})}/><span><strong>Include visual overview</strong><small>Totals and employee hour bars before the detailed table. Turn off for a single simple data sheet.</small></span></label>
    <label className="report-designer-audit"><input type="checkbox" checked={options.includeAudit} disabled={busy} onChange={e=>change({includeAudit:e.target.checked})}/><span><strong>Include exact audit sheets in Excel</strong><small>Add original segments, internal references, exact durations, and source JSON. The readable summary stays first.</small></span></label>
    </fieldset></details>
    <div className="report-designer-preview-title"><h4>2 · Check your preview</h4><span>{options.includeOverview?'Overview + hours table':'Hours table only'}{options.includeAudit?' + audit sheets':''}</span></div>
    <div className="report-designer-paper"><div className="report-designer-paper-heading"><div><span>STJW · HOURS REPORT</span><h4>{options.title.trim()||'Employee hours report'}</h4><p>{date(report.report.query.start)} – {date(report.report.query.end)} · {report.report.timezone}</p></div><span className="report-designer-badge">Preview</span></div>
      <div className="table-scroll" role="region" aria-label="Payroll export preview" tabIndex={0}><table><caption>{table.rows.length.toLocaleString()} {options.grouping==='jobs'?'employee / job':'employee'} rows · {options.decimalPlaces} decimal places</caption><thead><tr>{table.columns.map(column=><th key={column.key} scope="col">{column.label}</th>)}</tr></thead><tbody>{table.rows.slice(0,8).map((row,index)=><tr key={index}>{row.map((cell,col)=><td key={col}>{cell}</td>)}</tr>)}{!table.rows.length&&<tr><td colSpan={table.columns.length}>No recorded hours for these filters.</td></tr>}</tbody></table></div>
      <p className="report-designer-preview-note">{table.rows.length>8?`Previewing 8 of ${table.rows.length.toLocaleString()} rows. Downloads include every selected row. `:''}Period, community, and employee filters above control the export; the employee search below does not. Downloads capture current permitted data again.</p>
    </div>
    {!parsed.success&&<p className="error" role="alert">Choose a report title of 1–100 characters on one line.</p>}
    <div className="report-designer-save"><div><strong>{defaultsSaved?'Your report setup is saved':'Use this setup next time'}</strong><p>Save the layout to your account. Your dates and employee filters stay separate.</p></div><button type="button" className="button secondary" disabled={busy||savingDefaults||!parsed.success||defaultsSaved} onClick={onSaveDefaults}>{defaultsSaved?<Check size={17}/>:<Save size={17}/>} {savingDefaults?'Saving…':defaultsSaved?'Saved for me':'Save my report setup'}</button></div>
    <div className="report-designer-footer"><div className="report-designer-format"><strong>3 · Download Excel — recommended</strong><p>Excel includes sized columns, wrapped text, colors and print settings. CSV is plain data and cannot store column widths, colors or expanded cells.</p></div><div><button type="button" className="button primary" disabled={busy||!parsed.success} onClick={()=>onExport('xlsx')}><FileSpreadsheet size={18}/>Download Excel</button><button type="button" className="button secondary" disabled={busy||!parsed.success} onClick={()=>onExport('csv')}>CSV · plain data</button></div></div>
    <p className="report-designer-limits">Hours are rounded after exact aggregation. Breaks are separate; wages and overtime are not calculated.</p>
  </section>;
}
