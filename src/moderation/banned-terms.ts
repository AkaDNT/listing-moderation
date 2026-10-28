import { ModerationReason } from './moderation.types';

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsWholeTerm(text: string, term: string): boolean {
  const wordCharacter = String.raw`\p{L}\p{M}\p{N}\p{Pc}`;
  const pattern = new RegExp(
    `(^|[^${wordCharacter}])${escapeRegExp(term)}(?=$|[^${wordCharacter}])`,
    'iu',
  );
  return pattern.test(text.normalize('NFC'));
}

export function matchBannedTerms(title: string, description: string, terms: string[]): ModerationReason[] {
  const reasons: ModerationReason[] = [];
  const orderedTerms = [...terms].sort(compareOrdinal);

  for (const term of orderedTerms) {
    const normalizedTerm = term.normalize('NFC');
    const fields: string[] = [];
    if (containsWholeTerm(title, normalizedTerm)) fields.push('title');
    if (containsWholeTerm(description, normalizedTerm)) fields.push('description');
    if (fields.length === 0) continue;

    reasons.push({
      rule_id: 'R1',
      message: `R1: banned term "${term}" matched in ${fields.join(' and ')}`,
      detail: { fields },
    });
  }

  return reasons;
}
