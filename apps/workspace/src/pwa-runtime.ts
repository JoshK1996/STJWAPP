declare const __STJW_BUILD_VERSION__: string;

export const APP_BUILD_VERSION = typeof __STJW_BUILD_VERSION__ === 'string' ? __STJW_BUILD_VERSION__ : 'development';
const validVersion = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export interface UpdateState {
  available: boolean;
  checking: boolean;
  error: string | null;
  latestVersion: string | null;
}

export interface UpdateMonitorBrowser {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
}

export interface UpdateMonitorOptions {
  onChange: (state: UpdateState) => void;
  currentVersion?: string;
  fetcher?: typeof fetch;
  browser?: UpdateMonitorBrowser | null;
  intervalMs?: number;
  timeoutMs?: number;
}

/** Public release discovery only: no private responses, storage, write retries, or automatic reload. */
export function createUpdateMonitor(options: UpdateMonitorOptions) {
  const current = options.currentVersion ?? APP_BUILD_VERSION;
  const fetcher = options.fetcher ?? fetch;
  const browser = options.browser === undefined
    ? typeof window === 'undefined' ? null : { window, document }
    : options.browser;
  let state: UpdateState = { available: false, checking: false, error: null, latestVersion: null };
  let disposed = false;
  let running: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const publish = (next: Partial<UpdateState>) => {
    if (disposed) return;
    state = { ...state, ...next };
    options.onChange({ ...state });
  };

  const check = (): Promise<void> => {
    if (disposed || !validVersion(current)) return Promise.resolve();
    if (running) return running;
    controller = new AbortController();
    const signal = controller.signal;
    timeout = setTimeout(() => controller?.abort(), options.timeoutMs ?? 8_000);
    publish({ checking: true, error: null });
    running = (async () => {
      try {
        const response = await fetcher('/app-version.json', {
          cache: 'no-store', credentials: 'omit', redirect: 'error', signal,
          headers: { Accept: 'application/json' },
        });
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Unavailable release');
        const body: unknown = await response.json();
        const version = body && typeof body === 'object' && 'version' in body ? body.version : null;
        if (!validVersion(version)) throw new Error('Invalid release');
        // A rollback to this client's version must remove a previously detected update.
        publish({ latestVersion: version, available: version !== current, error: null });
      } catch {
        publish({ error: 'Unable to check for updates. Check your connection and try again.' });
      } finally {
        clearTimeout(timeout);
        controller = null;
        running = null;
        publish({ checking: false });
      }
    })();
    return running;
  };

  const checkWhenVisible = () => {
    if (!browser || browser.document.visibilityState === 'visible') void check();
  };
  browser?.window.addEventListener('focus', checkWhenVisible);
  browser?.window.addEventListener('online', checkWhenVisible);
  browser?.document.addEventListener('visibilitychange', checkWhenVisible);
  const interval = browser && validVersion(current)
    ? setInterval(checkWhenVisible, Math.max(15_000, options.intervalMs ?? 60_000))
    : undefined;
  if (browser) checkWhenVisible();

  return {
    check,
    dispose() {
      disposed = true;
      clearTimeout(timeout);
      clearInterval(interval);
      controller?.abort();
      browser?.window.removeEventListener('focus', checkWhenVisible);
      browser?.window.removeEventListener('online', checkWhenVisible);
      browser?.document.removeEventListener('visibilitychange', checkWhenVisible);
    },
  };
}
