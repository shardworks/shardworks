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
 * Atomically claims the next eligible task for the given agent.
 * Returns the claimed task ID, or null if no eligible task is available.
 */
export async function claimTask(agentId: string, workDir: string): Promise<string | null> {
  const { stdout, stderr, exitCode } = await exec('tq', ['claim', '--agent', agentId], workDir);
  if (exitCode !== 0) {
    throw new Error(`tq claim failed: ${stderr.trim() || stdout.trim()}`);
  }
  const result = JSON.parse(stdout.trim()) as { task: { id: string } | null };
  return result?.task?.id ?? null;
}
