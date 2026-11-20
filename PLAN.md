# Plan: pi-durable on Google Cloud

Port [`pi-durable-cloudflare`](https://github.com/pau-aran/pi-durable-cloudflare) (commit `b68bf92`, `@earendil-works/pi-durable` 1.5.2) to Google Cloud.

## Decision

One GKE shard pod owns each session, with its SQLite file on a single-writer Persistent Disk.

pi-durable needs one writer for each storage: "One process writes a storage at a time; there is no cross-process locking." On Cloudflare, the Durable Object gives this. On Google Cloud, the platform must give it.

### Rejected: Cloud Run with autoscaling

- Session affinity is "best effort". A second browser can reach another instance, and two instances then write one session.
- A WebSocket is an HTTP request. The request timeout stops it after 60 minutes at most.
- pi-durable has no Cloud SQL or Firestore storage. We would have to write one and pass `registerStorageConformance`.

### Chosen: a GKE StatefulSet of shard pods

- A StatefulSet keeps at most one pod with a given identity in the cluster.
- Each pod has its own Persistent Disk, attached read-write to one node.
- `openNodeSqliteStorage(file)` already ships in pi-durable 1.5.2.
- A pod holds a socket as long as the client keeps it open.

## Parts

| Part | Kind | Replaces | Notes |
| ---- | ---- | -------- | ----- |
| Browser | unchanged | — | `src/client/`. `PartySocket` reconnects and the command outbox replays. |
| Router | Deployment, stateless | Worker `src/index.ts` | Same two routes. Serves `dist/`. Sits behind a GKE Gateway. |
| Session shard | StatefulSet `session-shard` | `Session` Durable Object, `src/session.ts` | One `Session` object for each open id, in a `Map`. |
| Session files | Persistent Disk | Durable Object SQLite | `/data/sessions/<id>.sqlite` |
| Wake index | Persistent Disk | `setAlarm` / `alarm()` | `/data/wakes.sqlite`, table `wakes(session_id TEXT PRIMARY KEY, at INTEGER NOT NULL)` |
| Secret Manager | GCP | `wrangler secret put` | Exposes `OPENAI_API_KEY` to the shard pods. |

## Routing

- `POST /api/sessions`: the router picks a shard `k` and returns `{"sessionId": "s<k>-<uuid>", "url": "/sessions/s<k>-<uuid>"}`.
- `GET /api/sessions/s<k>-<uuid>` with `Upgrade: websocket`: the router proxies to `session-shard-k.session-shard:8080`.
- The shard number lives in the id, so a new shard changes only the ids that the router makes after it.

## Port of `src/session.ts`

| Cloudflare | Google Cloud |
| ---------- | ------------ |
| `class Session extends DurableObject` | A plain `class Session`. The shard keeps one for each open id in a `Map`. |
| `ctx.blockConcurrencyWhile(() => this.#initialize())` | One open promise for each id. Each message waits for it. |
| `openDurableObjectSqliteStorage(this.ctx.storage)` | `openNodeSqliteStorage("/data/sessions/<id>.sqlite")` |
| `ctx.storage.setAlarm`, `deleteAlarm`, `alarm()` | Upsert or delete in `wakes`, plus one timer in the pod for the earliest row. |
| `ctx.acceptWebSocket`, `serializeAttachment` | A `ws` server. The pod does not hibernate, so socket state stays in memory. |
| `ctx.abort(...)` | Close the session and remove it from the `Map`. The next message or wake opens it again. |
| `wrangler.jsonc`, `@cloudflare/vite-plugin` | `Dockerfile`, Kubernetes manifests in `deploy/`, plain `vite build`. |
| `"observability"` | Cloud Logging reads the JSON lines that `reportError` writes to stdout. |

No change: `src/chat.ts`, `src/tools.ts`, `src/schedule.ts`, `src/search.ts`, `src/protocol.ts`, `src/serial.ts`, `src/identity.ts`, `src/client/`.

### Wake rule

Keep `#arm` as it is: the earliest sleep, or a heartbeat `HEARTBEAT_MS` (60 s) ahead while work can run. Change only the write:

```ts
if (at === undefined) wakes.run("DELETE FROM wakes WHERE session_id = ?", this.id);
else wakes.run("INSERT INTO wakes (session_id, at) VALUES (?, ?) " +
  "ON CONFLICT(session_id) DO UPDATE SET at = excluded.at", this.id, at);
```

Keep the order of calls: arm `{ ...wake(), active: true }` before `conversation.submit` and before `resume()`.

When a row is due, the shard opens the session if it is closed, then does what `alarm()` does today. At boot, the shard opens each session with a due row and calls `resume()`.

When a session has no open socket and no wake row, the shard may close it and free its memory.

## Work units

1. **Node session host.** Port `src/session.ts` off `cloudflare:workers`: plain class, `ws`, `openNodeSqliteStorage`, wake index, and a session `Map`. Port the tests off `@cloudflare/vitest-plugin`, starting with `test/recovery.test.ts` and `test/schedule.test.ts`.
2. **Router.** Port `src/index.ts` to a Node server: shard-prefixed ids, WebSocket proxy, and static `dist/`. Drop `@cloudflare/vite-plugin`.
3. **Container and manifests.** `Dockerfile`, StatefulSet with a `volumeClaimTemplate`, headless Service, router Deployment, Gateway, and the secret reference.
4. **Deploy.**

   ```sh
   gcloud container clusters create-auto pi-durable --region us-central1
   printf %s "$OPENAI_API_KEY" | gcloud secrets create openai-api-key --data-file=-
   kubectl apply -f deploy/
   ```

## Cautions

- Do not force-delete a shard pod. Kubernetes can then start a second pod with the same name, and two writers can break the session files.
- Do not remove a shard. Each session id holds its shard number, and its file stays on the disk of that shard.
- Add authentication and rate limits before you expose the router. Anyone who can reach the sample can create sessions that use the model key.

## Out of scope

Authentication, rate limits, disk backups and snapshots, regional failover, moving a session between shards, and cost.

## Sources

- `pi-durable-cloudflare` at `b68bf92`: `README.md`, `wrangler.jsonc`, `src/index.ts`, `src/session.ts`, `src/chat.ts`.
- `@earendil-works/pi-durable` 1.5.2 `README.md`: "Sleeping and Waking Up", "Storage".
- Google Cloud docs: Cloud Run session affinity, Cloud Run WebSockets, sharing disks between VMs, GKE StatefulSets.
- Kubernetes docs: force delete StatefulSet pods.
