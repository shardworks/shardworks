Create a child task under a parent in the task queue.

Usage: /tq-subtask [parent-id] [description] [--deps <id,...>] [--priority <n>]

Arguments:
- parent-id: The parent task ID (e.g. tq-a1b2). Defaults to the task you are currently working on.
- description: A clear description of what the subtask should do.
- --deps <id,...>: Comma-separated list of dependency task IDs (optional).
- --priority <n>: Integer priority, higher runs first (optional, default 0).

Steps:
1. Determine the parent task ID (from argument or context).
2. Build the tq enqueue command with --parent and optional --depends-on flags.
   For each dep in --deps, add: `--depends-on <dep>`
3. Run: `tq enqueue '<description>' --parent <parent-id> [--depends-on <dep>...] [--priority <n>]`
4. Verify exit code 0 and print the new task ID from the output.
