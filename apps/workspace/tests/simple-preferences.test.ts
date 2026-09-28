import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizePreferences,preferencesSchema,preferencesPatchSchema} from '../shared/preferences';

test('simple workspace defaults preserve existing appearance and independently repair new saved views',()=>{
  const prior={theme:'dark',customColor:'#123456',accent:'custom',textSize:'large',reducedMotion:true};
  const value=normalizePreferences({...prior,scheduleView:{period:'invalid'},payrollExport:{columns:['unknown']},favoritePages:['clock','clock']});
  assert.equal(value.theme,'dark');assert.equal(value.accent,'custom');assert.equal(value.textSize,'large');assert.equal(value.reducedMotion,true);
  assert.equal(value.workspaceMode,'simple');assert.equal(value.scheduleView.period,'week');assert.equal(value.scheduleView.view,'assigned');
  assert.equal(value.payrollExport.includeOverview,true);assert.ok(value.favoritePages.includes('clock'));
  assert.deepEqual(preferencesSchema.parse(value),value);
});
test('personal default patches cannot introduce shared flag rules or silently reset other fields',()=>{
  assert.deepEqual(preferencesPatchSchema.parse({workspaceMode:'full'}),{workspaceMode:'full'});
  assert.equal(preferencesPatchSchema.safeParse({attentionPolicy:{}}).success,false);
  assert.equal(preferencesPatchSchema.safeParse({favoritePages:['payroll','payroll']}).success,false);
  assert.equal(preferencesPatchSchema.safeParse({scheduleView:{employeeId:'someone'}}).success,false);
  const patch=preferencesPatchSchema.parse({scheduleView:{period:'day',view:'assigned',employeeId:null,unitId:null,jobId:null}});
  assert.deepEqual(Object.keys(patch),['scheduleView']);
});
