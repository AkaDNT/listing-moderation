import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { HealthService } from './health.service';

interface StatusResponse { status(code: number): this; }

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('livez')
  live() { return { status: 'ok' }; }

  @Get('readyz')
  async ready(@Res({ passthrough: true }) response: StatusResponse) {
    if (await this.health.ready()) return { status: 'ok' };
    response.status(HttpStatus.SERVICE_UNAVAILABLE);
    return { status: 'not_ready' };
  }
}
