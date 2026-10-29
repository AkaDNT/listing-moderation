import { Database } from '../db/database';
import { ListingDto, ListingRow, mapListing } from '../listings/listing.mapper';

export type PublicationResult = { kind: 'published'; listing: ListingDto } | { kind: 'idle' };

export class PublicationFailure extends Error {
  readonly code?: string;
  constructor(readonly listingId: string, cause: unknown) {
    super('Publication failed after selecting a listing', { cause });
    this.name = 'PublicationFailure';
    const code = (cause as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) this.code = code;
  }
}

export class PublicationRepository {
  constructor(private readonly database: Database, private readonly ttlDays: number) {}

  async publishNext(): Promise<PublicationResult> {
    let selectedListingId: string | undefined;
    try {
      return await this.database.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL statement_timeout='10s'");
      await client.query("SET LOCAL lock_timeout='5s'");

      const selected = await client.query<ListingRow & { published_at: Date | null; expires_at: Date | null }>(
        `SELECT id,seller_id,category_id,title,description,price_vnd::text AS price_vnd,status,
           decision::text AS decision_json,decided_at,created_at,published_at,expires_at
         FROM listings WHERE status='auto_approved'
         ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`);
      if (selected.rowCount === 0) return { kind: 'idle' };
      const before = selected.rows[0];
      if (typeof before.id === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(before.id)) {
        selectedListingId = before.id;
      }
      const current = mapListing(before);
      selectedListingId = current.id;
      if ((current.decision as { outcome?: unknown }).outcome !== 'approved' ||
          before.published_at !== null || before.expires_at !== null) {
        throw new Error('T09 auto_approved listing has inconsistent decision or publication timestamps');
      }

      const updated = await client.query<ListingRow>(
        `WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at)
         UPDATE listings AS l
         SET status='published',published_at=moment.at,
             expires_at=moment.at+($2::double precision * interval '24 hours'),version=l.version+1
         FROM moment
         WHERE l.id=$1 AND l.status='auto_approved'
         RETURNING l.id,l.seller_id,l.category_id,l.title,l.description,l.price_vnd::text AS price_vnd,
           l.status,l.decision::text AS decision_json,l.decided_at,l.created_at`, [current.id, this.ttlDays]);
      if (updated.rowCount !== 1) throw new Error('T09 publication lost its locked auto_approved state guard');
      const listing = mapListing(updated.rows[0]);
      if (listing.status !== 'published' || listing.decided_at !== current.decided_at ||
          JSON.stringify(listing.decision) !== JSON.stringify(current.decision)) {
        throw new Error('T09 publication changed the committed moderation decision');
      }
      return { kind: 'published', listing };
      });
    } catch (error) {
      if (selectedListingId) throw new PublicationFailure(selectedListingId, error);
      throw error;
    }
  }
}
