import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  parseArgs,
  parseFunctionTarget,
  addSuppression,
  checkSuppressions,
} from '../src/Scripts/suppress.js';

describe('Suppression CLI Helper (add & check)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ditto-suppress-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('parseArgs', () => {
    it('throws with usage when no args or --help is passed', () => {
      expect(() => parseArgs([])).toThrow(/Usage: npm run suppress --/);
      expect(() => parseArgs(['--help'])).toThrow(/Usage: npm run suppress --/);
      expect(() => parseArgs(['-h'])).toThrow(/Usage: npm run suppress --/);
    });

    it('parses "add" command with targets, --dir and --reason', () => {
      const args = parseArgs([
        'add',
        'src/a.ts:fnA',
        'src/b.ts:fnB',
        '--dir',
        '/tmp/repo',
        '--reason',
        'intentional duplicate',
      ]);
      expect(args.command).toBe('add');
      expect(args.targetA).toBe('src/a.ts:fnA');
      expect(args.targetB).toBe('src/b.ts:fnB');
      expect(args.dir).toBe('/tmp/repo');
      expect(args.reason).toBe('intentional duplicate');
    });

    it('parses "check" command with optional --dir', () => {
      const args = parseArgs(['check', '--dir', '/tmp/repo']);
      expect(args.command).toBe('check');
      expect(args.dir).toBe('/tmp/repo');
    });

    it('throws when required flags are missing values', () => {
      expect(() => parseArgs(['add', 'a:1', 'b:2', '--dir'])).toThrow(
        /--dir needs a directory path/
      );
      expect(() => parseArgs(['add', 'a:1', 'b:2', '--reason'])).toThrow(
        /--reason needs a reason text/
      );
    });

    it('throws when unknown command or flag is passed', () => {
      expect(() => parseArgs(['foo'])).toThrow(/Unknown command "foo"/);
      expect(() => parseArgs(['check', '--unknown'])).toThrow(/Unknown flag --unknown/);
    });

    it('throws when "add" is missing one of the two targets', () => {
      expect(() => parseArgs(['add', 'src/a.ts:fnA'])).toThrow(
        /"add" requires two function targets/
      );
    });
  });

  describe('parseFunctionTarget', () => {
    it('parses valid path:function targets', () => {
      const parsed = parseFunctionTarget('src/utils/date.ts:formatDate');
      expect(parsed.filePath).toBe('src/utils/date.ts');
      expect(parsed.selector).toBe('formatDate');
      expect(parsed.isLineNumber).toBe(false);
    });

    it('parses valid path:line disambiguation targets', () => {
      const parsed = parseFunctionTarget('src/utils/date.ts:42');
      expect(parsed.filePath).toBe('src/utils/date.ts');
      expect(parsed.selector).toBe('42');
      expect(parsed.isLineNumber).toBe(true);
    });

    it('rejects targets without a function name/line or missing colon', () => {
      expect(() => parseFunctionTarget('src/utils/date.ts')).toThrow(/Invalid function target/);
      expect(() => parseFunctionTarget('src/utils/date.ts:')).toThrow(/Invalid function target/);
      expect(() => parseFunctionTarget(':formatDate')).toThrow(/Invalid function target/);
    });
  });

  describe('addSuppression', () => {
    it('creates .dittoignore with [suppressions] and writes shortest unambiguous hashes', async () => {
      const fileA = path.join(tmpDir, 'fileA.ts');
      const fileB = path.join(tmpDir, 'fileB.ts');

      await fs.writeFile(
        fileA,
        `export function truncateA(text: string, len: number) {
          if (text.length <= len) return text;
          return text.slice(0, len);
        }`
      );

      await fs.writeFile(
        fileB,
        `export function truncateB(text: string, len: number) {
          if (text.length <= len) return text;
          return text.slice(0, len);
        }`
      );

      const res = await addSuppression('fileA.ts:truncateA', 'fileB.ts:truncateB', {
        targetDir: tmpDir,
        reason: 'intentional shim for worker',
      });

      expect(res.ruleLine).toContain(':');
      expect(res.ruleLine).toContain('# intentional shim for worker');
      expect(res.key).toBeDefined();
      expect(res.key.split(':')[0].length).toBeGreaterThanOrEqual(12);

      const content = await fs.readFile(res.dittoIgnorePath, 'utf-8');
      expect(content).toContain('[suppressions]');
      expect(content).toContain(res.ruleLine);
    });

    it('correctly appends under existing commented/cased [suppressions] header instead of prepending to file', async () => {
      const fileA = path.join(tmpDir, 'fnA.ts');
      const fileB = path.join(tmpDir, 'fnB.ts');
      const dittoIgnorePath = path.join(tmpDir, '.dittoignore');

      await fs.writeFile(
        fileA,
        `export function computeA(x: number) {
            const res = x * 2;
            return res;
         }`
      );
      await fs.writeFile(
        fileB,
        `export function computeB(x: number) {
            const res = x * 2;
           return res;
         }`
      );

      await fs.writeFile(
        dittoIgnorePath,
        `[files]
        vendor/**
        [Suppressions] # pairs of intentional clones
        `
      );

      const res = await addSuppression('fnA.ts:computeA', 'fnB.ts:computeB', {
        targetDir: tmpDir,
        reason: 'intentional mirror',
      });

      const content = await fs.readFile(res.dittoIgnorePath, 'utf-8');
      const lines = content.split(/\r?\n/).filter(Boolean);
      expect(lines[0]).toBe('[files]');
      const headerIdx = lines.findIndex((l) => l.includes('[Suppressions]'));
      const ruleIdx = lines.findIndex((l) => l.includes(res.ruleLine));
      expect(headerIdx).toBeGreaterThan(0);
      expect(ruleIdx).toBe(headerIdx + 1);
    });

    it('uses file:line as disambiguator when function names collide in a file', async () => {
      const fileA = path.join(tmpDir, 'service.ts');
      const fileB = path.join(tmpDir, 'other.ts');

      await fs.writeFile(
        fileA,
        `export function format(val: string) {
          const trimmed = val.trim();
          return trimmed.toLowerCase();
        }

        export const helper = {
          format(val: number) {
            const num = Math.round(val);
            return String(num);
          }
        };`
      );

      await fs.writeFile(
        fileB,
        `export function clean(val: string) {
          const trimmed = val.trim();
          return trimmed.toLowerCase();
        }`
      );

      await expect(
        addSuppression('service.ts:format', 'other.ts:clean', {
          targetDir: tmpDir,
        })
      ).rejects.toThrow(/Ambiguous function name 'format' in service.ts \(2 candidates found\)/);

      const res = await addSuppression('service.ts:1', 'other.ts:clean', {
        targetDir: tmpDir,
      });

      expect(res.ruleLine).toContain(':');
      const content = await fs.readFile(res.dittoIgnorePath, 'utf-8');
      expect(content).toContain(res.ruleLine);
    });

    it('defaults reason to include both file paths when not specified', async () => {
      const fileA = path.join(tmpDir, 'a.ts');
      const fileB = path.join(tmpDir, 'b.ts');

      await fs.writeFile(
        fileA,
        `export function fnA(s: string) {
          const a = s.trim();
          return a;
        }`
      );
      await fs.writeFile(
        fileB,
        `export function fnB(s: string) {
          const b = s.trim();
          return b;
        }`
      );

      const res = await addSuppression('a.ts:fnA', 'b.ts:fnB', {
        targetDir: tmpDir,
      });

      expect(res.ruleLine).toContain('# Intentional duplicate: fnA (a.ts) <-> fnB (b.ts)');
    });

    it('supports polyglot files including Python via registered adapters', async () => {
      const filePyA = path.join(tmpDir, 'utils.py');
      const filePyB = path.join(tmpDir, 'helpers.py');

      await fs.writeFile(
        filePyA,
        `def calculate_tax(amount, rate):\n    if amount <= 0:\n        return 0\n    return amount * rate\n`
      );

      await fs.writeFile(
        filePyB,
        `def compute_tax(amount, rate):\n    if amount <= 0:\n        return 0\n    return amount * rate\n`
      );

      const res = await addSuppression('utils.py:calculate_tax', 'helpers.py:compute_tax', {
        targetDir: tmpDir,
        reason: 'cross-service python tax calculation',
      });

      expect(res.ruleLine).toContain(':');
      expect(res.ruleLine).toContain('# cross-service python tax calculation');

      const content = await fs.readFile(res.dittoIgnorePath, 'utf-8');
      expect(content).toContain(res.ruleLine);
    });

    it('appends to existing .dittoignore without deleting existing ignore patterns', async () => {
      const dittoIgnorePath = path.join(tmpDir, '.dittoignore');
      await fs.writeFile(dittoIgnorePath, `dist/**\n*.log\n`);

      const fileA = path.join(tmpDir, 'src', 'a.ts');
      const fileB = path.join(tmpDir, 'src', 'b.ts');
      await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });

      await fs.writeFile(
        fileA,
        `export function fnA(s: string) {
          const trimmed = s.trim();
          return trimmed.toLowerCase();
        }`
      );
      await fs.writeFile(
        fileB,
        `export function fnB(s: string) {
          const trimmed = s.trim();
          return trimmed.toUpperCase();
        }`
      );

      await addSuppression('src/a.ts:fnA', 'src/b.ts:fnB', {
        targetDir: tmpDir,
      });

      const content = await fs.readFile(dittoIgnorePath, 'utf-8');
      expect(content).toContain('dist/**');
      expect(content).toContain('*.log');
      expect(content).toContain('[suppressions]');
    });

    it('throws a clear error if function is not found', async () => {
      const fileA = path.join(tmpDir, 'fileA.ts');
      await fs.writeFile(
        fileA,
        `export function existingFn() {
          const a = 1;
          return a + 2;
        }`
      );

      await expect(
        addSuppression('fileA.ts:nonExistent', 'fileA.ts:existingFn', {
          targetDir: tmpDir,
        })
      ).rejects.toThrow(/Function 'nonExistent' was not found in fileA.ts/);
    });
  });

  describe('checkSuppressions', () => {
    it('identifies active, stale, and invalid suppression rules across languages', async () => {
      const fileA = path.join(tmpDir, 'a.ts');
      const fileB = path.join(tmpDir, 'b.py');

      await fs.writeFile(
        fileA,
        `export function clampA(n: number, min: number, max: number) {
          if (n < min) return min;
          if (n > max) return max;
          return n;
        }`
      );
      await fs.writeFile(
        fileB,
        `def clamp_b(n, lo, hi):\n    if n < lo:\n        return lo\n    if n > hi:\n        return hi\n    return n\n`
      );

      // Add valid rule
      await addSuppression('a.ts:clampA', 'b.py:clamp_b', {
        targetDir: tmpDir,
        reason: 'polyglot clamp pair',
      });

      // Manually inject a stale rule and an invalid rule
      const dittoIgnorePath = path.join(tmpDir, '.dittoignore');
      await fs.appendFile(
        dittoIgnorePath,
        `deadbeef12345678:feedface12345678 # stale rule\nshort:short # invalid short\n`
      );

      const check = await checkSuppressions({ targetDir: tmpDir });

      expect(check.hasDittoIgnore).toBe(true);
      expect(check.activeRules).toHaveLength(1);
      expect(check.activeRules[0].reason).toBe('polyglot clamp pair');
      expect(check.staleRules).toHaveLength(1);
      expect(check.staleRules[0].rawHashA).toBe('deadbeef12345678');
      expect(check.invalidRules).toHaveLength(1);
      expect(check.invalidRules[0].error).toContain('at least 12 characters');
    });

    it('returns clean diagnostic when no .dittoignore exists', async () => {
      const check = await checkSuppressions({ targetDir: tmpDir });
      expect(check.hasDittoIgnore).toBe(false);
      expect(check.activeRules).toHaveLength(0);
    });
  });
});
