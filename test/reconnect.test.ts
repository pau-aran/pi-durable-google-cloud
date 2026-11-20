// Adapted from p2 (apps/p2/test/p2/web-reconnect.test.ts).
// The browser's connection loop (src/client/reconnect.ts) with a manual clock and fake sockets.
import { describe, expect, it } from "vitest";
import {
  CONNECT_TIMEOUT_MS,
  keepConnected,
  RETRY_INITIAL_MS,
  RETRY_MAX_MS,
  type ReconnectEnvironment,
  type ReconnectLink,
  type SocketEvents,
  STABLE_MS,
} from "../src/client/reconnect.ts";

type FakeSocket = { events: SocketEvents; link: ReconnectLink & { closedWith: string | undefined } };

function setup() {
  let now = 0;
  let timers: { at: number; callback: () => void }[] = [];
  let wake: (() => void) | undefined;
  let online = true;
  const sockets: FakeSocket[] = [];
  const connected: boolean[] = [];
  const logs: string[] = [];
  const environment: ReconnectEnvironment = {
    now: () => now,
    after: (ms, callback) => {
      const timer = { at: now + ms, callback };
      timers.push(timer);
      return () => {
        timers = timers.filter((entry) => entry !== timer);
      };
    },
    online: () => online,
    onWake: (listener) => {
      wake = listener;
      return () => {
        wake = undefined;
      };
    },
    log: (message) => logs.push(message),
  };
  const connection = keepConnected({
    open: (events) => {
      const handlers: ((reason: string) => void)[] = [];
      const link = {
        closedWith: undefined as string | undefined,
        onClose: (handler: (reason: string) => void) => handlers.push(handler),
        close: (reason = "closed") => {
          if (link.closedWith !== undefined) return;
          link.closedWith = reason;
          for (const handler of handlers) handler(reason);
        },
      };
      sockets.push({ events, link });
      return link;
    },
    onConnected: (value) => connected.push(value),
    environment,
  });
  /** Advances the clock to `ms` later, running due timers in order. */
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((timer) => timer !== due);
      now = Math.max(now, due.at);
      due.callback();
    }
    now = end;
  };
  /** Ends the newest socket as a closed socket would. */
  const drop = (reason = "socket closed") => sockets.at(-1)?.link.close(reason);
  return {
    sockets,
    connected,
    logs,
    advance,
    drop,
    wake: () => wake?.(),
    stop: () => connection.stop(),
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

describe("web reconnect", () => {
  it("backs off while connections fail and starts over after one that worked", () => {
    const t = setup();
    expect(t.sockets.length).toBe(1);
    // Never opened: 250, 500, 1000 ms.
    for (const delay of [RETRY_INITIAL_MS, RETRY_INITIAL_MS * 2, RETRY_INITIAL_MS * 4]) {
      const count = t.sockets.length;
      t.drop();
      t.advance(delay - 1);
      expect(t.sockets.length).toBe(count);
      t.advance(1);
      expect(t.sockets.length).toBe(count + 1);
    }
    // This one works for a while, then drops: the next retry is quick again.
    t.sockets.at(-1)?.events.opened();
    t.advance(STABLE_MS);
    t.drop();
    t.advance(RETRY_INITIAL_MS);
    expect(t.sockets.length).toBe(5);
    expect(t.connected).toEqual([false, false, false, true, false]);
  });

  it("keeps backing off when connections open and end at once", () => {
    const t = setup();
    for (let index = 0; index < 6; index += 1) {
      t.sockets.at(-1)?.events.opened();
      t.drop();
      t.advance(RETRY_MAX_MS);
    }
    const count = t.sockets.length;
    t.sockets.at(-1)?.events.opened();
    t.drop();
    t.advance(RETRY_MAX_MS - 1);
    expect(t.sockets.length).toBe(count);
    t.advance(1);
    expect(t.sockets.length).toBe(count + 1);
  });

  it("gives up an attempt that does not open", () => {
    const t = setup();
    t.advance(CONNECT_TIMEOUT_MS);
    expect(t.sockets[0]?.link.closedWith).toMatch(/not open after 20.0 s/);
    t.advance(RETRY_INITIAL_MS);
    expect(t.sockets.length).toBe(2);
    // An attempt that opened in time is not affected by the timeout.
    t.sockets[1]?.events.opened();
    t.advance(CONNECT_TIMEOUT_MS);
    expect(t.sockets[1]?.link.closedWith).toBeUndefined();
  });

  it("retries at once on wake instead of waiting out the backoff", () => {
    const t = setup();
    for (let index = 0; index < 5; index += 1) {
      t.drop();
      t.advance(RETRY_MAX_MS);
    }
    const count = t.sockets.length;
    t.drop();
    t.advance(10);
    t.wake();
    expect(t.sockets.length).toBe(count + 1);
  });

  it("waits for the longest delay while offline, and goes at once when back online", () => {
    const t = setup();
    t.setOnline(false);
    t.drop();
    t.advance(RETRY_MAX_MS - 1);
    expect(t.sockets.length).toBe(1);
    t.setOnline(true);
    t.wake();
    expect(t.sockets.length).toBe(2);
  });

  it("logs close codes and how long the connection was open", () => {
    const t = setup();
    t.sockets[0]?.events.closed(1006, "", false);
    t.drop();
    t.advance(RETRY_INITIAL_MS);
    t.sockets[1]?.events.opened();
    t.advance(12_000);
    t.drop("server closed");
    t.sockets[1]?.events.closed(1000, "", true);
    expect(t.logs).toEqual([
      "Socket closed before opening: code 1006, not clean",
      "Connection failed after 0.0 s: socket closed",
      "Connection lost after 12.0 s open: server closed",
      "Socket closed after opening: code 1000",
    ]);
  });

  it("stops: closes the socket, retries nothing and ignores wakes", () => {
    const t = setup();
    t.sockets[0]?.events.opened();
    t.stop();
    expect(t.sockets[0]?.link.closedWith).toBe("stopped");
    t.wake();
    t.advance(RETRY_MAX_MS * 2);
    expect(t.sockets.length).toBe(1);
    expect(t.connected).toEqual([true]);
  });
});
