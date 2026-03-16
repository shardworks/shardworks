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
 * Atomically claims the next task for the given agent.
 * Pass claimDraft=true to claim from the draft pool (for refiner roles);
 * false (default) claims from the eligible pool (for implementer roles).
 * Pass role to filter tasks by assigned_role.
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
  return result?.task?.id ?? null;
}

/**
 * Claim a specific task by ID for an agent.
 * Used in conducted mode where the conductor pre-selects the task.
 */
export async function claimTaskById(agentId: string, workDir: string, taskId: string): Promise<string> {
  const args = ['claim-id', taskId, '--agent', agentId];
  const { stdout, stderr, exitCode } = await exec('tq', args, workDir);
  if (exitCode !== 0) {
    throw new Error(`tq claim-id failed: ${stderr.trim() || stdout.trim()}`);
  }
  const result = JSON.parse(stdout.trim()) as { task: { id: string } };
  return result.task.id;
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
