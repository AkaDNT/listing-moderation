import { Database } from '../db/database';
import { CategoryReference, ModerationReferences, SellerReference } from './moderation.types';

interface ReferenceRow {
  seller_id: unknown;
  trust_score: unknown;
  verified: unknown;
  category_id: unknown;
  median_price_vnd: unknown;
  banned_keywords: unknown;
}

export class ReferenceDataRepository {
  constructor(private readonly database: Database) {}

  async load(sellerId: string, categoryId: string): Promise<ModerationReferences | undefined> {
    const result = await this.database.query<ReferenceRow>(
      `SELECT s.id AS seller_id, s.trust_score, s.verified,
              c.id AS category_id, c.median_price_vnd::text AS median_price_vnd,
              ARRAY(SELECT term FROM banned_keywords ORDER BY term COLLATE "C") AS banned_keywords
       FROM sellers s CROSS JOIN categories c
       WHERE s.id = $1 AND c.id = $2`,
      [sellerId, categoryId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.seller_id !== sellerId || row.category_id !== categoryId ||
        !Number.isInteger(row.trust_score) || (row.trust_score as number) < 0 || (row.trust_score as number) > 100 ||
        typeof row.verified !== 'boolean' || typeof row.median_price_vnd !== 'string' ||
        !/^[1-9][0-9]*$/.test(row.median_price_vnd) || !Array.isArray(row.banned_keywords) ||
        row.banned_keywords.length === 0 || row.banned_keywords.some(term => typeof term !== 'string' || term.length === 0)) {
      throw new TypeError('Persisted moderation reference data is invalid');
    }

    const medianPriceVnd = BigInt(row.median_price_vnd);
    if (medianPriceVnd > 9223372036854775807n) {
      throw new TypeError('Persisted moderation category median exceeds int64');
    }
    const category: CategoryReference = {
      id: categoryId,
      medianPriceVnd,
    };
    const seller: SellerReference = {
      id: sellerId,
      trustScore: row.trust_score as number,
      verified: row.verified,
    };
    return { seller, category, bannedKeywords: row.banned_keywords as string[] };
  }
}
