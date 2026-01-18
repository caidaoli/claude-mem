/**
 * SDK Prompts Module
 * Generates prompts for the Claude Agent SDK memory worker
 */

import { logger } from '../utils/logger.js';
import type { ModeConfig } from '../services/domain/types.js';

export interface Observation {
  id: number;
  tool_name: string;
  tool_input: string;
  tool_output: string;
  created_at_epoch: number;
  cwd?: string;
}

export interface SDKSession {
  id: number;
  memory_session_id: string | null;
  project: string;
  user_prompt: string;
  last_assistant_message?: string;
}

/** Output format type for prompt generation */
type OutputFormat = 'xml' | 'json';

/**
 * Build observation format section based on output type
 */
function buildObservationFormatSection(mode: ModeConfig, format: OutputFormat): string {
  if (format === 'json') {
    return `IMPORTANT: You MUST respond with ONLY a valid JSON object. No explanations, no markdown, no thinking process - JUST the raw JSON.

CRITICAL - type field MUST be EXACTLY one of these values (no other values allowed):
${mode.observation_types.map(t => `  - "${t.id}": ${t.description}`).join('\n')}

Output format (JSON):
{
  "type": "${mode.observation_types[0].id}",
  "title": "${mode.prompts.xml_title_placeholder}",
  "subtitle": "${mode.prompts.xml_subtitle_placeholder}",
  "facts": ["${mode.prompts.xml_fact_placeholder}", "${mode.prompts.xml_fact_placeholder}"],
  "narrative": "${mode.prompts.xml_narrative_placeholder}",
  "concepts": ["${mode.prompts.xml_concept_placeholder}"],
  "files_read": ["${mode.prompts.xml_file_placeholder}"],
  "files_modified": ["${mode.prompts.xml_file_placeholder}"]
}

${mode.prompts.field_guidance}
${mode.prompts.concept_guidance}`;
  }

  // XML format
  return `${mode.prompts.output_format_header}

\`\`\`xml
<observation>
  <type>[ ${mode.observation_types.map(t => t.id).join(' | ')} ]</type>
  <!--
    ${mode.prompts.type_guidance}
  -->
  <title>${mode.prompts.xml_title_placeholder}</title>
  <subtitle>${mode.prompts.xml_subtitle_placeholder}</subtitle>
  <facts>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
  </facts>
  <!--
    ${mode.prompts.field_guidance}
  -->
  <narrative>${mode.prompts.xml_narrative_placeholder}</narrative>
  <concepts>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
  </concepts>
  <!--
    ${mode.prompts.concept_guidance}
  -->
  <files_read>
    <file>${mode.prompts.xml_file_placeholder}</file>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_read>
  <files_modified>
    <file>${mode.prompts.xml_file_placeholder}</file>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_modified>
</observation>
\`\`\`
${mode.prompts.format_examples}`;
}

/**
 * Build common prompt header with session context
 */
function buildSessionContextHeader(userPrompt: string): string {
  return `<observed_from_primary_session>
  <user_request>${userPrompt}</user_request>
  <requested_at>${new Date().toISOString().split('T')[0]}</requested_at>
</observed_from_primary_session>`;
}

/**
 * Build initial prompt to initialize the SDK agent
 */
export function buildInitPrompt(project: string, sessionId: string, userPrompt: string, mode: ModeConfig): string {
  return `${mode.prompts.system_identity}

${buildSessionContextHeader(userPrompt)}

${mode.prompts.observer_role}

${mode.prompts.spatial_awareness}

${mode.prompts.recording_focus}

${mode.prompts.skip_guidance}

${buildObservationFormatSection(mode, 'xml')}

${mode.prompts.footer}

${mode.prompts.header_memory_start}`;
}

/**
 * Build initial prompt for JSON output (used by CustomAgent)
 * Uses JSON format instead of XML for more reliable parsing with responseMimeType
 */
export function buildInitPromptJson(project: string, sessionId: string, userPrompt: string, mode: ModeConfig): string {
  return `${mode.prompts.system_identity}

${buildSessionContextHeader(userPrompt)}

${mode.prompts.observer_role}

${mode.prompts.spatial_awareness}

${mode.prompts.recording_focus}

${mode.prompts.skip_guidance}

${buildObservationFormatSection(mode, 'json')}

${mode.prompts.footer}

${mode.prompts.header_memory_start}`;
}

/**
 * Build prompt to send tool observation to SDK agent
 */
export function buildObservationPrompt(obs: Observation): string {
  // Safely parse tool_input and tool_output - they're already JSON strings
  let toolInput: any;
  let toolOutput: any;

  try {
    toolInput = typeof obs.tool_input === 'string' ? JSON.parse(obs.tool_input) : obs.tool_input;
  } catch (error) {
    logger.debug('SDK', 'Tool input is plain string, using as-is', {
      toolName: obs.tool_name
    }, error as Error);
    toolInput = obs.tool_input;
  }

  try {
    toolOutput = typeof obs.tool_output === 'string' ? JSON.parse(obs.tool_output) : obs.tool_output;
  } catch (error) {
    logger.debug('SDK', 'Tool output is plain string, using as-is', {
      toolName: obs.tool_name
    }, error as Error);
    toolOutput = obs.tool_output;
  }

  return `<observed_from_primary_session>
  <what_happened>${obs.tool_name}</what_happened>
  <occurred_at>${new Date(obs.created_at_epoch).toISOString()}</occurred_at>${obs.cwd ? `\n  <working_directory>${obs.cwd}</working_directory>` : ''}
  <parameters>${JSON.stringify(toolInput, null, 2)}</parameters>
  <outcome>${JSON.stringify(toolOutput, null, 2)}</outcome>
</observed_from_primary_session>`;
}

/**
 * Build prompt to generate progress summary
 */
export function buildSummaryPrompt(session: SDKSession, mode: ModeConfig): string {
  const lastAssistantMessage = session.last_assistant_message || (() => {
    logger.error('SDK', 'Missing last_assistant_message in session for summary prompt', {
      sessionId: session.id
    });
    return '';
  })();

  return `${mode.prompts.header_summary_checkpoint}
${mode.prompts.summary_instruction}

${mode.prompts.summary_context_label}
${lastAssistantMessage}

${mode.prompts.summary_format_instruction}
<summary>
  <request>${mode.prompts.xml_summary_request_placeholder}</request>
  <investigated>${mode.prompts.xml_summary_investigated_placeholder}</investigated>
  <learned>${mode.prompts.xml_summary_learned_placeholder}</learned>
  <completed>${mode.prompts.xml_summary_completed_placeholder}</completed>
  <next_steps>${mode.prompts.xml_summary_next_steps_placeholder}</next_steps>
  <notes>${mode.prompts.xml_summary_notes_placeholder}</notes>
</summary>

${mode.prompts.summary_footer}`;
}

/**
 * Build JSON-format summary prompt for Gemini
 * Uses JSON instead of XML for more reliable parsing with Gemini's responseMimeType
 */
export function buildSummaryPromptJson(session: SDKSession, mode: ModeConfig): string {
  const lastAssistantMessage = session.last_assistant_message || (() => {
    logger.error('SDK', 'Missing last_assistant_message in session for summary prompt', {
      sessionId: session.id
    });
    return '';
  })();

  return `IMPORTANT: You MUST respond with ONLY a valid JSON object. No explanations, no markdown, no thinking process - JUST the raw JSON.

${mode.prompts.header_summary_checkpoint}
${mode.prompts.summary_instruction}

${mode.prompts.summary_context_label}
${lastAssistantMessage}

Required JSON format (respond with ONLY this structure, nothing else):
{
  "request": "Brief description of what the user requested",
  "investigated": "What files, code, or resources were examined",
  "learned": "Key insights or discoveries from this session",
  "completed": "What was accomplished or built",
  "next_steps": "Suggested follow-up actions",
  "notes": null
}

CRITICAL: Your entire response must be a single valid JSON object. Do not include any text before or after the JSON.

${mode.prompts.summary_footer}`;
}

/**
 * Build prompt for continuation of existing session
 *
 * CRITICAL: Why contentSessionId Parameter is Required
 * ====================================================
 * This function receives contentSessionId from SDKAgent.ts, which comes from:
 * - SessionManager.initializeSession (fetched from database)
 * - SessionStore.createSDKSession (stored by new-hook.ts)
 * - new-hook.ts receives it from Claude Code's hook context
 *
 * The contentSessionId is the SAME session_id used by:
 * - NEW hook (to create/fetch session)
 * - SAVE hook (to store observations)
 * - This continuation prompt (to maintain session context)
 *
 * This is how everything stays connected - ONE session_id threading through
 * all hooks and prompts in the same conversation.
 *
 * Called when: promptNumber > 1 (see SDKAgent.ts line 150)
 * First prompt: Uses buildInitPrompt instead (promptNumber === 1)
 */
export function buildContinuationPrompt(userPrompt: string, promptNumber: number, contentSessionId: string, mode: ModeConfig): string {
  return buildContinuationPromptInternal(userPrompt, mode, 'xml');
}

/**
 * Build continuation prompt for JSON output (used by CustomAgent)
 * Uses JSON format instead of XML for more reliable parsing with responseMimeType
 */
export function buildContinuationPromptJson(userPrompt: string, promptNumber: number, contentSessionId: string, mode: ModeConfig): string {
  return buildContinuationPromptInternal(userPrompt, mode, 'json');
}

/**
 * Internal helper for building continuation prompts
 */
function buildContinuationPromptInternal(userPrompt: string, mode: ModeConfig, format: OutputFormat): string {
  return `${mode.prompts.continuation_greeting}

${buildSessionContextHeader(userPrompt)}

${mode.prompts.system_identity}

${mode.prompts.observer_role}

${mode.prompts.spatial_awareness}

${mode.prompts.recording_focus}

${mode.prompts.skip_guidance}

${mode.prompts.continuation_instruction}

${buildObservationFormatSection(mode, format)}

${mode.prompts.footer}

${mode.prompts.header_memory_continued}`;
} 