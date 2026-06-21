import React, { useState, useCallback, useEffect } from 'react';
import type { Settings } from '../types';
import { TerminalPreview } from './TerminalPreview';
import { useContextPreview } from '../hooks/useContextPreview';
import { useI18n } from '../i18n';

interface ContextSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: Settings;
  onSave: (settings: Settings) => void;
  isSaving: boolean;
  saveStatus: string;
}

function CollapsibleSection({
  title,
  description,
  children,
  defaultOpen = true
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={`settings-section-collapsible ${isOpen ? 'open' : ''}`}>
      <button
        className="section-header-btn"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <div className="section-header-content">
          <span className="section-title">{title}</span>
          {description && <span className="section-description">{description}</span>}
        </div>
        <svg
          className={`chevron-icon ${isOpen ? 'rotated' : ''}`}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {isOpen && <div className="section-content">{children}</div>}
    </div>
  );
}

function FormField({
  label,
  tooltip,
  children
}: {
  label: string;
  tooltip?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="form-field">
      <label className="form-field-label">
        {label}
        {tooltip && (
          <span className="tooltip-trigger" title={tooltip}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </span>
        )}
      </label>
      {children}
    </div>
  );
}

function ToggleSwitch({
  id,
  label,
  description,
  checked,
  onChange,
  disabled
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="toggle-row">
      <div className="toggle-info">
        <label htmlFor={id} className="toggle-label">{label}</label>
        {description && <span className="toggle-description">{description}</span>}
      </div>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        className={`toggle-switch ${checked ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
      >
        <span className="toggle-knob" />
      </button>
    </div>
  );
}

export function ContextSettingsModal({
  isOpen,
  onClose,
  settings,
  onSave,
  isSaving,
  saveStatus
}: ContextSettingsModalProps) {
  const { t } = useI18n();
  const [formState, setFormState] = useState<Settings>(settings);

  useEffect(() => {
    setFormState(settings);
  }, [settings]);

  const {
    preview,
    isLoading,
    error,
    projects,
    sources,
    selectedSource,
    setSelectedSource,
    selectedProject,
    setSelectedProject
  } = useContextPreview(formState);

  const updateSetting = useCallback((key: keyof Settings, value: string) => {
    const newState = { ...formState, [key]: value };
    setFormState(newState);
  }, [formState]);

  const handleSave = useCallback(() => {
    onSave(formState);
  }, [formState, onSave]);

  const toggleBoolean = useCallback((key: keyof Settings) => {
    const currentValue = formState[key];
    const newValue = currentValue === 'true' ? 'false' : 'true';
    updateSetting(key, newValue);
  }, [formState, updateSetting]);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleEsc);
      return () => window.removeEventListener('keydown', handleEsc);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="context-settings-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <h2>{t.settings.title}</h2>
          <div className="header-controls">
            <label className="preview-selector">
              {t.settings.source}
              <select
                value={selectedSource || ''}
                onChange={(e) => setSelectedSource(e.target.value)}
                disabled={sources.length === 0}
              >
                {sources.map(source => (
                  <option key={source} value={source}>{source}</option>
                ))}
              </select>
            </label>
            <label className="preview-selector">
              {t.settings.project}
              <select
                value={selectedProject || ''}
                onChange={(e) => setSelectedProject(e.target.value)}
                disabled={projects.length === 0}
              >
                {projects.map(project => (
                  <option key={project} value={project}>{project}</option>
                ))}
              </select>
            </label>
            <button
              onClick={onClose}
              className="modal-close-btn"
              title={t.settings.closeEsc}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body - 2 columns */}
        <div className="modal-body">
          {/* Left column - Terminal Preview */}
          <div className="preview-column">
            <div className="preview-content">
              {error ? (
                <div style={{ color: '#ff6b6b' }}>
                  {t.settings.errorLoadingPreview} {error}
                </div>
              ) : (
                <TerminalPreview content={preview} isLoading={isLoading} />
              )}
            </div>
          </div>

          {/* Right column - Settings Panel */}
          <div className="settings-column">
            {/* Section 1: Loading */}
            <CollapsibleSection
              title={t.settings.loading}
              description={t.settings.loadingDesc}
            >
              <FormField
                label={t.settings.observations}
                tooltip={t.settings.observationsTooltip}
              >
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={formState.CLAUDE_MEM_CONTEXT_OBSERVATIONS || '50'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_OBSERVATIONS', e.target.value)}
                />
              </FormField>
              <FormField
                label={t.settings.sessions}
                tooltip={t.settings.sessionsTooltip}
              >
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={formState.CLAUDE_MEM_CONTEXT_SESSION_COUNT || '10'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_SESSION_COUNT', e.target.value)}
                />
              </FormField>
            </CollapsibleSection>

            {/* Section 2: Display */}
            <CollapsibleSection
              title={t.settings.display}
              description={t.settings.displayDesc}
            >
              <div className="display-subsection">
                <span className="subsection-label">{t.settings.fullObservations}</span>
                <FormField
                  label={t.settings.count}
                  tooltip={t.settings.countTooltip}
                >
                  <input
                    type="number"
                    min="0"
                    max="20"
                    value={formState.CLAUDE_MEM_CONTEXT_FULL_COUNT || '5'}
                    onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_FULL_COUNT', e.target.value)}
                  />
                </FormField>
                <FormField
                  label={t.settings.field}
                  tooltip={t.settings.fieldTooltip}
                >
                  <select
                    value={formState.CLAUDE_MEM_CONTEXT_FULL_FIELD || 'narrative'}
                    onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_FULL_FIELD', e.target.value)}
                  >
                    <option value="narrative">{t.settings.narrativeOption}</option>
                    <option value="facts">{t.settings.factsOption}</option>
                  </select>
                </FormField>
              </div>

              <div className="display-subsection">
                <span className="subsection-label">{t.settings.tokenEconomics}</span>
                <div className="toggle-group">
                  <ToggleSwitch
                    id="show-read-tokens"
                    label={t.settings.readCost}
                    description={t.settings.readCostDesc}
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS')}
                  />
                  <ToggleSwitch
                    id="show-work-tokens"
                    label={t.settings.workInvestment}
                    description={t.settings.workInvestmentDesc}
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS')}
                  />
                  <ToggleSwitch
                    id="show-savings-amount"
                    label={t.settings.savings}
                    description={t.settings.savingsDesc}
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT')}
                  />
                </div>
              </div>
            </CollapsibleSection>

            {/* Section 4: Advanced */}
            <CollapsibleSection
              title={t.settings.advanced}
              description={t.settings.advancedDesc}
              defaultOpen={false}
            >
              <FormField
                label={t.settings.aiProvider}
                tooltip={t.settings.aiProviderTooltip}
              >
                <select
                  value={formState.CLAUDE_MEM_PROVIDER || 'claude'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_PROVIDER', e.target.value)}
                >
                  <option value="claude">{t.settings.claudeOption}</option>
                  <option value="gemini">{t.settings.geminiOption}</option>
                  <option value="openrouter">{t.settings.openrouterOption}</option>
                  <option value="custom">{t.settings.customOption}</option>
                </select>
              </FormField>

              {formState.CLAUDE_MEM_PROVIDER === 'claude' && (
                <FormField
                  label={t.settings.claudeModel}
                  tooltip={t.settings.claudeModelTooltip}
                >
                  <select
                    value={formState.CLAUDE_MEM_MODEL || 'haiku'}
                    onChange={(e) => updateSetting('CLAUDE_MEM_MODEL', e.target.value)}
                  >
                    <option value="haiku">{t.settings.haikuOption}</option>
                    <option value="sonnet">{t.settings.sonnetOption}</option>
                    <option value="opus">{t.settings.opusOption}</option>
                  </select>
                </FormField>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'gemini' && (
                <>
                  <FormField
                    label={t.settings.geminiApiKey}
                    tooltip={t.settings.geminiApiKeyTooltip}
                  >
                    <input
                      type="password"
                      value={formState.CLAUDE_MEM_GEMINI_API_KEY || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_GEMINI_API_KEY', e.target.value)}
                      placeholder={t.settings.enterGeminiKey}
                    />
                  </FormField>
                  <FormField
                    label={t.settings.geminiModel}
                    tooltip={t.settings.geminiModelTooltip}
                  >
                    <select
                      value={formState.CLAUDE_MEM_GEMINI_MODEL || 'gemini-2.5-flash-lite'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_GEMINI_MODEL', e.target.value)}
                    >
                      <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite (10 RPM free)</option>
                      <option value="gemini-2.5-flash">gemini-2.5-flash (10 RPM free)</option>
                      <option value="gemini-2.5-pro">gemini-2.5-pro (5 RPM free)</option>
                      <option value="gemini-2.0-flash">gemini-2.0-flash (15 RPM free)</option>
                      <option value="gemini-2.0-flash-lite">gemini-2.0-flash-lite (30 RPM free)</option>
                      <option value="gemini-3-flash-preview">gemini-3-flash-preview (5 RPM free)</option>
                    </select>
                  </FormField>
                  <div className="toggle-group" style={{ marginTop: '8px' }}>
                    <ToggleSwitch
                      id="gemini-rate-limiting"
                      label={t.settings.rateLimiting}
                      description={t.settings.rateLimitingDesc}
                      checked={formState.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED === 'true'}
                      onChange={(checked) => updateSetting('CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED', checked ? 'true' : 'false')}
                    />
                  </div>
                </>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'openrouter' && (
                <>
                  <FormField
                    label={t.settings.openrouterApiKey}
                    tooltip={t.settings.openrouterApiKeyTooltip}
                  >
                    <input
                      type="password"
                      value={formState.CLAUDE_MEM_OPENROUTER_API_KEY || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_API_KEY', e.target.value)}
                      placeholder={t.settings.enterOpenrouterKey}
                    />
                  </FormField>
                  <FormField
                    label={t.settings.openrouterModel}
                    tooltip={t.settings.openrouterModelTooltip}
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENROUTER_MODEL || 'xiaomi/mimo-v2-flash:free'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_MODEL', e.target.value)}
                      placeholder="e.g., xiaomi/mimo-v2-flash:free"
                    />
                  </FormField>
                  <FormField
                    label={t.settings.siteUrl}
                    tooltip={t.settings.siteUrlTooltip}
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENROUTER_SITE_URL || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_SITE_URL', e.target.value)}
                      placeholder="https://yoursite.com"
                    />
                  </FormField>
                  <FormField
                    label={t.settings.appName}
                    tooltip={t.settings.appNameTooltip}
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENROUTER_APP_NAME || 'claude-mem'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_APP_NAME', e.target.value)}
                      placeholder="claude-mem"
                    />
                  </FormField>
                </>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'custom' && (
                <>
                  <FormField
                    label={t.settings.apiBaseUrl}
                    tooltip={t.settings.apiBaseUrlTooltip}
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_CUSTOM_API_URL || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_CUSTOM_API_URL', e.target.value)}
                      placeholder="https://your-proxy.example.com"
                    />
                  </FormField>
                  <FormField
                    label={t.settings.apiKey}
                    tooltip={t.settings.apiKeyTooltip}
                  >
                    <input
                      type="password"
                      value={formState.CLAUDE_MEM_CUSTOM_API_KEY || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_CUSTOM_API_KEY', e.target.value)}
                      placeholder={t.settings.enterApiKey}
                    />
                  </FormField>
                  <FormField
                    label={t.settings.model}
                    tooltip={t.settings.modelTooltip}
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_CUSTOM_MODEL || 'gpt-4o'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_CUSTOM_MODEL', e.target.value)}
                      placeholder="gpt-4o"
                    />
                  </FormField>
                  <FormField
                    label={t.settings.protocol}
                    tooltip={t.settings.protocolTooltip}
                  >
                    <select
                      value={formState.CLAUDE_MEM_CUSTOM_PROTOCOL || 'openai'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_CUSTOM_PROTOCOL', e.target.value)}
                    >
                      <option value="openai">{t.protocols.openai}</option>
                      <option value="gemini">{t.protocols.gemini}</option>
                      <option value="codex">{t.protocols.codex}</option>
                    </select>
                  </FormField>
                  <FormField
                    label={t.settings.maxContextMessages}
                    tooltip={t.settings.maxContextMessagesTooltip}
                  >
                    <input
                      type="number"
                      min="0"
                      max="200"
                      value={formState.CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES || '0'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES', e.target.value)}
                    />
                  </FormField>
                  <FormField
                    label={t.settings.maxTokens}
                    tooltip={t.settings.maxTokensTooltip}
                  >
                    <input
                      type="number"
                      min="0"
                      max="2000000"
                      value={formState.CLAUDE_MEM_CUSTOM_MAX_TOKENS || '0'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_CUSTOM_MAX_TOKENS', e.target.value)}
                    />
                  </FormField>
                  <FormField
                    label={t.settings.firstTokenTimeout}
                    tooltip={t.settings.firstTokenTimeoutTooltip}
                  >
                    <input
                      type="number"
                      min="0"
                      max="600"
                      value={formState.CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT || '0'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT', e.target.value)}
                    />
                  </FormField>
                  <FormField
                    label={t.settings.totalTimeout}
                    tooltip={t.settings.totalTimeoutTooltip}
                  >
                    <input
                      type="number"
                      min="0"
                      max="3600"
                      value={formState.CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT || '0'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT', e.target.value)}
                    />
                  </FormField>
                  <div className="toggle-group" style={{ marginTop: '8px' }}>
                    <ToggleSwitch
                      id="custom-streaming"
                      label={t.settings.streaming}
                      description={t.settings.streamingDesc}
                      checked={formState.CLAUDE_MEM_CUSTOM_STREAMING !== 'false'}
                      onChange={(checked) => updateSetting('CLAUDE_MEM_CUSTOM_STREAMING', checked ? 'true' : 'false')}
                    />
                  </div>
                </>
              )}

              <FormField
                label={t.settings.workerPort}
                tooltip={t.settings.workerPortTooltip}
              >
                <input
                  type="number"
                  min="1024"
                  max="65535"
                  value={formState.CLAUDE_MEM_WORKER_PORT || '37777'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_WORKER_PORT', e.target.value)}
                />
              </FormField>

              <FormField
                label={t.settings.logLevel}
                tooltip={t.settings.logLevelTooltip}
              >
                <select
                  value={formState.CLAUDE_MEM_LOG_LEVEL || 'INFO'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_LOG_LEVEL', e.target.value)}
                >
                  <option value="DEBUG">DEBUG (most verbose)</option>
                  <option value="INFO">INFO (default)</option>
                  <option value="WARN">WARN</option>
                  <option value="ERROR">ERROR</option>
                  <option value="SILENT">SILENT (no logs)</option>
                </select>
              </FormField>

              <div className="toggle-group" style={{ marginTop: '12px' }}>
                <ToggleSwitch
                  id="show-last-summary"
                  label={t.settings.includeLastSummary}
                  description={t.settings.includeLastSummaryDesc}
                  checked={formState.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY === 'true'}
                  onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY')}
                />
                <ToggleSwitch
                  id="show-last-message"
                  label={t.settings.includeLastMessage}
                  description={t.settings.includeLastMessageDesc}
                  checked={formState.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE === 'true'}
                  onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE')}
                />
              </div>
            </CollapsibleSection>
          </div>
        </div>

        {/* Footer with Save button */}
        <div className="modal-footer">
          <div className="save-status">
            {saveStatus && <span className={saveStatus.includes('✓') ? 'success' : saveStatus.includes('✗') ? 'error' : ''}>{saveStatus}</span>}
          </div>
          <button
            className="save-btn"
            onClick={handleSave}
            disabled={isSaving}
          >
            {isSaving ? t.settings.saving : t.settings.save}
          </button>
        </div>
      </div>
    </div>
  );
}
