export const workspaceDestinations = [
  {id:'overview',label:'Workforce overview',description:'Hours, people and interactive charts',keywords:'dashboard home analytics graphs',tone:'violet'},
  {id:'clock',label:'My time clock',description:'Clock in, change jobs and take a break',keywords:'punch work timeclock',tone:'blue'},
  {id:'time-records',label:'Time records',description:'Review shifts, corrections and missing time',keywords:'history timesheet attendance',tone:'teal'},
  {id:'payroll',label:'Payroll',description:'Employee hours, job breakdowns and accountant exports',keywords:'excel csv wages pay rates',tone:'peach'},
  {id:'staff',label:'People & jobs',description:'Staff accounts, roles and job assignments',keywords:'employees directory members',tone:'violet'},
  {id:'schedule',label:'Schedule',description:'Staff shifts and planned work',keywords:'roster availability timetable',tone:'blue'},
  {id:'calendar',label:'Calendar',description:'Personal and community events',keywords:'dates plans events',tone:'peach'},
  {id:'messages',label:'Messages',description:'Internal conversations and saved drafts',keywords:'inbox communication mail',tone:'teal'},
  {id:'requests',label:'Requests',description:'Time off, schedule changes and reviews',keywords:'pto leave approval adjustment',tone:'peach'},
  {id:'reports',label:'Reports & imports',description:'Saved reports, templates and data imports',keywords:'excel csv documents library financial',tone:'violet'},
  {id:'school',label:'School records',description:'Students, families, classes and attendance',keywords:'grades teachers admissions curriculum',tone:'blue'},
  {id:'care',label:'Childcare',description:'Care programs, arrivals and verified pickups',keywords:'early childhood children check in',tone:'teal'},
  {id:'dismissal',label:'Dismissal',description:'Accountable pickup, bus and care handoffs',keywords:'arrival parent after school release',tone:'peach'},
  {id:'workspace',label:'School & community',description:'Explore the connected workspace',keywords:'modules organization roadmap',tone:'violet'},
  {id:'audit',label:'Activity log',description:'Review recorded changes and their history',keywords:'audit security events',tone:'blue'},
  {id:'settings',label:'Settings',description:'Appearance, navigation and account security',keywords:'theme colors password pin mfa personalize',tone:'teal'},
] as const;
export type WorkspaceDestination = (typeof workspaceDestinations)[number];
export function availableDestinations(actor:{mode:string;role:string},report:boolean):WorkspaceDestination[] {
  if(actor.mode==='pin')return workspaceDestinations.filter(item=>item.id==='clock');
  if(actor.mode!=='password')return [];
  return workspaceDestinations.filter(item=>!(['staff','payroll'].includes(item.id)&&!report)&&!(item.id==='audit'&&!['developer','owner','admin','finance'].includes(actor.role)));
}
export function findDestinations(items:readonly WorkspaceDestination[],query:string) {
  const words=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter(item=>words.every(word=>`${item.label} ${item.description} ${item.keywords}`.toLocaleLowerCase().includes(word)));
}
