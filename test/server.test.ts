import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { MAX_CLIENT_FRAME_CHARACTERS, SESSION_ID_PATTERN } from "../src/protocol.ts";
import { type Server, startServer } from "../src/server.ts";

const ID = "0190a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a6b";

let server: Server;
let origin: string;
let connected: { id: string; socket: WebSocket }[];
let closes: number;

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "server-"));
  const staticDir = join(root, "dist");
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<p>page</p>");
  writeFileSync(join(staticDir, "assets", "app.js"), "script");
  writeFileSync(join(root, "secret.txt"), "secret");
  connected = [];
  closes = 0;
  server = await startServer({
    port: 0,
    staticDir,
    sessions: {
      connect: async (id, socket) => void connected.push({ id, socket }),
      close: async () => void closes++,
    },
  });
  origin = `localhost:${server.port}`;
});

afterEach(() => server.close());

/** Resolves with the close code, or with the HTTP status of a refused upgrade. */
function open(path: string): { socket: WebSocket; opened: Promise<void>; ended: Promise<number> } {
  const socket = new WebSocket(`ws://${origin}${path}`);
  const opened = new Promise<void>((done) => socket.once("open", () => done()));
  const ended = new Promise<number>((done) => {
    socket.once("close", done);
    socket.once("unexpected-response", (_request, response) => done(response.statusCode!));
    socket.on("error", () => {});
  });
  return { socket, opened, ended };
}

/** GET `path` exactly as written; `fetch` would normalize it. */
function rawGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    request(`http://${origin}`, { path }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => done({ status: response.statusCode!, body }));
    })
      .on("error", fail)
      .end();
  });
}

test("POST /api/sessions returns a new session id", async () => {
  const response = await fetch(`http://${origin}/api/sessions`, { method: "POST" });
  expect(response.status).toBe(201);
  expect((await response.json()).sessionId).toMatch(SESSION_ID_PATTERN);
});

test("GET /healthz returns 200", async () => {
  expect((await fetch(`http://${origin}/healthz`)).status).toBe(200);
});

test("GET serves a file of dist, or the page", async () => {
  const script = await fetch(`http://${origin}/assets/app.js`);
  expect(await script.text()).toBe("script");
  expect(script.headers.get("content-type")).toContain("text/javascript");

  for (const path of ["/", `/s/${ID}`, "/assets/missing.js"]) {
    const page = await fetch(`http://${origin}${path}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toBe("<p>page</p>");
  }
});

test("GET does not serve a file outside dist", async () => {
  for (const path of ["/../secret.txt", "/..%2fsecret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"]) {
    expect(await rawGet(path), path).toEqual({ status: 200, body: "<p>page</p>" });
  }
  expect((await rawGet("/%zz")).body).toBe("<p>page</p>");
});

test("other methods and unknown API paths are refused", async () => {
  expect((await fetch(`http://${origin}/`, { method: "PUT" })).status).toBe(405);
  expect((await fetch(`http://${origin}/api/sessions`)).status).toBe(404);
});

test("a WebSocket upgrade attaches the socket to its session", async () => {
  const { socket, opened } = open(`/api/sessions/${ID}`);
  await opened;
  expect(connected.map((entry) => entry.id)).toEqual([ID]);

  const received = new Promise((done) => socket.once("message", (data) => done(String(data))));
  connected[0]!.socket.send("hello");
  expect(await received).toBe("hello");
});

test("a bad session id is rejected before it reaches the sessions", async () => {
  for (const id of ["nope", ID.toUpperCase(), `..%2f${ID}`, `${ID}/x`]) {
    expect(await open(`/api/sessions/${id}`).ended, id).toBe(400);
  }
  expect(await open(`/other/${ID}`).ended).toBe(400);
  expect(connected).toEqual([]);
});

test("an upgrade to a target that is no URL gets 400", async () => {
  const reply = await new Promise<string>((done) => {
    const socket = connect(server.port, "localhost", () =>
      socket.write(
        "GET //[ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      ),
    );
    let data = "";
    socket.on("data", (chunk) => (data += chunk));
    socket.on("close", () => done(data));
  });
  expect(reply).toMatch(/^HTTP\/1.1 400 /);
  expect(connected).toEqual([]);
});

test("a frame within the character limit reaches the session in any script, and a far larger one closes with 1009", async () => {
  const { socket, opened, ended } = open(`/api/sessions/${ID}`);
  await opened;
  const frames: string[] = [];
  connected[0]!.socket.on("message", (data) => frames.push(String(data)));

  // Three UTF-8 bytes per character, the most one UTF-16 code unit takes.
  socket.send("€".repeat(MAX_CLIENT_FRAME_CHARACTERS));
  socket.send("a".repeat(3 * MAX_CLIENT_FRAME_CHARACTERS + 1));
  expect(await ended).toBe(1009);
  expect(frames.map((frame) => frame.length)).toEqual([MAX_CLIENT_FRAME_CHARACTERS]);
});

test("a session that fails to open closes the socket", async () => {
  const failing = await startServer({
    port: 0,
    staticDir: "unused",
    sessions: { connect: () => Promise.reject(new Error("open failed")), close: async () => {} },
  });
  const socket = new WebSocket(`ws://localhost:${failing.port}/api/sessions/${ID}`);
  expect(await new Promise((done) => socket.once("close", done))).toBe(1011);
  await failing.close();
});

test("close stops accepting, closes the sessions, and drops the sockets", async () => {
  const { opened, ended } = open(`/api/sessions/${ID}`);
  await opened;

  await server.close();
  expect(closes).toBe(1);
  expect(await ended).toBe(1006);
  await expect(fetch(`http://${origin}/healthz`)).rejects.toThrow();
});
