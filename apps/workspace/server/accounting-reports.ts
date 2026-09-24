import type { Express } from 'express';
import ExcelJS from 'exceljs';
import type { AppRequest } from './auth';
import type { Database, Queryable, Row } from './db';
import { audit, requireCondition, type Actor } from './security';
import { accountingTransaction, requireAccountingConfig } from './accounting-ledger';
import { accountingReportInput, formatAmount, displayAccountingAmount, type AccountingReport, type AccountingStatementRow, accountingReportViews } from '../shared/accounting';
import { toCsv } from './reports';

/** Organization serialization gives a consistent source across these reads and all posting workflows. */
export async function buildAccountingReport(tx: Queryable, actor: Actor, raw: unknown): Promise<AccountingReport> {
  const input = accountingReportInput.parse(raw), config = await requireAccountingConfig(tx, actor), params: unknown[] = [actor.org_id, input.from, input.to];
  let scope = '';const scopeLabels:string[]=[];
  for (const [key, table, field] of [['unitId', 'units', 'unit_id'], ['fundId', 'accounting_funds', 'fund_id'], ['programId', 'accounting_funds', 'program_id'], ['grantId', 'accounting_funds', 'grant_id'], ['accountId', 'accounting_accounts', 'account_id']] as const) {
    if (!input[key]) continue;
    const selected=(await tx.query(`SELECT * FROM ${table} WHERE org_id=$1 AND id=$2`, [actor.org_id, input[key]])).rows[0];
    requireCondition(selected, 404, 'Selected accounting scope not found.');
    if(table==='accounting_funds')requireCondition(selected.kind===key.slice(0,-2),400,'Use the matching fund, program or grant filter.');
    scopeLabels.push(`${{unitId:'Community',fundId:'Fund',programId:'Program',grantId:'Grant',accountId:'Account'}[key]}: ${selected.name}`);
    params.push(input[key]); scope += ` AND l.${field}=$${params.length}`;
  }
  const totals = (await tx.query(`SELECT l.account_id,
    COALESCE(sum(CASE WHEN j.entry_date<$2 THEN l.debit-l.credit ELSE 0 END),0)::text AS opening,
    COALESCE(sum(CASE WHEN j.entry_date>=$2 THEN l.debit ELSE 0 END),0)::text AS debit,
    COALESCE(sum(CASE WHEN j.entry_date>=$2 THEN l.credit ELSE 0 END),0)::text AS credit
    FROM accounting_journal_lines l JOIN accounting_journals j ON j.id=l.journal_id AND j.org_id=l.org_id
    WHERE l.org_id=$1 AND j.status='posted' AND j.entry_date<=$3 ${scope} GROUP BY l.account_id`, params)).rows;
  const byAccount = new Map(totals.map(row => [row.account_id, row]));
  const accounts = (await tx.query('SELECT * FROM accounting_accounts WHERE org_id=$1 ORDER BY code', [actor.org_id])).rows;
  const fmt = (amount: bigint) => formatAmount(amount, config.precision), normal = (account: Row, units: bigint) => ['liability', 'equity', 'revenue'].includes(account.type) ? -units : units;
  let totalDebit = 0n, totalCredit = 0n, closingDebit = 0n, closingCredit = 0n;
  const ending = new Map<string, bigint>(), activity = new Map<string, bigint>(), functionals = new Map<string, bigint>();
  const trialBalance = accounts.filter(account => !input.accountId || input.accountId === account.id).map(account => {
    const row = byAccount.get(account.id), opening = BigInt(row?.opening ?? '0'), debit = BigInt(row?.debit ?? '0'), credit = BigInt(row?.credit ?? '0'), closing = opening + debit - credit;
    totalDebit += debit; totalCredit += credit; closingDebit += closing > 0n ? closing : 0n; closingCredit += closing < 0n ? -closing : 0n;
    ending.set(account.type, (ending.get(account.type) ?? 0n) + normal(account, closing));
    activity.set(account.type, (activity.get(account.type) ?? 0n) + normal(account, debit - credit));
    if (account.type === 'expense') functionals.set(account.functional_category, (functionals.get(account.functional_category) ?? 0n) + debit - credit);
    return {accountId: account.id, code: account.code, name: account.name, type: account.type,
      openingDebit: fmt(opening > 0n ? opening : 0n), openingCredit: fmt(opening < 0n ? -opening : 0n), debit: fmt(debit), credit: fmt(credit), closingDebit: fmt(closing > 0n ? closing : 0n), closingCredit: fmt(closing < 0n ? -closing : 0n)};
  });
  const statementRow = (key: string, label: string, type: string, amount: bigint): AccountingStatementRow => ({key, label, type, amount: fmt(amount)});
  const get = (map: Map<string,bigint>, key:string) => map.get(key) ?? 0n;
  const position = [statementRow('assets', 'Assets', 'asset', get(ending,'asset')), statementRow('liabilities','Liabilities','liability',get(ending,'liability')),
    statementRow('equity','Posted equity / net assets','equity',get(ending,'equity')), statementRow('accumulated_activity','Revenue less expenses not transferred to equity','equity',get(ending,'revenue')-get(ending,'expense')),
    statementRow('net_assets','Total net assets','total',get(ending,'equity')+get(ending,'revenue')-get(ending,'expense'))];
  const activities = [statementRow('revenue','Revenue','revenue',get(activity,'revenue')), statementRow('expense','Expenses','expense',get(activity,'expense')), statementRow('change','Change in net assets from activity','total',get(activity,'revenue')-get(activity,'expense'))];
  const functionalExpenses = ['program','management','fundraising','unclassified'].map(key => statementRow(key, {program:'Program services',management:'Management and general',fundraising:'Fundraising',unclassified:'Unclassified expenses'}[key]!, 'expense', get(functionals,key)));
  const cashRows = (await tx.query(`SELECT l.cash_flow_category,
    COALESCE(sum(CASE WHEN j.entry_date<$2 THEN l.debit-l.credit ELSE 0 END),0)::text AS opening,
    COALESCE(sum(CASE WHEN j.entry_date>=$2 THEN l.debit-l.credit ELSE 0 END),0)::text AS movement
    FROM accounting_journal_lines l JOIN accounting_journals j ON j.id=l.journal_id AND j.org_id=l.org_id
    WHERE l.org_id=$1 AND j.status='posted' AND j.entry_date<=$3 AND (l.account_snapshot->>'isCash')::boolean=true ${scope}
    GROUP BY l.cash_flow_category`, params)).rows;
  const cash = new Map(cashRows.map(row=>[row.cash_flow_category,BigInt(row.movement)]));
  const cashOpening = cashRows.reduce((sum,row)=>sum+BigInt(row.opening),0n), cashChange = cashRows.reduce((sum,row)=>sum+BigInt(row.movement),0n);
  const cashMovement = [statementRow('opening','Opening cash','balance',cashOpening),
    ...['operating','investing','financing','unclassified'].map(key=>statementRow(key, key.charAt(0).toUpperCase()+key.slice(1)+' cash movements','movement',get(cash,key))),
    statementRow('change','Net cash movement','total',cashChange), statementRow('closing','Closing cash','balance',cashOpening+cashChange)];
  const ledgerRows = (await tx.query(`SELECT j.id AS journal_id,j.entry_date::text AS date,j.description,j.reference,l.account_id,l.account_snapshot,l.debit::text AS debit,l.credit::text AS credit,l.memo
    FROM accounting_journal_lines l JOIN accounting_journals j ON j.id=l.journal_id AND j.org_id=l.org_id
    WHERE l.org_id=$1 AND j.status='posted' AND j.entry_date BETWEEN $2 AND $3 ${scope} ORDER BY j.entry_date,j.created_at,j.id,l.line_number LIMIT 1001`, params)).rows;
  const notices = ['Posted journals only. Drafts and imported source reports are excluded.', 'Cash movement classification comes from recorded cash lines; unclassified movements remain visible.', 'Statements require accountant review of opening balances, classifications and period adjustments.'];
  if(!config.reviewed)notices.unshift('These books use starter settings. Review currency, accounting basis and fiscal dates in Accounting settings.');
  if (input.unitId || input.fundId || input.programId || input.grantId || input.accountId) notices.push('This is a selected-dimension view. Debits and credits may differ when offsetting lines use other dimensions.');
  if (get(functionals,'unclassified') !== 0n) notices.push('Some expenses have no approved functional classification.');
  if (get(cash,'unclassified') !== 0n) notices.push('Unclassified cash movements must be classified before treating this as a complete cash-flow statement.');
  if (ledgerRows.length > 1000) notices.push('Ledger detail shows the first 1,000 lines. Narrow the dates or account for complete detail; statement totals include every matching posted line.');
  return {from:input.from,to:input.to,currency:config.currency,precision:config.precision,basis:config.basis,scopeLabels,filters:{...(input.unitId?{unitId:input.unitId}:{}),...(input.fundId?{fundId:input.fundId}:{}),...(input.programId?{programId:input.programId}:{}),...(input.grantId?{grantId:input.grantId}:{}),...(input.accountId?{accountId:input.accountId}:{})},trialBalance,
    totals:{debit:fmt(totalDebit),credit:fmt(totalCredit),closingDebit:fmt(closingDebit),closingCredit:fmt(closingCredit)},position,activities,functionalExpenses,cashMovement,
    ledger:ledgerRows.slice(0,1000).map(row=>({journalId:row.journal_id,date:row.date,description:row.description,reference:row.reference,accountId:row.account_id,accountName:row.account_snapshot.name,debit:fmt(BigInt(row.debit)),credit:fmt(BigInt(row.credit)),memo:row.memo})),ledgerTruncated:ledgerRows.length>1000,notices};
}
export function accountingReportCsv(report: AccountingReport,view:typeof accountingReportViews[number]='trial_balance'): string {
  if(view==='ledger'){
    requireCondition(!report.ledgerTruncated,400,'Narrow the dates or choose an account before exporting complete ledger detail.');
    return toCsv(report.ledger.map(row=>({'Date':row.date,'Description':row.description,'Reference':row.reference,'Account':row.accountName,'Debit':row.debit,'Credit':row.credit,'Memo':row.memo,'Currency':report.currency})),['Date','Description','Reference','Account','Debit','Credit','Memo','Currency']);
  }
  if(view!=='trial_balance'){
    const rows={position:report.position,activities:report.activities,functional_expenses:report.functionalExpenses,cash_movement:report.cashMovement}[view];
    return toCsv(rows.map(row=>({'Description':row.label,'Amount':row.amount,'Currency':report.currency,'Period starts':report.from,'Period ends':report.to,'Accounting basis':report.basis,'Scope':report.scopeLabels.join('; ')||'Entire organization'})),['Description','Amount','Currency','Period starts','Period ends','Accounting basis','Scope']);
  }
  return toCsv(report.trialBalance.map(row=>({'Account code':row.code,'Account name':row.name,'Account type':row.type.charAt(0).toUpperCase()+row.type.slice(1),'Currency':report.currency,'Period starts':report.from,'Period ends':report.to,
    'Opening debit':row.openingDebit,'Opening credit':row.openingCredit,'Period debit':row.debit,'Period credit':row.credit,'Closing debit':row.closingDebit,'Closing credit':row.closingCredit,'Scope':report.scopeLabels.join('; ')||'Entire organization'})),
    ['Account code','Account name','Account type','Currency','Period starts','Period ends','Opening debit','Opening credit','Period debit','Period credit','Closing debit','Closing credit','Scope']);
}
/** Excel displays small values numerically while preserving values beyond Excel's 15-digit accuracy as text. */
function excelMoney(value:string):number|string {const significant=value.replace(/[-.]/g,'').replace(/^0+/,'');return significant.length<=15?Number(value):value;}
export async function accountingReportWorkbook(report:AccountingReport):Promise<Buffer>{
  const workbook=new ExcelJS.Workbook();workbook.creator='STJW Workspace';workbook.subject='Posted accounting reports';workbook.created=new Date();
  const numberFormat='#,##0'+(report.precision?'.'+'0'.repeat(report.precision):'')+';[Red](#,##0'+(report.precision?'.'+'0'.repeat(report.precision):'')+')';
  const add=(name:string,title:string,headers:string[],rows:(string|number)[][],moneyColumns:number[]=[]):ExcelJS.Worksheet=>{
    const sheet=workbook.addWorksheet(name,{views:[{state:'frozen',ySplit:5}],pageSetup:{paperSize:9,orientation:headers.length>5?'landscape':'portrait',fitToPage:true,fitToWidth:1,fitToHeight:0,printTitlesRow:'5:5',margins:{left:0.3,right:0.3,top:0.5,bottom:0.5,header:0.2,footer:0.2}}});
    sheet.mergeCells(1,1,1,headers.length);sheet.getCell('A1').value=title;sheet.getRow(1).height=31;sheet.getCell('A1').font={name:'Aptos Display',size:19,bold:true,color:{argb:'FF16324F'}};
    sheet.mergeCells(2,1,2,headers.length);sheet.getCell('A2').value=`${report.from} to ${report.to} · ${report.currency} · ${report.basis==='accrual'?'Accrual':'Cash'} basis · Posted entries`;
    sheet.getRow(2).height=25;sheet.getCell('A2').font={size:10,color:{argb:'FF44556B'}};
    sheet.mergeCells(3,1,3,headers.length);sheet.getCell('A3').value='Accountant review required. Exact journal evidence remains in the app. Values over 15 significant digits are preserved as text.';sheet.getRow(3).height=32;sheet.getCell('A3').alignment={wrapText:true};sheet.getCell('A3').font={size:9,color:{argb:'FF59677A'}};
    const heading=sheet.getRow(5);heading.values=headers;heading.height=28;heading.eachCell(cell=>{cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF224D75'}};cell.font={bold:true,color:{argb:'FFFFFFFF'},size:10};cell.alignment={vertical:'middle',wrapText:true};});
    for(const values of rows){const row=sheet.addRow(values);row.height=32;row.eachCell((cell,column)=>{cell.font={name:'Aptos',size:10};cell.alignment={vertical:'middle',wrapText:true,horizontal:moneyColumns.includes(column)?'right':'left'};if(row.number%2===0)cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF0F6FA'}};if(moneyColumns.includes(column))cell.numFmt=numberFormat;});
      const maxLines=Math.max(...values.map((value,index)=>Math.ceil(String(value).length/(moneyColumns.includes(index+1)?18:headers[index].includes('Description')||headers[index]==='Memo'?44:28))));row.height=Math.min(280,Math.max(32,maxLines*13+10));}
    headers.forEach((label,index)=>{sheet.getColumn(index+1).width=moneyColumns.includes(index+1)?19:label.includes('Description')||label==='Memo'?48:label.includes('name')||label==='Account'?34:22;});
    sheet.autoFilter={from:{row:5,column:1},to:{row:5,column:headers.length}};sheet.headerFooter.oddFooter='STJW Workspace · &P of &N';return sheet;
  };
  const overview=add('Report overview','Accounting report packet',['About this packet','Details'],[
    ['Period',`${report.from} to ${report.to}`],['Currency',report.currency],['Accounting basis',report.basis==='accrual'?'Accrual':'Cash'],['Scope',report.scopeLabels.join('; ')||'Entire organization'],
    ['Period debit',displayAccountingAmount(report.totals.debit)],['Period credit',displayAccountingAmount(report.totals.credit)],['Ledger detail',report.ledgerTruncated?'First 1,000 lines only. Narrow dates or account for a complete ledger export.':`${report.ledger.length} posted ${report.ledger.length===1?'line':'lines'}`],
    ...report.notices.map(notice=>['Review note',notice])]);overview.getColumn(1).width=32;overview.getColumn(2).width=90;
  const highlight=(sheet:ExcelJS.Worksheet,row:number)=>sheet.getRow(row).eachCell(cell=>{cell.font={name:'Aptos',bold:true,size:10,color:{argb:'FF07584E'}};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFDDF5EC'}};cell.border={top:{style:'thin',color:{argb:'FF8CCDB7'}}};});
  const openingDebit=formatAmount(report.trialBalance.reduce((sum,row)=>sum+BigInt(row.openingDebit.replace('.','')),0n),report.precision),openingCredit=formatAmount(report.trialBalance.reduce((sum,row)=>sum+BigInt(row.openingCredit.replace('.','')),0n),report.precision);
  const trial=add('Trial balance','Trial balance',['Account code','Account name','Type','Opening debit','Opening credit','Period debit','Period credit','Closing debit','Closing credit'],[
    ...report.trialBalance.map(row=>[row.code,row.name,row.type.charAt(0).toUpperCase()+row.type.slice(1),...[row.openingDebit,row.openingCredit,row.debit,row.credit,row.closingDebit,row.closingCredit].map(excelMoney)]),
    ['','Total','',...[openingDebit,openingCredit,report.totals.debit,report.totals.credit,report.totals.closingDebit,report.totals.closingCredit].map(excelMoney)]],[4,5,6,7,8,9]);highlight(trial,trial.rowCount);
  for(const[name,title,rows]of[['Financial position','Financial position at '+report.to,report.position],['Activities','Statement of activities',report.activities],['Functional expenses','Functional expenses',report.functionalExpenses],['Cash movements','Cash movement classification',report.cashMovement]]as const){const sheet=add(name,title,['Description','Amount ('+report.currency+')'],rows.map(row=>[row.label,excelMoney(row.amount)]),[2]);rows.forEach((row,index)=>{if(row.type==='total'||row.key==='closing')highlight(sheet,index+6);});}
  add('Ledger detail',report.ledgerTruncated?'Ledger detail — first 1,000 lines':'Posted ledger detail',['Date','Description','Reference','Account','Debit','Credit','Memo'],report.ledger.map(row=>[row.date,row.description,row.reference,row.accountName,excelMoney(row.debit),excelMoney(row.credit),row.memo]),[5,6]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
export function installAccountingReports(app:Express,db:Database) {
  app.get('/api/accounting/reports',async(req,res)=>{
    const input=accountingReportInput.parse(req.query);
    const result=await accountingTransaction(db,(req as AppRequest).actor,(req as AppRequest).sessionHash,async(tx,actor)=>{
      const report=await buildAccountingReport(tx,actor,input),file=input.format==='xlsx'?await accountingReportWorkbook(report):input.format==='csv'?accountingReportCsv(report,input.view):undefined;
      await audit(tx,actor,'accounting.report_read',null,input); return {report,file};
    });
    if(input.format==='csv')res.type('text/csv').attachment(`${input.view.replace(/_/g,'-')}-${input.from}-${input.to}.csv`).send(result.file);
    else if(input.format==='xlsx')res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment(`accounting-${input.from}-${input.to}.xlsx`).send(result.file);
    else res.json(result.report);
  });
}
