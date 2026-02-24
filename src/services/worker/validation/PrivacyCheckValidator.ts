import { SessionStore } from '../../sqlite/SessionStore.js';
import { logger } from '../../../utils/logger.js';

/**
 * Validates user prompt privacy for session operations
 *
 * Centralizes privacy checks to avoid duplicate validation logic across route handlers.
 * If user prompt was entirely private (stripped to empty string), we skip processing.
 */
export class PrivacyCheckValidator {
  /**
   * Check if user prompt is public (not entirely private)
   *
   * @param store - SessionStore instance
   * @param contentSessionId - Claude session ID
   * @param promptNumber - Prompt number within session (0 = no prompts saved yet)
   * @param operationType - Type of operation being validated ('observation' or 'summarize')
   * @returns User prompt text if public, null if private
   */
  static checkUserPromptPrivacy(
    store: SessionStore,
    contentSessionId: string,
    promptNumber: number,
    operationType: 'observation' | 'summarize',
    sessionDbId: number,
    additionalContext?: Record<string, any>
  ): string | null {
    // promptNumber=0 means no user prompts have been saved yet for this session.
    // This happens when PostToolUse hooks arrive before session-init (UserPromptSubmit)
    // completes. This is a timing issue, not a privacy signal — allow the operation
    // through since there's no prompt to check privacy against.
    if (promptNumber === 0) {
      logger.debug('HOOK', `Allowing ${operationType} - session not yet initialized (no user prompts)`, {
        sessionId: sessionDbId,
        promptNumber,
        ...additionalContext
      });
      return '[pending-init]';
    }

    const userPrompt = store.getUserPrompt(contentSessionId, promptNumber);

    if (!userPrompt || userPrompt.trim() === '') {
      logger.debug('HOOK', `Skipping ${operationType} - user prompt was entirely private`, {
        sessionId: sessionDbId,
        promptNumber,
        ...additionalContext
      });
      return null;
    }

    return userPrompt;
  }
}
