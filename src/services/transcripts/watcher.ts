import { existsSync, statSync, watch as fsWatch, createReadStream } from 'fs';
import { basename, join, resolve as resolvePath, sep as pathSep } from 'path';
import { globSync } from 'glob';
import { logger } from '../../utils/logger.js';
import { expandHomePath } from './config.js';
import { loadWatchState, saveWatchState, type TranscriptWatchState } from './state.js';
import type { TranscriptWatchConfig, TranscriptSchema, WatchTarget } from './types.js';
import { TranscriptEventProcessor } from './processor.js';

interface TailState {
  offset: number;
}

export interface TranscriptWatcherOptions {
  reconciliationTickMs?: number;
  activeReconcileIntervalMs?: number;
  idleReconcileIntervalMs?: number;
  activeWindowMs?: number;
}

const DEFAULT_RECONCILIATION_TICK_MS = 5_000;
const DEFAULT_ACTIVE_RECONCILE_INTERVAL_MS = 5_000;
const DEFAULT_IDLE_RECONCILE_INTERVAL_MS = 60_000;
const DEFAULT_ACTIVE_WINDOW_MS = 5 * 60_000;

interface ReconciliationPolicy {
  activeReconcileIntervalMs: number;
  idleReconcileIntervalMs: number;
  activeWindowMs: number;
}

class FileTailer {
  private watcher: ReturnType<typeof fsWatch> | null = null;
  private tailState: TailState;
  private reading = false;
  private readAgain = false;
  private lastActivityAt = 0;
  private lastReconciledAt = 0;

  constructor(
    private filePath: string,
    initialOffset: number,
    private onLine: (line: string) => Promise<void>,
    private onOffset: (offset: number) => void
  ) {
    this.tailState = { offset: initialOffset };
  }

  start(): void {
    this.requestRead(false);
    this.watcher = fsWatch(this.filePath, { persistent: true }, () => {
      this.poke();
    });
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  poke(): void {
    this.requestRead(true);
  }

  reconcile(now: number, policy: ReconciliationPolicy): void {
    const isActive = this.lastActivityAt > 0 && now - this.lastActivityAt <= policy.activeWindowMs;
    const intervalMs = isActive
      ? policy.activeReconcileIntervalMs
      : policy.idleReconcileIntervalMs;

    if (intervalMs <= 0) return;
    if (now - this.lastReconciledAt < intervalMs) return;

    this.lastReconciledAt = now;
    this.requestRead(false);
  }

  private requestRead(markActive: boolean): void {
    if (markActive) {
      this.lastActivityAt = Date.now();
    }

    if (this.reading) {
      this.readAgain = true;
      return;
    }

    this.reading = true;
    this.readLoop().catch((error: unknown) => {
      logger.warn('TRANSCRIPT', 'Transcript tailer read failed; will retry from last committed offset', {
        file: this.filePath,
        offset: this.tailState.offset,
      }, error instanceof Error ? error : new Error(String(error)));
    }).finally(() => {
      this.reading = false;
      if (this.readAgain) {
        this.readAgain = false;
        this.requestRead(false);
      }
    });
  }

  private async readLoop(): Promise<void> {
    do {
      this.readAgain = false;
      await this.readNewData();
    } while (this.readAgain);
  }

  private async readNewData(): Promise<void> {
    if (!existsSync(this.filePath)) return;

    let size = 0;
    try {
      size = statSync(this.filePath).size;
    } catch (error: unknown) {
      logger.debug('WORKER', 'Failed to stat transcript file', { file: this.filePath }, error instanceof Error ? error : undefined);
      return;
    }

    if (size < this.tailState.offset) {
      this.tailState.offset = 0;
      this.onOffset(this.tailState.offset);
    }

    if (size <= this.tailState.offset) return;

    const startOffset = this.tailState.offset;

    const stream = createReadStream(this.filePath, {
      start: startOffset,
      end: size - 1,
      encoding: 'utf8'
    });

    let data = '';
    for await (const chunk of stream) {
      data += chunk as string;
    }
    if (data.length > 0) {
      this.lastActivityAt = Date.now();
    }

    const lines = data.split('\n');
    const completeLines = lines.slice(0, -1);
    let committedOffset = startOffset;

    for (const line of completeLines) {
      const lineBytes = Buffer.byteLength(`${line}\n`, 'utf8');
      const trimmed = line.trim();
      if (trimmed) {
        await this.onLine(trimmed);
      }
      committedOffset += lineBytes;
      this.tailState.offset = committedOffset;
      this.onOffset(committedOffset);
    }

    if (data.endsWith('\n') || completeLines.length > 0) return;

    const trimmed = data.trim();
    if (trimmed) {
      logger.debug('TRANSCRIPT', 'Leaving partial transcript line uncommitted', {
        file: this.filePath,
        offset: this.tailState.offset,
        bytesRead: Buffer.byteLength(data, 'utf8'),
      });
    }
  }
}

export class TranscriptWatcher {
  private processor = new TranscriptEventProcessor();
  private tailers = new Map<string, FileTailer>();
  private state: TranscriptWatchState;
  private rootWatchers: Array<ReturnType<typeof fsWatch>> = [];
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private config: TranscriptWatchConfig,
    private statePath: string,
    private options: TranscriptWatcherOptions = {}
  ) {
    this.state = loadWatchState(statePath);
  }

  async start(): Promise<void> {
    for (const watch of this.config.watches) {
      await this.setupWatch(watch);
    }
    this.startReconciliationLoop();
  }

  stop(): void {
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
    for (const tailer of this.tailers.values()) {
      tailer.close();
    }
    this.tailers.clear();
    for (const watcher of this.rootWatchers) {
      watcher.close();
    }
    this.rootWatchers = [];
  }

  private startReconciliationLoop(): void {
    const intervalMs = this.options.reconciliationTickMs ?? DEFAULT_RECONCILIATION_TICK_MS;
    if (intervalMs <= 0 || this.reconciliationTimer) return;

    const policy: ReconciliationPolicy = {
      activeReconcileIntervalMs: this.options.activeReconcileIntervalMs ?? DEFAULT_ACTIVE_RECONCILE_INTERVAL_MS,
      idleReconcileIntervalMs: this.options.idleReconcileIntervalMs ?? DEFAULT_IDLE_RECONCILE_INTERVAL_MS,
      activeWindowMs: this.options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS,
    };

    this.reconciliationTimer = setInterval(() => {
      const now = Date.now();
      for (const tailer of this.tailers.values()) {
        tailer.reconcile(now, policy);
      }
    }, intervalMs);
    this.reconciliationTimer.unref?.();
  }

  private async setupWatch(watch: WatchTarget): Promise<void> {
    const schema = this.resolveSchema(watch);
    if (!schema) {
      logger.warn('TRANSCRIPT', 'Missing schema for watch', { watch: watch.name });
      return;
    }

    const resolvedPath = expandHomePath(watch.path);
    const files = this.resolveWatchFiles(resolvedPath);

    for (const filePath of files) {
      await this.addTailer(filePath, watch, schema, true);
    }

    const watchRoot = this.deepestNonGlobAncestor(resolvedPath);
    if (!watchRoot || !existsSync(watchRoot)) {
      logger.debug('TRANSCRIPT', 'Watch root does not exist, skipping fs.watch', { watch: watch.name, watchRoot });
      return;
    }

    try {
      const watcher = fsWatch(watchRoot, { recursive: true, persistent: true }, (event, name) => {
        if (!name) return;
        const changed = resolvePath(watchRoot, name).replace(/\\/g, '/');
        const existingTailer = this.tailers.get(changed);
        if (existingTailer) {
          existingTailer.poke();
          return;
        }
        const matches = this.resolveWatchFiles(resolvedPath);
        for (const filePath of matches) {
          if (!this.tailers.has(filePath)) {
            void this.addTailer(filePath, watch, schema, false);
          }
        }
      });
      this.rootWatchers.push(watcher);
      logger.info('TRANSCRIPT', 'Watching transcript root recursively', { watch: watch.name, watchRoot });
    } catch (error) {
      logger.warn('TRANSCRIPT', 'Failed to start recursive fs.watch on transcript root', {
        watch: watch.name,
        watchRoot,
      }, error instanceof Error ? error : undefined);
    }
  }

  private deepestNonGlobAncestor(inputPath: string): string {
    if (!this.hasGlob(inputPath)) {
      if (existsSync(inputPath)) {
        try {
          const stat = statSync(inputPath);
          return stat.isDirectory() ? inputPath : resolvePath(inputPath, '..');
        } catch {
          return resolvePath(inputPath, '..');
        }
      }
      return inputPath;
    }

    const segments = inputPath.split(/[/\\]/);
    const literalSegments: string[] = [];
    for (const segment of segments) {
      if (/[*?[\]{}()]/.test(segment)) break;
      literalSegments.push(segment);
    }
    if (literalSegments.length === 0) return '';
    if (literalSegments.length === 1 && literalSegments[0] === '') {
      return '';
    }
    return literalSegments.join(pathSep);
  }

  private resolveSchema(watch: WatchTarget): TranscriptSchema | null {
    if (typeof watch.schema === 'string') {
      return this.config.schemas?.[watch.schema] ?? null;
    }
    return watch.schema;
  }

  private resolveWatchFiles(inputPath: string): string[] {
    if (this.hasGlob(inputPath)) {
      return globSync(this.normalizeGlobPattern(inputPath), { nodir: true, absolute: true });
    }

    if (existsSync(inputPath)) {
      try {
        const stat = statSync(inputPath);
        if (stat.isDirectory()) {
          const pattern = join(inputPath, '**', '*.jsonl');
          return globSync(this.normalizeGlobPattern(pattern), { nodir: true, absolute: true });
        }
        return [inputPath];
      } catch (error: unknown) {
        logger.debug('WORKER', 'Failed to stat watch path', { path: inputPath }, error instanceof Error ? error : undefined);
        return [];
      }
    }

    return [];
  }

  private normalizeGlobPattern(inputPath: string): string {
    return inputPath.replace(/\\/g, '/');
  }

  private hasGlob(inputPath: string): boolean {
    return /[*?[\]{}()]/.test(inputPath);
  }

  private async addTailer(
    filePath: string,
    watch: WatchTarget,
    schema: TranscriptSchema,
    initialDiscovery: boolean
  ): Promise<void> {
    if (this.tailers.has(filePath)) return;

    const sessionIdOverride = this.extractSessionIdFromPath(filePath);

    let offset = this.state.offsets[filePath] ?? 0;
    if (offset === 0 && watch.startAtEnd && initialDiscovery) {
      try {
        offset = statSync(filePath).size;
      } catch (error: unknown) {
        logger.debug('WORKER', 'Failed to stat file for startAtEnd offset', { file: filePath }, error instanceof Error ? error : undefined);
        offset = 0;
      }
    }

    const tailer = new FileTailer(
      filePath,
      offset,
      async (line: string) => {
        await this.handleLine(line, watch, schema, filePath, sessionIdOverride);
      },
      (newOffset: number) => {
        this.state.offsets[filePath] = newOffset;
        saveWatchState(this.statePath, this.state);
      }
    );

    tailer.start();
    this.tailers.set(filePath, tailer);
    logger.info('TRANSCRIPT', 'Watching transcript file', {
      file: filePath,
      watch: watch.name,
      schema: schema.name
    });
  }

  private async handleLine(
    line: string,
    watch: WatchTarget,
    schema: TranscriptSchema,
    filePath: string,
    sessionIdOverride?: string | null
  ): Promise<void> {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.debug('TRANSCRIPT', 'Failed to parse transcript line', {
          watch: watch.name,
          file: basename(filePath)
        }, error);
      } else {
        logger.warn('TRANSCRIPT', 'Failed to parse transcript line (non-Error thrown)', {
          watch: watch.name,
          file: basename(filePath),
          error: String(error)
        });
      }
      return;
    }

    try {
      await this.processor.processEntry(entry, watch, schema, sessionIdOverride ?? undefined);
    } catch (error: unknown) {
      logger.warn('TRANSCRIPT', 'Failed to process transcript line; offset not committed', {
        watch: watch.name,
        file: basename(filePath),
      }, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private extractSessionIdFromPath(filePath: string): string | null {
    const match = filePath.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? match[0] : null;
  }
}
