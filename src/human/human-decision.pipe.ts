import { PipeTransform } from '@nestjs/common';
import { ApiError } from '../http/errors';
import { isStorablePostgresText } from '../listings/listing-query';

export interface HumanDecisionRequest {
  decision: 'approve' | 'reject';
  moderatorId: string;
  note: string | null;
}

export interface HumanDecision {
  outcome: 'approved' | 'rejected';
  reason: { rule_id: 'HUMAN'; message: string };
}

export function mapHumanDecision(decision: HumanDecisionRequest['decision']): HumanDecision {
  if (decision === 'approve') {
    return { outcome: 'approved', reason: { rule_id: 'HUMAN', message: 'Approved by human moderator' } };
  }
  return { outcome: 'rejected', reason: { rule_id: 'HUMAN', message: 'Rejected by human moderator' } };
}

export class HumanDecisionRequestPipe implements PipeTransform<unknown, HumanDecisionRequest> {
  transform(value: unknown): HumanDecisionRequest {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw invalidRequest('Request body must be a JSON object');
    }
    const body = value as Record<string, unknown>;
    if (!Object.hasOwn(body, 'decision')) throw invalidRequest('Missing required field: decision');
    if (!Object.hasOwn(body, 'moderator_id')) throw invalidRequest('Missing required field: moderator_id');
    if (body.decision !== 'approve' && body.decision !== 'reject') {
      throw invalidRequest('decision must be approve or reject');
    }
    if (typeof body.moderator_id !== 'string') throw invalidRequest('moderator_id must be a string');
    validateMetadata(body.moderator_id, 'moderator_id');

    let note: string | null = null;
    if (Object.hasOwn(body, 'note')) {
      if (typeof body.note !== 'string') throw invalidRequest('note must be a string');
      validateMetadata(body.note, 'note');
      note = body.note;
    }
    return { decision: body.decision, moderatorId: body.moderator_id, note };
  }
}
function validateMetadata(value: string, field: 'moderator_id' | 'note'): void {
  if (!isStorablePostgresText(value)) {
    throw invalidRequest(`${field} must not contain NUL or unpaired UTF-16 surrogates`);
  }
}

function invalidRequest(message: string): ApiError {
  return new ApiError(400, 'invalid_request', message);
}
