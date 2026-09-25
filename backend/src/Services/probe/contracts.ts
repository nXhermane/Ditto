import type { ExtractedFunction } from "../../Models/contracts.js";

/** Per call. A pure utility that needs a second is not a pure utility. */
export const PROBE_TIMEOUT_MS = 1_000;

/** No repo gets to hold the pipeline hostage. */
export const MAX_WORKER_MS = 30_000;

/** Longer outputs are truncated for display only — never for comparison. */
export const MAX_DISPLAY_CHARS = 2_000;

export interface ProbeMember {
  id: string;
  body: string;
  /** Purity, from the extractor. The gate on execution. */
  isPure: boolean;
  /** Source language. Derived from `ExtractedFunction.language` so the two stay in lockstep. */
  language?: NonNullable<ExtractedFunction['language']>;
  /**
   * Same-file declarations the body needs to run — helpers it calls, constants
   * it reads. Without these a function that is legitimately pure still throws
   * ReferenceError in the sandbox. See Services/indexer/preamble.ts.
   */
  preamble?: string;
}

/** One function × one input, as reported by the worker. */
export interface ProbeCell {
  input: string;
  functionId: string;
  /** Serialised return value; '' when it threw. */
  output: string;
  /** 'Name: message'; '' when it did not throw. */
  error: string;
  /**
   * Canonical identity of this result. Built from the FULL serialisation even
   * when `output` was truncated, so two different long outputs never collapse
   * into a false agreement.
   */
  key: string;
}

export interface WorkerResult {
  cells: ProbeCell[];
  /** Members that could not be turned into a callable function. */
  unusable: Array<{ functionId: string; reason: string }>;
}

export interface LanguageProbeRunner {
  run(members: ProbeMember[], inputs: string[]): Promise<WorkerResult>;
}