import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import chalk from 'chalk';
import {
  isAnySourceFile,
  isAnyExcludedDirectory,
  adapterFor,
} from '../Services/indexer/language/registry.js';
import { parseDittoFile, createIgnoreMatcher } from '../Services/indexer/ignore.js';
import {
  resolveSuppressions,
  MIN_HASH_PREFIX_LENGTH,
  computeShortestUnambiguousPrefix,
} from '../Services/indexer/suppression.js';
import type { ExtractedFunction } from '../Models/contracts.js';
import type { SuppressionResolutionResult } from '../Services/indexer/suppression.js';

/**
 * `npm run suppress -- <command> [options]`
 *
 * Adds or audits per-pair duplicate suppression rules in `.dittoignore`.
 * Runs LOCALLY against any target repository.
 */

export interface CliArgs {
  command: 'add' | 'check';
  targetA?: string;
  targetB?: string;
  dir?: string;
  reason?: string;
}

export const usage = `Usage: npm run suppress -- <command> [options]

Commands:
  add <fileA:fnA> <fileB:fnB>  add a per-pair suppression rule to .dittoignore
  check                        audit .dittoignore rules against current repository state

Options:
  --dir <path>                 target repo directory (default: current working directory)
  --reason <text>              optional explanation for why this duplicate is intentional

Examples:
  npm run suppress -- add src/util.ts:formatDate src/helpers/date.ts:formatDate
  npm run suppress -- add utils.py:calc_tax helpers.py:compute_tax --reason "intentional tax duplicate"
  npm run suppress -- check
  npm run suppress -- check --dir ../another-repo`;

export const parseArgs = (argv: string[]): CliArgs => {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    throw new Error(usage);
  }

  const flags = new Map<string, string>();
  const positional: string[] = [];
  const takesValue = new Set(['--dir', '--reason']);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (takesValue.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        const detail = arg === '--dir' ? 'a directory path' : 'a reason text';
        throw new Error(`${arg} needs ${detail}.\n\n${usage}`);
      }
      flags.set(arg, value);
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag ${arg}.\n\n${usage}`);
    } else {
      positional.push(arg);
    }
  }

  const command = positional[0];
  if (command !== 'add' && command !== 'check') {
    throw new Error(`Unknown command "${command}". Expected "add" or "check".\n\n${usage}`);
  }

  if (command === 'add') {
    const targetA = positional[1];
    const targetB = positional[2];
    if (!targetA || !targetB) {
      throw new Error(`"add" requires two function targets: <fileA:fnA> <fileB:fnB>.\n\n${usage}`);
    }
    return {
      command: 'add',
      targetA,
      targetB,
      dir: flags.get('--dir'),
      reason: flags.get('--reason'),
    };
  }

  return {
    command: 'check',
    dir: flags.get('--dir'),
  };
};

export interface FunctionTarget {
  filePath: string;
  selector: string; // functionName or line number
  isLineNumber: boolean;
}

export interface AddSuppressionOptions {
  targetDir?: string;
  reason?: string;
}

export interface CheckSuppressionsOptions {
  targetDir?: string;
}

export type CheckSuppressionsResult = SuppressionResolutionResult & {
  hasDittoIgnore: boolean;
  totalRules: number;
  skippedParseErrors: number;
};

const plural = (count: number, singular: string, pluralForm: string = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralForm}`;

/**
 * Parses target strings like "src/utils/date.ts:formatDate" or "src/utils/date.ts:25"
 */
export const parseFunctionTarget = (targetStr: string): FunctionTarget => {
  const lastColon = targetStr.lastIndexOf(':');
  if (lastColon <= 0 || lastColon === targetStr.length - 1) {
    throw new Error(
      `Invalid function target '${targetStr}'. Expected format: path/to/file.ext:functionName or path/to/file.ext:line`
    );
  }

  const filePath = targetStr.slice(0, lastColon);
  const selector = targetStr.slice(lastColon + 1);
  const isLineNumber = /^\d+$/.test(selector);

  return {
    filePath,
    selector,
    isLineNumber,
  };
};

/**
 * Finds a specific function in a file and returns its extracted metadata.
 * Fails loud if multiple functions match a name, requiring file:line disambiguation.
 */
export const resolveFunctionInFile = async (
  target: FunctionTarget,
  baseDir: string
): Promise<ExtractedFunction> => {
  const adapter = adapterFor(target.filePath);
  if (!adapter) {
    throw new Error(
      `Unsupported file type for '${target.filePath}'. No registered language adapter matches this path.`
    );
  }

  const fullPath = path.resolve(baseDir, target.filePath);
  let content: string;
  try {
    content = await fs.readFile(fullPath, 'utf-8');
  } catch {
    throw new Error(`Could not read file: ${target.filePath} (resolved to ${fullPath})`);
  }

  const { functions } = adapter.extract(target.filePath, content);

  if (target.isLineNumber) {
    const targetLine = parseInt(target.selector, 10);
    const match = functions.find((fn) => targetLine >= fn.startLine && targetLine <= fn.endLine);
    if (!match) {
      throw new Error(
        `No function spans line ${targetLine} in ${target.filePath}. Functions in file: ${
          functions.map((f) => `${f.name} (L${f.startLine}-${f.endLine})`).join(', ') || 'none'
        }`
      );
    }
    return match;
  }

  // Otherwise matching by function name
  const matched = functions.filter((fn) => fn.name === target.selector);

  if (matched.length === 0) {
    throw new Error(
      `Function '${target.selector}' was not found in ${target.filePath}. Available functions: ${
        functions.map((f) => `${f.name} (L${f.startLine})`).join(', ') || 'none'
      }`
    );
  }

  if (matched.length > 1) {
    const candidates = matched
      .map((f) => `  - ${f.name} at line ${f.startLine} (L${f.startLine}-${f.endLine})`)
      .join('\n');
    throw new Error(
      `Ambiguous function name '${target.selector}' in ${target.filePath} (${matched.length} candidates found):\n${candidates}\n` +
        `Please disambiguate by specifying the line number: ${target.filePath}:<line>`
    );
  }

  return matched[0];
};

/**
 * Adds a suppression rule to the target repository's .dittoignore
 */
export const addSuppression = async (
  targetAStr: string,
  targetBStr: string,
  options: AddSuppressionOptions = {}
): Promise<{ ruleLine: string; dittoIgnorePath: string; key: string }> => {
  const baseDir = path.resolve(options.targetDir ?? process.cwd());
  const targetA = parseFunctionTarget(targetAStr);
  const targetB = parseFunctionTarget(targetBStr);

  const fnA = await resolveFunctionInFile(targetA, baseDir);
  const fnB = await resolveFunctionInFile(targetB, baseDir);

  const { functions: universe } = await extractRepoUniverse(baseDir);
  const allDistinctHashes = Array.from(
    new Set([...universe.map((f) => f.bodyHash), fnA.bodyHash, fnB.bodyHash].filter(Boolean))
  );

  const prefixA = computeShortestUnambiguousPrefix(
    fnA.bodyHash,
    allDistinctHashes,
    MIN_HASH_PREFIX_LENGTH
  );
  const prefixB = computeShortestUnambiguousPrefix(
    fnB.bodyHash,
    allDistinctHashes,
    MIN_HASH_PREFIX_LENGTH
  );

  const commentReason = options.reason
    ? options.reason.trim()
    : `Intentional duplicate: ${fnA.name} (${fnA.file}) <-> ${fnB.name} (${fnB.file})`;

  const ruleLine = `${prefixA}:${prefixB} # ${commentReason}`;
  const dittoIgnorePath = path.join(baseDir, '.dittoignore');

  let existingContent = '';
  try {
    existingContent = await fs.readFile(dittoIgnorePath, 'utf-8');
  } catch {
    // File does not exist yet
  }

  let updatedContent = '';
  const lines = existingContent.split(/\r?\n/);
  const sectionIndex = lines.findIndex((l) => {
    const withoutComment = l.split('#')[0].trim().toLowerCase();
    return withoutComment === '[suppressions]';
  });

  if (sectionIndex !== -1) {
    // Append to existing [suppressions] section
    lines.splice(sectionIndex + 1, 0, ruleLine);
    updatedContent = lines.join('\n');
    if (!updatedContent.endsWith('\n')) updatedContent += '\n';
  } else if (!existingContent.trim()) {
    updatedContent = `[suppressions]\n${ruleLine}\n`;
  } else {
    // [suppressions] section does not exist yet, append it at the bottom
    const separator = existingContent.endsWith('\n') ? '\n' : '\n\n';
    updatedContent = `${existingContent}${separator}[suppressions]\n${ruleLine}\n`;
  }

  await fs.writeFile(dittoIgnorePath, updatedContent, 'utf-8');

  return { ruleLine, dittoIgnorePath, key: `${prefixA}:${prefixB}` };
};

/**
 * Scans the target repository respecting .dittoignore path patterns
 * and extracts all functions across all registered languages.
 */
export const extractRepoUniverse = async (
  baseDir: string
): Promise<{ functions: ExtractedFunction[]; skippedParseErrors: number }> => {
  const dittoIgnorePath = path.join(baseDir, '.dittoignore');
  let filePatterns: string[] = [];

  try {
    const content = await fs.readFile(dittoIgnorePath, 'utf-8');
    filePatterns = parseDittoFile(content).filePatterns;
  } catch {
    // No .dittoignore yet
  }

  const ignoreMatcher = createIgnoreMatcher(filePatterns);
  const sourceFiles = await walkSourceFiles(baseDir, baseDir, (p) => ignoreMatcher.isIgnored(p));

  const allFunctions: ExtractedFunction[] = [];
  let skippedParseErrors = 0;
  for (const file of sourceFiles) {
    const adapter = adapterFor(file);
    if (!adapter) continue;

    try {
      const code = await fs.readFile(path.join(baseDir, file), 'utf-8');
      const { functions } = adapter.extract(file, code);
      allFunctions.push(...functions);
    } catch {
      skippedParseErrors++;
    }
  }

  return { functions: allFunctions, skippedParseErrors };
};

/**
 * Recursively scans directory for source files across all registered languages,
 * pruning canonical excluded directories and respecting .dittoignore path filters.
 */
export const walkSourceFiles = async (
  dir: string,
  baseDir: string = dir,
  isIgnored?: (path: string) => boolean
): Promise<string[]> => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      // Use canonical directory exclusions from language registry
      if (isAnyExcludedDirectory(entry.name)) {
        continue;
      }
      if (isIgnored?.(relativePath)) {
        continue;
      }
      const sub = await walkSourceFiles(fullPath, baseDir, isIgnored);
      results.push(...sub);
    } else if (entry.isFile()) {
      if (isIgnored?.(relativePath)) {
        continue;
      }
      if (isAnySourceFile(relativePath)) {
        results.push(relativePath);
      }
    }
  }

  return results;
};

/**
 * Audits all suppression rules configured in .dittoignore
 */
export const checkSuppressions = async (
  options: CheckSuppressionsOptions = {}
): Promise<CheckSuppressionsResult> => {
  const baseDir = path.resolve(options.targetDir ?? process.cwd());
  const dittoIgnorePath = path.join(baseDir, '.dittoignore');

  let content = '';
  try {
    content = await fs.readFile(dittoIgnorePath, 'utf-8');
  } catch {
    return {
      hasDittoIgnore: false,
      totalRules: 0,
      skippedParseErrors: 0,
      activeRules: [],
      staleRules: [],
      invalidRules: [],
      ambiguities: [],
    };
  }

  const parsed = parseDittoFile(content);
  if (parsed.rawSuppressions.length === 0) {
    return {
      hasDittoIgnore: true,
      totalRules: 0,
      skippedParseErrors: 0,
      activeRules: [],
      staleRules: [],
      invalidRules: [],
      ambiguities: [],
    };
  }

  const { functions: allFunctions, skippedParseErrors } = await extractRepoUniverse(baseDir);
  const resolution = resolveSuppressions(parsed.rawSuppressions, allFunctions);

  return {
    hasDittoIgnore: true,
    totalRules: parsed.rawSuppressions.length,
    skippedParseErrors,
    ...resolution,
  };
};

/**
 * CLI Runner Entrypoint
 */
export const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'add') {
    const { ruleLine, dittoIgnorePath } = await addSuppression(args.targetA!, args.targetB!, {
      targetDir: args.dir,
      reason: args.reason,
    });
    console.log(chalk.green(`✔ suppression added to ${dittoIgnorePath}:`));
    console.log(`  ${ruleLine}`);
    return;
  }

  if (args.command === 'check') {
    const targetDir = args.dir ? path.resolve(args.dir) : process.cwd();
    console.log(chalk.blue(`checking .dittoignore suppressions in ${targetDir}...`));
    const result = await checkSuppressions({ targetDir });

    if (!result.hasDittoIgnore) {
      console.log('  no .dittoignore found in target directory.');
      return;
    }

    if (result.totalRules === 0) {
      console.log('  no suppression rules configured in .dittoignore.');
      if (result.skippedParseErrors > 0) {
        console.log(
          chalk.yellow(`  ${plural(result.skippedParseErrors, 'file')} skipped (parse error)`)
        );
      }
      return;
    }

    console.log(`\n  audited ${plural(result.totalRules, 'rule')}:\n`);
    if (result.skippedParseErrors > 0) {
      console.log(
        chalk.yellow(`  ${plural(result.skippedParseErrors, 'file')} skipped (parse error)\n`)
      );
    }

    if (result.activeRules.length > 0) {
      console.log(chalk.green(`  ✔ ${plural(result.activeRules.length, 'active rule')}:`));
      for (const r of result.activeRules) {
        const namesA = r.functionsA?.map((f) => `${f.file}:${f.name}`).join(', ') ?? 'fnA';
        const namesB = r.functionsB?.map((f) => `${f.file}:${f.name}`).join(', ') ?? 'fnB';
        console.log(
          `    [${r.fullHashA.slice(0, 12)}:${r.fullHashB.slice(0, 12)}] ${namesA} <-> ${namesB}`
        );
        if (r.reason) console.log(`      Reason: ${r.reason}`);
      }
    }

    if (result.staleRules.length > 0) {
      console.log('');
      console.warn(
        chalk.yellow(
          `  ⚠ ${plural(result.staleRules.length, 'stale rule')} (functions modified or deleted):`
        )
      );
      for (const s of result.staleRules) {
        console.log(`    ${s.rawHashA}:${s.rawHashB}${s.reason ? ` # ${s.reason}` : ''}`);
      }
    }

    if (result.invalidRules.length > 0) {
      console.log('');
      console.error(
        chalk.red(
          `  ✖ ${plural(result.invalidRules.length, 'invalid rule')} (prefix shorter than ${MIN_HASH_PREFIX_LENGTH}):`
        )
      );
      for (const inv of result.invalidRules) {
        console.log(`    ${inv.rule.rawHashA}:${inv.rule.rawHashB} -> ${inv.error}`);
      }
    }

    if (result.ambiguities.length > 0) {
      console.log('');
      console.error(chalk.red(`  ✖ ${plural(result.ambiguities.length, 'ambiguous rule')}:`));
      for (const amb of result.ambiguities) {
        console.log(
          `    prefix '${amb.prefix}' matches ${amb.matchingHashes.length} distinct functions:`
        );
        for (const f of amb.functions) {
          console.log(`      * ${f.file}:${f.name} (${f.bodyHash.slice(0, 12)})`);
        }
      }
    }

    if (result.invalidRules.length > 0 || result.ambiguities.length > 0) {
      process.exit(1);
    }
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    if (err instanceof Error && err.message.startsWith('Usage:')) {
      console.log(err.message);
      process.exit(0);
    }
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
}
