
import type { Response } from 'express';
import { logger } from '../../utils/logger.js';
import type { SSEEvent, SSEClient } from '../worker-types.js';

export class SSEBroadcaster {
  private sseClients: Set<SSEClient> = new Set();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private static readonly HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds

  addClient(res: Response): void {
    this.sseClients.add(res);
    logger.debug('WORKER', 'Client connected', { total: this.sseClients.size });

    // Start heartbeat if this is the first client
    if (this.sseClients.size === 1) {
      this.startHeartbeat();
    }

    const socket = res.socket;
    const onClose = () => {
      res.off('close', onClose);
      res.off('error', onError);
      socket?.off('close', onClose);
      this.removeClient(res);
    };
    // Response errors are asynchronous and cannot be caught around write().
    // Keep the listener until close so pending failed writes remain handled.
    const onError = () => this.disconnectFailedClient(res);
    res.on('error', onError);
    res.on('close', onClose);
    // Bun's node:http emits socket close when a streaming client disconnects.
    socket?.on('close', onClose);

    this.sendToClient(res, { type: 'connected', timestamp: Date.now() });
  }

  removeClient(res: Response): void {
    this.sseClients.delete(res);
    logger.debug('WORKER', 'Client disconnected', { total: this.sseClients.size });

    // Stop heartbeat if no clients remain
    if (this.sseClients.size === 0) {
      this.stopHeartbeat();
    }
  }

  broadcast(event: SSEEvent): void {
    if (this.sseClients.size === 0) {
      logger.debug('WORKER', 'SSE broadcast skipped (no clients)', { eventType: event.type });
      return; 
    }

    const eventWithTimestamp = { ...event, timestamp: Date.now() };
    const data = `data: ${JSON.stringify(eventWithTimestamp)}\n\n`;

    logger.debug('WORKER', 'SSE broadcast sent', { eventType: event.type, clients: this.sseClients.size });

    for (const client of this.sseClients) {
      this.writeFrame(client, data);
    }
  }

  getClientCount(): number {
    return this.sseClients.size;
  }

  private writeFrame(res: Response, data: string): void {
    if (res.destroyed || res.writableEnded) {
      this.removeClient(res);
      return;
    }
    try {
      res.write(data);
    } catch (error) {
      this.disconnectFailedClient(res);
      logger.debug('WORKER', 'SSE client write failed', undefined, error instanceof Error ? error : undefined);
    }
  }

  private disconnectFailedClient(res: Response): void {
    this.removeClient(res);
    // A failed stream must close so EventSource can reconnect. Retain the
    // error listener until close to absorb already queued transport failures.
    if (!res.destroyed) res.destroy();
  }

  private sendToClient(res: Response, event: SSEEvent): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    this.writeFrame(res, data);
  }

  /**
   * Start sending periodic heartbeats to keep connections alive
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      return; // Already running
    }

    this.heartbeatInterval = setInterval(() => {
      if (this.sseClients.size > 0) {
        // Send SSE comment as heartbeat (browsers ignore comments but connection stays alive)
        const heartbeat = `: heartbeat ${Date.now()}\n\n`;
        for (const client of this.sseClients) {
          this.writeFrame(client, heartbeat);
        }
      }
    }, SSEBroadcaster.HEARTBEAT_INTERVAL_MS);

    logger.debug('WORKER', 'SSE heartbeat started', { intervalMs: SSEBroadcaster.HEARTBEAT_INTERVAL_MS });
  }

  /**
   * Stop the heartbeat interval
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      logger.debug('WORKER', 'SSE heartbeat stopped');
    }
  }
}
