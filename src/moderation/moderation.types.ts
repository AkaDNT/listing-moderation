export interface ModerationListing {
  sellerId: string;
  categoryId: string;
  title: string;
  description: string;
  priceVnd: bigint;
}

export interface SellerReference {
  id: string;
  trustScore: number;
  verified: boolean;
}

export interface CategoryReference {
  id: string;
  medianPriceVnd: bigint;
}

export interface ModerationReferences {
  seller: SellerReference;
  category: CategoryReference;
  bannedKeywords: string[];
}

export interface ModerationReason {
  rule_id: string;
  message: string;
  detail?: Record<string, unknown>;
}

export type ModerationStatus = 'auto_approved' | 'auto_rejected' | 'needs_human';
export type ModerationOutcome = 'approved' | 'rejected' | 'escalated';

export interface ModerationDecision {
  outcome: ModerationOutcome;
  reasons: ModerationReason[];
}

export type ModerationProposal =
  | { status: 'auto_approved'; decision: { outcome: 'approved'; reasons: ModerationReason[] } }
  | { status: 'auto_rejected'; decision: { outcome: 'rejected'; reasons: ModerationReason[] } }
  | { status: 'needs_human'; decision: { outcome: 'escalated'; reasons: ModerationReason[] } };

export type ModerationScreening =
  | { kind: 'terminal'; proposal: ModerationProposal }
  | { kind: 'requires_duplicate'; normalReasons: ModerationReason[] };

export type DuplicateFact =
  | { kind: 'clear' }
  | { kind: 'duplicate'; listingId: string };
