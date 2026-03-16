Mark a task queue task as completed.

Usage: /tq-complete [task-id] [result-json-or-summary]

Arguments:
- task-id: The task ID (e.g. tq-a1b2). Defaults to the task you are currently working on.
- result-json-or-summary: Optional result payload. Pass a JSON object, a plain string summary, or omit entirely.

Steps:
1. Determine the task ID (from argument or context).
2. Build the --result flag value: if the argument looks like JSON (starts with `{` or `[`), use it directly; otherwise wrap it as `{"summary": "<value>"}`. If no result given, omit the flag.
3. Run: `tq complete <task-id> --agent <AGENT_ID> [--result '<json>']`
4. Verify exit code 0.
5. Confirm by running: `tq show <task-id>` and checking `"status": "completed"`.
