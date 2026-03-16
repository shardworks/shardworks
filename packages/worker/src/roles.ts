import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface RoleDefinition {
  id: string;
  description: string;
  /**
   * Claim pool selection:
   *   true  — claim from the 'draft' pool (refiner roles)
   *   false — claim from the 'eligible' pool (implementer / planner roles)
   */
  claimDraft: boolean;
  /**
   * System prompt lines. Supports template variables:
   *   {{agentId}}  — the agent's ID
   *   {{tagsLine}} — "\nCapability tags: foo, bar" or empty string
   */
  systemPrompt: string[];
  /**
   * Work prompt lines. Supports template variables:
   *   {{agentId}}  — the agent's ID
   *   {{taskId}}   — the task being worked on
   */
  workPrompt: string[];
}

interface RolesFile {
  roles: RoleDefinition[];
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Resolves roles.json from ROLES_CONFIG env var, or <workDir>/roles.json.
 * Throws if the file cannot be read or the requested role doesn't exist.
 */
export function loadRole(roleId: string, workDir: string): RoleDefinition {
  const rolesPath = process.env['ROLES_CONFIG'] ?? join(workDir, 'roles.json');

  let file: RolesFile;
  try {
    file = JSON.parse(readFileSync(rolesPath, 'utf8')) as RolesFile;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load roles config from ${rolesPath}: ${msg}`);
  }

  const role = file.roles.find(r => r.id === roleId);
  if (!role) {
    const available = file.roles.map(r => r.id).join(', ');
    throw new Error(`Unknown role "${roleId}". Available roles: ${available}`);
  }

  return role;
}

/**
 * Returns all role definitions from roles.json.
 * Useful for conductors selecting a role when dispatching work.
 */
export function listRoles(workDir: string): RoleDefinition[] {
  const rolesPath = process.env['ROLES_CONFIG'] ?? join(workDir, 'roles.json');
  try {
    const file = JSON.parse(readFileSync(rolesPath, 'utf8')) as RolesFile;
    return file.roles;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load roles config from ${rolesPath}: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

export interface PromptVars {
  agentId: string;
  taskId: string;
  agentTags: string[];
}

function interpolate(lines: string[], vars: PromptVars): string {
  const tagsLine = vars.agentTags.length > 0
    ? `\nCapability tags: ${vars.agentTags.join(', ')}`
    : '';
  return lines
    .join('\n')
    .replaceAll('{{agentId}}', vars.agentId)
    .replaceAll('{{taskId}}', vars.taskId)
    .replaceAll('{{tagsLine}}', tagsLine);
}

export function renderSystemPrompt(role: RoleDefinition, vars: PromptVars): string {
  return interpolate(role.systemPrompt, vars);
}

export function renderWorkPrompt(role: RoleDefinition, vars: PromptVars): string {
  return interpolate(role.workPrompt, vars);
}
