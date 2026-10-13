# Web Awesome exit replacement map

Updated 2026-10-13. Source inspection is pinned to main `8999389dda5419cacccb2485648bacfed0130039`. This coordination note distinguishes landed replacements from open PRs and prepared candidates; it does not claim that Web Awesome is gone.

## Ownership

- **W-WA-EXIT:** pages except `pages/chat/**` and `pages/new-session/**`; shared styles/theme, `types/`, `app/`, this map, and existing `components/lobster-pet*` / `components/session-group-defaults-dialog*` work.
- **W-WA-EXIT-2:** other `components/**` and `lib/**` Web Awesome removal, coordinated with their active owners.
- **Other active lanes:** chat/new-session, sidebar, config form, picker, and shared primitive ports retain their assigned files. Do not edit another lane's implementation to unblock a consumer.

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

## Open and prepared consumers

| Surface | Replacement / retained contract | Current state |
| --- | --- | --- |
| Meetings reader tabs | `Tabs`, manual activation and existing panel IDs | [#170314](https://github.com/openclaw/openclaw/pull/170314), head `501dadc7846051d0ca0dbe53f81c5525250b8241`; exact-head CI running. Prior auto request was explicitly cancelled; use native replacement recovery after completed green proof. |
| Usage query filters | `Menu`, existing query owner and callbacks | [#170567](https://github.com/openclaw/openclaw/pull/170567), head `fd66504f291217f808a585589ec17fcbe2e267dc`; blocked by sidebar browser test described below. No merge intent. |
| Sessions advanced filters | `Popover`, native inputs and existing filter owner | [#170565](https://github.com/openclaw/openclaw/pull/170565); hosted CI passed, native checkout recovery remains blocked by a missing transition journal for two archive E2E files. No manual journal repair or new namespace. |
| Provider picker | Searchable `Menu`, preserve selected-option focus | [#170785](https://github.com/openclaw/openclaw/pull/170785); selected Qwen incorrectly focuses Google on keyboard reopen. Needs shared Menu focus fix. |
| Group mode menu | `Menu`, preserve exact trigger ID | Prepared; Folder prerequisite landed. Still needs typed explicit trigger ID. |
| Usage export | `Menu`, existing export callbacks and busy state | Prepared; needs Usage filter cut and typed trigger `aria-busy`. |
| Plugin install progress | `Popover`, preserve hover/pin intent and shared Escape owner | Prepared; needs outside-pointer/outside-focus options. Closing-phase guard and targeted E2E change are prepared, not proven on final owner API. |
| Catalog / session menus / communication options | `Menu`, action-before-close, nested controls and return focus | W-WA-EXIT-2 and current session-menu owners. |
| Mermaid / Board actions and tabs | `Menu` / `Tabs`, preserve selectors | W-WA-EXIT-2 and Board owner. |
| Browser/Terminal panels | Native `div[role=tabpanel]`, preserve IDs/classes/events | W-WA-EXIT-2 with current viewport owners. |
| Sidebar / shared pickers | Owned Menu/Popover/picker primitives | Sidebar and PRIM-C2 owners; active work must land on main first. |
| Chat / new-session menus and previews | Owned primitives in each renderer | Active chat/new-session lanes. |

Usage's failed case is `app-sidebar-session-filter.browser.test.ts > sidebar session filter popover > keeps keyboard navigation, focus and surface inside the viewport at 390 px (rtl)`: the first Filter opening expects `[false,true]` and observed `[false,true,false,true]`. The same test passed on the latest inspected scheduled main run `38439503520` at `838c6ada7dc9d657098b552eb846d8e5f176b79e`; this is **not established as inherited**. Ownership routing is pending; do not weaken the assertion or use an inherited-failure exception without new proof. PRIM-C2 also changes this test for its new picker occlusion contract; that unlanded change is not proof of the current failure's cause.

## Remaining shared primitive API work

At the inspected main pin, Menu supports checkbox/radio entries, `checked`, `closeOnSelect`, ordered `MenuEntry` content rows, and constrained `triggerAttributes` (`title`, `style`, `tabindex`, `aria-hidden`, plus `data-*`). These are already available; do not reimplement them.

| Missing contract | Consumer | Required owner change |
| --- | --- | --- |
| Explicit root trigger ID | Group mode menu | Add a typed trigger-ID contract without overwriting root `data-value`; nested trigger IDs remain authoritative. |
| Typed trigger `aria-busy` | Usage export | Extend the constrained trigger attribute type. |
| Outside-pointer and outside-focus dismissal options | Plugin install progress | Forward existing `OverlayOptions.dismissOutsidePointer` / `dismissOutsideFocus` through Popover, preserving defaults and Escape behavior. |
| Selected-item focus on keyboard reopen | Provider picker | Fix shared Menu navigation/focus ownership; no consumer DOM focus workaround. |

Pinned main blobs: Menu `e73cb12906d5237cdf65f79b4ba504e2a22b3b20`, Popover `b206bbecc4e8f30be9c557e9fefa3dac893a0cef`. Recheck main about every ten minutes. Read unlanded branches only; merge main once the needed contracts land. Historical draft patches do not override the current owner API or count as final proof.

## Theme and final package removal

The five formerly implicit values are already owned by Control UI:

| Token | Value |
| --- | --- |
| `--control-ui-font-weight-normal` | `400` |
| `--control-ui-font-weight-semibold` | `500` |
| `--control-ui-transition-fast` | `75ms` |
| `--control-ui-focus-ring` | `solid 0.1875rem var(--ring)` |
| `--control-ui-focus-ring-offset` | `0.0625rem` |

The completed AST inventory at main `8999389dda5419cacccb2485648bacfed0130039` counts **150 production WA tags**: chat 86, components 41, new-session 5, plugins 1, Usage 8, model setup 2, Sessions 1, Board 4, and Meetings 2. This includes other active lanes and does not establish zero usage. The exit condition is zero remaining consumers on main.

Only then remove Web Awesome from `ui/package.json` and regenerate the lockfile; remove its 3,096-line patch, workspace patch entry, checker/README references, theme import, `wa-light`/`wa-dark` bootstrap and mock toggles, WA token bridges/selectors/types/registrations, and PostCSS workaround/test/config references. Preserve live custom-event ABIs such as AgentFilePreview `wa-show`/`wa-hide` until their callers are cut over. The pet scene's stale `wa-button` obstacle selector also belongs in the final sweep. Regenerate the boot manifest through its owner.

Current startup budget: **374,285 B gzip JS and one startup CSS request**. Keep lazy boundaries. Use `ci:full` for overlay/focus changes and let PR CI run broad proof. Local proof is types plus the few directly changed test files; no local E2E batteries, repeat suites, Testbox waiting, or parity runs. Visual changes still need a few inspected, synthetic before/after captures. Attribute red checks by exact test name against the latest scheduled main run. Never bypass native landing guards.
