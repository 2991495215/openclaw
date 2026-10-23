export type SessionTranscriptWatermark = {
  generation: string | null;
  maxSeq: number | null;
};

export type SessionTranscriptContextVersion = {
  generation: string | null;
  rawSeq: number | null;
  updatedAt: number | null;
};

export function sameSessionTranscriptContextVersion(
  left: SessionTranscriptContextVersion,
  right: SessionTranscriptContextVersion,
): boolean {
  return (
    left.generation === right.generation &&
    left.rawSeq === right.rawSeq &&
    left.updatedAt === right.updatedAt
  );
}
