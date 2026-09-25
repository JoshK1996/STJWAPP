import test from 'node:test';
import assert from 'node:assert/strict';
import { communityAssignmentBlockers, sameEmployeeAssignments, selectEmployeeJob } from '../shared/employee-job-selection';

test('selecting a job adds its explicit community and retains unrelated assignments', () => {
  const before = { unitIds: ['school'], jobIds: ['teacher'] };
  const result = selectEmployeeJob(before, { id: 'caregiver', title: 'Caregiver', unitId: 'care', active: true }, true);
  assert.deepEqual(result, { unitIds: ['school', 'care'], jobIds: ['teacher', 'caregiver'] });
  assert.deepEqual(before, { unitIds: ['school'], jobIds: ['teacher'] });
  assert.deepEqual(selectEmployeeJob(result, { id: 'caregiver', title: 'Caregiver', unitId: 'care', active: true }, true), result);
});
test('community removal is blocked by selected jobs, including retained archived jobs', () => {
  const jobs = [{ id: 'teacher', title: 'Teacher', unitId: 'school', active: true }, { id: 'old', title: 'Former role', unitId: 'school', active: false }, { id: 'caregiver', title: 'Caregiver', unitId: 'care', active: true }];
  assert.deepEqual(communityAssignmentBlockers({ unitIds: ['school', 'care'], jobIds: ['teacher', 'old', 'caregiver'] }, jobs, 'school'), ['Teacher', 'Former role']);
  const result = selectEmployeeJob({ unitIds: ['school', 'care'], jobIds: ['teacher', 'caregiver'] }, jobs[0]!, false);
  assert.deepEqual(result, { unitIds: ['school', 'care'], jobIds: ['caregiver'] });
  assert.deepEqual(communityAssignmentBlockers(result, jobs, 'school'), []);
});
test('assignment equality ignores order and duplicate presentation without hiding real changes', () => {
  assert.equal(sameEmployeeAssignments({ unitIds: ['school', 'care'], jobIds: ['teacher', 'teacher'] }, { unitIds: ['care', 'school'], jobIds: ['teacher'] }), true);
  assert.equal(sameEmployeeAssignments({ unitIds: ['school'], jobIds: ['teacher'] }, { unitIds: ['school'], jobIds: [] }), false);
});
