Mark a task queue task as failed.

Usage: /tq-fail [task-id] [reason]

Arguments:
- task-id: The task ID (e.g. tq-a1b2). Defaults to the task you are currently working on.
- reason: A plain-text explanation of why the task could not be completed.

Steps:
1. Determine the task ID (from argument or context).
2. Run: `tq fail <task-id> --agent <AGENT_ID> --reason '<reason>'`
3. Verify exit code 0.
