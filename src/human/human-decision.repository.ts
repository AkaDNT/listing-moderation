import { Database } from '../db/database';
import { ListingDto, ListingRow, mapListing } from '../listings/listing.mapper';
import { stringifyJson } from '../http/json-codec';
import { HumanDecisionRequest, mapHumanDecision } from './human-decision.pipe';

export type HumanDecisionResult = { kind: 'applied'; listing: ListingDto } | { kind: 'missing' } | { kind: 'conflict' };

export class HumanDecisionRepository {
  constructor(private readonly database: Database) {}

  async resolve(listingId: string, request: HumanDecisionRequest, ttlDays: number): Promise<HumanDecisionResult> {
    return this.database.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL statement_timeout='10s'");
      await client.query("SET LOCAL lock_timeout='5s'");

      const locked = await client.query<ListingRow & { published_at: Date | null; expires_at: Date | null }>(
        `SELECT id,seller_id,category_id,title,description,price_vnd::text AS price_vnd,status,
           decision::text AS decision_json,decided_at,created_at,published_at,expires_at
         FROM listings WHERE id=$1 FOR UPDATE`, [listingId]);
      if (locked.rowCount !== 1) return { kind: 'missing' };
      const before = locked.rows[0];
      if (before.status !== 'needs_human') return { kind: 'conflict' };

      const persisted = mapListing(before);
      if ((persisted.decision as { outcome?: unknown }).outcome !== 'escalated' ||
          before.published_at !== null || before.expires_at !== null) {
        throw new Error('T09 needs_human listing has inconsistent persisted decision or publication timestamps');
      }

      const human = mapHumanDecision(request.decision);
      const status = request.decision === 'approve' ? 'published' : 'rejected';
      const updated = await client.query<ListingRow>(
        `WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at)
         UPDATE listings AS l
         SET status=$2,decision=$3::jsonb,decided_at=moment.at,
             published_at=CASE WHEN $2='published' THEN moment.at ELSE NULL END,
             expires_at=CASE WHEN $2='published'
               THEN moment.at+($4::double precision * interval '24 hours') ELSE NULL END,
             version=l.version+1
         FROM moment
         WHERE l.id=$1 AND l.status='needs_human'
         RETURNING l.id,l.seller_id,l.category_id,l.title,l.description,l.price_vnd::text AS price_vnd,
           l.status,l.decision::text AS decision_json,l.decided_at,l.created_at`,
        [listingId, status, stringifyJson({ outcome: human.outcome, reasons: [human.reason] }), ttlDays]);
      if (updated.rowCount !== 1) throw new Error('T09 human decision lost its locked listing state guard');
      const listing = mapListing(updated.rows[0]);
      if (listing.status !== status || listing.decided_at === null || !listing.decision ||
          (listing.decision as { outcome?: unknown }).outcome !== human.outcome) {
        throw new Error('T09 persisted human decision does not match its requested action');
      }

      const history = await client.query(
        `INSERT INTO moderation_history(listing_id,phase,decision,moderator_id,note,decided_at)
         SELECT id,'human',decision,$2,$3,decided_at FROM listings WHERE id=$1 RETURNING id`,
        [listingId, request.moderatorId, request.note]);
      if (history.rowCount !== 1) throw new Error('T09 human history insert did not insert exactly one row');
      return { kind: 'applied', listing };
    });
  }
}
