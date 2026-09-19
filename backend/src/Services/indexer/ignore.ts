import ignore from 'ignore';
import { parsePairSuppressions, type RawSuppressionRule } from './suppression.js';
import logger from '../../Config/logger.js';

export interface IgnoreMatcher {
  /** True when repo-relative path matches one of the ignore patterns */
  isIgnored(repoRelativePath: string): boolean;
  /** Active parsed glob patterns */
  patterns: string[];
}

export interface ParsedDittoConfig {
  filePatterns: string[];
  rawSuppressions: RawSuppressionRule[];
}

/**
 * Rigorously splits .dittoignore upstream:
 * - filePatterns (globs) passed exclusively to ignore()
 * - rawSuppressions passed to the pair engine
 */
export const parseDittoFile = (content?: string): ParsedDittoConfig => {
  if (!content) {
    return { filePatterns: [], rawSuppressions: [] };
  }

  const lines = content.split(/\r?\n/);
  const fileLines: string[] = [];
  const suppressionLines: string[] = [];

  let currentSection: 'files' | 'suppressions' = 'files';

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const commentIdx = trimmed.indexOf('#');
    const lineWithoutComment = (commentIdx !== -1 ? trimmed.slice(0, commentIdx) : trimmed).trim();

    if (lineWithoutComment.startsWith('[') && lineWithoutComment.endsWith(']')) {
      const header = lineWithoutComment.toLowerCase();
      if (header === '[files]') {
        currentSection = 'files';
        continue;
      }
      if (header === '[suppressions]') {
        currentSection = 'suppressions';
        continue;
      }
      logger.warn(`[DITTOIGNORE] Unknown section header '${lineWithoutComment}' ignored.`);
      continue;
    }

    if (currentSection === 'files') {
      fileLines.push(trimmed);
    } else {
      suppressionLines.push(rawLine);
    }
  }

  const parsedSuppressions = parsePairSuppressions(suppressionLines.join('\n'));

  for (const m of parsedSuppressions.malformed) {
    logger.warn(`[DITTOIGNORE] Malformed suppression rule: "${m.rawLine}" — ${m.error}`);
  }

  return {
    filePatterns: fileLines,
    rawSuppressions: parsedSuppressions.rules,
  };
};

/**
 * Parses raw .dittoignore file contents into clean glob patterns.
 * - Strips leading/trailing whitespace.
 * - Discards empty lines.
 * - Discards comment lines starting with '#'.
 */
export const parseIgnorePatterns = (content?: string): string[] => {
  return parseDittoFile(content).filePatterns;
};

export const createIgnoreMatcher = (patterns: string[]): IgnoreMatcher => {
  if (patterns.length === 0) {
    return {
      isIgnored: () => false,
      patterns: [],
    };
  }

  // ignore package implements official .gitignore specification
  const ig = ignore().add(patterns);

  return {
    isIgnored: (repoRelativePath: string): boolean => {
      // Normalise leading slash or relative prefix for .gitignore evaluation
      const cleanPath = repoRelativePath.replace(/^\/+/, '');
      if (!cleanPath) return false;
      return ig.ignores(cleanPath);
    },
    patterns,
  };
};
