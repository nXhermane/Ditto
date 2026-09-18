import { tsMorphAdapter } from './adapter.js';
import type { LanguageAdapter } from './adapter.js';
import { pythonAdapter } from './python/adapter.js';
import { EXCLUDED_DIRECTORIES } from '../filter.js';
import { EXCLUDED_PYTHON_DIRECTORIES } from './python/filter.js';

const adapters: LanguageAdapter[] = [
  tsMorphAdapter,
  pythonAdapter,
];

const ALL_EXCLUDED_DIRECTORIES = new Set<string>([
  ...EXCLUDED_DIRECTORIES,
  ...EXCLUDED_PYTHON_DIRECTORIES,
]);

/** Check if a directory name matches any default excluded directory across registered languages */
export const isAnyExcludedDirectory = (name: string): boolean => {
  return ALL_EXCLUDED_DIRECTORIES.has(name) || name.endsWith('.egg-info');
};

/** Check if any registered language adapter accepts this path */
export const isAnySourceFile = (path: string): boolean => {
  return adapters.some((adapter) => adapter.isSourceFile(path));
};

/** Retrieve the matching language adapter for a given file path */
export const adapterFor = (path: string): LanguageAdapter | null => {
  return adapters.find((adapter) => adapter.isSourceFile(path)) ?? null;
};
