import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useI18n } from '../i18n';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
type LogComponent = 'HOOK' | 'WORKER' | 'SDK' | 'PARSER' | 'DB' | 'SYSTEM' | 'HTTP' | 'SESSION' | 'CHROMA' | 'OTHER';

interface ParsedLogLine {
  raw: string;
  timestamp?: string;
  level?: LogLevel;
  component?: LogComponent;
  correlationId?: string;
  message?: string;
  isSpecial?: 'dataIn' | 'dataOut' | 'success' | 'failure' | 'timing' | 'happyPath';
}

const LOG_LEVELS: { key: LogLevel; icon: string; color: string }[] = [
  { key: 'DEBUG', icon: '🔍', color: 'var(--color-log-debug)' },
  { key: 'INFO', icon: 'ℹ️', color: 'var(--color-log-info)' },
  { key: 'WARN', icon: '⚠️', color: 'var(--color-log-warn)' },
  { key: 'ERROR', icon: '❌', color: 'var(--color-log-error)' },
];

const LOG_COMPONENTS: { key: LogComponent; icon: string; color: string }[] = [
  { key: 'HOOK', icon: '🪝', color: 'var(--color-log-component)' },
  { key: 'WORKER', icon: '⚙️', color: 'var(--color-log-info)' },
  { key: 'SDK', icon: '📦', color: 'var(--color-log-success)' },
  { key: 'PARSER', icon: '📄', color: 'var(--color-log-component)' },
  { key: 'DB', icon: '🗄️', color: 'var(--color-log-component)' },
  { key: 'SYSTEM', icon: '💻', color: 'var(--color-log-component)' },
  { key: 'HTTP', icon: '🌐', color: 'var(--color-log-component)' },
  { key: 'SESSION', icon: '📋', color: 'var(--color-log-component)' },
  { key: 'CHROMA', icon: '🔮', color: 'var(--color-log-component)' },
  { key: 'OTHER', icon: '🧩', color: 'var(--color-log-component)' },
];

// The logger has more components than there are chips; the rest are filtered by the Other chip.
const LISTED_COMPONENT_KEYS = new Set<string>(LOG_COMPONENTS.map(component => component.key));

function parseLogLine(line: string): ParsedLogLine {
  const pattern = /^\[([^\]]+)\]\s+\[(\w+)\s*\]\s+\[(\w+)\s*\]\s+(?:\[([^\]]+)\]\s+)?(.*)$/;
  const match = line.match(pattern);

  if (!match) {
    return { raw: line };
  }

  const [, timestamp, level, component, correlationId, message] = match;

  let isSpecial: ParsedLogLine['isSpecial'] = undefined;
  if (message.startsWith('→')) isSpecial = 'dataIn';
  else if (message.startsWith('←')) isSpecial = 'dataOut';
  else if (message.startsWith('✓')) isSpecial = 'success';
  else if (message.startsWith('✗')) isSpecial = 'failure';
  else if (message.startsWith('⏱')) isSpecial = 'timing';
  else if (message.includes('[HAPPY-PATH]')) isSpecial = 'happyPath';

  return {
    raw: line,
    timestamp,
    level: level?.trim() as LogLevel,
    component: component?.trim() as LogComponent,
    correlationId: correlationId || undefined,
    message,
    isSpecial,
  };
}

interface LogsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export function LogsDrawer({ isOpen, onClose }: LogsDrawerProps) {
  const { t } = useI18n();
  const [logs, setLogs] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [height, setHeight] = useState(350);
  const [isResizing, setIsResizing] = useState(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);
  const requestSeqRef = useRef(0);
  const clearingRef = useRef(false);

  const [activeLevels, setActiveLevels] = useState<Set<LogLevel>>(
    new Set(['DEBUG', 'INFO', 'WARN', 'ERROR'])
  );
  const [activeComponents, setActiveComponents] = useState<Set<LogComponent>>(
    new Set(LOG_COMPONENTS.map(component => component.key))
  );
  const [alignmentOnly, setAlignmentOnly] = useState(false);

  const parsedLines = useMemo(() => {
    if (!logs) return [];
    let record: ParsedLogLine | undefined;
    return logs.split('\n').map(raw => {
      const line = parseLogLine(raw);
      if (line.timestamp) record = line;
      else if (record) {
        line.level = record.level;
        line.component = record.component;
      }
      return line;
    });
  }, [logs]);

  const filteredLines = useMemo(() => {
    return parsedLines.filter(line => {
      if (alignmentOnly) {
        return line.raw.includes('[ALIGNMENT]');
      }
      if (!line.level || !line.component) {
        return activeLevels.size === LOG_LEVELS.length
          && activeComponents.size === LOG_COMPONENTS.length;
      }
      const componentChipKey = LISTED_COMPONENT_KEYS.has(line.component) ? line.component : 'OTHER';
      return activeLevels.has(line.level) && activeComponents.has(componentChipKey);
    });
  }, [parsedLines, activeLevels, activeComponents, alignmentOnly]);

  const checkIfAtBottom = useCallback(() => {
    if (!contentRef.current) return true;
    const { scrollTop, scrollHeight, clientHeight } = contentRef.current;
    return scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  const scrollToBottom = useCallback(() => {
    if (contentRef.current && wasAtBottomRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, []);

  const fetchLogs = useCallback(async () => {
    if (clearingRef.current) return;
    const request = ++requestSeqRef.current;
    wasAtBottomRef.current = checkIfAtBottom();

    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/logs');
      if (!response.ok) {
        throw new Error(t.logs.fetchFailed.replace('{status}', () => response.statusText));
      }
      const data = await response.json();
      if (request === requestSeqRef.current) setLogs(data.logs || '');
    } catch (err) {
      if (request === requestSeqRef.current) setError(err instanceof Error ? err.message : t.logs.unknownError);
    } finally {
      if (request === requestSeqRef.current) setIsLoading(false);
    }
  }, [checkIfAtBottom, t]);

  useEffect(() => {
    scrollToBottom();
  }, [logs, scrollToBottom]);

  const handleClearLogs = useCallback(async () => {
    if (!confirm(t.logs.confirmClear)) {
      return;
    }
    const request = ++requestSeqRef.current;
    clearingRef.current = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/logs/clear', { method: 'POST', signal: controller.signal });
      if (!response.ok) {
        throw new Error(t.logs.clearFailed.replace('{status}', () => response.statusText));
      }
      if (request === requestSeqRef.current) setLogs('');
    } catch (err) {
      if (controller.signal.aborted) {
        // Abort only says that the acknowledgment was lost: the worker may
        // already have cleared the file. Reconcile even with auto-refresh off,
        // keeping this operation's request ownership and a bounded read.
        const reconciliation = new AbortController();
        const reconciliationTimeout = setTimeout(() => reconciliation.abort(), 5000);
        try {
          const response = await fetch('/api/logs', { signal: reconciliation.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          if (request === requestSeqRef.current) {
            setLogs(data.logs || '');
            setError(t.logs.clearTimedOut);
          }
        } catch {
          if (request === requestSeqRef.current) {
            setError(t.logs.clearTimedOutUnrefreshed);
          }
        } finally {
          clearTimeout(reconciliationTimeout);
        }
      } else if (request === requestSeqRef.current) {
        setError(err instanceof Error ? err.message : t.logs.unknownError);
      }
    } finally {
      clearTimeout(timeout);
      clearingRef.current = false;
      if (request === requestSeqRef.current) setIsLoading(false);
    }
  }, [t]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    startYRef.current = e.clientY;
    startHeightRef.current = height;
  }, [height]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY = startYRef.current - e.clientY;
      const newHeight = Math.min(Math.max(150, startHeightRef.current + deltaY), window.innerHeight - 100);
      setHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  useEffect(() => {
    if (isOpen) {
      wasAtBottomRef.current = true; 
      fetchLogs();
    }
  }, [isOpen, fetchLogs]);

  useEffect(() => {
    if (!isOpen || !autoRefresh) {
      return;
    }

    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, [isOpen, autoRefresh, fetchLogs]);

  const toggleLevel = useCallback((level: LogLevel) => {
    setActiveLevels(prev => {
      const next = new Set(prev);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  }, []);

  const toggleComponent = useCallback((component: LogComponent) => {
    setActiveComponents(prev => {
      const next = new Set(prev);
      if (next.has(component)) {
        next.delete(component);
      } else {
        next.add(component);
      }
      return next;
    });
  }, []);

  const setAllLevels = useCallback((enabled: boolean) => {
    if (enabled) {
      setActiveLevels(new Set(['DEBUG', 'INFO', 'WARN', 'ERROR']));
    } else {
      setActiveLevels(new Set());
    }
  }, []);

  const setAllComponents = useCallback((enabled: boolean) => {
    if (enabled) {
      setActiveComponents(new Set(LOG_COMPONENTS.map(component => component.key)));
    } else {
      setActiveComponents(new Set());
    }
  }, []);

  if (!isOpen) {
    return null;
  }

  const getLineStyle = (line: ParsedLogLine): React.CSSProperties => {
    const levelConfig = LOG_LEVELS.find(l => l.key === line.level);
    const componentConfig = LOG_COMPONENTS.find(c => c.key === line.component);

    let color = 'var(--color-text-primary)';
    let fontWeight = 'normal';
    let backgroundColor = 'transparent';

    if (line.level === 'ERROR') {
      color = 'var(--color-log-error)';
      backgroundColor = 'rgba(248, 81, 73, 0.1)';
    } else if (line.level === 'WARN') {
      color = 'var(--color-log-warn)';
      backgroundColor = 'rgba(210, 153, 34, 0.05)';
    } else if (line.isSpecial === 'success') {
      color = 'var(--color-log-success)';
    } else if (line.isSpecial === 'failure') {
      color = 'var(--color-log-error)';
    } else if (line.isSpecial === 'happyPath') {
      color = 'var(--color-log-warn)';
    } else if (levelConfig) {
      color = levelConfig.color;
    }

    return { color, fontWeight, backgroundColor, padding: '1px 0', borderRadius: '2px' };
  };

  const renderLogLine = (line: ParsedLogLine, index: number) => {
    if (!line.timestamp) {
      return (
        <div key={index} className="log-line log-line-raw">
          {line.raw}
        </div>
      );
    }

    const levelConfig = LOG_LEVELS.find(l => l.key === line.level);
    const componentConfig = LOG_COMPONENTS.find(c => c.key === line.component);

    return (
      <div key={index} className="log-line" style={getLineStyle(line)}>
        <span className="log-timestamp">[{line.timestamp}]</span>
        {' '}
        <span className="log-level" style={{ color: levelConfig?.color }} title={line.level}>
          [{levelConfig?.icon || ''} {line.level?.padEnd(5)}]
        </span>
        {' '}
        <span className="log-component" style={{ color: componentConfig?.color }} title={line.component}>
          [{componentConfig?.icon || ''} {line.component?.padEnd(7)}]
        </span>
        {' '}
        {line.correlationId && (
          <>
            <span className="log-correlation">[{line.correlationId}]</span>
            {' '}
          </>
        )}
        <span className="log-message">{line.message}</span>
      </div>
    );
  };

  return (
    <section className="console-drawer" aria-label={t.logs.title} style={{ height: `${height}px` }}>
      <div
        className="console-resize-handle"
        onMouseDown={handleMouseDown}
        role="separator"
        tabIndex={0}
        aria-label={t.logs.resize}
        aria-orientation="horizontal"
        aria-valuemin={150}
        aria-valuemax={window.innerHeight - 100}
        aria-valuenow={height}
        onKeyDown={event => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          setHeight(current => Math.min(window.innerHeight - 100, Math.max(150, current + (event.key === 'ArrowUp' ? 40 : -40))));
        }}
      >
        <div className="console-resize-bar" />
      </div>

      <div className="console-header">
        <div className="console-tabs">
          <div className="console-tab active">{t.logs.title}</div>
        </div>
        <div className="console-controls">
          <label className="console-auto-refresh">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            {t.logs.autoRefresh}
          </label>
          <button
            className="console-control-btn"
            onClick={fetchLogs}
            disabled={isLoading}
            title={t.logs.refreshLogs}
          >
            ↻
          </button>
          <button
            className="console-control-btn"
            onClick={() => {
              wasAtBottomRef.current = true;
              scrollToBottom();
            }}
            title={t.logs.scrollToBottom}
          >
            ⬇
          </button>
          <button
            className="console-control-btn console-clear-btn"
            onClick={handleClearLogs}
            disabled={isLoading}
            title={t.logs.clearLogs}
          >
            🗑
          </button>
          <button
            className="console-control-btn"
            onClick={onClose}
            title={t.logs.closeConsole}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="console-filters">
        <div className="console-filter-section">
          <span className="console-filter-label">{t.logs.quick}</span>
          <div className="console-filter-chips">
            <button
              className={`console-filter-chip ${alignmentOnly ? 'active' : ''}`}
              onClick={() => setAlignmentOnly(!alignmentOnly)}
              style={{
                '--chip-color': '#f0883e',
              } as React.CSSProperties}
              title={t.logs.alignmentTitle}
              aria-pressed={alignmentOnly}
            >
              🔗 {t.logs.alignment}
            </button>
          </div>
        </div>
        <div className="console-filter-section">
          <span className="console-filter-label">{t.logs.levels}</span>
          <div className="console-filter-chips">
            {LOG_LEVELS.map(level => (
              <button
                key={level.key}
                className={`console-filter-chip ${activeLevels.has(level.key) ? 'active' : ''}`}
                onClick={() => toggleLevel(level.key)}
                style={{
                  '--chip-color': level.color,
                } as React.CSSProperties}
                title={t.logs.levelLabels[level.key]}
                aria-pressed={activeLevels.has(level.key)}
              >
                {level.icon} {t.logs.levelLabels[level.key]}
              </button>
            ))}
            <button
              className="console-filter-action"
              onClick={() => setAllLevels(activeLevels.size !== LOG_LEVELS.length)}
              title={activeLevels.size === LOG_LEVELS.length ? t.logs.selectNone : t.logs.selectAll}
              aria-label={activeLevels.size === LOG_LEVELS.length ? t.logs.deselectAllLevels : t.logs.selectAllLevels}
            >
              {activeLevels.size === LOG_LEVELS.length ? '○' : '●'}
            </button>
          </div>
        </div>
        <div className="console-filter-section">
          <span className="console-filter-label">{t.logs.components}</span>
          <div className="console-filter-chips">
            {LOG_COMPONENTS.map(comp => (
              <button
                key={comp.key}
                className={`console-filter-chip ${activeComponents.has(comp.key) ? 'active' : ''}`}
                onClick={() => toggleComponent(comp.key)}
                style={{
                  '--chip-color': comp.color,
                } as React.CSSProperties}
                title={t.logs.componentLabels[comp.key]}
                aria-pressed={activeComponents.has(comp.key)}
              >
                {comp.icon} {t.logs.componentLabels[comp.key]}
              </button>
            ))}
            <button
              className="console-filter-action"
              onClick={() => setAllComponents(activeComponents.size !== LOG_COMPONENTS.length)}
              title={activeComponents.size === LOG_COMPONENTS.length ? t.logs.selectNone : t.logs.selectAll}
              aria-label={activeComponents.size === LOG_COMPONENTS.length ? t.logs.deselectAllComponents : t.logs.selectAllComponents}
            >
              {activeComponents.size === LOG_COMPONENTS.length ? '○' : '●'}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="console-error">
          ⚠ {error}
        </div>
      )}

      <div className="console-content" ref={contentRef}>
        <div className="console-logs">
          {filteredLines.length === 0 ? (
            <div className="log-line log-line-empty">{logs ? t.logs.noMatchingLogs : t.logs.noLogs}</div>
          ) : (
            filteredLines.map((line, index) => renderLogLine(line, index))
          )}
        </div>
      </div>
    </section>
  );
}
