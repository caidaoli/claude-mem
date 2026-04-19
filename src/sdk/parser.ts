/**
 * XML Parser Module
 * Parses observation and summary XML blocks from SDK responses
 * Also supports JSON parsing for Gemini responses
 */

import { logger } from '../utils/logger.js';
import { ModeManager } from '../services/domain/ModeManager.js';

export interface ParsedObservation {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
}

export interface ParsedSummary {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
}

/**
 * Parse observation XML blocks from SDK response
 * Returns all observations found in the response
 */
export function parseObservations(text: string, correlationId?: string): ParsedObservation[] {
  const observations: ParsedObservation[] = [];

  // Match <observation>...</observation> blocks (non-greedy)
  const observationRegex = /<observation>([\s\S]*?)<\/observation>/g;

  let match;
  while ((match = observationRegex.exec(text)) !== null) {
    const obsContent = match[1];

    // Extract all fields
    const type = extractField(obsContent, 'type');
    const title = extractField(obsContent, 'title');
    const subtitle = extractField(obsContent, 'subtitle');
    const narrative = extractField(obsContent, 'narrative');
    const facts = extractArrayElements(obsContent, 'facts', 'fact');
    const concepts = extractArrayElements(obsContent, 'concepts', 'concept');
    const files_read = extractArrayElements(obsContent, 'files_read', 'file');
    const files_modified = extractArrayElements(obsContent, 'files_modified', 'file');

    // All fields except type are nullable in schema.
    // If type is missing or invalid, use first type from mode as fallback.

    // Determine final type using active mode's valid types
    const mode = ModeManager.getInstance().getActiveMode();
    const validTypes = mode.observation_types.map(t => t.id);
    const fallbackType = validTypes[0]; // First type in mode's list is the fallback
    let finalType = fallbackType;
    if (type) {
      if (validTypes.includes(type.trim())) {
        finalType = type.trim();
      } else {
        logger.error('PARSER', `Invalid observation type: ${type}, using "${fallbackType}"`, { correlationId });
      }
    } else {
      logger.error('PARSER', `Observation missing type field, using "${fallbackType}"`, { correlationId });
    }

    // All other fields are optional - save whatever we have

    // Filter out type from concepts array (types and concepts are separate dimensions)
    const cleanedConcepts = concepts.filter(c => c !== finalType);

    if (cleanedConcepts.length !== concepts.length) {
      logger.debug('PARSER', 'Removed observation type from concepts array', {
        correlationId,
        type: finalType,
        originalConcepts: concepts,
        cleanedConcepts
      });
    }

    // Skip ghost observations — records where every content field is null/empty.
    // These accumulate when the LLM emits a bare <observation/> (or one with only <type>)
    // due to context overflow. They carry no information and pollute the context window.
    // (subtitle and file lists are intentionally excluded from this guard: an observation
    // with only a subtitle is still too thin to be useful on its own.)
    if (!title && !narrative && facts.length === 0 && cleanedConcepts.length === 0) {
      logger.warn('PARSER', 'Skipping empty observation (all content fields null)', {
        correlationId,
        type: finalType
      });
      continue;
    }

    observations.push({
      type: finalType,
      title,
      subtitle,
      facts,
      narrative,
      concepts: cleanedConcepts,
      files_read,
      files_modified
    });
  }

  return observations;
}

/**
 * Parse summary XML block from SDK response
 * Returns null if no valid summary found or if summary was skipped
 *
 * @param coerceFromObservation - When true, attempts to convert <observation> tags
 *   into summary fields if no <summary> tags are found. Only set this when the
 *   response was expected to be a summary (i.e., a summarize message was sent).
 *   Prevents the infinite retry loop described in #1633.
 */
export function parseSummary(text: string, sessionId?: number, coerceFromObservation: boolean = false): ParsedSummary | null {
  // Check for skip_summary first
  const skipRegex = /<skip_summary\s+reason="([^"]+)"\s*\/>/;
  const skipMatch = skipRegex.exec(text);

  if (skipMatch) {
    logger.info('PARSER', 'Summary skipped', {
      sessionId,
      reason: skipMatch[1]
    });
    return null;
  }

  // Strip Markdown code block wrapper if present (e.g., ```xml ... ```)
  let cleanedText = text;
  const markdownBlockRegex = /^```(?:xml|XML)?\s*\n?([\s\S]*?)\n?```$/;
  const markdownMatch = markdownBlockRegex.exec(text.trim());
  if (markdownMatch) {
    cleanedText = markdownMatch[1];
  }

  // Match <summary>...</summary> block (non-greedy)
  const summaryRegex = /<summary>([\s\S]*?)<\/summary>/;
  const summaryMatch = summaryRegex.exec(cleanedText);

  if (!summaryMatch) {
    logger.warn('PARSER', 'No <summary> tag found in response', {
      sessionId,
      responseLength: text.length,
      responsePreview: text.substring(0, 200)
    });
    // When the LLM returns <observation> tags instead of <summary> tags,
    // coerce the observation content into summary fields rather than discarding it.
    // This breaks the infinite retry loop described in #1633: without coercion,
    // the summary is silently dropped, the session completes without a summary,
    // a new session is spawned with an ever-growing prompt, and the cycle repeats.
    // Only coerce when explicitly requested (i.e., when a summarize message was sent).
    if (/<observation>/.test(text)) {
      if (coerceFromObservation) {
        const coerced = coerceObservationToSummary(text, sessionId);
        if (coerced) {
          return coerced;
        }
        logger.warn('PARSER', 'Summary response contained <observation> tags instead of <summary> — coercion failed, no usable content', { sessionId });
      } else {
        logger.warn('PARSER', 'Summary response contained <observation> tags instead of <summary> — prompt conditioning may need strengthening', { sessionId });
      }
    }
    return null;
  }

  const summaryContent = summaryMatch[1];

  // Extract fields
  const request = extractField(summaryContent, 'request');
  const investigated = extractField(summaryContent, 'investigated');
  const learned = extractField(summaryContent, 'learned');
  const completed = extractField(summaryContent, 'completed');
  const next_steps = extractField(summaryContent, 'next_steps');
  const notes = extractField(summaryContent, 'notes'); // Optional

  // NOTE FROM THEDOTMACK: 100% of the time we must SAVE the summary, even if fields are missing. 10/24/2025
  // NEVER DO THIS NONSENSE AGAIN.

  // Log warning if all required fields are empty (diagnostic for Gemini issue)
  if (!request && !investigated && !learned && !completed && !next_steps) {
    logger.warn('PARSER', 'Summary tag found but all fields are empty', {
      sessionId,
      summaryContentLength: summaryContent.length,
      summaryContentPreview: summaryContent.substring(0, 200)
    });
  }

  // Guard: if NO sub-tags matched at all, this is a false positive —
  // <summary> accidentally appeared inside an <observation> response with no structured content.
  // This is NOT the same as missing some fields (which we intentionally allow above).
  // Fix for #1360.
  if (!request && !investigated && !learned && !completed && !next_steps) {
    // If the response also contains <observation> tags with real content, fall
    // back to coercion rather than discarding the response entirely — this covers
    // the case where the LLM wraps empty <summary></summary> around observation
    // content, which would otherwise resurrect the #1633 retry loop.
    if (coerceFromObservation && /<observation>/.test(text)) {
      const coerced = coerceObservationToSummary(text, sessionId);
      if (coerced) {
        logger.warn('PARSER', 'Empty <summary> match rejected — coerced from <observation> fallback (#1633)', { sessionId });
        return coerced;
      }
    }
    logger.warn('PARSER', 'Summary match has no sub-tags — skipping false positive', { sessionId });
    return null;
  }

  return {
    request,
    investigated,
    learned,
    completed,
    next_steps,
    notes
  };
}

/**
 * Coerce <observation> response into a ParsedSummary when <summary> tags are missing.
 * Maps observation fields to the closest summary equivalents so that a usable
 * summary is stored instead of nothing — breaking the retry loop (#1633).
 */
function coerceObservationToSummary(text: string, sessionId?: number): ParsedSummary | null {
  // Iterate all <observation> blocks — if the LLM emits multiple and the first is
  // empty, we still want to salvage the first one that has usable content.
  const obsRegex = /<observation>([\s\S]*?)<\/observation>/g;
  let obsMatch: RegExpExecArray | null;
  let blockIndex = 0;

  while ((obsMatch = obsRegex.exec(text)) !== null) {
    const obsContent = obsMatch[1];
    const title = extractField(obsContent, 'title');
    const subtitle = extractField(obsContent, 'subtitle');
    const narrative = extractField(obsContent, 'narrative');
    const facts = extractArrayElements(obsContent, 'facts', 'fact');

    if (title || narrative || facts.length > 0) {
      // Map observation fields → summary fields (best-effort)
      const request = title || subtitle || null;
      const investigated = narrative || null;
      const learned = facts.length > 0 ? facts.join('; ') : null;
      const completed = title ? `${title}${subtitle ? ' — ' + subtitle : ''}` : null;
      const next_steps = null; // No direct observation equivalent

      logger.warn('PARSER', 'Coerced <observation> response into <summary> to prevent retry loop (#1633)', {
        sessionId,
        blockIndex,
        hasTitle: !!title,
        hasNarrative: !!narrative,
        factCount: facts.length,
      });

      return { request, investigated, learned, completed, next_steps, notes: null };
    }

    blockIndex++;
  }

  return null;
}

/**
 * Extract a simple field value from XML content
 * Returns null for missing or empty/whitespace-only fields
 *
 * Uses non-greedy [\s\S]*? matching to support code snippets and nested tags (Issue #798).
 * Also strips wrapper tags and orphan same-name tags from malformed model output.
 */
function extractField(content: string, fieldName: string): string | null {
  // Use [\s\S]*? to match any character including newlines, non-greedily
  // This handles nested XML tags like <item>...</item> inside the field
  const regex = new RegExp(`<${fieldName}>([\\s\\S]*?)</${fieldName}>`);
  const match = regex.exec(content);
  if (!match) return null;

  let rawContent = match[1].trim();
  if (rawContent === '') return null;

  // Strip orphan same-name opening tags left by non-greedy matching
  // Handles: <investigated><investigated>content</investigated></investigated>
  // After first match: rawContent = "<investigated>content"
  const sameNameOpenTagRegex = new RegExp(`^<${fieldName}>\\s*`, 'i');
  rawContent = rawContent.replace(sameNameOpenTagRegex, '').trim();

  // Also strip any trailing orphan closing tags of the same name
  const sameNameCloseTagRegex = new RegExp(`\\s*</${fieldName}>$`, 'i');
  rawContent = rawContent.replace(sameNameCloseTagRegex, '').trim();

  if (rawContent === '') return null;

  // Generic XML wrapper tag stripper
  // Matches any <tagname>content</tagname> pattern where tagname is a simple identifier
  // Examples: <item>, <fact>, <point>, <bullet>, <entry>, <step>, etc.
  const wrapperRegex = /<([a-z_][a-z0-9_]*)>([^<]*)<\/\1>/gi;
  const items: string[] = [];
  let itemMatch;
  while ((itemMatch = wrapperRegex.exec(rawContent)) !== null) {
    const itemContent = itemMatch[2].trim();
    if (itemContent) {
      items.push(itemContent);
    }
  }

  // If wrapper tags were found, join them; otherwise return raw content
  if (items.length > 0) {
    return items.join('\n');
  }

  return rawContent;
}

/**
 * Extract array of elements from XML content
 * Handles nested tags and code snippets (Issue #798)
 */
function extractArrayElements(content: string, arrayName: string, elementName: string): string[] {
  const elements: string[] = [];

  // Match the array block using [\s\S]*? for nested content
  const arrayRegex = new RegExp(`<${arrayName}>([\\s\\S]*?)</${arrayName}>`);
  const arrayMatch = arrayRegex.exec(content);

  if (!arrayMatch) {
    return elements;
  }

  const arrayContent = arrayMatch[1];

  // Extract individual elements using [\s\S]*? for nested content
  const elementRegex = new RegExp(`<${elementName}>([\\s\\S]*?)</${elementName}>`, 'g');
  let elementMatch;
  while ((elementMatch = elementRegex.exec(arrayContent)) !== null) {
    const trimmed = elementMatch[1].trim();
    if (trimmed) {
      elements.push(trimmed);
    }
  }

  return elements;
}

/**
 * Extract balanced JSON segment from a specific index.
 * Supports nested objects/arrays and quoted strings with escapes.
 */
function extractBalancedJsonFromIndex(text: string, startIdx: number): string | null {
  const startChar = text[startIdx];
  if (startChar !== '{' && startChar !== '[') return null;

  const stack: string[] = [startChar];
  let inString = false;
  let escape = false;

  for (let i = startIdx + 1; i < text.length; i++) {
    const char = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === '\\' && inString) {
      escape = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }

    if (char === '}' || char === ']') {
      const open = stack.pop();
      if (!open) return null;

      const expectedClose = open === '{' ? '}' : ']';
      if (char !== expectedClose) {
        return null;
      }

      if (stack.length === 0) {
        return text.substring(startIdx, i + 1);
      }
    }
  }

  return null;
}

/**
 * Find the first parsable balanced JSON segment in text.
 * Useful for recovering from proxy noise, duplicated stream fragments,
 * and trailing garbage after a valid JSON payload.
 */
function extractBalancedJson(text: string, allowArray: boolean = false): string | null {
  const scanFor = (startChar: '{' | '['): string | null => {
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== startChar) continue;

      const candidate = extractBalancedJsonFromIndex(text, i);
      if (!candidate) continue;

      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // Continue searching for a later valid JSON segment
      }
    }
    return null;
  };

  // Prefer object roots first to avoid accidentally extracting small arrays
  // nested inside malformed object text (e.g., "files_modified":[]).
  const objectCandidate = scanFor('{');
  if (objectCandidate) return objectCandidate;

  if (allowArray) {
    return scanFor('[');
  }

  return null;
}

/**
 * Common preprocessing for JSON responses
 * Strips Markdown code blocks and extracts balanced JSON
 * @param text Raw response text
 * @param allowArray If true, also accepts JSON arrays (starting with '[')
 * @returns Cleaned JSON text ready for parsing
 */
function preprocessJsonResponse(text: string, allowArray: boolean = false): string {
  let jsonText = text.trim();

  // Strip Markdown code block if present (```json ... ``` or ``` ... ```)
  const codeBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/;
  const codeBlockMatch = codeBlockRegex.exec(jsonText);
  if (codeBlockMatch) {
    jsonText = codeBlockMatch[1].trim();
  }

  // Try to extract first parsable balanced JSON segment.
  // This handles valid JSON with trailing noise and malformed prefix snapshots.
  const extracted = extractBalancedJson(jsonText, allowArray);
  return extracted || jsonText;
}

/**
 * Parse summary from JSON response (used by Gemini with responseMimeType)
 * More reliable than XML parsing as Gemini API guarantees valid JSON output
 *
 * Note: Some Gemini proxies may not support responseMimeType, so we also
 * handle Markdown-wrapped JSON and try to extract JSON from text responses.
 */
export function parseSummaryJson(text: string, sessionId?: number): ParsedSummary | null {
  const jsonText = preprocessJsonResponse(text);

  try {
    const data = JSON.parse(jsonText);

    // Validate and extract fields
    const summary: ParsedSummary = {
      request: typeof data.request === 'string' ? data.request : null,
      investigated: typeof data.investigated === 'string' ? data.investigated : null,
      learned: typeof data.learned === 'string' ? data.learned : null,
      completed: typeof data.completed === 'string' ? data.completed : null,
      next_steps: typeof data.next_steps === 'string' ? data.next_steps : null,
      notes: typeof data.notes === 'string' ? data.notes : null,
    };

    // Log warning if all required fields are empty
    if (!summary.request && !summary.investigated && !summary.learned && !summary.completed && !summary.next_steps) {
      logger.warn('PARSER', 'JSON summary parsed but all fields are empty', {
        sessionId,
        keys: Object.keys(data)
      });
    }

    return summary;
  } catch (error) {
    const trimmedPreprocessed = jsonText.trim();
    const trimmedRaw = text.trim();
    const errorMsg = error instanceof Error ? error.message : String(error);
    const data: Record<string, unknown> = {
      error: errorMsg,
      rawText: text
    };
    if (trimmedPreprocessed && trimmedPreprocessed !== trimmedRaw) {
      data.preprocessedText = trimmedPreprocessed;
    }

    logger.error('PARSER', 'Failed to parse JSON summary', {
      sessionId,
      textLength: text.length
    }, data);
    return null;
  }
}

/**
 * Strip [**fieldname**: content] wrappers that some models reproduce from prompt placeholders.
 * Also handles [content] simple brackets (no nested brackets allowed).
 *
 * "[**title**: 统一复选框样式修复]" → "统一复选框样式修复"
 * "[**narrative**: Full context...]" → "Full context..."
 * "[World]" → "World"
 *
 * Only used on AI-generated JSON observation fields, never on user content.
 */
function stripFieldWrapper(value: string): string {
  const trimmed = value.trim();
  const boldMatch = /^\[\*\*\w+\*\*:\s*(.*)\]$/.exec(trimmed);
  if (boldMatch) return boldMatch[1];
  // Simple bracket wrapper: [content] where content has no inner brackets.
  // This avoids false matches on strings like "[a] and [b]".
  const simpleMatch = /^\[([^\[\]]+)\]$/.exec(trimmed);
  if (simpleMatch) return simpleMatch[1];
  return trimmed;
}

/**
 * Parse observations from JSON response (used by CustomAgent with responseMimeType)
 * More reliable than XML parsing as API guarantees valid JSON output
 *
 * Expected JSON format:
 * {
 *   "observations": [
 *     {
 *       "type": "discovery",
 *       "title": "...",
 *       "narrative": "...",
 *       "files_read": ["..."],
 *       "files_modified": ["..."],
 *       "concepts": ["..."]
 *     }
 *   ]
 * }
 *
 * Or single observation (wrapped automatically):
 * {
 *   "type": "discovery",
 *   "title": "...",
 *   ...
 * }
 */
export function parseObservationsJson(text: string, correlationId?: string): ParsedObservation[] {
  const jsonText = preprocessJsonResponse(text, true);
  const trimmed = jsonText.trim();

  // JSON observation mode is allowed to "skip" by returning no JSON at all.
  // Many models/proxies will still emit a short plain-text explanation despite prompt instructions.
  // Treat responses with no JSON payload as a skip (parity with XML parsing: no <observation> tags => no observations).
  if (!trimmed.includes('{') && !trimmed.includes('[')) {
    logger.debug('PARSER', 'Non-JSON response in JSON observation mode - treated as skip', {
      correlationId,
      textLength: text.length,
      textPreview: text.substring(0, 200)
    });
    return [];
  }

  try {
    const data = JSON.parse(trimmed);

    // Explicit skip sentinel (optional contract for JSON-mode providers)
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const obj = data as Record<string, unknown>;
      if (obj.skip === true) {
        logger.debug('PARSER', 'JSON observation skipped via sentinel', { correlationId });
        return [];
      }
    }

    // Handle array of observations or single observation
    let rawObservations: unknown[];
    if (Array.isArray(data)) {
      rawObservations = data;
    } else if (data.observations && Array.isArray(data.observations)) {
      rawObservations = data.observations;
    } else if (data.type) {
      // Single observation object
      rawObservations = [data];
    } else {
      logger.warn('PARSER', 'JSON response has no observations', {
        correlationId,
        keys: Object.keys(data)
      });
      return [];
    }

    const mode = ModeManager.getInstance().getActiveMode();
    const validTypes = mode.observation_types.map(t => t.id);
    const fallbackType = validTypes[0];

    const observations: ParsedObservation[] = [];

    for (const raw of rawObservations) {
      if (typeof raw !== 'object' || raw === null) continue;

      const obs = raw as Record<string, unknown>;

      // Determine type with validation
      let finalType = fallbackType;
      if (typeof obs.type === 'string') {
        if (validTypes.includes(obs.type.trim())) {
          finalType = obs.type.trim();
        } else {
          logger.error('PARSER', `Invalid observation type: ${obs.type}, using "${fallbackType}"`, { correlationId });
        }
      }

      // Extract arrays with type checking
      const files_read = Array.isArray(obs.files_read)
        ? obs.files_read.filter((f): f is string => typeof f === 'string')
        : [];
      const files_modified = Array.isArray(obs.files_modified)
        ? obs.files_modified.filter((f): f is string => typeof f === 'string')
        : [];
      const concepts = Array.isArray(obs.concepts)
        ? obs.concepts.filter((c): c is string => typeof c === 'string')
        : [];

      // Filter out type from concepts
      const cleanedConcepts = concepts.filter(c => c !== finalType);

      observations.push({
        type: finalType,
        title: typeof obs.title === 'string' ? stripFieldWrapper(obs.title) : null,
        subtitle: typeof obs.subtitle === 'string' ? stripFieldWrapper(obs.subtitle) : null,
        facts: Array.isArray(obs.facts)
          ? obs.facts.filter((f): f is string => typeof f === 'string').map(stripFieldWrapper)
          : [],
        narrative: typeof obs.narrative === 'string' ? stripFieldWrapper(obs.narrative) : null,
        concepts: cleanedConcepts,
        files_read,
        files_modified
      });
    }

    return observations;
  } catch (error) {
    const trimmedRaw = text.trim();
    const errorMsg = error instanceof Error ? error.message : String(error);
    const data: Record<string, unknown> = {
      error: errorMsg,
      rawText: text
    };
    if (trimmed && trimmed !== trimmedRaw) {
      data.preprocessedText = trimmed;
    }

    logger.error('PARSER', 'Failed to parse JSON observations', {
      correlationId,
      textLength: text.length
    }, data);
    return [];
  }
}
