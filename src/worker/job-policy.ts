export const MAX_JOB_CLAIMS = 5;

export function retryDelayMs(attempt: number, random: number): number {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_JOB_CLAIMS) {
    throw new RangeError('attempt must be between 1 and MAX_JOB_CLAIMS');
  }
  if (!Number.isFinite(random) || random < 0 || random > 1) throw new RangeError('random must be in [0, 1]');
  const ceilingMs = Math.min(30_000, 1000 * (2 ** (attempt - 1)));
  return Math.floor(random * ceilingMs);
}

export function sanitizeWorkerError(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unexpected_error:unknown';
  const record = error as { code?: unknown; name?: unknown };
  if (typeof record.code === 'string' && /^[0-9A-Z]{5}$/.test(record.code)) {
    return `database_error:${record.code}`;
  }
  const name = typeof record.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(record.name)
    ? record.name
    : 'unknown';
  return `unexpected_error:${name}`;
}
