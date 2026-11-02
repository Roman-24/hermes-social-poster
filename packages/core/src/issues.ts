import { z } from 'zod';
import { NetworkSchema } from './networks.js';

export const IssueSchema = z.object({
  level: z.enum(['error', 'warning', 'info']),
  code: z.string(),
  message: z.string(),
  network: NetworkSchema.optional(),
  /** Thread part index (0-based) when the issue concerns one part. */
  part: z.number().int().optional(),
  /** Media id when the issue concerns one file. */
  mediaId: z.string().optional(),
});
export type Issue = z.infer<typeof IssueSchema>;

export function hasErrors(issues: Issue[]): boolean {
  return issues.some((i) => i.level === 'error');
}
