/**
 * Smoke tests for packages/work/src/cli.ts argument parsing.
 *
 * Commander calls program.parse() at module load time, so the CLI module must
 * be imported dynamically after:
 *   1. process.argv is set to the desired arguments, and
 *   2. vi.resetModules() has been called so a fresh Commander instance is
 *      created for each test.
 *
 * Actual implementations (watch, dashboard, pool.end) are mocked so they
 * never run.
 */
export {};
//# sourceMappingURL=cli.test.d.ts.map