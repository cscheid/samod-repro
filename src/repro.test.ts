/**
 * Minimal reproduction of samod-core NotFound bug.
 *
 * Bug: When a client creates multiple automerge documents and syncs them to
 * a samod server using DontAnnounce policy, the server's document actor
 * transitions to NotFound before processing pending sync messages — silently
 * dropping the client's data. On reconnect, the documents are unavailable.
 *
 * Fix: https://github.com/shikokuchuo/samod/commit/e53c7ce23e20a3cdee31ad509b992b00229afcde
 *
 * This reproduction uses ONLY @automerge/automerge-repo and
 * @automerge/automerge-repo-network-websocket — no application-specific
 * dependencies.
 */

import { describe, test, beforeAll, afterAll, expect } from 'vitest';
import { Repo } from '@automerge/automerge-repo';
import type { DocumentId } from '@automerge/automerge-repo';
import { BrowserWebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket';
import { startServer, type ServerHandle } from './server-manager.js';

// ---------------------------------------------------------------------------
// Types (plain automerge documents, no application schema)
// ---------------------------------------------------------------------------

/** A simple document that holds a text string. */
interface TextDoc {
  text: string;
}

/** An index document that maps names to document IDs. */
interface IndexDoc {
  entries: { [name: string]: string };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForPeer(repo: Repo, timeoutMs: number = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout waiting for peer connection'));
    }, timeoutMs);

    const onPeer = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      repo.networkSubsystem.off('peer', onPeer);
    };

    repo.networkSubsystem.on('peer', onPeer);
  });
}

/**
 * Create a Repo connected to the server via WebSocket.
 * Returns the repo and adapter (for disconnecting later).
 */
async function connectRepo(serverUrl: string): Promise<{
  repo: Repo;
  adapter: BrowserWebSocketClientAdapter;
}> {
  const adapter = new BrowserWebSocketClientAdapter(serverUrl);
  const repo = new Repo({ network: [adapter] });
  await waitForPeer(repo, 30000);
  return { repo, adapter };
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TEST_DOCS: Array<{ name: string; content: string }> = [
  { name: 'config.yml', content: 'project:\n  type: website\n  title: "Test"\n' },
  { name: 'index.qmd', content: '---\ntitle: "Home"\n---\n\n# Welcome\n' },
  { name: 'about.qmd', content: '---\ntitle: "About"\n---\n\n## About\n' },
];

const HUB_PORT = 18_300;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('samod DontAnnounce bug reproduction', () => {
  let server: ServerHandle;

  beforeAll(async () => {
    console.log('Starting samod server...');
    server = await startServer({ port: HUB_PORT });
    console.log(`Server ready at ${server.url}`);
  }, 120_000);

  afterAll(async () => {
    if (server) {
      await server.stop();
      console.log('Server stopped');
    }
  });

  test('documents created in quick succession survive disconnect/reconnect', async () => {
    // --- Phase 1: Create documents ---
    const { repo: repo1, adapter: adapter1 } = await connectRepo(server.url);

    // Create an index document
    const indexHandle = repo1.create<IndexDoc>();
    indexHandle.change((doc) => {
      doc.entries = {};
    });

    // Create content documents in quick succession (this triggers the bug)
    const createdDocs: Array<{ name: string; docId: string }> = [];
    for (const { name, content } of TEST_DOCS) {
      const handle = repo1.create<TextDoc>();
      handle.change((doc) => {
        doc.text = content;
      });

      // Register in the index
      const docId = handle.documentId;
      indexHandle.change((doc) => {
        doc.entries[name] = docId;
      });

      createdDocs.push({ name, docId });
    }

    const indexDocId = indexHandle.documentId;
    console.log(`Created index doc: ${indexDocId}`);
    console.log(`Created ${createdDocs.length} content docs`);

    // Give the server time to receive sync messages
    await sleep(2000);

    // --- Phase 2: Disconnect ---
    adapter1.disconnect();
    console.log('Client disconnected');

    // Wait a moment between disconnect and reconnect
    await sleep(1000);

    // --- Phase 3: Reconnect with a fresh client and verify ---
    console.log('Reconnecting with fresh client...');
    const { repo: repo2, adapter: adapter2 } = await connectRepo(server.url);

    try {
      // Find the index document
      const indexHandle2 = await repo2.find<IndexDoc>(indexDocId as DocumentId);
      await indexHandle2.whenReady();

      const indexDoc = indexHandle2.doc();
      expect(indexDoc).toBeDefined();
      expect(indexDoc!.entries).toBeDefined();

      // Verify each content document
      const missing: string[] = [];
      const contentMismatch: string[] = [];

      for (const { name, content } of TEST_DOCS) {
        const docId = indexDoc!.entries[name];
        if (!docId) {
          missing.push(name);
          continue;
        }

        const handle = await repo2.find<TextDoc>(docId as DocumentId);

        try {
          // Wait for the document with a timeout
          const ready = await Promise.race([
            handle.whenReady().then(() => true),
            sleep(5000).then(() => false),
          ]);

          if (!ready) {
            missing.push(name);
            console.error(`  Document "${name}" (${docId}) timed out waiting for ready`);
            continue;
          }

          const doc = handle.doc();
          if (!doc || doc.text !== content) {
            contentMismatch.push(name);
            console.error(
              `  Content mismatch for "${name}": expected ${JSON.stringify(content).slice(0, 60)}, got ${JSON.stringify(doc?.text).slice(0, 60)}`,
            );
          }
        } catch (err) {
          missing.push(name);
          console.error(`  Document "${name}" (${docId}) failed: ${err}`);
        }
      }

      // Report results
      if (missing.length > 0) {
        console.error(`Missing documents: ${missing.join(', ')}`);
      }
      if (contentMismatch.length > 0) {
        console.error(`Content mismatches: ${contentMismatch.join(', ')}`);
      }

      expect(missing, `Missing documents: ${missing.join(', ')}`).toEqual([]);
      expect(contentMismatch, `Content mismatches: ${contentMismatch.join(', ')}`).toEqual([]);
    } finally {
      adapter2.disconnect();
    }
  });
});
