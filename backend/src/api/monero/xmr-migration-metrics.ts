import express, { Application, ErrorRequestHandler } from 'express';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const MIGRATION_EVENTS = [
  'announcement_view', 'try_click', 'arrival', 'default_enabled',
  'default_disabled', 'return_visit', 'auto_forward',
] as const;
type MigrationEvent = typeof MIGRATION_EVENTS[number];
type DailyCounts = Record<string, Partial<Record<MigrationEvent, number>>>;
const DAY_MS = 86400000;

/** Anonymous daily event totals. Never receives or retains URLs, IDs or headers. */
export class MigrationMetrics {
  private days: DailyCounts = {};
  private windowStart = 0;
  private windowCount = 0;
  private readonly file: string;

  constructor(directory = process.env.XMR_MIGRATION_METRICS_DIR ||
    (process.env.NODE_ENV === 'production' ? '/data/migration' : join(homedir(), '.xmr-space', 'migration'))) {
    this.file = join(directory, 'migration-events.json');
    try {
      if (statSync(this.file).size > 65536) { return; }
      const stored = JSON.parse(readFileSync(this.file, 'utf8'));
      if (stored.version !== 1 || !stored.days || typeof stored.days !== 'object') { return; }
      // Reconstruct only known counters: never propagate arbitrary persisted fields.
      for (const [day, counts] of Object.entries(stored.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !counts || typeof counts !== 'object') { continue; }
        const clean: Partial<Record<MigrationEvent, number>> = {};
        for (const event of MIGRATION_EVENTS) {
          const count = counts[event];
          if (Number.isSafeInteger(count) && count >= 0) { clean[event] = count; }
        }
        this.days[day] = clean;
      }
      this.prune(Date.now());
    } catch { /* First boot or invalid file starts with no imported counters. */ }
  }

  private prune(now: number): void {
    const oldest = new Date(now - 89 * DAY_MS).toISOString().slice(0, 10);
    const today = new Date(now).toISOString().slice(0, 10);
    for (const day of Object.keys(this.days)) {
      if (day < oldest || day > today) { delete this.days[day]; }
    }
  }

  record(event: MigrationEvent, now = Date.now()): number {
    if (now - this.windowStart >= 60000) { this.windowStart = now; this.windowCount = 0; }
    if (this.windowCount >= 120) { return 429; }
    this.windowCount++;
    this.prune(now);
    const day = new Date(now).toISOString().slice(0, 10);
    const previous = this.days[day]?.[event] || 0;
    this.days[day] = { ...this.days[day], [event]: previous + 1 };
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, days: this.days }) + '\n', { mode: 0o600 });
      renameSync(this.file + '.tmp', this.file);
      return 204;
    } catch {
      this.days[day][event] = previous;
      return 503;
    }
  }
}

export function mountMigrationMetrics(app: Application, siteOrigin: string, metrics = new MigrationMetrics()): void {
  const allowed = new Set([siteOrigin]);
  if (process.env.NODE_ENV !== 'production') {
    for (const value of (process.env.XMR_MIGRATION_LOCAL_ORIGINS || '').split(',')) {
      try {
        const url = new URL(value.trim());
        if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol)) {
          allowed.add(url.origin);
        }
      } catch { /* No implicit development origins. */ }
    }
  }
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    if (req.path !== '/') { res.sendStatus(404); return; }
    if (req.method !== 'POST') { res.sendStatus(405); return; }
    const origin = req.get('Origin');
    if (!origin || !allowed.has(origin) || new URL(origin).host !== req.get('Host') ||
        (req.get('Sec-Fetch-Site') && req.get('Sec-Fetch-Site') !== 'same-origin')) {
      res.sendStatus(403); return;
    }
    if (req.get('DNT') === '1' || req.get('Sec-GPC') === '1') { res.sendStatus(204); return; }
    if (!req.is('application/json')) { res.sendStatus(415); return; }
    next();
  });
  router.use(express.json({ limit: 128, strict: true, inflate: false }));
  router.use((req, res) => {
    const body = req.body;
    if (!body || Array.isArray(body) || Object.keys(body).length !== 1 ||
        !Object.prototype.hasOwnProperty.call(body, 'event') || !MIGRATION_EVENTS.includes(body.event)) {
      res.sendStatus(400); return;
    }
    res.sendStatus(metrics.record(body.event));
  });
  const rejectInvalidBody: ErrorRequestHandler = (error, _req, res, _next) => {
    res.sendStatus(error.status === 413 ? 413 : error.status === 415 ? 415 : 400);
  };
  router.use(rejectInvalidBody);
  app.use('/api/v1/migration-events', router);
}
