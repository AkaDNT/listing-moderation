import {
  DuplicateFact,
  ModerationListing,
  ModerationProposal,
  ModerationReferences,
  ModerationScreening,
} from './moderation.types';
import { matchBannedTerms } from './banned-terms';

const MAX_INT64 = 9223372036854775807n;
const TRUST_THRESHOLD = 80;

function invalidInput(message: string): never {
  throw new TypeError('Invalid moderation input: ' + message);
}

function validateInput(listing: ModerationListing, references: ModerationReferences): void {
  if (!listing || typeof listing !== 'object') invalidInput('listing must be an object');
  if (typeof listing.sellerId !== 'string' || typeof listing.categoryId !== 'string' ||
      typeof listing.title !== 'string' || typeof listing.description !== 'string') {
    invalidInput('listing string fields are required');
  }
  if (typeof listing.priceVnd !== 'bigint' || listing.priceVnd < 0n || listing.priceVnd > MAX_INT64) {
    invalidInput('priceVnd must be a nonnegative int64 bigint');
  }
  if (!references || typeof references !== 'object' || !references.seller || !references.category) {
    invalidInput('seller and category references are required');
  }
  if (references.seller.id !== listing.sellerId || references.category.id !== listing.categoryId) {
    invalidInput('reference IDs must match the listing');
  }
  if (!Number.isInteger(references.seller.trustScore) || references.seller.trustScore < 0 || references.seller.trustScore > 100 ||
      typeof references.seller.verified !== 'boolean') {
    invalidInput('seller reference is invalid');
  }
  if (typeof references.category.medianPriceVnd !== 'bigint' ||
      references.category.medianPriceVnd <= 0n || references.category.medianPriceVnd > MAX_INT64) {
    invalidInput('category median must be a positive int64 bigint');
  }
  if (!Array.isArray(references.bannedKeywords) || references.bannedKeywords.length === 0 ||
      references.bannedKeywords.some(term => typeof term !== 'string' || term.length === 0)) {
    invalidInput('bannedKeywords must be a nonempty string array');
  }
}

function r2Reason(listing: ModerationListing, references: ModerationReferences) {
  const price = listing.priceVnd;
  const median = references.category.medianPriceVnd;
  const comparison = price > 3n * median
    ? 'above_three_times'
    : 3n * price < median
      ? 'below_one_third'
      : undefined;
  if (!comparison) return undefined;

  const direction = comparison === 'above_three_times' ? 'above three times' : 'below one-third';
  return {
    rule_id: 'R2',
    message: `R2: price ${price} VND is ${direction} the category median ${median} VND`,
    detail: { price_vnd: price, median_price_vnd: median, comparison },
  };
}

export function screenModeration(listing: ModerationListing, references: ModerationReferences): ModerationScreening {
  validateInput(listing, references);

  const bannedReasons = matchBannedTerms(listing.title, listing.description, references.bannedKeywords);
  if (bannedReasons.length > 0) {
    return { kind: 'terminal', proposal: { status: 'auto_rejected', decision: { outcome: 'rejected', reasons: bannedReasons } } };
  }

  if (references.seller.trustScore >= TRUST_THRESHOLD) {
    return {
      kind: 'terminal',
      proposal: { status: 'auto_approved', decision: { outcome: 'approved', reasons: [{
        rule_id: 'R4',
        message: `R4: seller trust score ${references.seller.trustScore} meets threshold ${TRUST_THRESHOLD}`,
        detail: { trust_score: references.seller.trustScore, threshold: TRUST_THRESHOLD },
      }] } },
    };
  }

  const normalReasons = [];
  const priceReason = r2Reason(listing, references);
  if (priceReason) normalReasons.push(priceReason);
  if (!references.seller.verified) {
    normalReasons.push({
      rule_id: 'R5',
      message: 'R5: seller is not verified',
      detail: { verified: false },
    });
  }
  return { kind: 'requires_duplicate', normalReasons };
}

export function finalizeNormalModeration(
  screening: Extract<ModerationScreening, { kind: 'requires_duplicate' }>,
  duplicate: DuplicateFact,
): ModerationProposal {
  if (!screening || screening.kind !== 'requires_duplicate' || !duplicate ||
      (duplicate.kind !== 'clear' && duplicate.kind !== 'duplicate') ||
      (duplicate.kind === 'duplicate' && (typeof duplicate.listingId !== 'string' || duplicate.listingId.length === 0))) {
    throw new TypeError('An explicit valid duplicate fact is required');
  }

  const reasons = screening.normalReasons;
  const r2Reasons = reasons.filter(reason => reason.rule_id === 'R2');
  const r5Reasons = reasons.filter(reason => reason.rule_id === 'R5');
  const r3Reasons = duplicate.kind === 'duplicate' ? [{
    rule_id: 'R3',
    message: `R3: duplicate of active listing ${duplicate.listingId}`,
    detail: { listing_id: duplicate.listingId },
  }] : [];
  const combined = [...r2Reasons, ...r3Reasons, ...r5Reasons];

  if (r3Reasons.length > 0) return { status: 'auto_rejected', decision: { outcome: 'rejected', reasons: combined } };
  if (combined.length > 0) return { status: 'needs_human', decision: { outcome: 'escalated', reasons: combined } };
  return { status: 'auto_approved', decision: { outcome: 'approved', reasons: [] } };
}
