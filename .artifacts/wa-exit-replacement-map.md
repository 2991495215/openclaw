# Web Awesome exit replacement map

Updated 2026-10-13 21:35 UTC. Statuses are snapshots, not live merge claims. The completed source inventory is pinned to main `28c66ec624bb32e3c1c2ec0720a42e597fd00c13`; the two open PR heads are recorded below. This coordination note distinguishes 21 landed W-WA-EXIT cuts from open consumers and the final package-removal tail; it does not claim that Web Awesome is gone.

## Ownership

- **W-WA-EXIT:** pages except `pages/chat/**` and `pages/new-session/**`; shared styles/theme, `types/`, `app/`, this map, and existing `components/lobster-pet*` / `components/session-group-defaults-dialog*` work.
- **W-WA-EXIT-2:** other `components/**` and `lib/**` Web Awesome removal, coordinated with their active owners.
- **Other active lanes:** chat/new-session, sidebar, config form, picker, and shared primitive ports retain their assigned files. Do not edit another lane's implementation to unblock a consumer. Terminal fixtures are now in W-WA-EXIT scope for Provider/Export failure repairs; chat tests are in scope only when absent from the chat-pane branch diff. Fixture changes must follow causal CI evidence, not mask a regression.

PRIM-B landed in [#169128](https://github.com/openclaw/openclaw/pull/169128), merge `b68c44ca8f3ca9d0d4bccb7b620f867547e4cd55`. The shared JSDOM Popover fixture landed in [#169466](https://github.com/openclaw/openclaw/pull/169466), merge `14c397b921a5366423fd9eb2e7c17a72c08480be`. Consumers use the landed owners; never merge an unlanded lane branch.

## Landed W-WA-EXIT cuts

| Surface | Replacement | PR / merge |
| --- | --- | --- |
| Activity tool/person filters | `Popover`, existing filter owners | [#170570](https://github.com/openclaw/openclaw/pull/170570), `6dbbb5925efd24e61d7b44637afc12f79eb0ace2` |
| Plugin settings actions | `Menu`, existing reset/ask actions | [#170569](https://github.com/openclaw/openclaw/pull/170569), `bfb6a4b4be71d7a17176505659e25a10c68cd09a` |
| Cron job/run filters | `Popover`, existing controller | [#170580](https://github.com/openclaw/openclaw/pull/170580), `1aeab0fc15c2b5e9431d8cde386ae21546af6010` |
| Secrets row actions | `Menu` | [#170663](https://github.com/openclaw/openclaw/pull/170663), `08c2df68ea6d7ca5ed27aa8a5cc97ab2eb04adb6` |
| Systems filter/sort | `Menu`, ordered headings and radio entries | [#170786](https://github.com/openclaw/openclaw/pull/170786), `7ae69497bec4d9c37f170f046a3cbbf954ff19a7` |
| Pet dismiss menu | Lazy `Menu` | [#170568](https://github.com/openclaw/openclaw/pull/170568), `8b1315ac0cb1834b683186d7eab01f18d65b3d66` |
| Worktrees tabs | `Tabs` / `TabPanel` | [#170446](https://github.com/openclaw/openclaw/pull/170446), `b9bb50052387b504987622b3072c5716d69225f1` |
| Five implicit theme values | Owned Control UI tokens | [#169696](https://github.com/openclaw/openclaw/pull/169696), `0890636ae1678f639dfb08138e3f8c38b3b25d9a` |
| Plugin and Skill workshop panels | Native `div[role=tabpanel]` | [#169901](https://github.com/openclaw/openclaw/pull/169901), `92f2a8c273372c27f391c4ee44b59fbdf888171e` |
| Language controls | Owned select/menu controls | [#170237](https://github.com/openclaw/openclaw/pull/170237), `34617209ac59c6d336904d57a3112192b7d2c926` |
| Unused stylesheet tokens | Owned selectors/tokens | [#170128](https://github.com/openclaw/openclaw/pull/170128), `335d12304b010b5447dd8cfb96565e8444fbe150` |
| Devices row actions | `Menu` | [#170784](https://github.com/openclaw/openclaw/pull/170784), `8815aa67b132bad4a710ae7d58afd6b328ce55fa` |
| Remaining Cron menus | `Menu` | [#170917](https://github.com/openclaw/openclaw/pull/170917), `fd9b49fb7628d490c98e50ac422b1128f7ae8412` |
| Folder defaults controls | Owned controls | [#170566](https://github.com/openclaw/openclaw/pull/170566), `24a0c839f5ec86d569d2a16531e8e2bb95d77ff2` |
| Meetings reader tabs | `Tabs`, manual activation and existing panel IDs | [#170314](https://github.com/openclaw/openclaw/pull/170314), `7ff7af1773a6c0107f36d52dcb0e44f6d2a200fd` |
| Sessions advanced filters | `Popover`, native inputs and existing filter owner | [#170565](https://github.com/openclaw/openclaw/pull/170565), `71a4b8fb5d3889a645dc02bdafca675e0eda7d36` |
| Usage query filters | `Menu`, existing query owner and callbacks | [#170567](https://github.com/openclaw/openclaw/pull/170567), `e2df637d6058537b4a289306e2b97708b990dd13` |
| Shared menu/popover contracts | Stable root trigger ID, typed busy state, caller-selected Tab destination and pinned outside-dismissal policy | [#171269](https://github.com/openclaw/openclaw/pull/171269), `dab8518dfd4c42aef20d59a5c062e14398dd89e7` |
| Retired select styling and pet obstacle selector | Remove stale vendor selectors after owned-control migration | [#171302](https://github.com/openclaw/openclaw/pull/171302), `55eb758f6992fe726231c1c6a85c13e7757a55fe` |
| Group mode menu | `Menu`, exact root trigger ID and existing modal settlement | [#171343](https://github.com/openclaw/openclaw/pull/171343), `9f82f6501fae017ab3814c1f7674ed9a0638d935` |
| Plugin install progress | `Popover`, hover/pin intent, shared Escape owner and closing-phase focus-return guard | [#171346](https://github.com/openclaw/openclaw/pull/171346), `cf28acc7d32251dcb215329028ad8059281368fb` |

## Active consumers

The two remaining root consumer PRs are open at these recorded heads and build against the landed shared contracts. Provider/Export need attribution and repair of their CI failures. Install progress completed native landing after its transient gate-publisher failure cleared; its merge is recorded above.

| Surface | Replacement / retained contract | PR / recorded head |
| --- | --- | --- |
| Provider picker | Searchable `Menu`, selected-option focus and existing credential Tab flow; shared `tabFocusTarget` replaces local keyboard handling | [#170785](https://github.com/openclaw/openclaw/pull/170785), `7bb99b4f4dd6af6b9a1c1322f6247fc0c94b8e96` |
| Usage export | `Menu`, existing export callbacks and typed trigger busy state | [#171347](https://github.com/openclaw/openclaw/pull/171347), `092596505d2c6939c887337775bff8f95b52a626` |

Other consumer ownership remains unchanged:

| Surface | Replacement / retained contract | Owner |
| --- | --- | --- |
| Catalog / session menus / communication options | `Menu`, action-before-close, nested controls and return focus | W-WA-EXIT-2 and current session-menu owners. |
| Mermaid / Board actions and tabs | `Menu` / `Tabs`, preserve selectors | W-WA-EXIT-2 and Board owner. |
| Browser/Terminal panels | Native `div[role=tabpanel]`, preserve IDs/classes/events | W-WA-EXIT-2 with current viewport owners. |
| Sidebar / shared pickers | Owned Menu/Popover/picker primitives | Sidebar and PRIM-C2 owners; active work must land on main first. |
| Chat / new-session menus and previews | Owned primitives in each renderer | Active chat/new-session lanes. |

Usage's original sidebar RTL failure was not classified as inherited. After the PRIM-C2 Owners-picker occlusion fix landed and Usage merged actual main, the exact RTL case and all three UI-unit shards passed. The later SQLite build failures were separately attributed to main in the native evidence; Usage's native landing is complete.

## Shared primitive contracts

The contracts below are on main through #171269, merge `dab8518dfd4c42aef20d59a5c062e14398dd89e7`. Consumers should use these owners directly.

PRIM-C2 [#170387](https://github.com/openclaw/openclaw/pull/170387), merge `ecdc40dbcf9bfc4c083237fdfa69ea949088f27c`, now owns selected-item keyboard reopening. Its menu-machine implementation is preserved unchanged by the #171269 extension. Do not add consumer refocus or retry handlers.

| Landed contract | Consumer | Ownership |
| --- | --- | --- |
| Explicit root `triggerAttributes.id` | Group mode | Passed into both Zag IDs and the rendered trigger; nested IDs remain owned. |
| Typed trigger `aria-busy` | Usage export | Extends the constrained trigger attribute type. |
| `tabFocusTarget(backward)` | Provider | The existing Menu handler dismisses and honors vetoes before focusing the supplied destination. |
| `dismissOutsidePointer` / `dismissOutsideFocus` | Install progress | Popover forwards live options to the existing lifecycle owner; Escape stays with that owner. |

#171269's Chromium menu file passed 16 cases. Its new pinned-popover case passed Chromium and WebKit. Four existing WebKit native-Tab/button-focus cases failed identically on untouched PRIM-C2 main; their exact names and evidence are recorded in the PR. That PR's CI skipped WebKit, so its hosted run is not WebKit coverage. The shared API has no second dismissal owner and adds no startup imports.

Recheck actual main before integrating a prerequisite. Read unlanded branches only; merge `origin/main`, never a lane branch. Historical draft patches do not override the current owner API or count as final proof.

## Preserved primary drafts

The earlier read-only dirty-path audit accounted for all 82 original paths against the then-19 landed cuts and four active consumer PRs. Group mode has since landed; the classifications below preserve that audit snapshot. Index blobs, working-file bytes and status records remained unchanged. Scope attribution is not exact-byte parity and grants no permission to discard historical drafts.

| Classification | Distinct paths |
| --- | ---: |
| Landed PR scope | 60 |
| Active consumer PR scope | 18 |
| Other-lane work already landed or superseded | 2 |
| Unrepresented residuals | 2 |

The residuals are the staged 31-line `ui/src/test-helpers/menu.ts` draft, absent from main and all 23 PR file sets, and the unstaged one-line removal of the `web-awesome.ts` import in `ui/src/pages/sessions/session-row.tsx`, whose ownership is unestablished and whose import is still on the inventory head. Preserve both for explicit reconciliation. The group unit-test draft is folder-selector work already covered by #170566. The Usage overview tooltip-selector edit is superseded by PRIM-B #169128, not an omitted export change. No primary draft was restored, deleted or staged during the audit.

## Theme and final package removal

The five formerly implicit values are already owned by Control UI:

| Token | Value |
| --- | --- |
| `--control-ui-font-weight-normal` | `400` |
| `--control-ui-font-weight-semibold` | `500` |
| `--control-ui-transition-fast` | `75ms` |
| `--control-ui-focus-ring` | `solid 0.1875rem var(--ring)` |
| `--control-ui-focus-ring-offset` | `0.0625rem` |

The official `pnpm ui:solid:inventory --json --ref 28c66ec624bb32e3c1c2ec0720a42e597fd00c13` AST inventory counts **107 production WA tag sites in 38 files** (tests excluded). These counts cover rendered tags, not CSS selectors, imports, or live custom-event names. Every remaining file is listed below so the final sweep can find its owner and replacement without treating those other contracts as already removed.

| Owner | Tags | Files |
| --- | ---: | ---: |
| W-WA-EXIT root consumers | 6 | 2 |
| Chat | 61 | 19 |
| Sidebar | 25 | 8 |
| W-WA-EXIT-2/3 components | 10 | 5 |
| New session | 5 | 4 |

Main #171349 removed 17 chat sites in eight files after the previous 125-site snapshot; #171346 then removed the remaining install-progress tag. The root sites are covered by the two open PRs above. The other **101 tags in 36 files** remain external prerequisites even after those PRs land. Re-run the inventory at the final candidate; this is not a zero-usage claim. The replacement column names existing owners; each lane must preserve its surface's focus, selectors, styles and dismissal contract.

| File under `ui/src/` | Sites | Owner | Replacement |
| --- | ---: | --- | --- |
| `components/app-sidebar-agent-menu.ts` | 3 | Sidebar | `Menu` |
| `components/app-sidebar-identity-menu.ts` | 4 | Sidebar | `Menu` |
| `components/app-sidebar-nav-menus.ts` | 3 | Sidebar | `Menu` |
| `components/app-sidebar-session-menu-renderers.ts` | 5 | Sidebar | `Menu`; `SettingsToggle` or native checkbox |
| `components/board/board-widget-cell-render.solid.tsx` | 4 | W-WA-EXIT-2/3 | `Menu` |
| `components/new-session-link.ts` | 2 | W-WA-EXIT-2/3 | `Menu` |
| `components/session-menu-compact.ts` | 2 | W-WA-EXIT-2/3 | `Menu` |
| `components/session-menu-item.tsx` | 1 | W-WA-EXIT-2/3 | `Menu` |
| `components/session-menu-solid.tsx` | 1 | W-WA-EXIT-2/3 | `Menu` |
| `components/sidebar-agent-menu-switcher.ts` | 2 | Sidebar | `Menu` |
| `components/sidebar-agent-roster.ts` | 4 | Sidebar | `Menu` |
| `components/sidebar-reorder.ts` | 3 | Sidebar | `Menu` |
| `components/sidebar-session-filter-popover.ts` | 1 | Sidebar | `Popover` |
| `pages/chat/components/chat-composer-context.tsx` | 1 | Chat | `Popover` |
| `pages/chat/components/chat-composer-controls.tsx` | 5 | Chat | `Menu` |
| `pages/chat/components/chat-composer-emoji.tsx` | 1 | Chat | `Popover` |
| `pages/chat/components/chat-composer-library-menu.tsx` | 4 | Chat | `Menu` |
| `pages/chat/components/chat-composer-menu-rows.tsx` | 3 | Chat | `Menu`; `SettingsToggle` or native checkbox |
| `pages/chat/components/chat-composer-plus-menu.tsx` | 8 | Chat | `Menu` |
| `pages/chat/components/chat-composer-queue.tsx` | 2 | Chat | `Menu` |
| `pages/chat/components/chat-effort-picker.tsx` | 1 | Chat | `Popover` |
| `pages/chat/components/chat-header-panel-actions.tsx` | 1 | Chat | `Menu` |
| `pages/chat/components/chat-header-session-menu.tsx` | 6 | Chat | `Menu` |
| `pages/chat/components/chat-model-picker.tsx` | 1 | Chat | `Popover` |
| `pages/chat/components/chat-pane-header.tsx` | 4 | Chat | `Menu` |
| `pages/chat/components/chat-pane-placement.tsx` | 2 | Chat | `Menu` |
| `pages/chat/components/chat-pane-versions-menu.tsx` | 3 | Chat | `Menu`; `Popover` |
| `pages/chat/components/chat-permission-picker.tsx` | 3 | Chat | `Menu` |
| `pages/chat/components/chat-quick-action.tsx` | 1 | Chat | `Menu` |
| `pages/chat/components/chat-session-sharing.solid.tsx` | 6 | Chat | `Menu` |
| `pages/chat/components/chat-tool-content.solid.tsx` | 3 | Chat | `Tabs` / `TabPanel` |
| `pages/chat/components/session-diff-menus.tsx` | 6 | Chat | `Menu` |
| `pages/model-setup/provider-picker.tsx` | 2 | W-WA-EXIT | `Menu` |
| `pages/new-session/checkout-chip.tsx` | 2 | New session | `Popover` |
| `pages/new-session/palette-session-settings-view.tsx` | 1 | New session | `Popover` |
| `pages/new-session/project-chip.tsx` | 1 | New session | `Popover` |
| `pages/new-session/where-chip.tsx` | 1 | New session | `Popover` |
| `pages/usage/view.tsx` | 4 | W-WA-EXIT | `Menu` |

Once all consumers are gone, remove Web Awesome from `ui/package.json` and regenerate the lockfile; remove its 3,096-line patch, workspace patch entry, checker/README references, theme import, `wa-light`/`wa-dark` bootstrap and mock toggles, WA token bridges/selectors/types/registrations, and PostCSS workaround/test/config references. Retire vendor-only test/prebundle entries while preserving shared ownership tests. Regenerate the boot manifest through `pnpm ui:boot-manifest:gen`; do not hand-edit its vendor module entries. The full package-tail inspection was pinned to `8118777aeb0aa13640623fd9bd4c18aa0bd842ff`; #171302 subsequently removed the stale select styling and pet `wa-button` obstacle-selector alternative. Recheck remaining imports and selectors on the final candidate instead of replaying the old tail blindly.

**Native event ABI:** package removal alone does not remove every `wa-*` name. The native `modal-dialog.ts` owner still emits `wa-show`, `wa-hide`, `wa-after-show`, and `wa-after-hide`; AgentFilePreview, toast reparenting and modal test helpers consume those events. Preserve that live ABI during package removal, or migrate the producer, consumers and tests together before claiming literal zero `wa-*` usage. Also reconcile stale Workboard overlay tokens and the vendor-specific native-overlay-occlusion branch at their owners.

Current startup budget: **374,285 B gzip JS and one startup CSS request**. Keep lazy boundaries. Use `ci:full` for overlay/focus changes and let PR CI run broad proof. Local proof is types plus the few directly changed test files; no local E2E batteries, repeat suites, Testbox waiting, or parity runs. Visual changes still need a few inspected, synthetic before/after captures. Attribute red checks by exact test name against the latest scheduled main run. Never bypass native landing guards.
