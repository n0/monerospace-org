import { Application, Request, Response } from 'express';
import { IMoneroApi } from './monero-api.interface';
import { MoneroEventBus } from './monero-event-bus';

/**
 * Server-Sent Events stream for new blocks and mempool deltas.
 *
 * Why SSE over WebSocket: this stream is one-way (server → client), text-only,
 * recovers automatically on disconnect, and survives proxies that mangle WS
 * upgrades. WebSocket would let us receive client subscriptions (e.g. "only
 * stream tx detail for hash X") but we don't have a use case yet.
 *
 * On connect we emit a `snapshot` event with the current info + mempool
 * hashes so the client can render before the next 3s poll. Subsequent
 * events: `block` (new tip) and `mempool-delta` ({ added, removed }).
 *
 * Heartbeats: every 25s we send a comment frame (`:heartbeat`) so any
 * proxy/load-balancer with a 30s idle timeout doesn't drop us.
 */
export class MoneroSseRoutes {
  constructor(private bus: MoneroEventBus, private prefix = '/api/v1/') {}

  public initRoutes(app: Application): void {
    app.get(this.prefix + 'events', (req, res) => this.stream(req, res));
  }

  private stream(req: Request, res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disables nginx buffering
    res.flushHeaders();

    const send = (event: string, payload: unknown): void => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // Initial snapshot so the client renders before the first poll lands.
    send('snapshot', this.bus.snapshot());

    const onBlock = (header: IMoneroApi.BlockHeader): void => send('block', header);
    const onDelta = (d: { added: string[]; removed: string[] }): void => send('mempool-delta', d);

    this.bus.on('block', onBlock);
    this.bus.on('mempool-delta', onDelta);

    const heartbeat = setInterval(() => {
      // SSE comment frame; not delivered to onmessage but keeps the
      // socket alive across nginx/cloudflare idle timeouts.
      res.write(`:heartbeat ${Date.now()}\n\n`);
    }, 25_000);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      this.bus.off('block', onBlock);
      this.bus.off('mempool-delta', onDelta);
    };

    req.on('close', cleanup);
    req.on('aborted', cleanup);
  }
}
