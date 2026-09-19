import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { parseArgs } from '../src/Scripts/pipeline.js';
import PipelineService from '../src/Services/pipeline.service.js';
import type { ExtractedFunction } from '../src/Models/contracts.js';
import type { ICluster } from '../src/Models/cluster.model.js';

describe('parseArgs', () => {
  it('rejects unknown flags with usage guidance', () => {
    expect(() => parseArgs(['owner/repo', '--bogus'])).toThrow('Unknown flag --bogus');
  });

  it('rejects value flags when their value is another flag', () => {
    expect(() => parseArgs(['owner/repo', '--cache-dir', '--max', '50'])).toThrow(
      '--cache-dir needs a path'
    );
  });

  it('continues to parse valid value and boolean flags', () => {
    expect(parseArgs(['owner/repo', '--cache-dir', 'tmp/cache', '--max', '50', '--json'])).toEqual({
      owner: 'owner',
      name: 'repo',
      cacheDir: 'tmp/cache',
      maxFunctions: 50,
      json: true,
    });
  });
});

describe('PipelineService with extractor cache fixture', () => {
  const HASH_A = 'e434559c8e9a1b88a0b4537b816ff972d176f1f11fd15cdb803cd26e4b8ed339';
  const HASH_B = '41cf18cc268b48dc4227b26b4020a425ad5b7e39fa7ad3ca05b833a431bb4b8e';

  const fnA: ExtractedFunction = {
    name: 'fnA',
    file: 'src/a.ts',
    startLine: 1,
    endLine: 5,
    signature: 'export function fnA(): void',
    body: 'export function fnA() {}',
    bodyHash: HASH_A,
    loc: 5,
    isExported: true,
    params: [],
    returnTypeText: 'void',
    imports: [],
    callsExternal: false,
    isPure: true,
    language: 'ts',
  };

  const fnB: ExtractedFunction = {
    name: 'fnB',
    file: 'src/b.ts',
    startLine: 1,
    endLine: 5,
    signature: 'export function fnB(): void',
    body: 'export function fnB() {}',
    bodyHash: HASH_B,
    loc: 5,
    isExported: true,
    params: [],
    returnTypeText: 'void',
    imports: [],
    callsExternal: false,
    isPure: true,
    language: 'ts',
  };

  it('reads dittoIgnoreContent from cache file and suppresses matching clusters', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-cache-test-'));

    try {
      const cachePayload = {
        owner: 'test-owner',
        name: 'test-repo',
        commit: 'abc1234',
        functions: [fnA, fnB],
        dittoIgnoreContent: `
[files]
dist/**

[suppressions]
e434559c8e9a:41cf18cc268b # intentional test pair
`,
      };

      const cacheFilePath = path.join(tempDir, 'test-owner-test-repo.json');
      await writeFile(cacheFilePath, JSON.stringify(cachePayload), 'utf8');

      // Mocked repositories and services for a hermetic unit run
      const repoId = '6a5a506029d58c7241f1fd90';
      const docA = { ...fnA, _id: { toString: () => 'id-a' }, repoId };
      const docB = { ...fnB, _id: { toString: () => 'id-b' }, repoId };

      const repoRepository = {
        upsertSnapshot: vi.fn().mockResolvedValue({ _id: { toString: () => repoId }, embedVersion: 'v2' }),
        update: vi.fn().mockResolvedValue(undefined),
        saveStats: vi.fn().mockResolvedValue(undefined),
      };

      const functionRepository = {
        findCachedDerivations: vi.fn().mockResolvedValue([]),
        replaceForRepo: vi.fn().mockResolvedValue([docA, docB]),
      };

      let savedClusterDocs: Partial<ICluster>[] = [];
      const clusterRepository = {
        replaceForRepo: vi.fn().mockImplementation((_rId: string, docs: Partial<ICluster>[]) => {
          savedClusterDocs = docs;
          return Promise.resolve(docs);
        }),
      };

      const fingerprintService = {
        fingerprintAll: vi.fn().mockResolvedValue({
          byHash: new Map([
            [HASH_A, { domain: 'math', inputs: [], outputs: [] }],
            [HASH_B, { domain: 'math', inputs: [], outputs: [] }],
          ]),
          apiCalls: 0,
          reusedFromCache: 2,
          failed: 0,
        }),
      };

      // Mock embeddings with identical vectors to ensure candidate cluster formation
      const identicalVector = new Array(1536).fill(0.1);
      const embeddingService = {
        embedAll: vi.fn().mockResolvedValue({
          byHash: new Map([
            [HASH_A, identicalVector],
            [HASH_B, identicalVector],
          ]),
          embedded: 0,
          reusedFromCache: 2,
        }),
      };

      const adjudicateService = {
        adjudicateAll: vi.fn().mockResolvedValue({
          clusters: [
            {
              memberIds: ['id-a', 'id-b'],
              canonicalId: 'id-a',
              behaviorSummary: 'test identical functions',
              domain: 'math',
              differences: [],
              disagreementRisk: 'none',
              confidence: 0.95,
              probeInputs: [],
            },
          ],
          rejected: 0,
          failed: 0,
        }),
      };

      const probeService = {
        probe: vi.fn().mockResolvedValue(undefined),
      };

      const pipeline = new PipelineService({
        repoRepository: repoRepository as never,
        functionRepository: functionRepository as never,
        clusterRepository: clusterRepository as never,
        fingerprintService: fingerprintService as never,
        embeddingService: embeddingService as never,
        adjudicateService: adjudicateService as never,
        probeService: probeService as never,
      });

      const report = await pipeline.run({
        owner: 'test-owner',
        name: 'test-repo',
        cacheDir: tempDir,
      });

      // Verify the cluster was suppressed via the cache's dittoIgnoreContent
      expect(savedClusterDocs).toHaveLength(1);
      expect(savedClusterDocs[0].isSuppressed).toBe(true);
      expect(savedClusterDocs[0].suppressionReason).toBe('intentional test pair');

      // Verify stats reflect suppressedClusters without debt
      expect(report.stats.suppressedClusters).toBe(1);
      expect(report.stats.semanticDuplicateClusters).toBe(0);
      expect(report.stats.linesRemovable).toBe(0);
      expect(report.stats.callSitesUnifiable).toBe(0);
      expect(report.stats.healthScore).toBe(100);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
