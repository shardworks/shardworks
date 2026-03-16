import { spawn } from 'node:child_process';

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function exec(cmd: string, args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

/**
 * Returns true if a task has direct children in the 'draft' status.
 *
 * Used to detect parent container tasks whose children are not yet refined.
 * The tq-level claim already redirects eligible children, so if we reach here
 * with the parent, it means there are no eligible children — but there may be
 * draft children that need refining before the parent can be implemented.
 */
async function hasDraftChildren(workDir: string, taskId: string): Promise<boolean> {
  const { stdout, exitCode } = await exec(
    'tq', ['list', '--parent', taskId, '--status', 'draft'], workDir,
  );
  if (exitCode !== 0) return false;
  try {
    const tasks = JSON.parse(stdout.trim()) as Array<unknown>;
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
export async function claimTask(agentId: string, workDir: string, claimDraft = false, role?: string): Promise<string | null> {
  const args = ['claim', '--agent', agentId];
  if (claimDraft) args.push('--draft');
  if (role) args.push('--role', role);
  const { stdout, stderr, exitCode } = await exec('tq', args, workDir);
  if (exitCode !== 0) {
    throw new Error(`tq claim failed: ${stderr.trim() || stdout.trim()}`);
  }
  const result = JSON.parse(stdout.trim()) as { task: { id: string } | null };
  const taskId = result?.task?.id ?? null;
  if (taskId === null) return null;

  // If we're an implementer (not a drafter) and the claimed task is a parent
  // container with unrefined draft children, release it so the conductor can
  // spawn a refiner to process those children first.
  if (!claimDraft && await hasDraftChildren(workDir, taskId)) {
    process.stderr.write(
      `worker: releasing ${taskId} — parent task has unrefined draft children\n`,
    );
    await releaseTask(agentId, workDir, taskId);
    return null;
  }

  return taskId;
}

/**
 * Claim a specific task by ID for an agent.
 * Used in conducted mode where the conductor pre-selects the task.
 * Pass claimDraft=true for refiner roles that claim from the draft pool.
 *
 * Returns the ID of the actually-claimed task, which may be a child of the
 * requested task if the tq-level claim redirected to an eligible descendant.
 */
export async function claimTaskById(agentId: string, workDir: string, taskId: string, claimDraft = false): Promise<string> {
  const args = ['claim-id', taskId, '--agent', agentId];
  if (claimDraft) args.push('--draft');
  const { stdout, stderr, exitCode } = await exec('tq', args, workDir);
  if (exitCode !== 0) {
    throw new Error(`tq claim-id failed: ${stderr.trim() || stdout.trim()}`);
  }
  const result = JSON.parse(stdout.trim()) as { task: { id: string } };
  const claimedId = result.task.id;

  // If we're an implementer and the claimed task is a parent with draft-only
  // children (no eligible children — otherwise tq would have redirected us),
  // release it. The conductor should spawn a refiner for those children.
  if (!claimDraft && await hasDraftChildren(workDir, claimedId)) {
    process.stderr.write(
      `worker: releasing ${claimedId} — parent task has unrefined draft children\n`,
    );
    await releaseTask(agentId, workDir, claimedId);
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
export async function releaseTask(agentId: string, workDir: string, taskId: string): Promise<void> {
  const args = ['release', taskId, '--agent', agentId];
  const { stderr, exitCode } = await exec('tq', args, workDir);
  if (exitCode !== 0) {
    throw new Error(`tq release failed: ${stderr.trim()}`);
  }
}
