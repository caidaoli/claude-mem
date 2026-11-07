#!/usr/bin/env bun

import { runDeleteProjectCommand } from '../src/services/project-memory/cli.js';

function printHelp(): void {
  console.log(`
Erase selected projects from local claude-mem data and local historical backups.

Usage:
  bun scripts/delete-project-memory.ts
  node scripts/delete-project-memory.cjs

Behavior:
  1. Requires the worker and agent sessions to be stopped
  2. Lists projects in current data, backups, caches and the vector index
  3. Previews database, file and backup cleanup and asks for confirmation
  4. Clears associated tools, work state, deliverables, media and shared diagnostic logs
  5. Verifies database and vector cleanup; fails explicitly on incomplete cleanup

Cloud synchronization history / remote Chroma:
  Refused before deletion: the deployed protocols cannot prove erasure of historical
  server operations and remote backups. A sync tombstone is not complete erasure.

Source files and original agent transcripts are not deleted. Payload-free replay
checkpoints remain so cleanup cannot cause automatic historical inference.
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
