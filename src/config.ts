export interface RuntimeConfig {
  port: number;
  databaseUrl: string;
  pollIntervalMs: number;
  listingTtlDays: number;
}

// Node timers turn delays above the signed 32-bit maximum into a 1ms timeout.
export const MAX_POLL_INTERVAL_MS = 2_147_483_647;

export function loadConfig(_env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const env = _env;
  const integer = (name: string, value: string | undefined, fallback?: number): number => {
    if (value === undefined && fallback !== undefined) return fallback;
    if (value === undefined || !/^[0-9]+$/.test(value)) throw new Error(`${name} must be a positive decimal integer`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive safe integer`);
    return parsed;
  };
  const port = integer('PORT', env.PORT, 8080);
  if (port > 65535) throw new Error('PORT must be between 1 and 65535');
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  let parsedUrl: URL;
  try { parsedUrl = new URL(databaseUrl); } catch { throw new Error('DATABASE_URL must be a valid PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(parsedUrl.protocol) || !parsedUrl.hostname || !parsedUrl.pathname.slice(1)) {
    throw new Error('DATABASE_URL must use PostgreSQL protocol and include host and database');
  }
  const pollIntervalMs = integer('POLL_INTERVAL_MS', env.POLL_INTERVAL_MS, 1000);
  if (pollIntervalMs > MAX_POLL_INTERVAL_MS) {
    throw new Error(`POLL_INTERVAL_MS must be between 1 and ${MAX_POLL_INTERVAL_MS}`);
  }
  return {
    port,
    databaseUrl,
    pollIntervalMs,
    listingTtlDays: integer('LISTING_TTL_DAYS', env.LISTING_TTL_DAYS),
  };
}
