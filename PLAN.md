# Plan: pi-durable on Google Cloud

A small chat application that runs [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) 1.5.2 on Google Cloud. All code in this repository is written new against the public API of that package.

## Decision

One GKE pod owns every session. Each session is one SQLite file on a single-writer Persistent Disk.

pi-durable needs one writer for each storage: "One process writes a storage at a time; there is no cross-process locking." A test confirmed it: a second Harness on the same file opens without an error, and then its commits fail.

### Rejected: Cloud Run

- The maximum instance count "can be exceeded for a brief period", so two instances can write one session.
- An instance has no persistent local disk for the SQLite files.

### Rejected for now: shards and a router

One pod serves the page, the API, and the sockets. More pods need a router and a shard number in each session id. Add them when one pod is too small. A plain UUID then means shard 0.

### Chosen: a StatefulSet with one replica

- A StatefulSet keeps at most one pod with a given identity in the cluster.
- The pod has its own Persistent Disk, attached read-write to one node.
- `openNodeSqliteStorage(file)` ships in pi-durable.

## Parts

| Part | File | Notes |
| ---- | ---- | ----- |
| Browser | `src/client/`, `index.html` | Plain TypeScript, built by Vite into `dist/`. |
| Server | `src/server.ts` | HTTP, static `dist/`, WebSocket upgrade, `SIGTERM`. |
| Sessions | `src/sessions.ts` | A `Map` of open sessions, the wake index, and one timer. |
| Session | `src/session.ts` | One Harness, its sockets, and its wake row. |
| Agent | `src/chat.ts` | Models, tools, and system prompt. It does not know the host. |
| Protocol | `src/protocol.ts` | The frames between browser and server. |
| Session files | Persistent Disk | `/data/sessions/<id>.sqlite` |
| Wake index | Persistent Disk | `/data/wakes.sqlite`, table `wakes(session_id TEXT PRIMARY KEY, at INTEGER NOT NULL)` |

## Routes

- `POST /api/sessions` returns `201 {"sessionId": "<uuid>"}`.
- `GET /api/sessions/<uuid>` with `Upgrade: websocket` attaches the socket to that session.
- `GET /healthz` returns `200`.
- Each other `GET` under `/api/` returns `404`.
- Each other `GET` serves a file from `dist/`, or `dist/index.html`. The page of a session is `/s/<uuid>`.

The server rejects a session id that does not match `SESSION_ID_PATTERN`, because the id becomes a file name.

## Protocol

`src/protocol.ts` is the contract. A session has one conversation, the root.

- On attach, the server sends `view`: the value of `root.watch()`.
- After each commit, the server sends `ops` to every socket of the session.
- The browser sends `prompt` with a `requestId`. The server arms the wake, submits with `whenBusy: "followUp"`, and answers with `result`.
- When a socket drops, the browser connects again and gets a new `view`. It sends each unanswered `prompt` again with the same `requestId`, and pi-durable stores it once.

## Wake rule

The Harness opens with `onWake`, so it keeps no timer for sleeps. The session writes the next wake to the index:

```ts
const heartbeat = wake.active ? Date.now() + HEARTBEAT_MS : undefined; // 60 s
const at = heartbeat === undefined || wake.at === undefined ? (heartbeat ?? wake.at) : Math.min(heartbeat, wake.at);
if (at === undefined) wakes.run("DELETE FROM wakes WHERE session_id = ?", id);
else wakes.run("INSERT INTO wakes (session_id, at) VALUES (?, ?) " +
  "ON CONFLICT(session_id) DO UPDATE SET at = excluded.at", id, at);
```

- **Arm before work.** Write `{ ...harness.wake(), active: true }` before `submit` and before `resume()`. `onWake` runs after the commit, so a pod that stops between the two is still woken.
- **Arm before open.** Before a session opens, move its row to at most `now + HEARTBEAT_MS`. A session whose open fails is then tried again.
- **Due row.** One timer waits for the earliest row. When a row is due, the pod opens the session if it is closed, arms it as active, calls `resume()`, then arms `harness.wake()`.
- **Boot.** The same timer starts at boot, so due rows open their sessions.
- **Close.** A session with no socket and `wake().active === false` closes and leaves the `Map`. Its row stays, and the timer opens it again.
- **Failure.** When `harness.closed` ends as `failed`, or a wake write fails, the session closes its sockets and leaves the `Map`. The browser connects again, and that opens it again.
- **Shutdown.** On `SIGTERM`, the server stops new connections and calls `sessions.close()`. A close is not a crash: pi-durable sends a stopped model request again and counts no restart.

A test confirmed the rule: two sessions with sleeping tasks were closed, and a new process opened them from the index and ran the tasks.

## Deployment

`deploy.yaml` is the one file to edit. It has two values to change: the image and the domain.

| Object | Purpose |
| ------ | ------- |
| StatefulSet `pi-durable`, 1 replica | The pod, a `volumeClaimTemplate` mounted at `/data`, `OPENAI_API_KEY` from Secret `openai`, a readiness probe on `/healthz`, and a termination grace period. |
| Service | Port 8080, with the `BackendConfig` annotation. |
| BackendConfig | `timeoutSec: 86400`. The default of 30 s is the longest life of a WebSocket through the load balancer. |
| ManagedCertificate | The certificate of the domain. The browser needs HTTPS for `crypto.randomUUID()`. |
| FrontendConfig | `redirectToHttps`: an HTTP request gets a redirect to HTTPS. |
| Ingress | The external Application Load Balancer, with the `ManagedCertificate` and `FrontendConfig` annotations. |

```sh
gcloud container clusters create-auto pi-durable --region us-central1
gcloud artifacts repositories create pi-durable --repository-format docker --location us-central1
gcloud builds submit --tag us-central1-docker.pkg.dev/PROJECT/pi-durable/app
kubectl create secret generic openai --from-literal=OPENAI_API_KEY="$OPENAI_API_KEY"
kubectl apply -f deploy.yaml
```

Then point the DNS record of the domain at the address of the Ingress.

## Tests

Tests run on Node with Vitest and need no Google Cloud account. They use a temporary directory and the faux model provider of pi-ai.

- `test/sessions.test.ts`: prompt and answer, two sockets on one session, a repeated `requestId`, a closed session that a due wake opens again, work that a lost process left, an idle session that closes, and a failed open that is tried again.
- `test/server.test.ts`: the routes, a bad session id, a frame that is too large, and shutdown.
- `test/chat.test.ts`: the tools.

Only a real deployment needs a Google Cloud project with billing.

## Work units

Each unit is one branch from `port` and owns its files.

| Branch | Files |
| ------ | ----- |
| `host` | `src/sessions.ts`, `src/session.ts`, `test/sessions.test.ts` |
| `server` | `src/server.ts`, `src/chat.ts`, `test/server.test.ts`, `test/chat.test.ts` |
| `client` | `src/client/`, `index.html` |
| `deploy` | `Dockerfile`, `.dockerignore`, `deploy.yaml`, `DEPLOY.md` |

`src/protocol.ts` and the types in `src/sessions.ts` and `src/chat.ts` are the contracts between the units.

## Cautions

- Do not force-delete the pod. Kubernetes can then start a second pod with the same name, and two writers can break the session files.
- Do not raise `replicas`. Each pod gets its own disk, and nothing routes a session to its pod.
- SQLite runs with `synchronous = NORMAL`. A commit survives a process crash, but a node failure can lose the newest commits.
- The disk is in one zone. The application is down while that zone is down.
- Add authentication and rate limits before you expose the application. Anyone who can reach it can create sessions that use the model key.

## Out of scope

Authentication, rate limits, more than one conversation in a session, disk backups, removal of old session files, regional failover, and cost.

## Sources

- `@earendil-works/pi-durable` 1.5.2 `README.md`: "Persist and Resume", "Sleeping and Waking Up", "Failures and Recovery", "Watching a Conversation", "Storage".
- Google Cloud docs: Cloud Run maximum instances, GKE backend service timeout, GKE StatefulSets.
- Kubernetes docs: force delete StatefulSet pods.
