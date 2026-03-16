import { createHash } from 'node:crypto';

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

/**
 * Generate a top-level task ID: `tq-XXXX`
 * The hash is deterministic given the same inputs, which allows batch
 * enqueue to reference sibling IDs before they are inserted.
 */
export function generateId(
  description: string,
  createdBy: string,
  timestamp: Date,
): string {
  const input = `${description}::${createdBy}::${timestamp.toISOString()}`;
  return `tq-${shortHash(input)}`;
}

/**
 * Generate a child task ID: `<parentId>.XXXX`
 * The dot-prefix makes subtree membership visible in the ID.
 */
export function generateChildId(
  parentId: string,
  description: string,
  createdBy: string,
  timestamp: Date,
): string {
  const input = `${parentId}::${description}::${createdBy}::${timestamp.toISOString()}`;
  return `${parentId}.${shortHash(input)}`;
}
