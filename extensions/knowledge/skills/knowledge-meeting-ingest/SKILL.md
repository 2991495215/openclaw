---
name: knowledge-meeting-ingest
description: Ingest meeting transcripts from any recorder into Knowledge with attendee enrichment, timeline merge, supported decisions and commitments, and verification of substance and sequence. Summary-only input is not a verified meeting ingestion.
---

# Meeting ingestion

Turn one transcript into a sourced meeting page, updated entity profiles, and
structured claims, then verify them. Read a reference only when its step needs it:

- [setup](references/setup.md): always, first (status, ontology, search)
- [source acquisition](references/source-acquisition.md): fetching from an API, including Granola
- [sources](references/sources.md): retaining originals; citation format
- [speakers](references/speakers.md): possible split, duplicate or unclear speaker
- [identity](references/identity.md): resolving a person, company or project
- [meeting page](references/meeting-page.md): writing the meeting page
- [profiles](references/profiles.md): creating or updating a profile
- [assertions](references/assertions.md): claims, attendance edges, reruns
- [publish](references/publish.md): batch or page writes
- [recovery](references/recovery.md): any uncertain, rejected or conflicting write
- [verify](references/verify.md): verification and report

## Contract

- One page per real meeting. Retain the full transcript; recorder summaries are
  claims, not facts.
- Speakers are resolved on evidence, never guessed.
- Every identified attendee gets a substantive profile with a Timeline line and
  attendance edge. Every relevant entity with a page gets a Timeline line and
  links in both directions.
- Decisions, commitments and events become claims. Unverified claims don't
  spread to other pages.
- Never call a meeting fully ingested until verification passes.

## Steps

### 1. Acquire and normalize

Get the complete transcript. Empty, summary-only or in-progress input fails this
step: report it. If the user only wants notes saved, use `knowledge-capture` and
say the meeting ingestion is not complete.

Normalize in working context to: source, source_id, title, date, time, duration,
attendees (source claims), ordered segments with `speaker`, `speaker_raw` and
`text`, source summary, URL. Unknown values are null.

Retain the original export and the transcript ([sources](references/sources.md)).
Normalized text is a labeled derivative. Report acquisition, retention and
publication separately, with real counts ("9/16 originals retained").

**Done when:** complete transcript retained; evidence receipts in hand.

### 2. Split, dedup, resolve speakers

Check for a multi-meeting recording, an existing page for this meeting, and the
speaker map ([speakers](references/speakers.md)).

**Done when:** each real meeting has its segment range; duplicates found; every
speaker label is mapped or explicitly unresolved, with basis.

### 3. Gate each claim

Check every proposed assertion against the transcript and earlier Knowledge about
the same entity.

- Role or relationship: explicit passage, not implication.
- Ownership: explicit ownership language; mentioning a name is not owning it.
- New proper noun: search Knowledge for the spelling; otherwise label it unverified.
- Major life or deal event: verbatim support, checked against existing chronology.

Surprising claims get more scrutiny. Keep conflicting accounts with both
citations. Inferences and uncertain identities stay labeled on the meeting page
and never enter profiles, timelines, metadata or relationships as fact.

**Done when:** each claim is marked publish, label-as-uncertain or withhold.

### 4. Publish

Order: meeting page → entity pages → claims and edges → link edits.
Batch related records ([publish](references/publish.md)).

- Meeting page per [meeting page](references/meeting-page.md).
- For each attendee and relevant entity: find or create the page
  (`knowledge-entities` for hard cases), add the Timeline line, update State only
  if meaning changed ([profiles](references/profiles.md)).
- Claims per [assertions](references/assertions.md): decisions, commitments,
  facts and one `source_event: true` event for the meeting itself, with all
  relevant `entities`. Other events keep their own dates.
- An evidenced `attended` relationship per attendee. In the shipped ontology it
  runs participant → meeting; confirm in the definition. Set `source_page`.
- Mentioned people with pages get links too. Don't create pages for unknown
  speakers.
- For legal or personal content, keep the meeting page factual and limit spread
  to profiles; ask if scope is unclear.

**Done when:** every planned record has a published receipt in your work log.

### 5. Verify (hard gate, every meeting)

Run [verify](references/verify.md) first. Then check:

- **Substance:** required sections have content or a source-grounded reason.
- **Links:** `knowledge_verify` `expectedLinks` for meeting ↔ each entity, plus
  claim `entities`/`dependencies`, commitment `owner`, and edge
  `from`/`to`/`label`/`source_page`.
- **State:** no updated profile has a State topic named for a date or meeting.
- **Speakers:** no raw label passes as a known person; run the
  fabricated-attendee check in [speakers](references/speakers.md).
- **Quotes:** read each quoted span's lines with `knowledge_evidence_read`. Fix
  any that aren't verbatim.
- **Sequence:** compare narrated order (before/during/after, places, people) with
  timestamps, independently of heading order. Use
  `knowledge_chronicle_day` (meeting date and timezone) and `knowledge_timeline`
  for related entities. An inversion or impossible place/time is a contradiction;
  never invent transit. Fix and recheck, or record an explicit user waiver as
  WAIVED, not resolved. A waiver covers sequence only.

**Done when:** all checks pass, or failures are fixed and rechecked.

## Report

Per meeting: page, retained sources, attendees enriched, entities updated or
reused, claims and edges, verification result, sequence PASS or WAIVED with the
open contradiction. List withheld claims, unresolved identities and remaining
work. A partial report is honest progress, not completion.
