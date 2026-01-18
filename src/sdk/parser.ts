/**
 * XML Parser Module
 * Parses observation and summary XML blocks from SDK responses
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

    // NOTE FROM THEDOTMACK: ALWAYS save observations - never skip. 10/24/2025
    // All fields except type are nullable in schema
    // If type is missing or invalid, use first type from mode as fallback

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
      logger.error('PARSER', 'Removed observation type from concepts array', {
        correlationId,
        type: finalType,
        originalConcepts: concepts,
        cleanedConcepts
      });
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
 */
export function parseSummary(text: string, sessionId?: number): ParsedSummary | null {
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

  // Match <summary>...</summary> block (non-greedy)
  const summaryRegex = /<summary>([\s\S]*?)<\/summary>/;
  const summaryMatch = summaryRegex.exec(text);

  if (!summaryMatch) {
    // Log for debugging: no <summary> tag found in response
    logger.warn('PARSER', 'No <summary> tag found in response', {
      sessionId,
      responseLength: text.length,
      responsePreview: text.substring(0, 500)
    });
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
 * Extract a simple field value from XML content
 * Returns null for missing or empty/whitespace-only fields
 *
 * BUGFIX: Use [\s\S]*? instead of [^<]* to support content containing < symbols
 * (e.g., code comparisons like "a < b", HTML references, math expressions)
 *
 * BUGFIX: Strip any simple XML wrapper tags that models (e.g., Gemini) may use.
 * Uses a generic approach to handle <item>, <fact>, <point>, <bullet>, <entry>, etc.
 *
 * BUGFIX: Handle nested same-name tags from Gemini (e.g., <investigated><investigated>...</investigated></investigated>)
 * The non-greedy regex matches to the first closing tag, leaving an orphan opening tag.
 */
function extractField(content: string, fieldName: string): string | null {
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
 */
function extractArrayElements(content: string, arrayName: string, elementName: string): string[] {
  const elements: string[] = [];

  // Match the array block
  const arrayRegex = new RegExp(`<${arrayName}>(.*?)</${arrayName}>`, 's');
  const arrayMatch = arrayRegex.exec(content);

  if (!arrayMatch) {
    return elements;
  }

  const arrayContent = arrayMatch[1];

  // Extract individual elements
  const elementRegex = new RegExp(`<${elementName}>([^<]+)</${elementName}>`, 'g');
  let elementMatch;
  while ((elementMatch = elementRegex.exec(arrayContent)) !== null) {
    elements.push(elementMatch[1].trim());
  }

  return elements;
}
