import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parseJson, stringifyJson } from '../src/http/json-codec';

interface PolicyModule {
  screenModeration?: (listing: unknown, references: unknown) => any;
  finalizeNormalModeration?: (screening: unknown, duplicate: unknown) => any;
}

function loadPolicy(): PolicyModule {
  try { return require('../src/moderation/moderation-policy') as PolicyModule; }
  catch { return {}; }
}

const policy = loadPolicy();
const categories = JSON.parse(readFileSync(resolve(__dirname, '../../seed/categories.json'), 'utf8')) as Array<{
  id: string; median_price_vnd: number;
}>;
const sellers = JSON.parse(readFileSync(resolve(__dirname, '../../seed/sellers.json'), 'utf8')) as Array<{
  id: string; trust_score: number; verified: boolean;
}>;
const keywords = JSON.parse(readFileSync(resolve(__dirname, '../../seed/banned_keywords.json'), 'utf8')) as string[];

function input(overrides: Record<string, unknown> = {}) {
  return {
    sellerId: 's-1007', title: 'Used device', description: '', priceVnd: 6000000n, categoryId: 'c-phones',
    ...overrides,
  };
}

function refs(sellerId = 's-1007', categoryId = 'c-phones', bannedKeywords = keywords) {
  const seller = sellers.find(value => value.id === sellerId)!;
  const category = categories.find(value => value.id === categoryId)!;
  return {
    seller: { id: seller.id, trustScore: seller.trust_score, verified: seller.verified },
    category: { id: category.id, medianPriceVnd: BigInt(category.median_price_vnd) },
    bannedKeywords,
  };
}

function finish(screening: any, duplicate: { kind: 'clear' } | { kind: 'duplicate'; listingId: string }) {
  assert.equal(screening.kind, 'requires_duplicate');
  return policy.finalizeNormalModeration!(screening, duplicate);
}

test('production screening makes R1 terminal before trusted R4 and includes the matched seed term', () => {
  assert.equal(typeof policy.screenModeration, 'function', 'production moderation screening must be available');
  const result = policy.screenModeration!(input({ sellerId: 's-1001', title: 'Replica phone', priceVnd: 0n }), refs('s-1001'));
  assert.equal(result.kind, 'terminal');
  assert.equal(result.proposal.status, 'auto_rejected');
  assert.equal(result.proposal.decision.outcome, 'rejected');
  assert.equal(result.proposal.decision.reasons.length, 1);
  assert.equal(result.proposal.decision.reasons[0].rule_id, 'R1');
  assert.ok(result.proposal.decision.reasons[0].message.includes('replica'));
});

test('production R4 is inclusive at 80 and skips price, duplicate, and verification rules', () => {
  assert.equal(typeof policy.screenModeration, 'function', 'production moderation screening must be available');
  const exactly80 = policy.screenModeration!(input({ sellerId: 's-1006', priceVnd: 0n }), refs('s-1006'));
  assert.equal(exactly80.kind, 'terminal');
  assert.equal(exactly80.proposal.status, 'auto_approved');
  assert.deepEqual(exactly80.proposal.decision.reasons.map((reason: any) => reason.rule_id), ['R4']);

  const trustedUnverified = policy.screenModeration!(input({ sellerId: 's-1005', priceVnd: 0n }), refs('s-1005'));
  assert.equal(trustedUnverified.proposal.status, 'auto_approved');
  assert.deepEqual(trustedUnverified.proposal.decision.reasons.map((reason: any) => reason.rule_id), ['R4']);

  const oneBelow = policy.screenModeration!(input({ sellerId: 's-1007' }), refs('s-1007'));
  assert.equal(oneBelow.kind, 'requires_duplicate');
  assert.deepEqual(oneBelow.normalReasons.map((reason: any) => reason.rule_id), []);
});

test('production R2 uses exact strict thirds and triple boundaries for all persisted categories', () => {
  assert.equal(typeof policy.screenModeration, 'function', 'production moderation screening must be available');
  for (const category of categories) {
    const median = BigInt(category.median_price_vnd);
    const lowerFloor = median / 3n;
    for (const [price, hit] of [
      [lowerFloor - 1n, true],
      [lowerFloor, lowerFloor * 3n < median],
      [lowerFloor + 1n, (lowerFloor + 1n) * 3n < median],
      [median * 3n - 1n, false],
      [median * 3n, false],
      [median * 3n + 1n, true],
    ] as Array<[bigint, boolean]>) {
      const screening = policy.screenModeration!(
        input({ categoryId: category.id, priceVnd: price }), refs('s-1007', category.id),
      );
      assert.equal(screening.kind, 'requires_duplicate');
      assert.equal(screening.normalReasons.some((reason: any) => reason.rule_id === 'R2'), hit,
        `${category.id} median ${median}, price ${price}`);
    }
  }
  for (const [median, price, hit] of [
    [32000000n, 10666666n, true], [32000000n, 10666667n, false],
    [2500000n, 833333n, true], [2500000n, 833334n, false],
  ] as Array<[bigint, bigint, boolean]>) {
    const screening = policy.screenModeration!(
      input({ priceVnd: price }), { ...refs('s-1007'), category: { id: 'c-phones', medianPriceVnd: median } },
    );
    assert.equal(screening.normalReasons.some((reason: any) => reason.rule_id === 'R2'), hit);
  }
});

test('production R5 and duplicate aggregation retain only actual hits in stable priority order', () => {
  assert.equal(typeof policy.screenModeration, 'function', 'production moderation screening must be available');
  assert.equal(typeof policy.finalizeNormalModeration, 'function', 'production moderation finalizer must be available');
  const unverified = policy.screenModeration!(input({ sellerId: 's-1004' }), refs('s-1004'));
  assert.deepEqual(unverified.normalReasons.map((reason: any) => reason.rule_id), ['R5']);
  assert.equal(finish(unverified, { kind: 'clear' }).status, 'needs_human');

  const multiHit = policy.screenModeration!(input({ sellerId: 's-1004', priceVnd: 0n }), refs('s-1004'));
  assert.deepEqual(multiHit.normalReasons.map((reason: any) => reason.rule_id), ['R2', 'R5']);
  const duplicate = finish(multiHit, { kind: 'duplicate', listingId: 'existing-42' });
  assert.equal(duplicate.status, 'auto_rejected');
  assert.equal(duplicate.decision.outcome, 'rejected');
  assert.deepEqual(duplicate.decision.reasons.map((reason: any) => reason.rule_id), ['R2', 'R3', 'R5']);
  assert.ok(duplicate.decision.reasons[1].message.includes('existing-42'));

  const clear = finish(policy.screenModeration!(input(), refs('s-1007')), { kind: 'clear' });
  assert.deepEqual(clear, { status: 'auto_approved', decision: { outcome: 'approved', reasons: [] } });
});

test('production proposal details preserve bigint JSON tokens and reject invalid int64 inputs', () => {
  assert.equal(typeof policy.screenModeration, 'function', 'production moderation screening must be available');
  const max = 9223372036854775807n;
  const screening = policy.screenModeration!(input({ priceVnd: 0n }), {
    seller: { id: 's-1007', trustScore: 79, verified: true },
    category: { id: 'c-phones', medianPriceVnd: 9223372036854775807n },
    bannedKeywords: keywords,
  });
  const proposal = finish(screening, { kind: 'clear' });
  const roundTrip = parseJson(stringifyJson(proposal.decision)) as any;
  const encoded = stringifyJson(proposal.decision);
  assert.match(encoded, /9223372036854775807/);
  assert.equal(roundTrip.reasons[0].rule_id, 'R2');
  assert.equal(roundTrip.reasons[0].detail.median_price_vnd.toString(), max.toString());
  assert.equal(roundTrip.reasons[0].detail.price_vnd.toString(), '0');

  for (const priceVnd of [-1n, 9223372036854775808n]) {
    assert.throws(() => policy.screenModeration!(input({ priceVnd }), refs('s-1007')),
      /price|int64/i);
  }
});

test('production moderation is deterministic, pure, and requires an explicit R3 fact', () => {
  assert.equal(typeof policy.screenModeration, 'function', 'production moderation screening must be available');
  assert.equal(typeof policy.finalizeNormalModeration, 'function', 'production moderation finalizer must be available');
  const listing = Object.freeze(input());
  const snapshot = refs();
  const reference = Object.freeze({
    seller: Object.freeze(snapshot.seller), category: Object.freeze(snapshot.category),
    bannedKeywords: Object.freeze([...keywords]),
  });
  const first = policy.screenModeration!(listing, reference);
  const second = policy.screenModeration!(listing, reference);
  assert.deepEqual(second, first);
  assert.equal(first.kind, 'requires_duplicate');
  assert.throws(() => policy.finalizeNormalModeration!(first, undefined), TypeError);
});

test('production R2 keeps unsafe integer prices and oversized intermediate products exact', () => {
  const max = 9223372036854775807n;
  for (const [median, price, hit] of [
    [6000000n, 0n, true],
    [6000000n, 9007199254740993n, true],
    [6000000n, max, true],
    [max, max, false],
    [max, max / 3n, true],
    [max, max / 3n + 1n, false],
  ] as Array<[bigint, bigint, boolean]>) {
    const screening = policy.screenModeration!(input({ priceVnd: price }), {
      ...refs(), category: { id: 'c-phones', medianPriceVnd: median },
    });
    const proposal = finish(screening, { kind: 'clear' });
    assert.equal(proposal.status, hit ? 'needs_human' : 'auto_approved');
    assert.equal(proposal.decision.outcome, hit ? 'escalated' : 'approved');
    if (hit) {
      const encoded = stringifyJson(proposal.decision);
      assert.ok(encoded.includes(`"price_vnd":${price}`));
      assert.ok(encoded.includes(`"median_price_vnd":${median}`));
    }
  }
});

test('production screening fails closed for inconsistent or invalid reference snapshots', () => {
  const valid = refs();
  for (const reference of [
    { ...valid, seller: { ...valid.seller, id: 'different-seller' } },
    { ...valid, category: { ...valid.category, id: 'different-category' } },
    { ...valid, category: { ...valid.category, medianPriceVnd: 0n } },
    { ...valid, category: { ...valid.category, medianPriceVnd: 9223372036854775808n } },
    { ...valid, seller: { ...valid.seller, trustScore: 80.5 } },
    { ...valid, bannedKeywords: [] },
  ]) assert.throws(() => policy.screenModeration!(input(), reference), TypeError);
  assert.throws(() => policy.screenModeration!(input({ priceVnd: 9007199254740992 }), valid), TypeError);
  assert.throws(() => policy.finalizeNormalModeration!(policy.screenModeration!(input(), valid),
    { kind: 'duplicate', listingId: '' }), TypeError);
});