# Claude-Mem: AI Development Instructions

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

## Architecture

**5 Lifecycle Hooks**: SessionStart → UserPromptSubmit → PostToolUse → Summary → SessionEnd

**Hooks** (`src/hooks/*.ts`) - TypeScript → ESM, built to `plugin/scripts/*-hook.js`

**Worker Service** (`src/services/worker-service.ts`) - Express API on port 37777, Bun-managed, handles AI processing asynchronously

**Database** (`src/services/sqlite/`) - SQLite3 at `~/.claude-mem/claude-mem.db`

**Search Skill** (`plugin/skills/mem-search/SKILL.md`) - HTTP API for searching past work, auto-invoked when users ask about history

**Chroma** (`src/services/sync/ChromaSync.ts`) - Vector embeddings for semantic search

**Viewer UI** (`src/ui/viewer/`) - React interface at http://localhost:37777, built to `plugin/ui/viewer.html`

## Privacy Tags
- `<private>content</private>` - User-level privacy control (manual, prevents storage)

**Implementation**: Tag stripping happens at hook layer (edge processing) before data reaches worker/database. See `src/utils/tag-stripping.ts` for shared utilities.

## Build Commands

```bash
npm run build-and-sync        # Build, sync to marketplace, restart worker
```

## Configuration

Settings are managed in `~/.claude-mem/settings.json`. The file is auto-created with defaults on first run.

## File Locations

- **Source**: `<project-root>/src/`
- **Built Plugin**: `<project-root>/plugin/`
- **Installed Plugin**: `~/.claude/plugins/marketplaces/thedotmack/`
- **Database**: `~/.claude-mem/claude-mem.db`
- **Chroma**: `~/.claude-mem/chroma/`

## Exit Code Strategy

Claude-mem hooks use specific exit codes per Claude Code's hook contract:

- **Exit 0**: Success or graceful shutdown (Windows Terminal closes tabs)
- **Exit 1**: Non-blocking error (stderr shown to user, continues)
- **Exit 2**: Blocking error (stderr fed to Claude for processing)

**Philosophy**: Worker/hook errors exit with code 0 to prevent Windows Terminal tab accumulation. The wrapper/plugin layer handles restart logic. ERROR-level logging is maintained for diagnostics.

See `private/context/claude-code/exit-codes.md` for full hook behavior matrix.

## Requirements

- **Bun** (all platforms - auto-installed if missing)
- **uv** (all platforms - auto-installed if missing, provides Python for Chroma)
- Node.js

## Documentation

**Public Docs**: https://docs.claude-mem.ai (Mintlify)
**Source**: `docs/public/` - MDX files, edit `docs.json` for navigation
**Deploy**: Auto-deploys from GitHub on push to main

## Pro Features Architecture

Claude-mem is designed with a clean separation between open-source core functionality and optional Pro features.

**Open-Source Core** (this repository):

- All worker API endpoints on localhost:37777 remain fully open and accessible
- Pro features are headless - no proprietary UI elements in this codebase
- Pro integration points are minimal: settings for license keys, tunnel provisioning logic
- The architecture ensures Pro features extend rather than replace core functionality

**Pro Features** (coming soon, external):

- Enhanced UI (Memory Stream) connects to the same localhost:37777 endpoints as the open viewer
- Additional features like advanced filtering, timeline scrubbing, and search tools
- Access gated by license validation, not by modifying core endpoints
- Users without Pro licenses continue using the full open-source viewer UI without limitation

This architecture preserves the open-source nature of the project while enabling sustainable development through optional paid features.

## Fork Feature: CustomAgent (PRESERVE DURING UPSTREAM MERGES)

This fork maintains `CustomAgent` — a multi-protocol AI provider supporting OpenAI/Gemini APIs. Upstream removed it in v10.0.6. **All files and modification points below MUST be preserved when merging upstream.**

`.gitattributes` protects CustomAgent-only files via `merge=ours`. Shared files require manual attention.

### CustomAgent-only files

| File | Purpose |
|------|---------|
| `src/services/worker/CustomAgent.ts` | Core: class, `isCustomSelected()`, `isCustomAvailable()`, SSE parsers |
| `tests/worker/custom-agent-session.test.ts` | Session flow tests |
| `tests/worker/custom-agent-utils.test.ts` | Utility function tests |
| `tests/worker/custom-agent-history-truncation.test.ts` | Context truncation tests |
| `tests/worker/gemini-sse-parser.test.ts` | Gemini SSE stream parser tests |

### Shared file modification points

After upstream merges, verify these CustomAgent additions survive:

**`src/services/worker-service.ts`**
- Import: `import { CustomAgent, isCustomSelected, isCustomAvailable } from './worker/CustomAgent.js'`
- Property: `private customAgent: CustomAgent`
- Constructor: `this.customAgent = new CustomAgent(this.dbManager, this.sessionManager)`
- `getAiStatus()`: `if (isCustomSelected() && isCustomAvailable()) provider = 'custom'`
- Route registration: `customAgent` passed to `SessionRoutes`
- `getActiveAgent()`: `CustomAgent` in return type union and provider check

**`src/services/worker/http/routes/SessionRoutes.ts`**
- Import: `CustomAgent, isCustomSelected, isCustomAvailable`
- Constructor: `customAgent` parameter and property
- `getActiveAgent()`: CustomAgent provider check
- Agent registry: `'custom'` entry in `startGeneratorWithProvider`

**`src/services/worker-types.ts`**
- `currentProvider` union type includes `'custom'`

**`src/shared/SettingsDefaultsManager.ts`**
- Settings: `CLAUDE_MEM_CUSTOM_API_URL`, `CLAUDE_MEM_CUSTOM_API_KEY`, `CLAUDE_MEM_CUSTOM_MODEL`, `CLAUDE_MEM_CUSTOM_PROTOCOL`, `CLAUDE_MEM_CUSTOM_STREAMING`, `CLAUDE_MEM_CUSTOM_TIMEOUT_*`

**`src/shared/EnvManager.ts`**
- `CUSTOM_API_KEY` in `MANAGED_CREDENTIAL_KEYS` and `ClaudeMemEnv`

**`src/services/worker/agents/ResponseProcessor.ts`**
- `ProcessAgentResponseOptions` interface (`parseJsonObservation`, `parseJsonSummary`)
- JSON observation/summary parsing branches

**`src/sdk/parser.ts`**
- `parseObservationsJson()`, `parseSummaryJson()` functions

**`src/sdk/prompts.ts`**
- JSON format variants: `buildInitPromptJson`, `buildContinuationPromptJson`, `buildSummaryPromptJson`, `buildObservationPrompt` (JSON output section)

## Important

No need to edit the changelog ever, it's generated automatically.
