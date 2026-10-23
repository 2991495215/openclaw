# Split, dedup and speaker resolution

## Split: one recording may hold several meetings

Signals: roster changes, hard topic cuts, fresh introductions or context resets,
an agenda naming several sessions. Two or more signals suggest a split. The same
people changing topics in one conversation is one meeting.

For a split, partition into contiguous, non-overlapping segment ranges in original
order: drop nothing, duplicate nothing. Run the remaining steps once per meeting.
Record the shared source ID and exact boundaries on each page. Cross-link siblings
after their pages exist. Flag uncertain boundaries.

## Dedup across recorders

Search existing meetings by source ID, then title, attendees and date. Date ±1
day, attendee overlap ≥50% and a similar title make a candidate, not proof. Read
candidates and their coverage before deciding.

If the meeting exists, reconcile into it. Retain both originals and source IDs,
note coverage differences, and use the richer transcript. Also inspect the
existing claims and connections, not just the page. Record source IDs in prose
or declared ontology fields, never in arbitrary frontmatter.

## Speaker resolution

1. Start from the attendee list and explicit roster or user evidence.
2. Never guess. Use `UNKNOWN` or `[Room]` with an uncertainty flag.
3. Resolve candidates with the identity rules; read existing evidence.
4. Record each raw label → identity (or unresolved), with basis and confidence
   (high/medium/low). Being on the roster doesn't tie a person to a voice track.
5. **Role check:** if a speaker's stated role or company contradicts the named
   person's evidence, the label may be wrong. Inspect before reattributing.
6. **Phantom speakers:** more tracks than attendees, mid-sentence handoffs or
   labels that never address each other suggest over-splitting. Merge labels only
   on evidence, not counts.
7. **User correction:** an explicit user identification overrides the mapping.
   Retain it as attributed evidence and keep the original transcript. Repairs of
   existing assertions go through `knowledge-correct`.
8. Search spelling variants before creating a transcript-only person. After
   confirming identity, reuse the page and optionally add the alias.

## Fabricated-attendee check (during verification)

Names absent from both transcript and roster, or email domains that conflict with
a known identity, need inspection. Don't auto-rename or fill in addresses. Fix
affected outputs within scope and recheck. Uncertain identities stay flagged.
