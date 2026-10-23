# Entity profiles

Answer "what do the sources establish about this entity?", not "what happened in
the last call?".

## Sections

- **Introduction:** supported identity, how they are known, continuing context.
- **State:** the current situation in short `###` topics named for what they
  cover. Most new sources change nothing here; their contribution is a Timeline
  line. When a fact changes, rewrite the existing topic so it reads as current.
  Never add a topic or paragraph named for a date, meeting or source.
- **Timeline:** newest first, one line per event:
  `- **YYYY-MM-DD** — what happened for this entity. [[source|Label · lines]]`

Optional sections, only with evidence. Person: What They Believe, What They're
Building, Motivations, Assessment, Relationship, Contact, Network, Open Threads.
Company: Open Threads. Never fill headings with speculation or placeholders.

## Rules

- Every fact and Timeline line has an inline citation. Dates are event dates.
- Unknown role, employer and surname stay absent. Populate ontology fields such
  as `role` only when the source establishes them.
- Attribute beliefs to the speaker. Your assessment is not their belief.
- Keep user-written assessments. Flag conflicts with both citations.
- Different companies' feedback gets separate context, not a copied meeting blob.
- A rerun or repeat report changes nothing; don't save a no-op.
- Partial identity goes in structured `identity`, not only a parenthetical.

## Update an existing profile

1. Read the page, revision and hash.
2. Add the Timeline line. Edit a State topic only if its meaning changed.
3. Use `knowledge_edit_body` for these local changes rather than resending the
   page. Never edit from a truncated read.

For a full source-to-profile example, read
[meeting and entity example](meeting-entity-example.md).
