# Web Awesome exit replacement map

Updated on 2026-10-12 after the coordinator split. This is a coordination artifact, not a statement that the unlanded replacements are on main.

## Ownership

- **W-WA-EXIT:** pages except `pages/chat/**` and `pages/new-session/**`; shared styles/theme; `types/`; `app/`; this map; existing `components/lobster-pet*` and `components/session-group-defaults-dialog*` work.
- **W-WA-EXIT-2:** all other `components/**` and `lib/**` Web Awesome removal. Preserve active lane ownership while their ports are still in progress.
- **Chat/new-session lanes:** their remaining WA sites. The composer, sidebar/rails/headers, config form, and picker lanes still own their active ports.

PRIM-B is still a prerequisite. The latest inspected API is `285afec0b35db0bfd6320f854ae02216aab61b01` on `origin/solid2/p2-prim-b`; it was not merged into the W-WA-EXIT production branch. Test-only compositions are explicitly identified below. The shared JSDOM Popover fixture is on main through [#169466](https://github.com/openclaw/openclaw/pull/169466), merge `14c397b921a5366423fd9eb2e7c17a72c08480be`.

## Sites and replacements

| Existing site | Replacement / contract | Owner and state |
| --- | --- | --- |
| Activity tool/person filter popovers | `Popover`; existing filter owners and trigger IDs | W-WA-EXIT, prepared |
| Cron job/run filters and row actions | `Popover` / `Menu`; existing controller actions | W-WA-EXIT, prepared |
| Devices row actions | `Menu`; disabled/danger state and action ordering | W-WA-EXIT, prepared |
| Sessions advanced filters | `Popover`; native inputs, existing grouping/filter owner | W-WA-EXIT, prepared |
| Usage export and query menus | `Menu`; existing export/query callbacks | W-WA-EXIT, prepared |
| Worktrees tabs | `Tabs` / `TabPanel`; existing tab owner | W-WA-EXIT, prepared |
| Secrets row actions | `Menu`; existing secret action owner | W-WA-EXIT, prepared |
| Provider picker / group defaults dialog | `Menu`; searchable provider rows, exact trigger IDs | W-WA-EXIT, prepared |
| Pet dismiss menu | `Menu`, loaded only when opened | W-WA-EXIT, prepared |
| Plugin settings actions | `Menu` | W-WA-EXIT, prepared |
| Plugins discovery/settings and Skill workshop standalone panels | Native `div[role=tabpanel]`; existing IDs, labels and keyboard focusability | W-WA-EXIT, [#169901](https://github.com/openclaw/openclaw/pull/169901), awaiting CI failure attribution |
| Plugin install progress popup | `Popover`; preserve hover/pin intent and shared Escape ownership | W-WA-EXIT, prepared; needs two existing overlay options exposed by W-WA-EXIT-2 |
| Meetings reader tabs | `Tabs`; manual activation, existing panel IDs | W-WA-EXIT, prepared |
| Systems sidebar filter/sort | `Menu`; ordered headings and radio entries | W-WA-EXIT, prepared; requires `MenuEntry` content rows from W-WA-EXIT-2 |
| Catalog session menu | `Menu`; action-before-close, external return focus | W-WA-EXIT-2, prepared draft handed off |
| Shared session menu and communication options | `Menu`; embedded controls and nested menus | W-WA-EXIT-2, prepared draft handed off; legacy callers still need migration |
| Mermaid actions | `Menu`; source/diagram, expand, title, 4 px gap | W-WA-EXIT-2, prepared draft handed off |
| Board tabs/widget menus | `Tabs` / `Menu`; preserve data-board-tab-id | W-WA-EXIT-2, draft handed off; legacy widget helper still called by active chat header lane |
| Browser/Terminal active tab panels | Native `div[role=tabpanel]`; preserve IDs/classes/events | W-WA-EXIT-2, prepared draft handed off |
| Sidebar menus / select-picker / multi-select / agent pickers | Owned Menu/Popover/picker primitives; retain current active-lane contracts | W-WA-EXIT-2 coordinates with assigned sidebar/picker lanes |
| Config form / language picker | Owned select/menu primitives | Active config lane; [#169046](https://github.com/openclaw/openclaw/pull/169046) deletes `pages/config/language-select.ts` |
| Chat / new-session menus, pickers, previews | Owned primitives in each rendering consumer | Active chat/new-session lanes |
| `hub-tabs`, `panel-tab-strip`, modal, tooltip, native-link-menu | PRIM-B owners | PRIM-B; do not duplicate |

## Agreed primitive API work for W-WA-EXIT-2

The page drafts consume these narrow extensions. Their prepared patches live on the shared host; copy/review them rather than starting another implementation.

| Patch | Contract |
| --- | --- |
| `/tmp/w-wa-exit-native-api-b285afec.patch` | Menu item `title` and typed HTML/data attributes; constrained trigger attributes and stable trigger ID; live inherited CSS direction, including changes after mount; refresh placement when opening. Retains newer PRIM-B fixes. |
| `/tmp/session-menu-menu-entry.patch` | Ordered discriminated `MenuEntry` content rows; per-submenu open callback; nested metadata forwarding; deduplicate repeated close notifications on disposal. |
| `/tmp/solid2-wa-exit-popover-dismiss-options.patch` | Forward existing `dismissOutsidePointer` / `dismissOutsideFocus` options through Popover. Defaults unchanged. Install progress sets both false while retaining shared Escape handling. |
| Board draft's separate Tabs patch | Typed attributes before owned tab attributes, solely to retain existing `data-board-tab-id` selectors. |

Do not restore removed reactive projection scaffolding: adopt only a thin projection with its first production caller. The current drafts retain their existing domain owners.

The final Menu contract must preserve an explicit root `triggerAttributes.id` and the root caller's `data-value`; nested item IDs remain authoritative for nested triggers. The inspected W-WA-EXIT-2 draft preserves root `data-value` but still lacks the stable ID. The frozen nested-menu composition supports the ID but overwrites the root value with `undefined`. Owner handoff: `/tmp/w-wa-exit-menu-contract-handoff.md`. Resolve this in the primitive owner before final page proof.

## Prepared consumer patches and proof locations

- W-WA-EXIT production branch: `solid2/w-wa-exit`; first page batch is still uncommitted. Recovery patch: `/tmp/w-wa-exit-first-current-main.patch`.
- Page follow-ups: `/tmp/openclaw-wa-meetings.patch`, `/tmp/solid2-wa-exit-plugin-actions.patch`. Systems page changes are the `pages/systems/**` and matching styles hunks within `/tmp/openclaw-wa-exit-misc.patch`.
- W-WA-EXIT-2 handoff: `/tmp/w-wa-exit-mermaid.patch`, `/tmp/openclaw-wa-viewports.patch`, Catalog hunks in `/tmp/openclaw-wa-exit-misc.patch`, and `/tmp/session-menu-wa-exit.patch`. The session-menu worker is preserving its final test migration and reporting remaining proof. Board worker is preserving its draft separately.
- Shared native test helper: `/tmp/w-wa-exit-menu-helper.ts` (also untracked `ui/src/test-helpers/menu.ts` in the first worktree). It opens/selects real native controls rather than dispatching synthetic WA events. Coordinate one owner for this helper.
- Current test-only composition: `/tmp/openclaw-wa-exit-next`, based on main `112c4900cf36a`, with exact PRIM-B prerequisite files plus the proposed extensions. It preserves main's Solid rc.14 pins; only the three already-approved Zag dependency pins were added for proof. **Do not publish this composition or count it as a main merge.**

Initial first-batch tests, typecheck, focused E2E, native overlay suites, and screenshots were exercised on an earlier exact PRIM-B composition. On the latest composition, Mermaid's ten existing unit cases pass. Final page proof must use the actual main prerequisite after PRIM-B lands. Native-menu close/dispose regression and focused session-menu tests also have prepared proof; preserve the reported exact source identity.

## Theme and final removal

The five previously implicit values and the stylesheet consumer cutover landed in [#169696](https://github.com/openclaw/openclaw/pull/169696), merge `0890636ae1678f639dfb08138e3f8c38b3b25d9a`:

| Owned token | Value |
| --- | --- |
| `--control-ui-font-weight-normal` | `400` |
| `--control-ui-font-weight-semibold` | `500` |
| `--control-ui-transition-fast` | `75ms` |
| `--control-ui-focus-ring` | `solid 0.1875rem var(--ring)` |
| `--control-ui-focus-ring-offset` | `0.0625rem` |

The landed stylesheet cutover covers `styles/select-picker.css`, `styles/sidebar-menus.css`, and `styles/chat/composer.css`. PRIM-B replaces the old tooltip implementation. Theme proof matched eight computed-style profiles and twelve screenshot pairs; startup JS gzip fell from 410,332 to 410,315 B.

The latest retained main AST inventory, pinned to `28df9fe159fc`, counted **202 WA tags**. The partial test composition counted **162**, before the session-menu and Board follow-ups. These are source snapshots, not a zero-usage claim.

Only after all consumers are gone: remove Web Awesome from `ui/package.json` and regenerate the lockfile; remove its workspace patch entry, patch file/README/checker references; theme import; `wa-light` / `wa-dark` bootstrap toggles; WA token bridges/selectors/types/registrations; PostCSS workaround and its tests/config references. Regenerate the boot manifest through its owner. Final proof includes themed/RTL/large-text/forced-color/reduced-motion styles, Chromium/WebKit overlay contracts, UI build and startup measurement.

The current worker rules permit 450,000 B gzip startup JS and two startup CSS requests during migration. Preserve lazy boundaries, report both measurements, add `ci:full` before landing a run that changes overlays/focus, and attribute inherited reds by exact failing test name against the latest scheduled main run (or reproduce on the merge base).
