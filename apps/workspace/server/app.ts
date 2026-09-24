import { installStaffScheduling } from './staff-scheduling';
import { installScheduleRequests } from './schedule-requests';
import { installOrganization } from "./organization";
import { installOrganizationBranding } from './organization-branding';
import { savePersonalPreferences } from './preferences';
import { installGradeImports } from "./grade-imports";
import { installAttendanceReports } from "./attendance-reports";
import { installFinance } from './finance';
import { installImportWorkbooks } from './import-workbooks';
import { installCompensation } from './compensation';
import { installTimetable } from "./timetable";
import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { installPublicWeb } from './web-static';
import type { Database } from './db';
import { installAuth, type AppRequest } from './auth';
import { audit, canReport, digest, manages, opaqueToken, orgWide, Problem, requireCondition } from './security';
import { listStaff, listRequests, createRequest, reviewRequest } from './workforce';
import { getAuthenticatedClock, applyAuthenticatedClockCommand } from './clock-session';
import { createStaffAccount } from './temporary-credentials';
import { createManagedJob, updateStaffAccount, issueManagedStaffSetupLink } from './staff-authority';
import { getAuthorizedWorkforceReport, exportAuthorizedWorkforceReport, type WorkforceReportProof } from './workforce-report-access';
import { getAuthorizedWorkforceReportV2, exportAuthorizedWorkforceReportV2 } from './workforce-report-v2-access';
import { getAuthorizedPayrollHours, exportAuthorizedPayrollHours } from './payroll-hours';
import { installStaffImports } from './imports';
import { suggestImport } from './jev';
import { moduleCatalog, requestInput, dateOnly, isOwnerRole } from '../shared/contracts';
import { installCommunity } from './community';
import { installSchool } from './school';
import { installAttendance } from './attendance';
import { installTimeRecords } from './time-records';
import { installTimeAdjustments } from './time-adjustments';
import { installAdmissions } from './admissions';
import { installGrading } from './grading';
import { installCare } from './care';
import { installDismissal } from './dismissal';
import { installReportLibrary } from './report-library';
import { installReportSnapshots } from './report-snapshots';
import { installCareTransfers } from './care-transfers';
import { installSchoolImports } from './school-imports';
import { installReportCards } from './report-cards';
import { installStandingPolicies } from './standing-policies';
import { installGpaPolicies } from './gpa-policies';
import { installGpaDecisions } from './gpa-decisions';
import { installStandingDecisions } from './standing-decisions';
export interface AppConfig {origin:string;production:boolean;staffDomain:string;demo:boolean}
const actorOf=(req:Request)=>(req as AppRequest).actor;
const sessionHashOf=(req:Request)=>(req as AppRequest).sessionHash;
const reportProofOf=(req:Request):WorkforceReportProof=>actorOf(req).mode==='api'
  ? {mode:'api',hash:digest(req.get('authorization')!.slice(7))}
  : {mode:'password',hash:(req as AppRequest).sessionHash};
const idOf=(value:unknown)=>z.uuid().parse(value);
export function createApp(db: Database, config: AppConfig) {
  const app=express();
  app.disable('x-powered-by');
  app.set('trust proxy',false);
  app.use(helmet({strictTransportSecurity:false,contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'data:'],connectSrc:["'self'"],frameAncestors:["'none'"],upgradeInsecureRequests:config.production?[]:null}}}));
  app.use('/api',(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  app.get('/api/health',async(_req,res)=>{await db.query('SELECT 1');res.json({status:'ok',version:'0.1.0'});});
  app.get('/api/config',(_req,res)=>res.json({name:'St. Joseph the Worker',demo:config.demo}));
  app.use('/api',(req,res,next)=>{
    if(!['GET','HEAD','OPTIONS'].includes(req.method)) {
      requireCondition(req.get('origin')===config.origin,403,'Request origin is not allowed.');
      requireCondition(req.is('application/json'),415,'Send application/json.');
    }
    next();
  });
  app.use(express.json({limit:'512kb'}));app.use(cookieParser());
  installAuth(app,db,config.production);
  app.get('/api/me',async(req,res)=>{
    const actor=actorOf(req);const organization=(await db.query('SELECT * FROM organizations WHERE id=$1',[actor.org_id])).rows[0];
    const units=(await db.query('SELECT * FROM units WHERE org_id=$1 AND ($2::boolean OR id=ANY($3::uuid[])) ORDER BY name',[actor.org_id,orgWide(actor),actor.unit_ids])).rows;
    res.json({actor,organization,units,permissions:{manage:manages(actor),report:canReport(actor),owner:isOwnerRole(actor.role)&&actor.mode==='password'},modules:moduleCatalog});
  });
  app.patch('/api/me/preferences',async(req,res)=>{
    res.set('Cache-Control','private, no-store').json(await savePersonalPreferences(db,actorOf(req),sessionHashOf(req),req.body));
  });
  installOrganizationBranding(app,db);
  app.get('/api/clock',async(req,res)=>res.set('Cache-Control','private, no-store').json(await getAuthenticatedClock(db,actorOf(req),(req as AppRequest).sessionHash!)));
  app.post('/api/clock',async(req,res)=>res.set('Cache-Control','private, no-store').json(await applyAuthenticatedClockCommand(db,actorOf(req),(req as AppRequest).sessionHash!,req.body)));
  app.get('/api/board',async(req,res)=>{
    const actor=actorOf(req);requireCondition(canReport(actor),403,'Manager or reporting access required.');
    const rows=(await db.query(`SELECT u.id AS user_id,u.name,j.title AS job_title,n.name AS unit_name,n.id AS unit_id,g.kind,s.started_at,g.started_at AS segment_started_at
      FROM shifts s JOIN users u ON u.id=s.user_id JOIN segments g ON g.shift_id=s.id AND g.org_id=s.org_id AND g.revision=s.revision AND g.ended_at IS NULL
      JOIN jobs j ON j.id=g.job_id JOIN units n ON n.id=j.unit_id WHERE s.org_id=$1 AND s.ended_at IS NULL AND ($2::boolean OR n.id=ANY($3::uuid[])) ORDER BY u.name`,[actor.org_id,orgWide(actor),actor.unit_ids])).rows;
    res.json({rows,asOf:new Date().toISOString()});
  });
  app.get('/api/staff',async(req,res)=>{requireCondition(canReport(actorOf(req)),403,'Staff access required.');res.json({rows:await listStaff(db,actorOf(req))});});
  app.get('/api/jobs',async(req,res)=>{
    const actor=actorOf(req);
    const rows=(await db.query('SELECT j.*,u.name AS unit_name FROM jobs j JOIN units u ON u.id=j.unit_id WHERE j.org_id=$1 AND ($2::boolean OR j.unit_id=ANY($3::uuid[])) ORDER BY u.name,j.title',[actor.org_id,orgWide(actor),actor.unit_ids])).rows;res.json({rows});
  });
  app.post('/api/jobs',async(req,res)=>{
    res.set('Cache-Control','private, no-store').status(201).json(await createManagedJob(db,actorOf(req),sessionHashOf(req),req.body));
  });
  app.post('/api/staff',async(req,res)=>{
    const result=await createStaffAccount(db,actorOf(req),(req as AppRequest).sessionHash,req.body,config.staffDomain,config.origin);
    res.status(201).json(result);
  });
  app.patch('/api/staff/:id',async(req,res)=>{
    res.set('Cache-Control','private, no-store').json(await updateStaffAccount(db,actorOf(req),sessionHashOf(req),idOf(req.params.id),req.body,config.staffDomain));
  });
  app.post('/api/staff/:id/setup-link',async(req,res)=>{
    res.set('Cache-Control','private, no-store').json(await issueManagedStaffSetupLink(db,actorOf(req),sessionHashOf(req),idOf(req.params.id),config.origin));
  });
  app.get('/api/requests',async(req,res)=>res.json({rows:await listRequests(db,actorOf(req))}));
  app.post('/api/requests',async(req,res)=>res.status(201).json(await createRequest(db,actorOf(req),requestInput.parse(req.body))));
  app.post('/api/requests/:id/review',async(req,res)=>{
    const input=z.object({status:z.enum(['approved','declined']),note:z.string().trim().min(3).max(1000)}).strict().parse(req.body);
    res.json(await reviewRequest(db,actorOf(req),idOf(req.params.id),input.status,input.note));
  });
  installStaffScheduling(app,db);
  installScheduleRequests(app,db);
  const reportQuery=z.object({start:dateOnly,end:dateOnly,group:z.enum(['hour','day','week','month','year']).default('day'),unitId:z.uuid().optional(),userId:z.uuid().optional(),columns:z.string().max(500).optional()});
  app.get('/api/reports',async(req,res)=>res.json(await getAuthorizedWorkforceReport(db,actorOf(req),reportProofOf(req),reportQuery.parse(req.query))));
  app.get('/api/reports/export',async(req,res)=>{
    const query=reportQuery.parse(req.query);
    const csv=await exportAuthorizedWorkforceReport(db,actorOf(req),reportProofOf(req),query);
    res.attachment(`stjw-segments-${query.start}-${query.end}.csv`).type('text/csv').send(csv);
  });
  app.get('/api/reports/v2',async(req,res)=>res.json(await getAuthorizedWorkforceReportV2(db,actorOf(req),reportProofOf(req),req.query)));
  app.get('/api/payroll/hours',async(req,res)=>res.json(await getAuthorizedPayrollHours(db,actorOf(req),reportProofOf(req),req.query)));
  app.get('/api/payroll/hours/export',async(req,res)=>{
    const controller=new AbortController();
    const closed=()=>{if(!res.writableEnded)controller.abort();};
    res.once('close',closed);
    try{
      const result=await exportAuthorizedPayrollHours(db,actorOf(req),reportProofOf(req),req.query,{signal:controller.signal});
      if(controller.signal.aborted)return;
      res.set('Cache-Control','private, no-store').set('X-STJW-Report-As-Of',result.asOf)
        .attachment(`stjw-payroll-hours-${result.query.start}-${result.query.end}.${result.format}`)
        .type(result.format==='xlsx'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':result.format==='csv'?'text/csv':'application/json').send(result.body);
    }finally{res.off('close',closed);}
  });
  app.get('/api/reports/v2/export',async(req,res)=>{
    const result=await exportAuthorizedWorkforceReportV2(db,actorOf(req),reportProofOf(req),req.query);
    res.set('X-STJW-Report-Version','2').set('X-STJW-Duration-Unit','microsecond').set('X-STJW-Report-As-Of',result.asOf)
      .attachment(`stjw-segments-v2-${result.query.start}-${result.query.end}.${result.format}`)
      .type(result.format==='csv'?'text/csv':'application/json').send(result.body);
  });
  app.get('/api/audit',async(req,res)=>{
    const actor=actorOf(req);requireCondition(['developer','owner','admin','finance'].includes(actor.role),403,'Organization-wide audit access required.');
    const limit=z.coerce.number().int().min(1).max(500).default(100).parse(req.query.limit);
    const rows=(await db.query('SELECT a.*,u.name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id WHERE a.org_id=$1 ORDER BY a.created_at DESC,a.id LIMIT $2',[actor.org_id,limit])).rows;res.json({rows});
  });
  installStaffImports(app,db,config.staffDomain);
  app.post('/api/imports/suggest',async(req,res)=>{
    res.set('Cache-Control','private, no-store');
    const actor=actorOf(req);requireCondition(manages(actor),403,'Import management access required.');
    const input=z.object({headers:z.array(z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9 _./()%:-]+$/)).min(1).max(40)}).strict().parse(req.body);
    try{res.json(await suggestImport(db,actor,input.headers,(req as AppRequest).sessionHash));}catch(error){if(error instanceof Problem)throw error;throw new Problem(503,'Jev could not return a suggestion. Please choose a template manually.');}
  });
  app.get('/api/tokens',async(req,res)=>{const actor=actorOf(req);requireCondition(isOwnerRole(actor.role),403,'Owner access required.');res.json({rows:(await db.query('SELECT id,name,scopes,expires_at,revoked_at FROM api_tokens WHERE org_id=$1 ORDER BY expires_at DESC',[actor.org_id])).rows});});
  app.post('/api/tokens',async(req,res)=>{
    const actor=actorOf(req);requireCondition(isOwnerRole(actor.role),403,'Owner access required.');
    const input=z.object({name:z.string().trim().min(2).max(80),scopes:z.array(z.enum(['reports:read','staff:read'])).min(1).max(2),days:z.number().int().min(1).max(90)}).strict().parse(req.body);
    const token=opaqueToken(),id=randomUUID();await db.transaction(async tx=>{await tx.query('INSERT INTO api_tokens(id,org_id,user_id,token_hash,name,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,actor.org_id,actor.id,digest(token),input.name,JSON.stringify(input.scopes),new Date(Date.now()+input.days*86400000)]);await audit(tx,actor,'api_token.created',id,{name:input.name,scopes:input.scopes});});res.json({id,token});
  });
  app.post('/api/tokens/:id/revoke',async(req,res)=>{
    const actor=actorOf(req);requireCondition(isOwnerRole(actor.role),403,'Owner access required.');const id=idOf(req.params.id);
    await db.transaction(async tx=>{await tx.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1 AND org_id=$2',[id,actor.org_id]);await audit(tx,actor,'api_token.revoked',id);});res.json({ok:true});
  });
  installCommunity(app,db);
  installSchool(app,db);
  installSchoolImports(app,db);
  installReportCards(app,db);
  installStandingPolicies(app,db);
  installGpaPolicies(app,db);
  installGpaDecisions(app,db);
  installStandingDecisions(app,db);
  installTimetable(app,db);
  installAttendanceReports(app,db);
  installCare(app,db);
  installDismissal(app,db);
  installReportLibrary(app,db);
  installReportSnapshots(app,db);
  installFinance(app,db);
  installImportWorkbooks(app,db);
  installCompensation(app,db);
  installCareTransfers(app,db);
  installAttendance(app,db);
  installTimeRecords(app,db);
  installTimeAdjustments(app,db);
  installAdmissions(app,db);
  installGrading(app,db);
  installGradeImports(app,db);
  installOrganization(app,db);
  app.use('/api',(_req,res)=>res.status(404).json({error:'Endpoint not found.'}));
  installPublicWeb(app);
  app.use((error:any,_req:Request,res:Response,_next:NextFunction)=>{
    if(error instanceof z.ZodError) return res.status(400).json({error:error.issues.map(x=>`${x.path.join('.')}: ${x.message}`).join('; ')});
    if(error instanceof Problem)return res.status(error.status).json({error:error.message});
    if(error.code==='23505')return res.status(409).json({error:'This record already exists or conflicts with another change. Refresh and try again.'});
    if(error.code==='23503')return res.status(400).json({error:'A referenced record is unavailable.'});
    if(error.type==='entity.too.large')return res.status(413).json({error:'The request is too large.'});
    if(error instanceof SyntaxError || error.message==='CSV_INVALID')return res.status(400).json({error:'The submitted data could not be parsed.'});
    const incident=randomUUID();console.error(JSON.stringify({incident,code:error.code??'internal_error'}));res.status(500).json({error:'The operation could not be completed.',incident});
  });
  return app;
}
