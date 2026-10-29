import { ModerationJobRepository } from './moderation-job.repository';
import { sanitizeWorkerError } from './job-policy';
import { MAX_POLL_INTERVAL_MS } from '../config';
import { PublicationRepository, PublicationFailure } from '../lifecycle/publication.repository';
import { ExpiryRepository } from '../lifecycle/expiry.repository';

export class WorkerLoop {
  private running = false;
  private loopPromise?: Promise<void>;
  private activeAbort?: AbortController;

  constructor(
    private readonly jobs: ModerationJobRepository,
    private readonly publications: PublicationRepository,
    private readonly expiries: ExpiryRepository,
    private readonly pollIntervalMs: number,
  ) {
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > MAX_POLL_INTERVAL_MS) {
      throw new TypeError(`Worker polling interval must be an integer between 1 and ${MAX_POLL_INTERVAL_MS}`);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.activeAbort?.abort();
    await this.loopPromise;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const result = await this.jobs.claimNext();
        if (result.kind === 'claimed') {
          if (result.claim.recovered) {
            console.log(JSON.stringify({ event: 'worker_claim_recovered', job_id: result.claim.jobId,
              listing_id: result.claim.listingId, attempt: result.claim.attempt, phase: 'auto' }));
          }
          try {
            const completed = await this.jobs.processClaim(result.claim);
            if (completed.kind === 'completed') {
              console.log(JSON.stringify({ event: 'worker_job_completed', job_id: result.claim.jobId,
                listing_id: result.claim.listingId, attempt: result.claim.attempt, phase: 'auto',
                status: completed.status, outcome: completed.outcome, rule_ids: completed.ruleIds }));
            } else {
              console.error(JSON.stringify({ event: `worker_job_${completed.kind}`, job_id: result.claim.jobId,
                listing_id: result.claim.listingId, attempt: result.claim.attempt, phase: 'auto',
                ...(completed.kind === 'quarantined' ? { diagnostic: completed.diagnostic } : {}) }));
            }
          } catch (error) {
            try {
              const recovery = await this.jobs.recordFailure(result.claim, error);
              console.error(JSON.stringify({ event: 'worker_job_attempt_failed', job_id: result.claim.jobId,
                listing_id: result.claim.listingId, attempt: result.claim.attempt, phase: 'auto',
                diagnostic: sanitizeWorkerError(error), recovery }));
            } catch (recoveryError) {
              console.error(JSON.stringify({ event: 'worker_job_recovery_write_failed', job_id: result.claim.jobId,
                listing_id: result.claim.listingId, attempt: result.claim.attempt, phase: 'auto',
                diagnostic: sanitizeWorkerError(recoveryError) }));
            }
          }
        } else if (result.kind === 'quarantined' || result.kind === 'exhausted') {
          console.error(JSON.stringify({ event: `worker_job_${result.kind}`, job_id: result.jobId,
            listing_id: result.listingId, attempt: result.attempt, phase: 'auto', diagnostic: result.diagnostic }));
        }
      } catch (error) {
        console.error(JSON.stringify({ event: 'worker_claim_failed', phase: 'auto', diagnostic: sanitizeWorkerError(error) }));
      }

      if (this.running) {
        try {
          const result = await this.publications.publishNext();
          if (result.kind === 'published') {
            console.log(JSON.stringify({ event: 'worker_listing_published', listing_id: result.listing.id }));
          }
        } catch (error) {
          console.error(JSON.stringify({ event: 'worker_publication_failed', phase: 'publication',
            ...(error instanceof PublicationFailure ? { listing_id: error.listingId } : {}),
            diagnostic: sanitizeWorkerError(error) }));
        }
      }

      if (this.running) {
        try {
          const expiredIds = await this.expiries.expireBatch();
          if (expiredIds.length > 0) {
            console.log(JSON.stringify({ event: 'worker_listings_expired', count: expiredIds.length }));
          }
        } catch (error) {
          console.error(JSON.stringify({ event: 'worker_expiry_failed', phase: 'expiry', diagnostic: sanitizeWorkerError(error) }));
        }
      }

      if (!this.running) break;
      this.activeAbort = new AbortController();
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, this.pollIntervalMs);
          this.activeAbort!.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      } catch (error) {
        console.error(JSON.stringify({ event: 'worker_poll_wait_failed', phase: 'poll', diagnostic: sanitizeWorkerError(error) }));
      } finally {
        this.activeAbort = undefined;
      }
    }
  }
}
