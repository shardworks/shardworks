/**
 * Unit tests for worker/src/claim.ts
 *
 * We mock exec from ../src/utils.js and test the three exported functions:
 *   - claimTask
 *   - claimTaskById
 *   - releaseTask
 *
 * hasDraftChildren is private but exercised indirectly via claimTask /
 * claimTaskById by controlling what the mocked exec returns for the
 * `tq list --parent <id> --status draft` call that follows a successful claim.
 */
export {};
//# sourceMappingURL=claim.test.d.ts.map