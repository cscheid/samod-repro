# samod: DontAnnounce policy drops documents synced by clients

## Bug summary

When a client creates new automerge documents and syncs them to a samod
server that uses `DontAnnounce` announce policy, the documents are silently
lost. A fresh client reconnecting to the same server will get
`Document <id> is unavailable` for every document the first client created.

The bug is deterministic and affects every document synced to the server,
not just some.

## Root cause

In `samod-core/src/actors/document/doc_state.rs`, `handle_load()`:

1. Client syncs a new document to the server.
2. The server spawns a document actor in `Loading` phase and queues the
   client's sync message in `pending_sync_messages`.
3. Two async tasks are dispatched: storage load + announce policy check.
4. Storage load returns empty (document is new, nothing on disk).
5. Announce policy resolves to `DontAnnounce` (the server's policy is
   `|_, _| false`).
6. `handle_load` checks: `doc.get_heads().is_empty()` is true, and
   `eligible_conns` (connections with non-`DontAnnounce` policy) is false.
7. **Bug**: transitions to `NotFound`, dropping all `pending_sync_messages`
   — the client's document data is lost.

The pending sync messages contain the actual document data from the client,
but they are never processed.

## Fix

Before transitioning to `NotFound`, check whether there are pending sync
messages. If there are, process them first — they may contain the document
data. Only transition to `NotFound` when there are no pending messages AND
no eligible connections.

Fix commit: https://github.com/shikokuchuo/samod/commit/e53c7ce23e20a3cdee31ad509b992b00229afcde

## Reproducing

### Prerequisites

- Rust toolchain (for building the server)
- Node.js >= 18 (for running the test)

### Steps

```bash
# Install TypeScript dependencies
npm install

# Run the test
npm test
```

The test (`src/repro.test.ts`) does the following:

1. Starts `samod-minimal-server` — a ~90-line Rust binary that creates a
   samod `Repo` with `DontAnnounce` policy and serves it over WebSocket.
2. Connects a TypeScript client using `@automerge/automerge-repo` and
   `@automerge/automerge-repo-network-websocket`.
3. Creates 4 automerge documents (1 index + 3 content) in quick succession.
4. Waits 2 seconds, then disconnects.
5. Creates a fresh client (no local state) and reconnects.
6. Calls `repo.find(docId)` for each document and asserts the content
   matches.

**With the bug**: step 6 throws `Document <id> is unavailable`.

**With the fix**: step 6 succeeds and all documents have correct content.

### Testing against unfixed samod

To verify the bug, edit `samod-minimal-server/Cargo.toml` and point the
`samod` dependency to a version before the fix (e.g., commit `60b808f`).
Rebuild and rerun the test — it will fail.

## Repository structure

```
├── README.md
├── package.json              # TypeScript dependencies (automerge-repo, vitest)
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── repro.test.ts         # The reproduction test
│   └── server-manager.ts     # Starts/stops the Rust server as a child process
└── samod-minimal-server/     # Standalone Rust binary (no application-specific code)
    ├── Cargo.toml
    └── src/
        └── main.rs           # ~90 lines: samod Repo + axum WebSocket handler
```

Both the server and the client use only automerge ecosystem packages — no
application-specific dependencies.
