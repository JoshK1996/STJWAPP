import {formatWorkforceDuration,exactWorkforceTimestamp} from '../shared/workforce-display';
import './exact-workforce-time.css';

export function ExactWorkforceDuration({value}:{value:string}){
 return <span className="exact-workforce-time" title={`${value} microseconds`} aria-label={formatWorkforceDuration(value,true)}>{formatWorkforceDuration(value)}</span>;
}

export function ExactWorkforceTimestamp({value,zone}:{value:string;zone:string}){
 return <time dateTime={value} title={value}>{exactWorkforceTimestamp(value,zone)}</time>;
}

const durationKeys=new Set(['duration_microseconds','recorded_duration_microseconds','work_microseconds','break_microseconds']);
const instantKeys=new Set(['started_at','ended_at','clipped_started_at','clipped_ended_at']);
export function workforceColumnLabel(label:string){return label.replace(/ \(microseconds\)$/,'');}
export function ExactWorkforceCell({column,value,zone}:{column:string;value:unknown;zone:string}){
 if(value==null)return <>{column==='ended_at'||column==='recorded_duration_microseconds'?'Unknown / open':column.startsWith('clipped_')?'No contribution':'—'}</>;
 if(durationKeys.has(column))return <ExactWorkforceDuration value={String(value)}/>;
 if(instantKeys.has(column))return <time dateTime={String(value)}>{String(value)}</time>;
 return <>{String(value)}</>;
}
export function WorkforcePrecisionEvidence({asOf,zone,provenance}:{asOf:string;zone:string;provenance:{range:{from:string;toExclusive:string};workMicroseconds:string;breakMicroseconds:string}}){
 return <div className="workforce-precision-evidence">
  <p className="panel-note">Exact microsecond report. Durations show hours, minutes and seconds, including recorded fractions. CSV and JSON keep whole microseconds. Unknown / open means no recorded ending or full duration; it is not zero.</p>
  <p>Data as of <ExactWorkforceTimestamp value={asOf} zone={zone}/></p>
  <p>Recorded work: <ExactWorkforceDuration value={provenance.workMicroseconds}/> · Recorded breaks: <ExactWorkforceDuration value={provenance.breakMicroseconds}/></p>
  <details><summary>Exact source timestamps and units</summary><p>UTC range: <code>{provenance.range.from}</code> through <code>{provenance.range.toExclusive}</code> (end excluded).</p><p>Source observation: <code>{asOf}</code> · Timezone: {zone} · Precision version 2 · Duration unit: microsecond.</p></details>
 </div>;
}
