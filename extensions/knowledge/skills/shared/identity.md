# Identity and links

## Resolve before asking

Run in order and stop at the first clear answer. Never ask the user "who is X?"
when Knowledge or the source already says.

1. Search with `knowledge_grep` (try spelling variants and synonyms), then read
   the candidate pages and metadata. A hit count is not an answer; read the page.
2. If the source has a stable account ID, `knowledge_lookup` its namespaced alias
   (`email:<address>`, `github:<login>`, `discord:<user id>`, `slack:<user id>`).
   One key on two pages means a duplicate.
3. Check retained sources and context: `knowledge_connections` (`claims`,
   `incoming`, `outgoing`, `dependents`), `knowledge_timeline({entity: id})` and
   `knowledge_chronicle_last_seen`.
4. Web research only when needed, with public hints from steps 1–3. Never send
   private context to public search. Fold what you learn back into the page.
5. Ask only if ambiguity blocks a write, and ask with a hypothesis: what you
   searched, what you found, and a confirmable guess ("Is X the ops lead at
   Acme?"), with confirm / correct / skip. Otherwise leave the mention unresolved.

**Confident enough not to ask:** the page already states the role or relationship,
or three or more dated entries describe the same role.

**Hypotheses, not proof:** an email domain (`jane@acme.com` suggests Acme; check
the company page), a display name, a filled role field, repeated copies of one
assertion, an invite list. Keep ambiguous candidates separate.

- A handle or mononym can be a complete identity. For a genuinely unresolved one,
  set `identity: {status: "partial", context: "..."}`. Candidates need an
  observed page ID, basis and evidence; they do not merge pages.
- Add spelling variants as aliases only after identity is confirmed. Keep
  existing aliases.
- Two pages confirmed as one entity: `knowledge_merge` (see `knowledge-correct`).
  A lookup with `redirectedFrom` found a merged page; use the returned ID.
- For chat authors, use provider-scoped stable author IDs across display-name
  changes. Don't create another profile for an already resolved handle.
- Source context, employment and speaker identity are distinct. A company name in
  a participant label does not establish `works_at`.

## When to create a page

When in doubt, don't. A missing page can be created later; a junk page wastes
attention and degrades search.

- **Person:** they took part (spoke, were addressed, or other evidence shows they
  were present), or you will likely deal with them again and the source says
  something substantive about them. An invite-list-only name gets no page.
- **Company, project or concept:** the source says something substantive about
  it (a decision, commitment, status update, plan or real discussion), or it is
  a reusable idea worth referencing again. A passing mention gets no page.
- **Never a page for:** a tool or platform merely used along the way; a garbled
  or unverified proper noun (write it in prose as `Name (unverified spelling)`);
  a low-confidence identification; bots or spam.
- **Sub-features and small workstreams** (one plugin, one PR) go into the parent
  project's Timeline.
- **Type:** pick the best-fitting declared ontology type for what the thing is (a
  product is not a company; an investment firm may have its own type). If no
  declared type fits, say so rather than forcing one.
- Find before creating: search, then create only if nothing matches.

## Links

- Inside pages, link with wikilinks to observed paths or titles. These create
  References/Referenced-by navigation only. They are not typed relationships,
  `entities` or `dependencies`.
- An authored source → entity link gives the entity a derived backlink. That
  does not author the entity → source link. When both directions are required,
  write both.
- Link every identified entity that has a page to the source, and back. Never
  link a garbled name or a low-confidence guess: a wrong link pollutes the graph
  more than a missing one.
- Never hand-write References/Referenced-by lists. Never guess an ambiguous link
  target; use the observed path.
