export type EmployeeJobChoice = { id: string; title: string; unitId: string; active: boolean };
export type EmployeeAssignmentSelection = { unitIds: string[]; jobIds: string[] };

/** A job explicitly brings its community with it; unrelated selections are retained. */
export function selectEmployeeJob(selection: EmployeeAssignmentSelection, job: EmployeeJobChoice, checked: boolean): EmployeeAssignmentSelection {
  return checked
    ? { unitIds: [...new Set([...selection.unitIds, job.unitId])], jobIds: [...new Set([...selection.jobIds, job.id])] }
    : { unitIds: selection.unitIds, jobIds: selection.jobIds.filter(id => id !== job.id) };
}

/** Removing a community never silently removes jobs. The employee must unassign them first. */
export function communityAssignmentBlockers(selection: EmployeeAssignmentSelection, jobs: EmployeeJobChoice[], unitId: string): string[] {
  return jobs.filter(job => job.unitId === unitId && selection.jobIds.includes(job.id)).map(job => job.title);
}

export function sameEmployeeAssignments(left: EmployeeAssignmentSelection, right: EmployeeAssignmentSelection): boolean {
  return (['unitIds', 'jobIds'] as const).every(key => {
    const a = [...new Set(left[key])].sort(), b = [...new Set(right[key])].sort();
    return a.length === b.length && a.every((value, index) => value === b[index]);
  });
}
