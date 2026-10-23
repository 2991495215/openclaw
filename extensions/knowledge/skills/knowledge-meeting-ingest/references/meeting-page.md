# Meeting page

Use a clean source title; no ingestion date in the title. Store the occurrence in
the meeting type's `fields.occurred_at` at source precision. A date-only value is
not a midnight instant. Put source timezone context in the body; never guess a
timezone.

```markdown
# {Meeting Title}

**Attendees:** {resolved people as links; uncertain identities flagged}
**Date:** {date, or unknown}
**Duration:** {if known}

## Summary

{3–5 key outcomes, each cited}

## Key Decisions

{Decisions with context and citations, or: _No decisions — discussion only._}

## Action Items

{Commitments with owners/deadlines when known, or: _None — exploratory conversation._}

## Notable Quotes

{Verbatim spans in blockquotes, attributed and cited, or:
_No notable quotes — operational/logistics meeting._}

## Discussion Notes

{Notes by topic, cited}

## Source Context

{Only if not clear elsewhere: source ID/URL, raw speaker label → identity (or
unresolved) with basis, split boundaries, transcription limits.}
```

- Summary, Key Decisions, Action Items and Notable Quotes are required. Check the
  transcript before writing "none"; a bare `None` is not a reason.
- Quotes are verbatim transcript spans. Never put a paraphrase in a blockquote.
- Cite transcript passages through the meeting's own observed path with verified
  line labels; cite attendees and mentions through their entity paths.
- The transcript stays an attachment. Don't paste it into the body.
- Publish the body with its evidence first, then add self-citations and links
  using the returned path.

For a complete worked page and matching profile, read
[meeting and entity example](meeting-entity-example.md).
