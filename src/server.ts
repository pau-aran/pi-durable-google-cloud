import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import { createChatHarnessOptions } from "./chat.ts";
import { MAX_CLIENT_FRAME_CHARACTERS, SESSION_ID_PATTERN } from "./protocol.ts";
import { openSessions, type Sessions } from "./sessions.ts";

const SESSION_PATH = "/api/sessions/";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export type Server = {
  /** The port in use, which differs from the requested one when that was 0. */
  port: number;
  /** Stop accepting connections, close every session, and drop the remaining sockets. */
  close(): Promise<void>;
};

/** Serve the routes of `PLAN.md` on `port`: the session API, the WebSocket upgrade, and the files of `staticDir`. */
export async function startServer(options: { port: number; staticDir: string; sessions: Sessions }): Promise<Server> {
  const staticDir = resolve(options.staticDir);
  // `maxPayload` counts UTF-8 bytes, and one character (UTF-16 code unit) takes at most 3 of them. So each frame within
  // the character limit passes, and the session closes a frame over that limit with 1009. `ws` closes larger ones first.
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 3 * MAX_CLIENT_FRAME_CHARACTERS });

  async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
    const index = resolve(staticDir, "index.html");
    let file = index;
    try {
      const requested = resolve(staticDir, `.${decodeURIComponent(pathname)}`);
      // Path traversal guard: a path outside `staticDir` gets the page.
      if (requested.startsWith(staticDir + sep)) file = requested;
    } catch {
      // A malformed escape gets the page too.
    }
    let body = await readFile(file).catch(() => undefined);
    if (body === undefined) {
      file = index;
      body = await readFile(index);
    }
    response.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "POST" && pathname === "/api/sessions") {
      response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: randomUUID() }));
    } else if (request.method !== "GET") {
      response.writeHead(405).end();
    } else if (pathname === "/healthz") {
      response.writeHead(200).end("ok");
    } else if (pathname.startsWith("/api/")) {
      response.writeHead(404).end();
    } else {
      await serveStatic(pathname, response);
    }
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  server.on("upgrade", (request, socket, head) => {
    // A target that is no URL, such as `//[`, gets an empty path and so a 400.
    const pathname = URL.parse(request.url ?? "/", "http://localhost")?.pathname ?? "";
    const id = pathname.startsWith(SESSION_PATH) ? pathname.slice(SESSION_PATH.length) : "";
    if (!SESSION_ID_PATTERN.test(id)) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      // `ws` reports a frame that is too large, and each other protocol error, as an `error` event before it closes
      // the socket. Without a listener that event would stop the process.
      webSocket.on("error", () => {});
      options.sessions.connect(id, webSocket).catch(() => webSocket.close(1011));
    });
  });

  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(options.port, done);
  });

  return {
    port: (server.address() as AddressInfo).port,
    async close() {
      const closed = new Promise((done) => server.close(done));
      await options.sessions.close();
      for (const webSocket of sockets.clients) webSocket.terminate();
      server.closeAllConnections();
      await closed;
    },
  };
}

if (import.meta.main) {
  const dataDir = process.env.DATA_DIR ?? "./data";
  const sessions = await openSessions({ dataDir, harness: createChatHarnessOptions });
  const server = await startServer({ port: Number(process.env.PORT ?? 8080), staticDir: "dist", sessions });
  console.log(`Listening on port ${server.port}`);
  const shutdown = () => void server.close().then(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
