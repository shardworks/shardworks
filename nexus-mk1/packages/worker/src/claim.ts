import { claim, claimById, release, fail, listTasks } from '@shardworks/tq/src/tasks.js';

/**
 * Returns true if a task has direct children in the 'draft' status.
 *
 * Used to detect parent container tasks whose children are not yet refined.
 * The tq-level claim already redirects eligible children, so if we reach here
 * with the parent, it means there are no eligible children — but there may be
 * draft children that need refining before the parent can be implemented.
 */
async function hasDraftChildren(taskId: string): Promise<boolean> {
  try {
    const tasks = await listTasks({ parent_id: taskId, status: 'draft' });
    return tasks.length > 0;
  } catch {
    return false;
  }
}

/**
 * Atomically claims the next task for the given agent.
 * Pass claimDraft=true to claim from the draft pool (for refiner roles);
 * false (default) claims from the eligible pool (for implementer roles).
 * Pass role to filter tasks by assigned_role.
 *
 * If the claimed task is a parent with eligible children, the tq-level claim
 * will have already redirected to the highest-priority eligible descendant.
 *
 * If the claimed task is a parent with only draft children (not yet refined),
 * the task is released and null is returned so the conductor can spawn a
 * refiner instead.
 *
 * Returns the claimed task ID, or null if no suitable task is available.
 */
export async function claimTask(agentId: string, _workDir: string, claimDraft = false, role?: string, capabilities: string[] = []): Promise<string | null> {
  const result = await claim(agentId, capabilities, claimDraft, role);
  const taskId = result?.task?.id ?? null;
  if (taskId === null) return null;

  // If we're an implementer (not a drafter) and the claimed task is a parent
  // container with unrefined draft children, release it so the conductor can
  // spawn a refiner to process those children first.
  if (!claimDraft && await hasDraftChildren(taskId)) {
    process.stderr.write(
      `worker: releasing ${taskId} — parent task has unrefined draft children\n`,
    );
    await releaseTask(agentId, _workDir, taskId);
    return null;
  }

  return taskId;
}

/**
 * Claim a specific task by ID for an agent.
 * Used in conducted mode where the conductor pre-selects the task.
 * Pass claimDraft=true for refiner roles that claim from the draft pool.
 *
 * NOTE: Unlike the CLI `tq claim-id`, the library claimById() does not accept
 * a capabilities parameter. The capabilities argument is accepted here for API
 * compatibility but is silently dropped. If capabilities filtering on claim-id
 * is needed, the library function signature must be extended first.
 *
 * Returns the ID of the actually-claimed task, which may be a child of the
 * requested task if the tq-level claim redirected to an eligible descendant.
 */
export async function claimTaskById(agentId: string, _workDir: string, taskId: string, claimDraft = false, _capabilities: string[] = []): Promise<string> {
  const result = await claimById(taskId, agentId, claimDraft);
  // claimById throws on failure; task is always non-null on success
  const claimedId = result.task?.id;
  if (!claimedId) throw new Error(`tq claim-id returned no task for ${taskId}`);

  // If we're an implementer and the claimed task is a parent with draft-only
  // children (no eligible children — otherwise tq would have redirected us),
  // release it. The conductor should spawn a refiner for those children.
  if (!claimDraft && await hasDraftChildren(claimedId)) {
    process.stderr.write(
      `worker: releasing ${claimedId} — parent task has unrefined draft children\n`,
    );
    await releaseTask(agentId, _workDir, claimedId);
    throw new Error(
      `Task ${claimedId} is a parent with unrefined draft children; cannot implement directly`,
    );
  }

  return claimedId;
}

/**
 * Release a claimed task back to `eligible` so another worker can pick it up.
 * Used when the worker hits a rate limit or other transient failure.
 */
export async function releaseTask(agentId: string, _workDir: string, taskId: string): Promise<void> {
  await release(taskId, agentId);
}

/**
 * Fail a claimed task with a reason string.  If the task has remaining
 * attempts (max_attempts > attempt_count + 1), it is released back to
 * eligible after a backoff so another worker can retry it.  Otherwise it
 * transitions to the terminal `failed` state.
 *
 * Used by the worker when a post-completion operation (e.g. merge) fails.
 */
export async function failTask(agentId: string, taskId: string, reason: string): Promise<void> {
  await fail(taskId, agentId, reason);
}
