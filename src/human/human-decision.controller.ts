import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { HumanDecisionRequest, HumanDecisionRequestPipe } from './human-decision.pipe';
import { HumanDecisionService } from './human-decision.service';

@Controller('v1/listings')
export class HumanDecisionController {
  constructor(private readonly service: HumanDecisionService) {}

  @Post(':id/decision')
  @HttpCode(200)
  decide(@Param('id') id: string, @Body(HumanDecisionRequestPipe) request: HumanDecisionRequest) {
    return this.service.decide(id, request);
  }
}
