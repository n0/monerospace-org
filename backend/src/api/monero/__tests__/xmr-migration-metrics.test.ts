import express from 'express';
import { createServer, request, Server } from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MigrationMetrics, mountMigrationMetrics } from '../xmr-migration-metrics';

describe('anonymous migration counters', () => {
  let directory: string;
  let server: Server;
  const origin = 'https://monerospace.org';
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'migration-metrics-'));
    const app = express();
    mountMigrationMetrics(app, origin, new MigrationMetrics(directory));
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  function post(body: unknown, headers: Record<string, string> = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1', port: (server.address() as AddressInfo).port,
        path: '/api/v1/migration-events', method: 'POST',
        headers: { Host: 'monerospace.org', Origin: origin, 'Content-Type': 'application/json', ...headers },
      }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  }
  function stored(): any { return JSON.parse(readFileSync(join(directory, 'migration-events.json'), 'utf8')); }

  it('accepts only anonymous known events and never persists extra payload or headers', async () => {
    expect(await post({ event: 'arrival' }, { 'X-Forwarded-For': '203.0.113.9', Referer: origin + '/tx/private-lookup' })).toBe(204);
    expect(await post({ event: 'arrival', txid: 'private-lookup' })).toBe(400);
    expect(await post({ event: 'private-lookup' })).toBe(400);
    expect(await post({ event: 'arrival', padding: 'x'.repeat(200) })).toBe(413);
    expect(await post({ event: 'arrival' }, { Origin: 'https://evil.example' })).toBe(403);
    expect(await post({ event: 'arrival' }, { Host: 'xmr.tx.taxi' })).toBe(403);
    expect(await post({ event: 'arrival' }, { 'Sec-Fetch-Site': 'cross-site' })).toBe(403);
    expect(await post({ event: 'arrival' }, { DNT: '1' })).toBe(204);
    expect(await post({ event: 'arrival' }, { 'Sec-GPC': '1' })).toBe(204);
    expect(stored()).toEqual({ version: 1, days: { [new Date().toISOString().slice(0, 10)]: { arrival: 1 } } });
  });

  it('persists across restart and removes old or unknown persisted fields', () => {
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(directory, 'migration-events.json'), JSON.stringify({
      version: 1, visitor: 'discard', days: {
        '2000-01-01': { arrival: 99 }, [today]: { arrival: 2, txid: 'discard' },
      },
    }));
    expect(new MigrationMetrics(directory).record('arrival')).toBe(204);
    expect(new MigrationMetrics(directory).record('default_enabled')).toBe(204);
    expect(stored()).toEqual({ version: 1, days: { [today]: { arrival: 3, default_enabled: 1 } } });
  });

  it('bounds the global write budget and opens a new minute without identity tracking', () => {
    const metrics = new MigrationMetrics(directory);
    const now = Date.now();
    for (let i = 0; i < 120; i++) { expect(metrics.record('try_click', now)).toBe(204); }
    expect(metrics.record('arrival', now)).toBe(429);
    expect(metrics.record('arrival', now + 60000)).toBe(204);
    expect(stored().days[new Date(now).toISOString().slice(0, 10)].try_click).toBe(120);
  });
});
