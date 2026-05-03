
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

    // Setup cleanup on disconnect
    res.on('close', () => {
      this.removeClient(res);
    });

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

    // Single-pass write with error handling
    const deadClients: SSEClient[] = [];
    for (const client of this.sseClients) {
      try {
        client.write(data);
      } catch {
        // Client disconnected, mark for removal
        deadClients.push(client);
      }
    }

    // Remove dead clients
    for (const client of deadClients) {
      this.sseClients.delete(client);
      logger.debug('WORKER', 'Removed dead SSE client', { remaining: this.sseClients.size });
    }
  }

  getClientCount(): number {
    return this.sseClients.size;
  }

  private sendToClient(res: Response, event: SSEEvent): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    res.write(data);
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
          try {
            client.write(heartbeat);
          } catch {
            // Client might be disconnected, will be cleaned up on next event
          }
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
