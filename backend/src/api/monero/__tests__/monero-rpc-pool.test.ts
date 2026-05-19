import { AddressInfo } from 'net';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { MoneroRpcPool } from '../monero-rpc';

type RpcBody = { method?: string; params?: Record<string, unknown> };
type RpcHandler = (path: string, body: RpcBody) => { status?: number; body: unknown };

async function makeRpcServer(handler: RpcHandler): Promise<{
  url: string;
  calls: RpcBody[];
  close: () => Promise<void>;
}> {
  const calls: RpcBody[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) as RpcBody : {};
      calls.push(body);
      const result = handler(req.url ?? '/', body);
      res.statusCode = result.status ?? 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}

describe('MoneroRpcPool', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('uses fallback while the primary daemon is still syncing', async () => {
    const primary = await makeRpcServer((_path, body) => {
      if (body.method === 'get_info') {
        return {
          body: {
            result: {
              status: 'OK',
              height: 100,
              target_height: 1_000,
              synchronized: false,
              top_block_hash: '00',
            },
          },
        };
      }
      return { status: 500, body: { error: 'primary should not serve data while syncing' } };
    });
    const fallback = await makeRpcServer((_path, body) => ({
      body: { result: { count: body.method === 'get_block_count' ? 1_000 : 0, status: 'OK' } },
    }));

    try {
      const pool = new MoneroRpcPool({
        rpcUrl: primary.url,
        fallbackRpcUrls: [fallback.url],
        timeoutMs: 500,
        requirePrimarySync: true,
        primaryHealthCheckIntervalMs: 1_000,
      });

      const count = await pool.jsonRpc<{ count: number }>('get_block_count');

      expect(count.count).toBe(1_000);
      expect(primary.calls.map((call) => call.method)).toEqual(['get_info']);
      expect(fallback.calls.map((call) => call.method)).toEqual(['get_block_count']);
    } finally {
      await primary.close();
      await fallback.close();
    }
  });

  it('falls back when the synced primary fails a read', async () => {
    const primary = await makeRpcServer((_path, body) => {
      if (body.method === 'get_info') {
        return {
          body: {
            result: {
              status: 'OK',
              height: 1_000,
              target_height: 1_000,
              synchronized: true,
              top_block_hash: '00',
            },
          },
        };
      }
      return { status: 502, body: { error: 'temporary primary failure' } };
    });
    const fallback = await makeRpcServer(() => ({
      body: { result: { count: 1_000, status: 'OK' } },
    }));

    try {
      const pool = new MoneroRpcPool({
        rpcUrl: primary.url,
        fallbackRpcUrls: [fallback.url],
        timeoutMs: 500,
        requirePrimarySync: true,
        primaryHealthCheckIntervalMs: 1_000,
      });

      const count = await pool.jsonRpc<{ count: number }>('get_block_count');

      expect(count.count).toBe(1_000);
      expect(primary.calls[0].method).toBe('get_info');
      expect(primary.calls.filter((call) => call.method === 'get_block_count')).toHaveLength(3);
      expect(fallback.calls.map((call) => call.method)).toEqual(['get_block_count']);
    } finally {
      await primary.close();
      await fallback.close();
    }
  });
});
