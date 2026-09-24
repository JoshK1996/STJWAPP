import type { z } from "zod";
import type { BridgeConfig } from "./config.js";
import { BridgeError } from "./errors.js";
import { reportInputSchema, reportOutputSchema, staffInputSchema, staffOutputSchema } from "./schemas.js";
import { reportOutputV2Schema } from "./report-v2-schema.js";

export const limits = Object.freeze({ responseBytes: 2 * 1024 * 1024, timeoutMs: 10000, concurrent: 4, requestsPerMinute: 60 });
export class StjwReads {
  #active = 0;
  #recent: number[] = [];
  constructor(private readonly config: BridgeConfig, private readonly timeoutMs = limits.timeoutMs) {}
  async staff(input: unknown, signal?: AbortSignal) {
    if (!staffInputSchema.safeParse(input).success) throw new BridgeError("INVALID_INPUT");
    return this.#get("/api/staff", new URLSearchParams(), staffOutputSchema, signal);
  }
  async report(input: unknown, signal?: AbortSignal) {
    const checked = reportInputSchema.safeParse(input);
    if (!checked.success) throw new BridgeError("INVALID_INPUT");
    const params = new URLSearchParams(Object.entries(checked.data).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const result = await this.#get("/api/reports", params, reportOutputSchema, signal);
    for (const key of ["start", "end", "group", "unitId", "userId"] as const)
      if (result.query[key] !== checked.data[key]) throw new BridgeError("INVALID_RESPONSE");
    return result;
  }
  async reportV2(input: unknown, signal?: AbortSignal) {
    const checked = reportInputSchema.safeParse(input);
    if (!checked.success) throw new BridgeError("INVALID_INPUT");
    const params = new URLSearchParams(Object.entries(checked.data).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const result = await this.#get("/api/reports/v2", params, reportOutputV2Schema, signal);
    for (const key of ["start", "end", "group", "unitId", "userId"] as const)
      if (result.query[key] !== checked.data[key]) throw new BridgeError("INVALID_RESPONSE");
    return result;
  }
  async #get<T>(path: "/api/staff" | "/api/reports" | "/api/reports/v2", params: URLSearchParams, schema: z.ZodType<T>, outerSignal?: AbortSignal): Promise<T> {
    if (this.#active >= limits.concurrent) throw new BridgeError("BUSY");
    const now = Date.now();
    this.#recent = this.#recent.filter((at) => now - at < 60000);
    if (this.#recent.length >= limits.requestsPerMinute) throw new BridgeError("RATE_LIMITED");
    this.#recent.push(now); this.#active++;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const url = new URL(path, this.config.origin);
      url.search = params.toString();
      const response = await fetch(url, {
        method: "GET", redirect: "manual", credentials: "omit", signal,
        headers: { Authorization: `Bearer ${this.config.token}`, Accept: "application/json", "User-Agent": "STJW-local-read-MCP/0.1" },
      });
      const reject = async (code: ConstructorParameters<typeof BridgeError>[0]): Promise<never> => {
        await response.body?.cancel().catch(() => {});
        throw new BridgeError(code);
      };
      if (response.status >= 300 && response.status < 400) return await reject("REDIRECT_BLOCKED");
      if (response.status === 401) return await reject("UNAUTHENTICATED");
      if (response.status === 403) return await reject("FORBIDDEN");
      if (response.status === 429) return await reject("RATE_LIMITED");
      if (!response.ok) return await reject(response.status < 500 ? "UPSTREAM_REJECTED" : "UNAVAILABLE");
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) return await reject("INVALID_RESPONSE");
      const length = response.headers.get("content-length");
      if (length && (!/^\d+$/.test(length) || Number(length) > limits.responseBytes)) return await reject("RESPONSE_LIMIT");
      if (!response.body) throw new BridgeError("INVALID_RESPONSE");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let bytes = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > limits.responseBytes) throw new BridgeError("RESPONSE_LIMIT");
        chunks.push(next.value);
      }
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw new BridgeError("INVALID_RESPONSE"); }
      const checked = schema.safeParse(parsed);
      if (!checked.success) {
        const exceededArrayLimit = checked.error.issues.some((issue) => issue.code === "too_big" && issue.origin === "array");
        throw new BridgeError(exceededArrayLimit ? "RESPONSE_LIMIT" : "INVALID_RESPONSE");
      }
      return checked.data;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (outerSignal?.aborted) throw new BridgeError("CANCELLED");
      if (controller.signal.aborted) throw new BridgeError("TIMEOUT");
      throw new BridgeError("UNAVAILABLE");
    } finally {
      clearTimeout(timer); controller.abort();
      await reader?.cancel().catch(() => {});
      this.#active--;
    }
  }
}
