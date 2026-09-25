import { parentPort, workerData } from 'node:worker_threads';
import crypto from 'node:crypto';
import { loadPyodide } from 'pyodide';
import type { ProbeCell, WorkerResult } from '../../contracts.js';

interface PythonWorkerData {
  /** The harness.py source code as a string (injected into Pyodide globals). */
  harnessSource: string;
  members: Array<{ id: string; body: string; preamble?: string }>;
  inputs: string[];
  /** Maximum characters to display before truncating and hashing output. */
  maxDisplayChars: number;
  /**
   * SharedArrayBuffer view for per-call interruption.
   * Main thread writes 2 (SIGINT) to trigger KeyboardInterrupt in Pyodide.
   * Worker resets to 0 before each call.
   */
  interruptBuffer: Int32Array;
}

const data = workerData as PythonWorkerData;

async function run(): Promise<void> {
  const pyodide = await loadPyodide();

  // Configure the interrupt buffer for per-call timeout.
  pyodide.setInterruptBuffer(data.interruptBuffer);

  await pyodide.runPythonAsync(data.harnessSource);

  const cells: ProbeCell[] = [];
  const unusable: Array<{ functionId: string; reason: string }> = [];
  const ready: Array<{ id: string; fn: any }> = [];

  for (const member of data.members) {
    try {
      const memberScope = pyodide.toPy({});

      if (member.preamble) {
        try {
          await pyodide.runPythonAsync(member.preamble, { globals: memberScope });
        } catch (_) {
          // Optional preamble failure is non-fatal.
        }
      }

      await pyodide.runPythonAsync(member.body, { globals: memberScope });

      const keys = Array.from(memberScope.keys() as string[]).filter((k: string) => !k.startsWith('__'));
      let targetFn: any = null;

      // Find the first callable in the scope (the candidate function).
      for (const k of keys) {
        const val = memberScope.get(k);
        if (typeof val === 'function' || (val && typeof val.call === 'function')) {
          targetFn = val;
          break;
        }
      }

      if (!targetFn) {
        unusable.push({
          functionId: member.id,
          reason: 'No callable function found in member body',
        });
      } else {
        ready.push({ id: member.id, fn: targetFn });
      }
    } catch (err) {
      unusable.push({
        functionId: member.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }


  const invokeHelper = pyodide.globals.get('invoke_candidate');

  for (const input of data.inputs) {
    for (const entry of ready) {
      let output = '';
      let error = '';
      let key = '';

      // Reset interrupt buffer to 0 (no signal) before each call.
      Atomics.store(data.interruptBuffer, 0, 0);

      // Arm a 1-second timeout: write 2 (SIGINT) to the shared buffer.
      // Pyodide checks this buffer at bytecode boundaries and raises KeyboardInterrupt.
      const interruptTimer = setTimeout(() => {
        Atomics.store(data.interruptBuffer, 0, 2); // 2 = SIGINT
      }, 1000);

      try {
        const rawResult: string = invokeHelper(entry.fn, input);
        clearTimeout(interruptTimer);
        // Reset buffer after successful completion.
        Atomics.store(data.interruptBuffer, 0, 0);

        const result = JSON.parse(rawResult);

        if (result.ok) {
          const full: string = result.value;
          const isLong = full.length > data.maxDisplayChars;
          // Long outputs: store SHA-256 hash as key, truncate display.
          key = 'return:' + (isLong ? crypto.createHash('sha256').update(full).digest('hex') : full);
          output = isLong ? full.slice(0, data.maxDisplayChars) + '...' : full;
        } else {
          error = `${result.name}: ${result.message}`;
          key = `throw:${result.name}`;
        }
      } catch (err: any) {
        clearTimeout(interruptTimer);
        // Always reset buffer after error too.
        Atomics.store(data.interruptBuffer, 0, 0);

        // Map KeyboardInterrupt (from interrupt buffer) to throw:Timeout
        // for semantic parity with the JS probe (vm.runInContext timeout).
        const isInterrupt =
          err?.type === 'KeyboardInterrupt' ||
          String(err?.message || err).includes('KeyboardInterrupt');

        if (isInterrupt) {
          error = 'Timeout: exceeded 1000ms';
          key = 'throw:Timeout';
        } else {
          const name = err instanceof Error ? err.name : 'Error';
          const msg = err instanceof Error ? err.message : String(err);
          error = `${name}: ${msg}`;
          key = `throw:${name}`;
        }
      }

      cells.push({
        input,
        functionId: entry.id,
        output,
        error,
        key,
      });
    }
  }

  const response: WorkerResult = { cells, unusable };
  parentPort?.postMessage(response);
}

run().catch((err) => {
  throw err;
});
