export const messages = {
  CONFIGURATION: "STJW MCP configuration is invalid. Set a bare HTTPS STJW_API_ORIGIN and a valid STJW_API_TOKEN in the launching environment.",
  INVALID_INPUT: "Invalid tool input. Use only the documented dates, grouping and optional identity filters.",
  UNAUTHENTICATED: "STJW rejected this credential. It may be expired or revoked. Ask the owner to review the configured token.",
  FORBIDDEN: "STJW denied this read. Review token expiry or revocation, the required scope, and the account's current access.",
  RATE_LIMITED: "The request limit was reached. Wait before trying again.",
  BUSY: "The connector is handling its maximum number of requests. Try again after they finish.",
  REDIRECT_BLOCKED: "STJW returned a redirect. The connector does not forward credentials to redirects; verify its configured origin.",
  RESPONSE_LIMIT: "The response exceeds connector limits. Narrow report dates or filters, or use the STJW application.",
  INVALID_RESPONSE: "STJW returned a response that does not match this connector's supported contract.",
  TIMEOUT: "The STJW request exceeded the connector's time limit.",
  CANCELLED: "The STJW request was cancelled.",
  UPSTREAM_REJECTED: "STJW rejected the request. Check the supplied dates and filters in the application.",
  UNAVAILABLE: "STJW is unavailable. Check connectivity and try again.",
} as const;
export type ErrorCode = keyof typeof messages;
export class BridgeError extends Error {
  constructor(readonly code: ErrorCode) { super(messages[code]); this.name = "BridgeError"; }
}
export function safeError(error: unknown) {
  return error instanceof BridgeError ? error : new BridgeError("UNAVAILABLE");
}
