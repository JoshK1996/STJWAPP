import { BridgeError } from "./errors.js";

export type BridgeConfig = Readonly<{ origin: string; token: string }>;
export function readConfig(env: Record<string, string | undefined>): BridgeConfig {
  // Values are used by ordinary transport code only. Never log this object.
  try {
    const raw = env.STJW_API_ORIGIN, token = env.STJW_API_TOKEN;
    if (!raw || raw !== raw.trim() || !token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error();
    const url = new URL(raw);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && env.STJW_ALLOW_LOOPBACK_HTTP === "1")) throw new Error();
    if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error();
    return Object.freeze({ origin: url.origin, token });
  } catch { throw new BridgeError("CONFIGURATION"); }
}
