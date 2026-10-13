# Web Awesome exit replacement map

Updated 2026-10-13 06:17 UTC. GitHub PR states below were read at that time; they are not CI or merge claims. Native primitive sources were inspected on main `bc745ece46ccd4682a9242f5978f4826a6b8235f`. This coordination map does not publish any prepared source or merge an unlanded lane.

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
| Usage export menu | `Menu`; existing export callbacks | Separate prepared cut; today’s API suffices, deferred while `usage.css` overlaps the query-filter PR |
| Group-defaults folder picker | Native modal; save/abort/late-result ownership | Open [#170566](https://github.com/openclaw/openclaw/pull/170566); mode menu remains a separate cut |
| Pet dismiss menu | Lazy `Menu`; existing dismiss actions and focus handoff | Open [#170568](https://github.com/openclaw/openclaw/pull/170568) |
| Plugin settings actions | `Menu`; editor lifecycle and nested Escape | Open [#170569](https://github.com/openclaw/openclaw/pull/170569) |
| Cron job-filter popup | `Popover`; existing filter owner | Open [#170580](https://github.com/openclaw/openclaw/pull/170580); independent of remaining Cron menus |
| Meetings reader tabs | `Tabs`; manual activation and panel IDs | Open [#170314](https://github.com/openclaw/openclaw/pull/170314) |
| Secret Store row actions | `Menu`; permissions, busy state, Edit/Delete, trigger title | Open [#170663](https://github.com/openclaw/openclaw/pull/170663); uses the existing public trigger handle, so no new primitive API is required |
| Provider picker | `Menu`; provider name/method/hint, selected-item focus, secret retention | Prepared private cut; needs item attributes and rich leaf content |
| Devices actions | `Menu`; action order, danger/disabled state and read-only reason | Prepared private cut; trigger metadata and disabled-item title remain API gaps |
| Remaining Cron menus | `Menu`; title, selected-row semantics, ordered groups | Prepared; item attributes and ordered non-action entries remain API gaps |
| Systems filter/sort | `Menu`; Sort/Status headings, radio groups, divider, `.session-menu__text` | Prepared; rich leaf content and ordered non-action entries remain API gaps |
| Group-defaults mode menu | `Menu`; exact trigger ID and selected `data-value` | Prepared; preserve stable root trigger metadata |
| Plugin install-progress popup | `Popover`; hover, focus, pinning, explicit Escape | Prepared; needs outside-pointer/focus dismissal options exposed by Popover |

## Other active owners

W-WA-EXIT-2 browser/terminal native viewports landed in [#169587](https://github.com/openclaw/openclaw/pull/169587). Its follow-ups remain open: native-link actions [#170378](https://github.com/openclaw/openclaw/pull/170378) and obsolete browser tab-panel registration [#170471](https://github.com/openclaw/openclaw/pull/170471). Do not assume their proposed shared hooks exist on main until inspected there.

Shared pickers/dialogs/toast remain with PRIM-C2 [#170387](https://github.com/openclaw/openclaw/pull/170387); sidebar work remains with [#168852](https://github.com/openclaw/openclaw/pull/168852). Board, Markdown, config-form, and chat consumers retain their assigned owners. In particular, `config-form.render.tsx` still renders the settings help `<wa-popover>` on inspected main: `.settings-section__help-popover::part(body)` remains live and must move with that consumer.

## Exact remaining primitive contracts

These are narrow presentation adapters, not new domain owners. Current main's `MenuItem.content` is only used under submenus; `Menu.children` prepends content and cannot interleave groups.

| Needed API | Concrete contract |
| --- | --- |
| `Menu.triggerAttributes` | Preserve title on Cron/Devices/System triggers. Preserve explicit root trigger ID and caller-supplied root `data-value` for group-defaults mode; nested triggers retain authoritative item identity. Secret Store's newer cut already preserves title through the public trigger handle. |
| `MenuItem.title` | A disabled Devices pairing action retains the localized read-only reason. An undefined dedicated title must not erase a supplied attribute. |
| `MenuItem.attributes` | Provider rows retain `data-manual-provider`, `data-selected`, and `data-initial-focus`; selected Cron rows retain `aria-current`. Primitive-owned identity/role/disabled state remain authoritative. |
| Rich leaf `MenuItem.content` | Render provider name + method + hint and Systems `.session-menu__text`, while `label` remains the accessible name and typeahead text. |
| Ordered content entries (`MenuEntry` or equivalent) | Preserve Sort heading → three radios → separator + Status heading → three radios, and Cron action dividers. Decorative entries must not join keyboard navigation. |
| `Popover.dismissOutsidePointer` / `dismissOutsideFocus` | `pages/plugins/install-action.tsx` currently controls a `wa-popup`: pinned progress survives outside pointer/focus, unpinned hover/focus handlers may close it, and Escape dismisses it. Forward false for both outside policies to the existing overlay owner; preserve defaults for other consumers and retain native Escape. |

Owner handoff: `/tmp/w-wa-exit-menu-contract-handoff.md`. Retained proposals: `/tmp/w-wa-exit-native-api-b285afec.patch`, `/tmp/session-menu-menu-entry.patch`, and `/tmp/solid2-wa-exit-popover-dismiss-options.patch`. They are proposals for the W2 owner, not code to merge from an unlanded branch. Activity, Sessions, Usage, Pet, plugin settings, the Cron filter popup, folder modal, and the newer Secret Store cut can use today's primitives independently.

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
