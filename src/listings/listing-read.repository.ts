import { Database } from '../db/database';
import { ListingRow } from './listing.mapper';
import { ParsedListingQuery } from './listing-query';

export class ListingReadRepository {
  constructor(private readonly database: Database) {}

  async findById(id: string): Promise<ListingRow | undefined> {
    const result = await this.database.query<ListingRow>(
      `SELECT id, seller_id, category_id, title, description, price_vnd::text AS price_vnd,
              status, decision::text AS decision_json, decided_at, created_at
       FROM listings WHERE id = $1`,
      [id],
    );
    return result.rows[0];
  }

  async list(query: ParsedListingQuery): Promise<ListingRow[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.sellerId !== undefined) {
      values.push(query.sellerId);
      conditions.push(`seller_id = $${values.length}`);
    }
    if (query.status !== undefined) {
      values.push(query.status);
      conditions.push(`status = $${values.length}`);
    }
    values.push(query.limit);

    const result = await this.database.query<ListingRow>(
      `SELECT id, seller_id, category_id, title, description, price_vnd::text AS price_vnd,
              status, decision::text AS decision_json, decided_at, created_at
       FROM listings${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length}`,
      values,
    );
    return result.rows;
  }
}
