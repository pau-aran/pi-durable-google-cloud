// Adapted from p2 (apps/p2/src/web/reconnect.ts).
// The browser's connection loop: keeps one socket to the server and replaces it when it ends.

/** Retry delays after a failed or short-lived connection: 250 ms, doubling, at most 5 s. */
export const RETRY_INITIAL_MS = 250;
export const RETRY_MAX_MS = 5000;
/** A connection that stayed open this long counted as working: the next retry starts again at the initial delay. */
export const STABLE_MS = 10_000;
/** A socket not open after this long is given up. */
export const CONNECT_TIMEOUT_MS = 20_000;

/** What the page tells the loop about one socket. */
export interface SocketEvents {
  /** The socket is ready: the session's first `view` frame arrived. */
  opened(): void;
  closed(code: number, reason: string, wasClean: boolean): void;
}

/** The link over one socket: it ends when the socket closes, and closing it ends it at once. */
export interface ReconnectLink {
  onClose(handler: (reason: string) => void): void;
  close(reason?: string): void;
}

export interface ReconnectEnvironment {
  now(): number;
  /** Runs `callback` after `ms`; returns a cancel function. */
  after(ms: number, callback: () => void): () => void;
  /** False when the device is known to be offline. */
  online(): boolean;
  /**
   * `listener` runs when the page may have been away: back online, visible again, network changed, or restored.
   * Returns a function that removes it.
   */
  onWake(listener: () => void): () => void;
  log(message: string): void;
}

export interface ReconnectOptions {
  /** Opens a socket and its link; the socket reports to `events`. */
  open(events: SocketEvents): ReconnectLink;
  onConnected(connected: boolean): void;
  environment: ReconnectEnvironment;
}

type Attempt = {
  link: ReconnectLink | undefined;
  startedAt: number;
  /** When the socket opened; undefined while connecting. */
  openedAt: number | undefined;
  cancelTimeout: () => void;
};

/**
 * Keeps the page connected until stopped:
 *
 * - After a close it retries with backoff. A connection that stayed open STABLE_MS resets the backoff; one that opens
 *   and ends at once keeps backing off instead of looping.
 * - An attempt not open after CONNECT_TIMEOUT_MS is given up: browsers have no handshake timeout.
 * - On wake (online, visible, network change, back/forward cache) a pending retry runs at once. This server sends no
 *   pings, so an open socket is not checked: it is replaced when the browser reports its close.
 * - Every close is logged with its reason and close code: a 1006 that never opened is a refused handshake, one after
 *   opening a dropped connection.
 */
export function keepConnected(options: ReconnectOptions): { stop(): void } {
  const env = options.environment;
  let failures = 0;
  let current: Attempt | undefined;
  let cancelRetry: (() => void) | undefined;
  let stopped = false;

  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

  const connect = (): void => {
    cancelRetry = undefined;
    const attempt: Attempt = { link: undefined, startedAt: env.now(), openedAt: undefined, cancelTimeout: () => {} };
    current = attempt;
    const link = options.open({
      opened: () => {
        if (current !== attempt) return;
        attempt.openedAt = env.now();
        attempt.cancelTimeout();
        options.onConnected(true);
      },
      closed: (code, reason, wasClean) => {
        const opened = attempt.openedAt === undefined ? "before opening" : "after opening";
        env.log(`Socket closed ${opened}: code ${code}${reason ? ` (${reason})` : ""}${wasClean ? "" : ", not clean"}`);
      },
    });
    attempt.link = link;
    attempt.cancelTimeout = env.after(CONNECT_TIMEOUT_MS, () => {
      if (attempt.openedAt === undefined) link.close(`not open after ${seconds(CONNECT_TIMEOUT_MS)}`);
    });
    link.onClose((reason) => closed(attempt, reason));
  };

  const closed = (attempt: Attempt, reason: string): void => {
    if (current !== attempt) return;
    current = undefined;
    attempt.cancelTimeout();
    if (stopped) return;
    options.onConnected(false);
    const now = env.now();
    if (attempt.openedAt === undefined) env.log(`Connection failed after ${seconds(now - attempt.startedAt)}: ${reason}`);
    else env.log(`Connection lost after ${seconds(now - attempt.openedAt)} open: ${reason}`);
    if (attempt.openedAt !== undefined && now - attempt.openedAt >= STABLE_MS) failures = 0;
    const backoff = Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** failures);
    failures += 1;
    // Offline, an attempt fails at once; the `online` wake retries sooner than this.
    cancelRetry = env.after(env.online() ? backoff : RETRY_MAX_MS, connect);
  };

  const wake = (): void => {
    if (!cancelRetry) return;
    cancelRetry();
    connect();
  };

  const removeWake = env.onWake(wake);
  connect();
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      removeWake();
      cancelRetry?.();
      cancelRetry = undefined;
      current?.link?.close("stopped");
    },
  };
}

/**
 * The page's environment: wakes on `online`, visibility, network changes (where reported) and back/forward restores.
 * A wake only runs a waiting retry at once (`keepConnected`).
 * Logs go to the console under `name`.
 */
export function browserEnvironment(name: string): ReconnectEnvironment {
  return {
    now: () => Date.now(),
    after: (ms, callback) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
    online: () => navigator.onLine,
    onWake: (listener) => {
      const pageshow = (event: PageTransitionEvent) => {
        if (event.persisted) listener();
      };
      const visibility = () => {
        if (document.visibilityState === "visible") listener();
      };
      // Chromium only: Wi-Fi to cellular and back. Only a retry that waits gains from it: an open socket that the
      // change left dead is not noticed until the browser reports its close (this server sends no pings).
      const network = (navigator as { connection?: EventTarget }).connection;
      window.addEventListener("online", listener);
      window.addEventListener("pageshow", pageshow);
      document.addEventListener("visibilitychange", visibility);
      network?.addEventListener("change", listener);
      return () => {
        window.removeEventListener("online", listener);
        window.removeEventListener("pageshow", pageshow);
        document.removeEventListener("visibilitychange", visibility);
        network?.removeEventListener("change", listener);
      };
    },
    log: (message) => console.info(`[${name}] ${message}`),
  };
}
