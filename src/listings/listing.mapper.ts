import { isLosslessNumber } from 'lossless-json';
import { parseJson } from '../http/json-codec';

const MAX_INT64 = 9223372036854775807n;
const STATUSES = new Set([
  'pending', 'auto_approved', 'auto_rejected', 'needs_human', 'published', 'rejected', 'expired',
]);
const OUTCOMES = new Set(['approved', 'rejected', 'escalated']);

export interface ListingRow {
  id: unknown;
  seller_id: unknown;
  category_id: unknown;
  title: unknown;
  description: unknown;
  price_vnd: unknown;
  status: unknown;
  decision_json: unknown;
  decided_at: unknown;
  created_at: unknown;
}

export interface ListingDto {
  id: string;
  seller_id: string;
  title: string;
  description: string;
  price_vnd: bigint;
  category_id: string;
  status: string;
  created_at: string;
  decided_at: string | null;
  decision: unknown;
}

function fail(message: string): never { throw new TypeError('Invalid persisted listing: ' + message); }

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') return fail(field + ' must be a string');
  return value;
}

function isoDate(value: unknown, field: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return fail(field + ' must be a valid timestamp');
  return value.toISOString();
}

function parsePrice(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return fail('price_vnd must be a decimal integer string');
  const price = BigInt(value);
  if (price > MAX_INT64) return fail('price_vnd exceeds int64');
  return price;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertJsonValue(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || isLosslessNumber(value)) return;
  if (Array.isArray(value)) { for (const item of value) assertJsonValue(item); return; }
  if (isJsonObject(value)) { for (const item of Object.values(value)) assertJsonValue(item); return; }
  fail('decision contains a non-JSON value');
}

function parseDecision(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return fail('decision must be selected as JSON text');
  const decision = parseJson(value);
  if (!isJsonObject(decision) || typeof decision.outcome !== 'string' || !OUTCOMES.has(decision.outcome) ||
      !Array.isArray(decision.reasons)) return fail('decision has an invalid shape');
  for (const reason of decision.reasons) {
    if (!isJsonObject(reason) || typeof reason.rule_id !== 'string' || typeof reason.message !== 'string' ||
        (reason.detail !== undefined && !isJsonObject(reason.detail))) return fail('decision reason has an invalid shape');
    assertJsonValue(reason);
  }
  assertJsonValue(decision);
  return decision;
}

export function mapListing(row: ListingRow): ListingDto {
  const id = requiredString(row.id, 'id');
  const sellerId = requiredString(row.seller_id, 'seller_id');
  const categoryId = requiredString(row.category_id, 'category_id');
  const title = requiredString(row.title, 'title');
  const description = requiredString(row.description, 'description');
  const price = parsePrice(row.price_vnd);
  const status = requiredString(row.status, 'status');
  if (!STATUSES.has(status)) return fail('status is not supported');
  const createdAt = isoDate(row.created_at, 'created_at');

  let decision: Record<string, unknown> | null;
  let decidedAt: string | null;
  if (status === 'pending') {
    if (row.decision_json !== null || row.decided_at !== null) return fail('pending row must not have a decision');
    decision = null;
    decidedAt = null;
  } else {
    if (row.decision_json === null || row.decided_at === null) return fail('completed row must have a decision and timestamp');
    decision = parseDecision(row.decision_json);
    decidedAt = isoDate(row.decided_at, 'decided_at');
  }

  return {
    id, seller_id: sellerId, title, description, price_vnd: price, category_id: categoryId,
    status, created_at: createdAt, decided_at: decidedAt, decision,
  };
}
