import { ModerationJobRepository } from './moderation-job.repository';
import { sanitizeWorkerError } from './job-policy';
import { MAX_POLL_INTERVAL_MS } from '../config';

export class WorkerLoop {
  private running = false;
  private loopPromise?: Promise<void>;
  private activeAbort?: AbortController;

  constructor(private readonly jobs: ModerationJobRepository, private readonly pollIntervalMs: number) {
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
          try {
            const completed = await this.jobs.processClaim(result.claim);
            if (completed.kind === 'completed') {
              console.log(JSON.stringify({ event: 'worker_job_completed', job_id: result.claim.jobId,
                listing_id: result.claim.listingId, attempt: result.claim.attempt }));
            }
          } catch (error) {
            try {
              const recovery = await this.jobs.recordFailure(result.claim, error);
              console.error(JSON.stringify({ event: 'worker_job_attempt_failed', job_id: result.claim.jobId,
                listing_id: result.claim.listingId, attempt: result.claim.attempt,
                diagnostic: sanitizeWorkerError(error), recovery }));
            } catch (recoveryError) {
              console.error(JSON.stringify({ event: 'worker_job_recovery_write_failed', job_id: result.claim.jobId,
                listing_id: result.claim.listingId, attempt: result.claim.attempt,
                diagnostic: sanitizeWorkerError(recoveryError) }));
            }
          }
        } else if (result.kind === 'quarantined' || result.kind === 'exhausted') {
          console.error(JSON.stringify({ event: `worker_job_${result.kind}`, job_id: result.jobId }));
        }
      } catch (error) {
        console.error(JSON.stringify({ event: 'worker_claim_failed', diagnostic: sanitizeWorkerError(error) }));
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
        console.error(JSON.stringify({ event: 'worker_poll_wait_failed', diagnostic: sanitizeWorkerError(error) }));
      } finally {
        this.activeAbort = undefined;
      }
    }
  }
}
