# Web Awesome exit replacement map

Updated 2026-10-13 06:59 UTC. GitHub PR states below are coordination snapshots, not current-head CI claims. Native primitive sources were inspected on main `0348a2526c561d8ccce61bfd23931024a6b8f13e`. This coordination map does not publish any prepared source or merge an unlanded lane.

## Ownership and landed foundations

- **W-WA-EXIT:** pages except `pages/chat/**` and `pages/new-session/**`; shared styles/theme, `types/`, `app/`, this map, and the already-started `components/lobster-pet*` / `components/session-group-defaults-dialog*` cuts.
- **W-WA-EXIT-2:** other `components/**` and `lib/**` WA removal, coordinating with the active sidebar, picker, config-form, Board, Markdown, and chat owners.
- **Chat/new-session lanes:** their remaining WA consumers. Preserve their active ownership.

PRIM-B [#169128](https://github.com/openclaw/openclaw/pull/169128) and SHELL [#168612](https://github.com/openclaw/openclaw/pull/168612) are **landed**. Native Menu, Popover, Tabs, dialogs, and the Solid route outlet are on main. Consumers must build against actual main; an unlanded primitive branch or old test composition is not a production prerequisite.

## Focused W-WA-EXIT cuts

| Surface | Replacement / retained contract | Current state |
| --- | --- | --- |
| Shared implicit theme values | Owned tokens; no dependency change | Landed [#169696](https://github.com/openclaw/openclaw/pull/169696) |
| Standalone plugin/workshop panels | Native `div[role=tabpanel]`; IDs, labels, focusability | Landed [#169901](https://github.com/openclaw/openclaw/pull/169901) |
| Unused WA style tokens | Owned stylesheet consumers | Landed [#170128](https://github.com/openclaw/openclaw/pull/170128) |
| Language picker | Owned controls | Landed [#170237](https://github.com/openclaw/openclaw/pull/170237) |
| Worktrees tabs | `Tabs` / `TabPanel`; original tab owner and forced-color behavior | Landed [#170446](https://github.com/openclaw/openclaw/pull/170446) |
| Activity tool/person filters | `Popover`; original trigger IDs and filter owners | Open [#170570](https://github.com/openclaw/openclaw/pull/170570) |
| Sessions advanced filters | `Popover`; existing grouping/filter owner | Open [#170565](https://github.com/openclaw/openclaw/pull/170565) |
| Usage query filters | `Menu`; existing query callbacks and checked state | Open [#170567](https://github.com/openclaw/openclaw/pull/170567) |
| Usage export menu | `Menu`; existing export callbacks and busy trigger state | Private static follow-up; requires the typed `aria-busy` trigger allowance below, with publication deferred until the query-filter PR lands |
| Group-defaults folder picker | Native modal; save/abort/late-result ownership | Open [#170566](https://github.com/openclaw/openclaw/pull/170566); mode menu remains a separate cut |
| Pet dismiss menu | Lazy `Menu`; existing dismiss actions and focus handoff | Landed [#170568](https://github.com/openclaw/openclaw/pull/170568), merge `8b1315ac0cb1834b683186d7eab01f18d65b3d66` |
| Plugin settings actions | `Menu`; editor lifecycle and nested Escape | Open [#170569](https://github.com/openclaw/openclaw/pull/170569) |
| Cron job-filter popup | `Popover`; existing filter owner | Open [#170580](https://github.com/openclaw/openclaw/pull/170580); independent of remaining Cron menus |
| Meetings reader tabs | `Tabs`; manual activation and panel IDs | Open [#170314](https://github.com/openclaw/openclaw/pull/170314) |
| Secret Store row actions | `Menu`; permissions, busy state, Edit/Delete, trigger title | Open [#170663](https://github.com/openclaw/openclaw/pull/170663); uses the existing public trigger handle, so no new primitive API is required |
| Provider picker | `Menu`; provider name/method/hint, selected-item focus, secret retention | Private cut now uses landed item attributes and rich leaf content; review/proof in progress |
| Devices actions | `Menu`; action order, danger/disabled state and read-only reason | Private cut uses landed trigger/item attributes; reviewed, runtime proof pending |
| Remaining Cron menus | `Menu`; title, selected-row semantics, ordered groups | Separate prepared follow-up uses landed attributes and ordered content entries; follows the job-filter PR |
| Systems filter/sort | `Menu`; Sort/Status headings, radio groups, divider, `.session-menu__text` | Private cut uses landed rich leaf content and ordered entries; review/proof pending |
| Group-defaults mode menu | `Menu`; exact trigger ID and selected `data-value` | Prepared; preserve stable root trigger metadata |
| Plugin install-progress popup | `Popover`; hover, focus, pinning, explicit Escape | Prepared; needs outside-pointer/focus dismissal options exposed by Popover |

## Other active owners

W-WA-EXIT-2 browser/terminal native viewports landed in [#169587](https://github.com/openclaw/openclaw/pull/169587). Its follow-ups remain open: native-link actions [#170378](https://github.com/openclaw/openclaw/pull/170378) and obsolete browser tab-panel registration [#170471](https://github.com/openclaw/openclaw/pull/170471). Do not assume their proposed shared hooks exist on main until inspected there.

Shared pickers/dialogs/toast remain with PRIM-C2 [#170387](https://github.com/openclaw/openclaw/pull/170387); sidebar work remains with [#168852](https://github.com/openclaw/openclaw/pull/168852). Board, Markdown, config-form, and chat consumers retain their assigned owners. In particular, `config-form.render.tsx` still renders the settings help `<wa-popover>` on inspected main: `.settings-section__help-popover::part(body)` remains live and must move with that consumer.

## Exact remaining primitive contracts

Main now supplies typed trigger attributes, item attributes, checkbox/radio entries, rich leaf content, and ordered `MenuEntry` content rows. Provider, Devices, Systems, and remaining Cron menus use these landed APIs. Leaf `content` preserves visual structure while `label` supplies typeahead text. Decorative content entries do not join keyboard navigation.

Three presentation contracts remain with W-WA-EXIT-2:

| Needed API | Concrete contract |
| --- | --- |
| Explicit root Menu trigger ID | Group defaults must preserve `session-group-defaults-mode-trigger` and its selected `data-value`. Current `triggerAttributes` excludes `id`, and Menu writes `${identity.id}:trigger`; a wrapper ID is not equivalent. Keep nested trigger identity owned by the menu. |
| `Popover.dismissOutsidePointer` / `dismissOutsideFocus` | The install-progress popup stays open while pinned after outside pointer/focus, but explicit Escape still dismisses it. Forward these existing overlay options through Popover, preserving defaults for other consumers. |
| Busy Menu trigger attribute | Usage export must retain `aria-busy` on its actual trigger button while exporting. Include `"aria-busy"` in the existing `MenuProps.triggerAttributes` `Pick`; the trigger already spreads these attributes, so this allowance is type-only and requires no runtime change. |

Observed shared Menu defect: Provider picker [#170785](https://github.com/openclaw/openclaw/pull/170785), head `9f5823ce96cd8f809ba105b8fa2962a7754d1020`, loses selected-item focus after choosing `qwen-cn`, filling the synthetic credential, closing, and reopening with Enter. In menu phase `open`, `qwen-cn` retains `data-selected`, `data-initial-focus`, and `aria-checked="true"`, but the first `gemini-api-key` row owns `data-highlighted`, `tabindex="0"`, and `document.activeElement`. The same script and fixture pass on literal baseline `06001d846eefe470e7e9d04f10d4981355497ca8`. Pinned `@zag-js/menu@2.0.0-next.3` maps Enter/Space to `ARROW_DOWN`; controlled open queues a first-item highlight after native initial focus, then `useMenuMachine` follows `highlightedId` for keyboard focus. The shared adapter must align opening highlight with explicit initial focus while preserving Home/End navigation. Repair the owner on main; do not add a consumer retry or refocus workaround.

Owner handoff: `/tmp/w-wa-exit-menu-contract-handoff.md`. The retained `/tmp/solid2-wa-exit-popover-dismiss-options.patch` is a proposal for the W2 owner, not a branch to merge. Older Menu proposal files are historical: inspect the landed owner before adopting any hunk.

Activity and Sessions have complete proof but remain blocked by native landing guards: Activity's cancelled auxiliary jobs yield `UNSTABLE`; Sessions' retained partial-checkout journal names missing archive tests. Do not bypass either guard. Settings, Secrets, Folder, Cron, and Meetings are integrating actual main where a named failure or native `UNKNOWN` recovery requires it. The canonical sidebar roster repair landed in [#170708](https://github.com/openclaw/openclaw/pull/170708), merge `4ef51a7506977f3f689fb780da01cd3968753fe5`; preserve other unproven CI failures separately.

## Installed theme values

The five previously implicit values landed in #169696, merge `0890636ae1678f639dfb08138e3f8c38b3b25d9a`, and remain installed in `ui/src/styles/base.css`:

| Owned token | Installed value |
| --- | --- |
| `--control-ui-font-weight-normal` | `400` |
| `--control-ui-font-weight-semibold` | `500` |
| `--control-ui-transition-fast` | `75ms` |
| `--control-ui-focus-ring` | `solid 0.1875rem var(--ring)` |
| `--control-ui-focus-ring-offset` | `0.0625rem` |

Two unused `--wa-color-overlay-modal` declarations on native loading/Markdown modal hosts have a separate pending two-line cleanup patch. Native backdrop CSS already reads `--openclaw-modal-backdrop-color`, falling back to `--overlay-modal-backdrop`; removing those unused declarations preserves current native appearance. This does not permit removing the live settings help part rule.

## Proof and final package removal

The restored startup budget is **374,285 B JavaScript gzip and one startup CSS request** ([#170497](https://github.com/openclaw/openclaw/pull/170497)). Preserve every lazy boundary and report same-machine base/head startup measurements; page renderers and bridge registrations must not move into startup.

PR CI is the broad test runner. Add `ci:full` for overlays/focus/shared UI; it runs every UI unit, Control UI E2E, browser-extension, and real-Gateway shard. Locally run UI types and directly changed test files, one at a time. Capture only a few targeted synthetic before/after states, with one build per side when needed; inspect and embed them. Do not run local E2E batteries, whole suites, or parity runs. Attribute inherited failures by exact test name against the latest scheduled main run or matching base proof.

There is no zero-usage claim. Only when the actual-main WA inventory is zero may the final cut remove the dependency, lockfile entry, 3,096-line package patch and references, theme import, WA token bridges, `wa-light`/`wa-dark` toggles, registrations/types, and the PostCSS workaround with its config/tests. Regenerate generated outputs through their owners and retain native theme/accessibility/overlay proof through the prescribed focused checks and PR CI. No dependency version changes are part of these consumer cuts.
