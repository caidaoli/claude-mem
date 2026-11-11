// CLAUDE_MEM_SKIP_TOOLS matching, shared by every capture path so the setting
// means the same thing whichever runtime the user picked:
//   - the worker ingest path (src/services/worker/http/shared.ts), and
//   - the hook handlers' server-runtime branches (observation.ts, file-edit.ts),
//     which send events straight to the server and never pass through worker
//     ingest.
//
// Matching is case-insensitive, because hosts spell the same tool differently
// and adapters rename some (OpenCode's `read` arrives as `Read`). A user's
// `read` or `Read` entry keeps matching either way. Entries ending with '*'
// are prefix patterns (e.g. 'mcp__*' skips every MCP tool). Fork commit 7ff1b4a5.

export function isToolSkipped(toolName: string, skipToolsSetting: string | undefined, nativeToolName?: string): boolean {
  if (!skipToolsSetting) return false;
  const patterns = skipToolsSetting.split(',').map(tool => tool.trim().toLowerCase()).filter(Boolean);
  const matches = (name: string) =>
    patterns.some(pattern => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern));
  if (matches(toolName.toLowerCase())) return true;
  // Match the host's actual name after an adapter renames it for evidence.
  // Qualified MCP exclusions keep their server scope: a native name that
  // happens to look qualified must not match a different server's tool.
  const nativeName = typeof nativeToolName === 'string' ? nativeToolName.toLowerCase() : undefined;
  return !!nativeName && !nativeName.startsWith('mcp__') && matches(nativeName);
}
