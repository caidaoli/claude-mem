/**
 * CleanupModal - Database maintenance and cleanup interface
 *
 * Provides time-based purge functionality for managing database size.
 * Users can preview and execute cleanup operations with confirmation.
 */

import React, { useState, useCallback } from 'react';
import { API_ENDPOINTS } from '../constants/api';
import { useI18n } from '../i18n';

interface CleanupModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface CleanupPreview {
  period: string;
  cutoffDate: string | null;
  preview: {
    observations: number;
    summaries: number;
    prompts: number;
    sessions: number;
  };
  totalRecords: number;
}

interface CleanupResult {
  success: boolean;
  period: string;
  cutoffDate: string | null;
  deleted: {
    observations: number;
    summaries: number;
    prompts: number;
    sessions: number;
  };
  totalDeleted: number;
}

const CLEANUP_OPTIONS = [
  { value: '7d', labelKey: 'last7Days' as const, descKey: 'last7DaysDesc' as const },
  { value: '15d', labelKey: 'last15Days' as const, descKey: 'last15DaysDesc' as const },
  { value: '1m', labelKey: 'last1Month' as const, descKey: 'last1MonthDesc' as const },
  { value: '6m', labelKey: 'last6Months' as const, descKey: 'last6MonthsDesc' as const },
  { value: '1y', labelKey: 'last1Year' as const, descKey: 'last1YearDesc' as const },
  { value: 'all', labelKey: 'all' as const, descKey: 'allDesc' as const }
] as const;

type CleanupPeriod = typeof CLEANUP_OPTIONS[number]['value'];

export function CleanupModal({ isOpen, onClose }: CleanupModalProps) {
  const { t } = useI18n();
  const [selectedPeriod, setSelectedPeriod] = useState<CleanupPeriod>('7d');
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const resetState = useCallback(() => {
    setPreview(null);
    setResult(null);
    setError(null);
    setShowConfirm(false);
    setConfirmText('');
  }, []);

  const handleClose = useCallback(() => {
    resetState();
    onClose();
  }, [onClose, resetState]);

  const fetchPreview = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch(`${API_ENDPOINTS.MAINTENANCE_CLEANUP_PREVIEW}?period=${selectedPeriod}`);
      if (!response.ok) {
        throw new Error(`Preview failed: ${response.statusText}`);
      }
      const data = await response.json();
      setPreview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setIsLoading(false);
    }
  }, [selectedPeriod]);

  const executeCleanup = useCallback(async () => {
    if (selectedPeriod === 'all' && confirmText !== t.cleanup.confirmPhrase) {
      setError(t.cleanup.confirmError);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(API_ENDPOINTS.MAINTENANCE_CLEANUP, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: selectedPeriod, confirm: true })
      });

      if (!response.ok) {
        throw new Error(`Cleanup failed: ${response.statusText}`);
      }

      const data = await response.json();
      setResult(data);
      setPreview(null);
      setShowConfirm(false);
      setConfirmText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cleanup failed');
    } finally {
      setIsLoading(false);
    }
  }, [selectedPeriod, confirmText, t]);

  if (!isOpen) return null;

  const selectedOption = CLEANUP_OPTIONS.find(opt => opt.value === selectedPeriod);

  return (
    <div className="modal-backdrop" onClick={handleClose}>
      <div className="modal-content cleanup-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
            </svg>
            {t.cleanup.title}
          </h2>
          <button className="modal-close-btn" onClick={handleClose} title={t.cleanup.close}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          {/* Period Selection */}
          <div className="cleanup-section">
            <label className="section-label">{t.cleanup.cleanupPeriod}</label>
            <div className="cleanup-options">
              {CLEANUP_OPTIONS.map(option => (
                <button
                  key={option.value}
                  type="button"
                  className={`cleanup-option ${selectedPeriod === option.value ? 'selected' : ''} ${option.value === 'all' ? 'danger' : ''}`}
                  onClick={() => {
                    setSelectedPeriod(option.value);
                    resetState();
                  }}
                >
                  <span className="option-label">{t.cleanup[option.labelKey]}</span>
                  <span className="option-description">{t.cleanup[option.descKey]}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Error Display */}
          {error && (
            <div className="cleanup-error">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              {error}
            </div>
          )}

          {/* Preview Results */}
          {preview && !result && (
            <div className="cleanup-preview">
              <h3>{t.cleanup.previewTitle}</h3>
              {preview.cutoffDate && (
                <p className="cutoff-date">
                  {t.cleanup.cutoffDate} <strong>{new Date(preview.cutoffDate).toLocaleString()}</strong>
                </p>
              )}
              <div className="preview-stats">
                <div className="stat-item">
                  <span className="stat-label">{t.cleanup.observations}</span>
                  <span className="stat-value">{preview.preview.observations.toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">{t.cleanup.summaries}</span>
                  <span className="stat-value">{preview.preview.summaries.toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">{t.cleanup.prompts}</span>
                  <span className="stat-value">{preview.preview.prompts.toLocaleString()}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">{t.cleanup.sessions}</span>
                  <span className="stat-value">{preview.preview.sessions.toLocaleString()}</span>
                </div>
                <div className="stat-item total">
                  <span className="stat-label">{t.cleanup.total}</span>
                  <span className="stat-value">{preview.totalRecords.toLocaleString()}</span>
                </div>
              </div>

              {preview.totalRecords > 0 && !showConfirm && (
                <button
                  type="button"
                  className={`cleanup-confirm-btn ${selectedPeriod === 'all' ? 'danger' : ''}`}
                  onClick={() => setShowConfirm(true)}
                >
                  {t.cleanup.startCleanup}
                </button>
              )}

              {preview.totalRecords === 0 && (
                <p className="no-records">{t.cleanup.noRecords}</p>
              )}
            </div>
          )}

          {/* Confirmation for dangerous operations */}
          {showConfirm && preview && preview.totalRecords > 0 && (
            <div className={`cleanup-confirm ${selectedPeriod === 'all' ? 'danger' : ''}`}>
              <div className="confirm-warning">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <p>
                  <strong>{preview.totalRecords.toLocaleString()}</strong>{t.cleanup.confirmWarningPost}
                </p>
              </div>

              {selectedPeriod === 'all' && (
                <div className="confirm-input">
                  <label>{t.cleanup.confirmTypeLabel}</label>
                  <input
                    type="text"
                    value={confirmText}
                    onChange={e => setConfirmText(e.target.value)}
                    placeholder={t.cleanup.confirmPlaceholder}
                  />
                </div>
              )}

              <div className="confirm-actions">
                <button
                  type="button"
                  className="cancel-btn"
                  onClick={() => {
                    setShowConfirm(false);
                    setConfirmText('');
                  }}
                >
                  {t.cleanup.cancel}
                </button>
                <button
                  type="button"
                  className={`execute-btn ${selectedPeriod === 'all' ? 'danger' : ''}`}
                  onClick={executeCleanup}
                  disabled={isLoading || (selectedPeriod === 'all' && confirmText !== t.cleanup.confirmPhrase)}
                >
                  {isLoading ? t.cleanup.deleting : t.cleanup.delete}
                </button>
              </div>
            </div>
          )}

          {/* Success Result */}
          {result && result.success && (
            <div className="cleanup-result success">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <h3>{t.cleanup.cleanupComplete}</h3>
              <div className="result-stats">
                <p><strong>{result.totalDeleted.toLocaleString()}</strong>{t.cleanup.recordsDeleted}</p>
                <ul>
                  <li>{result.deleted.observations.toLocaleString()} {t.cleanup.observation}</li>
                  <li>{result.deleted.summaries.toLocaleString()} {t.cleanup.summary}</li>
                  <li>{result.deleted.prompts.toLocaleString()} {t.cleanup.prompt}</li>
                  <li>{result.deleted.sessions.toLocaleString()} {t.cleanup.session}</li>
                </ul>
              </div>
              <button type="button" className="done-btn" onClick={handleClose}>
                {t.cleanup.done}
              </button>
            </div>
          )}
        </div>

        {/* Footer with Preview Button */}
        {!preview && !result && (
          <div className="modal-footer">
            <button type="button" className="cancel-btn" onClick={handleClose}>
              {t.cleanup.cancel}
            </button>
            <button
              type="button"
              className="preview-btn"
              onClick={fetchPreview}
              disabled={isLoading}
            >
              {isLoading ? t.cleanup.loading : t.cleanup.preview}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
