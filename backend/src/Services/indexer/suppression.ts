import logger from '../../Config/logger.js';
import type { ExtractedFunction } from '../../Models/contracts.js';

export const MIN_HASH_PREFIX_LENGTH = 12;
export const FULL_HASH_LENGTH = 64;

/**
 * Raw suppression rule from .dittoignore parsing
 */
export interface RawSuppressionRule {
  rawHashA: string; // full or prefix
  rawHashB: string;
  /** Optional human-readable reason documented after '#' */
  reason?: string;
}

/** Rule resolved unambiguously against the universe of functions */
export interface ResolvedSuppression {
  fullHashA: string;
  fullHashB: string;
  canonicalKey: string;
  reason?: string;
  /** Functions associated with hash A */
  functionsA?: Array<{ file: string; name: string }>;
  /** Functions associated with hash B */
  functionsB?: Array<{ file: string; name: string }>;
}

export interface AmbiguityDiagnostic {
  prefix: string;
  matchingHashes: string[];
  functions: Array<{ file: string; name: string; bodyHash: string }>;
  message: string;
}

export interface SuppressionResolutionResult {
  activeRules: ResolvedSuppression[];
  ambiguities: AmbiguityDiagnostic[];
  invalidRules: Array<{ rule: RawSuppressionRule; error: string }>;
  staleRules: RawSuppressionRule[];
}

export interface SuppressionMatcher {
  /** Check whether a duplicate pair between hashA and hashB is suppressed */
  isPairSuppressed(hashA: string, hashB: string): boolean;
  /** Retrieve suppression metadata (e.g. reason) for this pair */
  getSuppression(hashA: string, hashB: string): ResolvedSuppression | undefined;
  activeRules: ResolvedSuppression[];
  ambiguities: AmbiguityDiagnostic[];
}

/**
 * Builds a deterministic, commutative pair key from two hashes.
 * Canonical form: min(hashA, hashB) + ":" + max(hashA, hashB).
 * Order-independent: buildPairKey(a, b) === buildPairKey(b, a).
 */
export const buildPairKey = (hashA: string, hashB: string): string => {
  const a = hashA.toLowerCase().trim();
  const b = hashB.toLowerCase().trim();
  return a < b ? `${a}:${b}` : `${b}:${a}`;
};

export interface SuppressionDiagnostic {
  rawLine: string;
  error: string;
}
/**
 * Parses raw text content of suppressions (from .dittoignore [suppressions]).
 *
 * Syntax: <hashA>:<hashB> # optional reason
 * Or  : <hashA> <hasbB> # optional reason
 */
export const parsePairSuppressions = (
  content?: string
): { rules: RawSuppressionRule[]; malformed: SuppressionDiagnostic[] } => {
  if (!content) return { rules: [], malformed: [] };

  const rules: RawSuppressionRule[] = [];
  const malformed: SuppressionDiagnostic[] = [];
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Split line from inline comment
    const commentIndex = trimmed.indexOf('#');
    const rulePart = commentIndex !== -1 ? trimmed.slice(0, commentIndex).trim() : trimmed;
    const reason = commentIndex !== -1 ? trimmed.slice(commentIndex + 1).trim() : undefined;

    // Support separator ':' or whitespace
    let parts: string[] = [];
    if (rulePart.includes(':')) {
      parts = rulePart
        .split(':')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      parts = rulePart
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }

    if (parts.length === 2) {
      rules.push({
        rawHashA: parts[0].toLowerCase(),
        rawHashB: parts[1].toLowerCase(),
        reason: reason || undefined,
      });
    } else {
      malformed.push({
        rawLine,
        error:
          parts.length < 2
            ? 'Line has fewer than 2 hash tokens'
            : 'Line has more than 2 tokens without a leading "#" for comment',
      });
    }
  }

  return { rules, malformed };
};

type ResolveOutcome =
  | { status: 'resolved'; resolvedHash: string }
  | { status: 'ambiguous'; diagnostic: AmbiguityDiagnostic }
  | { status: 'notFound' };

const resolveHashCandidate = (
  prefix: string,
  allDistinctHashes: string[],
  hashToFunctions: Map<string, Array<{ file: string; name: string }>>
): ResolveOutcome => {
  const p = prefix.toLowerCase();

  if (p.length === FULL_HASH_LENGTH) {
    if (hashToFunctions.has(p)) {
      return { status: 'resolved', resolvedHash: p };
    }
    return { status: 'notFound' };
  }

  const candidates = allDistinctHashes.filter((h) => h.startsWith(p));

  if (candidates.length === 1) {
    return { status: 'resolved', resolvedHash: candidates[0] };
  }

  if (candidates.length > 1) {
    const fns: Array<{ file: string; name: string; bodyHash: string }> = [];
    for (const c of candidates) {
      const list = hashToFunctions.get(c) || [];
      for (const item of list) {
        fns.push({ ...item, bodyHash: c });
      }
    }

    return {
      status: 'ambiguous',
      diagnostic: {
        prefix,
        matchingHashes: candidates,
        functions: fns,
        message: `Ambiguous prefix '${prefix}' matches ${candidates.length} distinct hashes: ${candidates.join(', ')}`,
      },
    };
  }

  return { status: 'notFound' };
};

/**
 * Resolves raw rules against the universe of real functions in the repo or PR.
 * - Validates minimum length (>= 12).
 * - Detects any prefix ambiguity (1 prefix -> multiple distinct hashes).
 * - Binds each hash to the real functions that carry it (even if multiple functions have the same body).
 */
export const resolveSuppressions = (
  rawRules: RawSuppressionRule[],
  knownFunctions: ExtractedFunction[]
): SuppressionResolutionResult => {
  // Index the universe of hashes and map to their functions
  const hashToFunctions = new Map<string, Array<{ file: string; name: string }>>();
  for (const fn of knownFunctions) {
    if (!fn.bodyHash) continue;
    const h = fn.bodyHash.toLowerCase();
    const existing = hashToFunctions.get(h) || [];
    existing.push({ file: fn.file, name: fn.name });
    hashToFunctions.set(h, existing);
  }

  const allDistinctHashes = Array.from(hashToFunctions.keys());

  const activeRules: ResolvedSuppression[] = [];
  const ambiguities: AmbiguityDiagnostic[] = [];
  const invalidRules: Array<{ rule: RawSuppressionRule; error: string }> = [];
  const staleRules: RawSuppressionRule[] = [];

  for (const rule of rawRules) {
    if (
      rule.rawHashA.length < MIN_HASH_PREFIX_LENGTH ||
      rule.rawHashB.length < MIN_HASH_PREFIX_LENGTH
    ) {
      invalidRules.push({
        rule,
        error: `Hashes must be at least ${MIN_HASH_PREFIX_LENGTH} characters long`,
      });
      continue;
    }

    const matchA = resolveHashCandidate(rule.rawHashA, allDistinctHashes, hashToFunctions);
    if (matchA.status === 'ambiguous') {
      ambiguities.push(matchA.diagnostic);
      continue;
    }

    const matchB = resolveHashCandidate(rule.rawHashB, allDistinctHashes, hashToFunctions);
    if (matchB.status === 'ambiguous') {
      ambiguities.push(matchB.diagnostic);
      continue;
    }

    // If both hashes exist in the current context
    if (matchA.status === 'resolved' && matchB.status === 'resolved') {
      activeRules.push({
        fullHashA: matchA.resolvedHash,
        fullHashB: matchB.resolvedHash,
        canonicalKey: buildPairKey(matchA.resolvedHash, matchB.resolvedHash),
        reason: rule.reason,
        functionsA: hashToFunctions.get(matchA.resolvedHash),
        functionsB: hashToFunctions.get(matchB.resolvedHash),
      });
    } else {
      // The hash was not found in the analyzed functions (rule inactive or stale)
      staleRules.push(rule);
    }
  }

  return { activeRules, ambiguities, invalidRules, staleRules };
};

/**
 * Builds the in-memory matcher with anomaly reporting
 */
export const createSuppressionMatcher = (
  resolution: SuppressionResolutionResult
): SuppressionMatcher => {
  const keyMap = new Map<string, ResolvedSuppression>();

  for (const rule of resolution.activeRules) {
    keyMap.set(rule.canonicalKey, rule);
  }

  return {
    isPairSuppressed: (hashA: string, hashB: string): boolean => {
      const key = buildPairKey(hashA, hashB);
      return keyMap.has(key);
    },
    getSuppression: (hashA: string, hashB: string): ResolvedSuppression | undefined => {
      const key = buildPairKey(hashA, hashB);
      return keyMap.get(key);
    },
    activeRules: resolution.activeRules,
    ambiguities: resolution.ambiguities,
  };
};

export interface ClusterSuppressionResult {
  suppressed: boolean;
  reasons: string[];
}

/**
 * Evaluates whether a cluster of functions is suppressed.
 * A cluster is suppressed iff active suppression rules connect all member
 * hashes into a single connected component (Union-Find).
 */
export const evaluateClusterSuppression = (
  memberHashes: string[],
  matcher: SuppressionMatcher
): ClusterSuppressionResult => {
  const distinctHashes = Array.from(
    new Set(memberHashes.map((h) => h.toLowerCase().trim()).filter(Boolean))
  );

  if (distinctHashes.length === 0) {
    return { suppressed: false, reasons: [] };
  }
  // Edge case: byte-identical members (e.g. duplicate identical functions across packages)
  // When there is exactly 1 distinct hash and 2+ members, check for an h:h self-pair rule.
  if (distinctHashes.length === 1) {
    if (memberHashes.length >= 2) {
      const h = distinctHashes[0];
      const suppression = matcher.getSuppression(h, h);
      if (suppression) {
        return {
          suppressed: true,
          reasons: suppression.reason ? [suppression.reason] : [],
        };
      }
    }
    return { suppressed: false, reasons: [] };
  }

  const parent = new Map<string, string>();
  for (const h of distinctHashes) {
    parent.set(h, h);
  }

  const find = (i: string): string => {
    const root = parent.get(i) ?? i;
    if (root === i) return i;
    const next = find(root);
    parent.set(i, next);
    return next;
  };

  const union = (i: string, j: string): boolean => {
    const rootI = find(i);
    const rootJ = find(j);
    if (rootI !== rootJ) {
      parent.set(rootI, rootJ);
      return true;
    }
    return false;
  };

  const reasons = new Set<string>();
  let components = distinctHashes.length;

  for (let i = 0; i < distinctHashes.length; i++) {
    for (let j = i + 1; j < distinctHashes.length; j++) {
      const hashA = distinctHashes[i];
      const hashB = distinctHashes[j];

      if (matcher.isPairSuppressed(hashA, hashB)) {
        const suppression = matcher.getSuppression(hashA, hashB);
        if (suppression?.reason) {
          reasons.add(suppression.reason);
        }
        if (union(hashA, hashB)) {
          components -= 1;
        }
      }
    }
  }

  // The cluster is suppressed iff all members form 1 connected component
  return {
    suppressed: components === 1,
    reasons: Array.from(reasons),
  };
};

export const logSuppressionDiagnostics = (
  resolution: SuppressionResolutionResult,
  malformed: Array<{ rawLine: string; error: string }> = []
): void => {
  for (const m of malformed) {
    logger.warn(`[DITTOIGNORE] Malformed suppression rule: "${m.rawLine}" — ${m.error}`);
  }
  for (const amb of resolution.ambiguities) {
    logger.warn(`[SUPPRESSION AMBIGUITY] ${amb.message}`);
  }
  for (const inv of resolution.invalidRules) {
    logger.warn(
      `[SUPPRESSION INVALID] Rule '${inv.rule.rawHashA}:${inv.rule.rawHashB}' invalid: ${inv.error}`
    );
  }
  for (const stale of resolution.staleRules) {
    logger.warn(
      `[SUPPRESSION STALE] Rule '${stale.rawHashA}:${stale.rawHashB}' matches no active function bodies.`
    );
  }
};

/**
 * Computes the shortest unambiguous prefix for a given hash against a set of candidate hashes.
 * Ensures minimum length of MIN_HASH_PREFIX_LENGTH (12), expanding if collisions exist.
 */
export const computeShortestUnambiguousPrefix = (
  targetHash: string,
  allDistinctHashes: string[],
  minLength: number = MIN_HASH_PREFIX_LENGTH
): string => {
  const normalizedTarget = targetHash.toLowerCase().trim();
  const otherHashes = allDistinctHashes
    .map((h) => h.toLowerCase().trim())
    .filter((h) => h !== normalizedTarget);

  let length = Math.max(minLength, 1);
  while (length <= normalizedTarget.length) {
    const candidatePrefix = normalizedTarget.slice(0, length);
    const hasCollision = otherHashes.some((h) => h.startsWith(candidatePrefix));
    if (!hasCollision) {
      return candidatePrefix;
    }
    length += 1;
  }

  return normalizedTarget;
};
