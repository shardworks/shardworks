/**
 * Unit tests for tasks.ts — DB layer mocked via vi.mock.
 *
 * Strategy:
 * - `withCommit(msg, fn)` is intercepted to call `fn(mockConn)` directly.
 * - `pool.getConnection()` returns a shared `mockConn`.
 * - `mockConn.execute` is a vi.fn() whose return values are configured per-test
 *   using `.mockResolvedValueOnce()` in the order queries fire.
 */
export {};
//# sourceMappingURL=tasks.test.d.ts.map