# Delete Project Memory

The interactive tool erases selected projects from the local claude-mem database,
local historical snapshots, and associated files and search indexes. Removing a
source checkout alone does not remove this data.

## Run

Run the deletion command:

```bash
node scripts/delete-project-memory.cjs
```

Alternatively, use `bun scripts/delete-project-memory.ts`. The tool requires an
interactive terminal. The command holds a worker spawn lock, automatically stops
the local worker, and verifies it is offline before listing projects. Select
projects, review the scope, and confirm. The lock prevents ordinary hooks from
starting a worker during cleanup; avoid agent activity until cleanup finishes.
If shutdown fails or another local service remains active, the command exits
before deleting project data. It leaves the worker stopped, including on cancellation.

An existing vector index is checked even when vector search is disabled, because
that setting does not erase historical data. A read-only SQLite check skips
Chroma startup when the index contains no document, metadata or queued records
and no vector segment files. Otherwise, inspecting the index may require Chroma
dependency preparation, which can take a few minutes. The terminal reports this
separately from worker shutdown.

For a custom data directory:

```bash
CLAUDE_MEM_DATA_DIR=/path/to/.claude-mem node scripts/delete-project-memory.cjs
```

## Deletion scope

The project list includes database records without sessions, projects found only
in backups or supported caches, and orphaned vector documents with project
metadata. Project matching follows SQLite's ASCII `NOCASE` convention.

Cleanup covers:

- Sessions, observations, summaries, prompts, raw tool input/output, work state,
  deliverable registrations, auxiliary project rows, and associated media rows.
- My Work project records and derived caches, context injection caches, corpus
  observations, hook metadata spools, and project vector fragments, including
  fragments whose source SQLite rows were deleted previously.
- Deliverable **bucket copies**, and media files no longer referenced by another
  project. Original `source_path` files are never removed. Shared bucket names
  are not treated as unique project identities.
- SQLite snapshots under `backups/`, including `backups/auto/`, legacy snapshots,
  and complete interrupted restore copies beside the live database. Old schemas
  are read directly, without upgrading the snapshots. Only the selected project
  records are scrubbed; other projects and snapshot files remain usable.
- **All shared diagnostic logs inside the data directory's `logs/` folder.**
  Some log entries contain unlabelled source text, so reliable per-project log
  removal is impossible. Confirmation explicitly includes logs of other projects.

Foreign-key relationships are checked before deletion. If a selected session has
records belonging to another project, the command refuses and names that project;
select the related projects together. Files outside the managed directories,
symlinks, corrupt/unattributable records, and incomplete restore sidecars cause an
explicit failure rather than guessing ownership.

Database cleanup uses transactions, secure deletion, compaction and WAL
checkpointing. Vector deletions are awaited and verified, including preservation
of other projects' documents. Files and vectors are cleaned before the databases;
backups are scrubbed before current data. A failure exits nonzero and is **not** a
success. Earlier completed steps may already have removed data; resolve the
reported error and rerun. A `project-delete-pending.json` receipt keeps only the
selected project names until completion, so a failed compaction can still be
finished after the rows are gone. It never runs automatically; a rerun requires
the same project selection and another confirmation.

## Cloud limitation

**Complete cloud erasure is not currently supported by the deployed sync
protocol.** Sync Hub retains historical operation bodies in its append-only log;
ordinary tombstones only change the visible state. There is no project-scoped API
that proves erasure of that history and the provider's backups. Remote Chroma's
backup retention also cannot be verified locally.

Accordingly, this tool refuses **before project deletion** when cloud sync is
configured, selected records contain synchronization evidence, or Chroma is
configured as remote. It does not silently downgrade the operation to local-only
cleanup, upload unrelated pending records, clear replication cursors, or claim
that a tombstone erased historical copies. Server-side project erasure support
is still required to satisfy an erasure request spanning cloud history/backups.

## Boundaries

Original Claude Code/Codex transcripts, source repositories, exports or snapshots
copied outside claude-mem's managed data directory, OS backups, and filesystem
snapshots are outside this command. Unknown files without reliable project
metadata cannot be attributed automatically. This is application-level erasure,
not a guarantee against forensic recovery from storage hardware.

Payload-free transcript positions, consumed-event receipts and paid-send
bookkeeping remain where necessary to prevent automatic replay. Deletion does
not permanently exclude a project: new activity can create new records, and an
explicit later transcript import can import the original external transcripts
again. Do not request a historical import if those sources must stay forgotten.
