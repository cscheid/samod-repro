/**
 * Server lifecycle manager for the samod bug reproduction.
 *
 * Starts and stops the samod-minimal-server binary as a child process
 * with an isolated data directory. This server is a plain samod WebSocket
 * server with DontAnnounce policy — no quarto-specific code.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface ServerHandle {
  /** WebSocket URL for sync clients */
  url: string;
  /** Path to the server's data directory */
  dataDir: string;
  /** Stop the server and clean up */
  stop(): Promise<void>;
}

interface StartOptions {
  port: number;
  /** If provided, use this directory instead of creating a temp one */
  dataDir?: string;
}

/** Directory containing the samod-minimal-server crate */
const SERVER_DIR = path.resolve(import.meta.dirname, '..', 'samod-minimal-server');

/**
 * Wait for a line matching `pattern` in the process's combined stdout/stderr.
 * Rejects after `timeoutMs`.
 */
function waitForOutput(
  proc: ChildProcess,
  pattern: RegExp,
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';

    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timeout (${timeoutMs}ms) waiting for ${label} to be ready.\nCaptured output:\n${output}`,
        ),
      );
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      for (const line of text.split('\n')) {
        if (line.trim()) {
          console.log(`  [${label}] ${line}`);
        }
      }
      if (pattern.test(output)) {
        cleanup();
        resolve();
      }
    };

    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`${label} exited with code ${code} before becoming ready.\nOutput:\n${output}`));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      proc.stdout?.off('data', onData);
      proc.stderr?.off('data', onData);
      proc.off('exit', onExit);
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('exit', onExit);
  });
}

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/**
 * Start the samod-minimal-server.
 *
 * This is a plain samod WebSocket server with DontAnnounce policy —
 * the exact configuration that triggers the bug.
 *
 * Timeout is generous (120s) because the first run may need to compile.
 */
export async function startServer(options: StartOptions): Promise<ServerHandle> {
  const dataDir = options.dataDir ?? (await makeTempDir('samod-repro-'));

  const proc = spawn(
    'cargo',
    [
      'run', '--',
      '--data-dir', dataDir,
      '--port', String(options.port),
    ],
    {
      cwd: SERVER_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RUST_LOG: process.env.RUST_LOG ?? 'info',
      },
    },
  );

  await waitForOutput(proc, /samod-minimal-server listening/, 120_000, 'samod-server');

  return {
    url: `ws://127.0.0.1:${options.port}`,
    dataDir,
    async stop() {
      if (!proc.killed) {
        proc.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            proc.kill('SIGKILL');
            resolve();
          }, 5000);
          proc.on('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
