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

Aim for a usable speaker map. Use every real signal, record a confidence, and
leave a label unresolved only when there is genuinely no signal.

1. **Recorder's own track.** Recorders that split audio into "me"/"microphone"
   and "them"/"room" (Granola does) put the note owner on the "me" track. Map
   it to the note owner with high confidence unless the content contradicts it.
2. **Handoffs.** In round-robin meetings, "Gideon, go ahead" followed by an
   update maps that update span to Gideon. Map the span, not the whole "them"
   track. Medium confidence unless the speaker also self-identifies.
3. **Self-identification and roles.** "This is Calin, on cloud workers…" or a
   role that matches one roster person is evidence too. If a stated role
   contradicts the named person's evidence, inspect before reattributing.
4. Record each label or span → person, with basis and confidence
   (high/medium/low) in `attribution_confidence` and your work log. Only a
   compact speaker list goes on the meeting page.
5. Use `UNKNOWN` or `[Room]` only when no signal exists. Two roster people
   with the same first name and no other signal stay unresolved.
6. A roster lists invitees. It is not proof that someone spoke or attended.
7. **Phantom speakers:** more tracks than attendees, mid-sentence handoffs or
   labels that never address each other suggest over-splitting. Merge labels only
   on evidence, not counts.
8. **User correction:** an explicit user identification overrides the mapping.
   Retain it as attributed evidence and keep the original transcript. Repairs of
   existing assertions go through `knowledge-correct`.
9. Search spelling variants before creating a transcript-only person. After
   confirming identity, reuse the page and optionally add the alias.

## Fabricated-attendee check (during verification)

Names absent from both transcript and roster, or email domains that conflict with
a known identity, need inspection. Don't auto-rename or fill in addresses. Fix
affected outputs within scope and recheck. Uncertain identities stay flagged.
