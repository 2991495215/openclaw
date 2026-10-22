import type { MediaUnderstandingAttachmentsConfig } from "../config/types.tools.js";
import { resolveAttachmentKind } from "./attachments.normalize.js";
import type {
  MediaAttachment,
  MediaAttachmentDisposition,
  MediaUnderstandingCapability,
  MediaUnderstandingDecision,
} from "./types.js";

const DEFAULT_MAX_ATTACHMENTS = 1;

/** Selects attachments for a media-understanding capability under configured ordering limits. */
export function selectAttachments(params: {
  capability: MediaUnderstandingCapability;
  attachments: MediaAttachment[];
  policy?: MediaUnderstandingAttachmentsConfig;
  previousDecisions?: readonly MediaUnderstandingDecision[];
}): { selected: MediaAttachment[]; droppedAttachmentIndexes: number[] } {
  const { capability, attachments, policy } = params;
  const decidedAudioIndexes = new Set(
    capability === "audio"
      ? (params.previousDecisions ?? []).flatMap((decision) =>
          decision.capability === "audio"
            ? decision.attachments
                .map((attachment) => attachment.attachmentIndex)
                .concat(Object.keys(decision.attachmentDispositions ?? {}).map(Number))
            : [],
        )
      : [],
  );
  const matches = attachments.filter((item) => {
    // Reuse the preflight selection budget, including dropped/failed indexes,
    // without treating those attachments as successfully transcribed.
    if (
      capability === "audio" &&
      (item.alreadyTranscribed || decidedAudioIndexes.has(item.index))
    ) {
      return false;
    }
    return resolveAttachmentKind(item) === capability;
  });
  if (matches.length === 0) {
    return { selected: [], droppedAttachmentIndexes: [] };
  }

  // Ordering is stable and non-mutating so downstream decisions can still cite
  // original attachment indexes.
  const prefer = policy?.prefer;
  let ordered = matches;
  if (prefer === "last") {
    ordered = matches.toReversed();
  } else if (prefer === "path" || prefer === "url") {
    const preferred: MediaAttachment[] = [];
    const remaining: MediaAttachment[] = [];
    for (const item of matches) {
      (item[prefer] ? preferred : remaining).push(item);
    }
    ordered = [...preferred, ...remaining];
  }
  const mode = policy?.mode ?? "first";
  const maxAttachments = policy?.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS;
  const limit = mode === "all" ? Math.max(1, maxAttachments) : 1;
  return {
    selected: ordered.slice(0, limit),
    droppedAttachmentIndexes: ordered.slice(limit).map((attachment) => attachment.index),
  };
}

export function createAttachmentDispositions(
  indexes: readonly number[],
  disposition: MediaAttachmentDisposition,
): Record<number, MediaAttachmentDisposition> {
  return Object.fromEntries(indexes.map((index) => [index, disposition]));
}
