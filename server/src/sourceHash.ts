import { createHash } from 'node:crypto';

export function sourceHash(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}
