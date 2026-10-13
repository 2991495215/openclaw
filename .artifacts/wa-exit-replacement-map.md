# Web Awesome exit replacement map

Updated on 2026-10-12 against main `08c29ebe2a2f46b0e7c27861a8c9180d5db30e4c`. This is a coordination artifact. Landed work is linked explicitly; prepared patches, test compositions, and private focused cuts are not on main.

## Ownership

- **W-WA-EXIT:** pages except `pages/chat/**` and `pages/new-session/**`; shared styles/theme; `types/`; `app/`; this map; existing `components/lobster-pet*` and `components/session-group-defaults-dialog*` work.
- **W-WA-EXIT-2:** all other `components/**` and `lib/**` Web Awesome removal. Preserve active lane ownership while their ports are still in progress.
- **Chat/new-session lanes:** their remaining WA sites. The composer, sidebar/rails/headers, config form, and picker lanes still own their active ports.

The native PRIM-B primitives landed in [#169128](https://github.com/openclaw/openclaw/pull/169128), merge `b68c44ca8f3ca9d0d4bccb7b620f867547e4cd55`; the remaining consumer work uses those owners rather than a separate prerequisite branch. The shared JSDOM Popover fixture is on main through [#169466](https://github.com/openclaw/openclaw/pull/169466), merge `14c397b921a5366423fd9eb2e7c17a72c08480be`. The missing W-WA-EXIT-2 API extensions are listed below and must not be confused with the landed base primitives.

## Sites and replacements

| Existing site | Replacement / contract | Owner and state |
| --- | --- | --- |
| Activity tool/person filter popovers | `Popover`; existing filter owners and trigger IDs | W-WA-EXIT, prepared |
| Cron job/run filters and row actions | `Popover` / `Menu`; existing controller actions | W-WA-EXIT, full batch prepared; focused JobsFilterPopover cut private, pending publication proof |
| Devices row actions | `Menu`; disabled/danger state and action ordering | W-WA-EXIT, prepared |
| Sessions advanced filters | `Popover`; native inputs, existing grouping/filter owner | W-WA-EXIT, prepared |
| Usage export and query menus | `Menu`; existing export/query callbacks | W-WA-EXIT, prepared |
| Worktrees tabs | `Tabs` / `TabPanel`; existing tab owner | W-WA-EXIT, public [#170446](https://github.com/openclaw/openclaw/pull/170446) open at `08114a52cd5c02d4767499bd89ce7fb9dc5f4348`; current successor private, pending proof/publication |
| Secrets row actions | `Menu`; existing secret action owner | W-WA-EXIT, prepared |
| Provider picker / group defaults dialog | `Menu`; searchable provider rows, exact trigger IDs | W-WA-EXIT, prepared |
| Pet dismiss menu | `Menu`, loaded only when opened | W-WA-EXIT, prepared |
| Plugin settings actions | `Menu` | W-WA-EXIT, prepared |
| Plugins discovery/settings and Skill workshop standalone panels | Native `div[role=tabpanel]`; existing IDs, labels and keyboard focusability | W-WA-EXIT, landed [#169901](https://github.com/openclaw/openclaw/pull/169901), merge `92f2a8c273372c27f391c4ee44b59fbdf888171e` |
| Plugin install progress popup | `Popover`; preserve hover/pin intent and shared Escape ownership | W-WA-EXIT, prepared; needs two existing overlay options exposed by W-WA-EXIT-2 |
| Meetings reader tabs | `Tabs`; manual activation, existing panel IDs | W-WA-EXIT, public [#170314](https://github.com/openclaw/openclaw/pull/170314) open at `ef1f4e22c3609d6494df816f580ff1086b1bed30`; successor private, awaiting the landed Worktrees forced-color style fix |
| Systems sidebar filter/sort | `Menu`; ordered headings and radio entries | W-WA-EXIT, prepared; requires `MenuEntry` content rows from W-WA-EXIT-2 |
| Catalog session menu | `Menu`; action-before-close, external return focus | W-WA-EXIT-2, prepared draft handed off |
| Shared session menu and communication options | `Menu`; embedded controls and nested menus | W-WA-EXIT-2, prepared draft handed off; legacy callers still need migration |
| Mermaid actions | `Menu`; source/diagram, expand, title, 4 px gap | W-WA-EXIT-2, prepared draft handed off |
| Board tabs/widget menus | `Tabs` / `Menu`; preserve data-board-tab-id | W-WA-EXIT-2, draft handed off; legacy widget helper still called by active chat header lane |
| Browser/Terminal active tab panels | Native `div[role=tabpanel]`; preserve IDs/classes/events | W-WA-EXIT-2, prepared draft handed off |
| Sidebar menus / select-picker / multi-select / agent pickers | Owned Menu/Popover/picker primitives; retain current active-lane contracts | W-WA-EXIT-2 coordinates with assigned sidebar/picker lanes |
| Config form / language picker | Owned select/menu primitives | Config cut landed [#169046](https://github.com/openclaw/openclaw/pull/169046), merge `b8d31e961294ff7eaf4e1e4b399a3c2ff3eea3f1`, deleting `pages/config/language-select.ts`; language controls landed separately [#170237](https://github.com/openclaw/openclaw/pull/170237), merge `34617209ac59c6d336904d57a3112192b7d2c926` |
| Chat / new-session menus, pickers, previews | Owned primitives in each rendering consumer | Active chat/new-session lanes |
| `hub-tabs`, `panel-tab-strip`, modal, tooltip, native-link-menu | PRIM-B owners | PRIM-B; do not duplicate |

## Remaining primitive API work for W-WA-EXIT-2

At the inspected main pin, `MenuProps.triggerAttributes` is still absent. Checkbox/radio entries, `checked`, and per-item `closeOnSelect` are available. `MenuItem.content` is consumed only for nested-menu children: leaf items still render a label and optional details, so arbitrary leaf rich/content rows are absent. Root Menu children do not supply that leaf-row contract.

`dismissOutsidePointer` and `dismissOutsideFocus` already belong to lower-level `OverlayOptions`, but neither Menu nor Popover exposes caller forwarding. Plugin install progress still needs Popover forwarding; full Cron and Usage menu cuts still need trigger metadata for titles and `aria-busy`. The focused JobsFilterPopover cut uses the existing external anchor and Popover handle, so it does not depend on these gaps.

The page drafts consume these narrow extensions. Their prepared patches live on the shared host; copy/review them rather than starting another implementation.

| Patch | Contract |
| --- | --- |
| `/tmp/w-wa-exit-native-api-b285afec.patch` | Menu item `title` and typed HTML/data attributes; constrained trigger attributes and stable trigger ID; live inherited CSS direction, including changes after mount; refresh placement when opening. Historical prepared patch; rebase and review against the landed primitive owner before use. |
| `/tmp/session-menu-menu-entry.patch` | Ordered discriminated `MenuEntry` content rows; per-submenu open callback; nested metadata forwarding; deduplicate repeated close notifications on disposal. |
| `/tmp/solid2-wa-exit-popover-dismiss-options.patch` | Forward existing `dismissOutsidePointer` / `dismissOutsideFocus` options through Popover. Defaults unchanged. Install progress sets both false while retaining shared Escape handling. |
| Board draft's separate Tabs patch | Typed attributes before owned tab attributes, solely to retain existing `data-board-tab-id` selectors. |

Do not restore removed reactive projection scaffolding: adopt only a thin projection with its first production caller. The current drafts retain their existing domain owners.

The final Menu contract must preserve an explicit root `triggerAttributes.id` and the root caller's `data-value`; nested item IDs remain authoritative for nested triggers. The earlier W-WA-EXIT-2 draft preserved root `data-value` but lacked the stable ID; the frozen nested-menu composition supported the ID but overwrote the root value with `undefined`. These are historical draft defects, not descriptions of a landed trigger-attributes API. Owner handoff: `/tmp/w-wa-exit-menu-contract-handoff.md`. Resolve this in the primitive owner before final page proof.

## Prepared consumer patches and proof locations

- W-WA-EXIT production branch: `solid2/w-wa-exit`; first page batch is still uncommitted. Recovery patch: `/tmp/w-wa-exit-first-current-main.patch`.
- Page follow-ups: `/tmp/openclaw-wa-meetings.patch`, `/tmp/solid2-wa-exit-plugin-actions.patch`. Systems page changes are the `pages/systems/**` and matching styles hunks within `/tmp/openclaw-wa-exit-misc.patch`.
- W-WA-EXIT-2 handoff: `/tmp/w-wa-exit-mermaid.patch`, `/tmp/openclaw-wa-viewports.patch`, Catalog hunks in `/tmp/openclaw-wa-exit-misc.patch`, and `/tmp/session-menu-wa-exit.patch`. The session-menu worker is preserving its final test migration and reporting remaining proof. Board worker is preserving its draft separately.
- Shared native test helper: `/tmp/w-wa-exit-menu-helper.ts` (also staged as `ui/src/test-helpers/menu.ts` in the first worktree). It opens/selects real native controls rather than dispatching synthetic WA events. Coordinate one owner for this helper.
- Historical test-only composition: `/tmp/openclaw-wa-exit-next`, based on main `112c4900cf36a`, with exact PRIM-B prerequisite files plus the proposed extensions. It preserves main's Solid rc.14 pins; only the three already-approved Zag dependency pins were added for proof. **Do not publish this composition or count it as a main merge.**

Initial first-batch tests, typecheck, focused E2E, native overlay suites, and screenshots were exercised on an earlier exact PRIM-B composition. The retained historical composition reported Mermaid's ten existing unit cases passing. Final page proof must use the actual landed primitives and exact current main input, with any required W-WA-EXIT-2 extensions integrated explicitly. Earlier composition proof does not establish current-main consumer readiness. Native-menu close/dispose regression and focused session-menu tests also have prepared proof; preserve the reported exact source identity.

The focused Cron patch and readiness record remain at `/tmp/w-wa-exit-cron-popover-only.lqi8azi9/cron-jobs-popover-only.patch` and `/tmp/w-wa-exit-cron-popover-only.lqi8azi9/readiness.json`. Its private signed candidate includes main `e78a253059eb07d70ea3f7140e1c4e9b9fadc383`, changes only `pages/cron/view-jobs-filter.tsx` and `styles/cron.css`, and removes the caller's duplicate Popover visibility owner. It is unpublished; runtime/browser publication proof is still pending. The public Meetings and Worktrees PRs above are open, not landed; their successors remain private. Meetings waits for the Worktrees forced-color style fix to land before successor proof. The coordinator owns the remaining proof and publication.

## Theme and final removal

The five previously implicit values and the stylesheet consumer cutover landed in [#169696](https://github.com/openclaw/openclaw/pull/169696), merge `0890636ae1678f639dfb08138e3f8c38b3b25d9a`:

| Owned token | Value |
| --- | --- |
| `--control-ui-font-weight-normal` | `400` |
| `--control-ui-font-weight-semibold` | `500` |
| `--control-ui-transition-fast` | `75ms` |
| `--control-ui-focus-ring` | `solid 0.1875rem var(--ring)` |
| `--control-ui-focus-ring-offset` | `0.0625rem` |

The landed stylesheet cutover covers `styles/select-picker.css`, `styles/sidebar-menus.css`, and `styles/chat/composer.css`. The landed PRIM-B owner replaces the old tooltip implementation. Theme proof matched eight computed-style profiles and twelve screenshot pairs; startup JS gzip fell from 410,332 to 410,315 B.

The remaining unused stylesheet-token cleanup landed in [#170128](https://github.com/openclaw/openclaw/pull/170128), merge `335d12304b010b5447dd8cfb96565e8444fbe150`. Its reported proof covers 32 captured frames; startup JS gzip changed from 411,170 to 411,158 B (−12 B). This is a separate measured input from the Theme proof above.

The retained main AST inventory at exact pin `e78a253059eb07d70ea3f7140e1c4e9b9fadc383` counts **190 production WA tags** across `ui/src`, `extensions/workboard/browser`, and `extensions/x/src`; its artifact is `/tmp/w-wa-exit-main-e78-inventory.json`. Main has since advanced to the pin in this map's opening; no newer inventory was run for this static refresh. The historical partial test composition counted **162** before session-menu and Board follow-ups. Neither count establishes zero usage on main. **The exit condition is zero remaining WA consumers on main**, followed by the dependency and bootstrap removal below.

Only after all consumers are gone: remove Web Awesome from `ui/package.json` and regenerate the lockfile; remove its workspace patch entry, patch file/README/checker references; theme import; `wa-light` / `wa-dark` bootstrap toggles; WA token bridges/selectors/types/registrations; PostCSS workaround and its tests/config references. Regenerate the boot manifest through its owner. Final proof includes themed/RTL/large-text/forced-color/reduced-motion styles, Chromium/WebKit overlay contracts, UI build and startup measurement.

The current worker rules permit 450,000 B gzip startup JS and two startup CSS requests during migration. Preserve lazy boundaries, report both measurements, add `ci:full` before landing a run that changes overlays/focus, and attribute inherited reds by exact failing test name against the latest scheduled main run (or reproduce on the merge base).
