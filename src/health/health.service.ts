import { Injectable } from '@nestjs/common';
import { Database } from '../db/database';

@Injectable()
export class HealthService {
  private draining = false;
  private inFlight?: Promise<boolean>;

  constructor(private readonly database: Database) {}

  drain(): void { this.draining = true; }

  async ready(): Promise<boolean> {
    if (this.draining) return false;
    if (!this.inFlight) {
      const probe = this.database.readinessProbe().then(() => true, () => false);
      this.inFlight = probe.finally(() => { this.inFlight = undefined; });
    }
    const healthy = await this.inFlight;
    return healthy && !this.draining;
  }
}
