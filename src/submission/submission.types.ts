export type ListingStatus =
  | 'pending'
  | 'auto_approved'
  | 'auto_rejected'
  | 'needs_human'
  | 'published'
  | 'rejected'
  | 'expired';

export interface SubmissionFields {
  sellerId: string;
  title: string;
  description: string;
  priceVnd: bigint;
  categoryId: string;
}

export interface SubmissionIdentity {
  key: string;
  requestHash: string;
}

export type SubmissionResult =
  | { kind: 'created'; id: string; status: 'pending' }
  | { kind: 'replayed'; id: string; status: ListingStatus };

export type MissingReference = 'seller' | 'category';

export class UnknownReferenceError extends Error {
  constructor(readonly reference: MissingReference) {
    super(`Unknown ${reference}`);
    this.name = 'UnknownReferenceError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency key was already used with a different request');
    this.name = 'IdempotencyConflictError';
  }
}
