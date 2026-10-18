import type {
  NotesItem,
  NotesSource,
} from '../../../electron/llm/meetingNotesTypes';

export interface NotesEvidenceRequirement {
  lineIndex: number;
  quote: string;
}

export const scoreNotesSemanticEvidence = (
  source: NotesSource,
  item: NotesItem | undefined,
  originalClaimId: string,
  requirements: NotesEvidenceRequirement[],
): string[] => {
  const evidence = requirements.map(({ lineIndex, quote }) => {
    const segment = source.segments.find((row) => row.index === lineIndex);
    const start = segment?.text.indexOf(quote) ?? -1;
    if (!quote || start < 0 || segment?.text.lastIndexOf(quote) !== start)
      throw new Error('invalid_gold_evidence');
    return { lineIndex, quote, start, end: start + quote.length };
  });
  if (!item) return ['original_claim_missing'];
  const failures =
    item.id === originalClaimId ? [] : ['original_claim_identity'];
  for (const { lineIndex, quote, start, end } of evidence) {
    let covered = start;
    const spans = item.sources
      .filter((span) => span.segment === lineIndex)
      .sort((left, right) => left.start - right.start);
    for (const span of spans) {
      if (span.start > covered) break;
      covered = Math.max(covered, span.end);
    }
    if (covered < end) failures.push(`missing_evidence:${lineIndex}:${quote}`);
  }
  return failures;
};
