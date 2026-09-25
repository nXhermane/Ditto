import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Resolves a worker file by name, falling back to the .ts source when
 * running in dev (nothing built to dist/ yet).
 */
export function resolveProbeFile(importMetaUrl: string, fileName: string): string {
  const currentDir = dirname(fileURLToPath(importMetaUrl));
  const directPath = join(currentDir, fileName);

  if (existsSync(directPath)) {
    return directPath;
  }

  if (fileName.endsWith('.js')) {
    const tsVariant = join(currentDir, fileName.replace(/\.js$/, '.ts'));
    if (existsSync(tsVariant)) return tsVariant;
  }

  return directPath;
}
