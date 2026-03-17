/**
 * Unit tests for worker/src/merge.ts
 *
 * mergeWorktreeToMain orchestrates a sequence of git/tq exec() calls.
 * We mock utils.ts (exec) and node:fs (existsSync, rmSync) so no real git
 * operations occur.
 *
 * parseUntrackedOverwriteFiles is a pure string-parsing helper exported for
 * direct testing.
 */
export {};
//# sourceMappingURL=merge.test.d.ts.map