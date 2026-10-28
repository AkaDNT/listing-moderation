import { randomUUID } from 'node:crypto';
import { Database } from '../db/database';
import {
  IdempotencyConflictError,
  ListingStatus,
  SubmissionFields,
  SubmissionIdentity,
  SubmissionResult,
  UnknownReferenceError,
} from './submission.types';

export class SubmissionRepository {
  constructor(private readonly database: Database) {}

  async submit(fields: SubmissionFields, identity?: SubmissionIdentity): Promise<SubmissionResult> {
    if (identity) {
      const existing = await this.findByKey(identity.key);
      if (existing) return this.resolveReplay(existing, identity);
    }

    const listingId = randomUUID();
    const jobId = randomUUID();

    try {
      return await this.database.transaction(async client => {
        const seller = await client.query<{ id: string }>(
          'SELECT id FROM sellers WHERE id = $1 FOR KEY SHARE',
          [fields.sellerId],
        );
        if (seller.rowCount !== 1) throw new UnknownReferenceError('seller');

        const category = await client.query<{ id: string }>(
          'SELECT id FROM categories WHERE id = $1 FOR KEY SHARE',
          [fields.categoryId],
        );
        if (category.rowCount !== 1) throw new UnknownReferenceError('category');

        await client.query(
          `INSERT INTO listings(id, seller_id, category_id, title, description, price_vnd)
           VALUES ($1, $2, $3, $4, $5, $6::bigint)`,
          [listingId, fields.sellerId, fields.categoryId, fields.title, fields.description, fields.priceVnd.toString()],
        );

        await client.query(
          'INSERT INTO moderation_jobs(id, listing_id) VALUES ($1, $2)',
          [jobId, listingId],
        );

        if (identity) {
          await client.query(
            'INSERT INTO submission_keys(key, request_hash, listing_id) VALUES ($1, $2, $3)',
            [identity.key, identity.requestHash, listingId],
          );
        }

        return { kind: 'created', id: listingId, status: 'pending' };
      });
    } catch (error) {
      if (!identity || !this.isSubmissionKeyConflict(error)) throw error;

      // The failed transaction has rolled back; read the committed winner in a fresh statement.
      const winner = await this.findByKey(identity.key);
      if (!winner) throw error;
      return this.resolveReplay(winner, identity);
    }
  }

  private async findByKey(key: string): Promise<{ requestHash: string; id: string; status: ListingStatus } | undefined> {
    const result = await this.database.query<{
      request_hash: string;
      id: string;
      status: ListingStatus;
    }>(
      `SELECT k.request_hash, l.id, l.status
       FROM submission_keys k
       JOIN listings l ON l.id = k.listing_id
       WHERE k.key = $1`,
      [key],
    );
    const row = result.rows[0];
    return row ? { requestHash: row.request_hash, id: row.id, status: row.status } : undefined;
  }

  private resolveReplay(
    existing: { requestHash: string; id: string; status: ListingStatus },
    identity: SubmissionIdentity,
  ): SubmissionResult {
    if (existing.requestHash !== identity.requestHash) throw new IdempotencyConflictError();
    return { kind: 'replayed', id: existing.id, status: existing.status };
  }

  private isSubmissionKeyConflict(error: unknown): boolean {
    return typeof error === 'object' && error !== null &&
      'code' in error && error.code === '23505' &&
      'constraint' in error && error.constraint === 'submission_keys_pkey';
  }
}
