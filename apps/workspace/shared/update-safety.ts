export type UpdateSafety = {
  pendingWrites: number;
  clockPending: boolean;
  unsavedChanges: boolean;
  busy: boolean;
  workflowOpen: boolean;
  formHasChanges: boolean;
  accountSetup: boolean;
};

/** Updating is an explicit user action; uncertain work is never discarded. */
export function updateBlockReason(state: UpdateSafety): string {
  if (state.clockPending) return 'Resolve the clock request using Retry or Refresh before updating.';
  if (state.pendingWrites > 0 || state.busy) return 'Wait for the current action to finish before updating.';
  if (state.accountSetup) return 'Finish account setup or verification before updating.';
  if (state.unsavedChanges || state.formHasChanges) return 'Save or clear your changes before updating.';
  if (state.workflowOpen) return 'Finish or close the open form before updating.';
  return '';
}
