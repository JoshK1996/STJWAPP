import {DateTime} from 'luxon';
import {workforceUtcMicrosSchema} from './workforce-reports-v2';

function micros(value:string){
 // A chart ceiling can add one digit to the validated 20-digit source maximum.
 if(!/^(0|[1-9][0-9]{0,20})$/.test(value))throw new RangeError('Use a nonnegative whole microsecond value.');
 return BigInt(value);
}

/** Exact recorded duration. Decimal hours and payroll rounding are deliberately not inferred. */
export function formatWorkforceDuration(value:string,expanded=false):string{
 const total=micros(value),hours=total/3_600_000_000n,minutes=(total%3_600_000_000n)/60_000_000n;
 const seconds=(total%60_000_000n)/1_000_000n,fraction=(total%1_000_000n).toString().padStart(6,'0').replace(/0+$/,'');
 const parts:string[]=[];
 if(hours)parts.push(`${hours.toLocaleString('en-US')} ${expanded?(hours===1n?'hour':'hours'):'h'}`);
 if(minutes)parts.push(`${minutes} ${expanded?(minutes===1n?'minute':'minutes'):'min'}`);
 if(seconds||fraction||!parts.length)parts.push(`${seconds}${fraction?'.'+fraction:''} ${expanded?(seconds===1n&&!fraction?'second':'seconds'):'s'}`);
 return parts.join(' ');
}

/** Only this bounded visual percentage becomes Number; source totals and labels remain integers. */
export function workforceBarPercent(value:string,maximum:string):number{
 const amount=micros(value),max=micros(maximum);
 if(max===0n)return 0;
 const bounded=amount>max?max:amount;
 return Number(bounded*10_000n/max)/100;
}

export function workforceChartScale(values:readonly string[]):{maximum:string;ticks:string[]}{
 let maximum=1_000_000n;
 for(const value of values){const amount=micros(value);if(amount>maximum)maximum=amount;}
 // Four equal divisions stay integral without rounding any recorded total.
 maximum=((maximum+3n)/4n)*4n;
 return {maximum:maximum.toString(),ticks:[4n,3n,2n,1n,0n].map(part=>(maximum*part/4n).toString())};
}

export function exactWorkforceTimestamp(value:string,zone:string):string{
 workforceUtcMicrosSchema.parse(value);
 const local=DateTime.fromISO(value).setZone(zone);
 const fraction=value.slice(20,26).replace(/0+$/,'');
 return `${local.toFormat('LLL d, yyyy · h:mm:ss')}${fraction?'.'+fraction:''} ${local.toFormat('a (ZZ)')}`;
}
