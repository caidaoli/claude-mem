#!/usr/bin/env bun

import { runDeleteProjectCommand } from '../src/services/project-memory/cli.js';

function printHelp(): void {
  console.log(`
Delete one or more projects' claude-mem data interactively.

Usage:
  bun scripts/delete-project-memory.ts
  node scripts/delete-project-memory.cjs

Behavior:
  1. Lists all projects stored in the database
  2. Lets you choose one or more projects interactively
  3. Shows the total sessions / observations / summaries / prompts that will be deleted
  4. Asks for explicit confirmation before deleting
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  if (args.length > 0) {
    console.error('This script is interactive and does not accept positional arguments.');
    console.error('Run: bun scripts/delete-project-memory.ts');
    process.exit(1);
  }

  const exitCode = await runDeleteProjectCommand(args);
  process.exit(exitCode);
}

main().catch((error) => {
  console.error('delete-project-memory failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
