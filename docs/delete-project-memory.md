# Delete Project Memory

`claude-mem` keeps project memory in its database. Deleting a project directory does not remove that memory automatically.

This repository now includes an interactive deletion tool that lets you remove one or more projects safely.

## Commands

Run the Bun script directly:

```bash
bun scripts/delete-project-memory.ts
```

Or use the Node wrapper, which locates `bun` for you:

```bash
node scripts/delete-project-memory.cjs
```

## Behavior

The tool does four things:

1. Lists all projects found in the `claude-mem` database
2. Lets you select one or more projects interactively
3. Shows the total number of sessions, observations, summaries, and prompts that will be removed
4. Requires explicit confirmation before deleting anything

Deletion is done by removing matching rows from `sdk_sessions`. Foreign keys then cascade cleanup to observations, summaries, and prompts automatically.

## Notes

- The tool is interactive and requires a TTY.
- Internal observer-session projects are excluded from the selection list.
- If you use a custom data directory, set `CLAUDE_MEM_DATA_DIR` before running the command.

Example:

```bash
CLAUDE_MEM_DATA_DIR=/path/to/.claude-mem node scripts/delete-project-memory.cjs
```
