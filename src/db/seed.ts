import { PoolClient } from 'pg';
import { SeedData } from './assets';

export async function upsertSeeds(client: PoolClient, seeds: SeedData): Promise<void> {
  for (const seller of seeds.sellers) {
    await client.query(
      `INSERT INTO sellers(id,name,trust_score,verified,note) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, trust_score=EXCLUDED.trust_score,
         verified=EXCLUDED.verified, note=EXCLUDED.note`,
      [seller.id, seller.name, seller.trust_score, seller.verified, seller.note],
    );
  }
  for (const category of seeds.categories) {
    await client.query(
      `INSERT INTO categories(id,name,median_price_vnd) VALUES($1,$2,$3)
       ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, median_price_vnd=EXCLUDED.median_price_vnd`,
      [category.id, category.name, String(category.median_price_vnd)],
    );
  }
  for (const term of seeds.banned_keywords) {
    await client.query('INSERT INTO banned_keywords(term) VALUES($1) ON CONFLICT(term) DO NOTHING', [term]);
  }
}
