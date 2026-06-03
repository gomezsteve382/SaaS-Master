---
name: SRT Command Center 5-pane redesign (GRADUATED into srt-lab)
description: The IA that collapses SRT Lab's ~40 tabs into 5 per-vehicle panes + Advanced drawer; now LIVE in the real app via CommandShell.jsx (no longer a mockup).
---

# SRT Command Center — 5-pane UX redesign

GRADUATED (June 2026): now LIVE in the real srt-lab app. `src/components/CommandShell.jsx`
replaces the old `WorkspaceSidebar` + tall vehicle banner inside `App.jsx`'s VehicleWorkspace.
It wraps the existing tab-conditional unchanged (all tab content components reused as-is).
`WorkspaceSidebar.jsx` is left on disk but no longer imported.

Collapses SRT Lab's ~40 sprawling tabs into 5 focused per-vehicle panes plus an
"Advanced / Reference" drawer for the long tail of read-only/expert tabs.

**Navigation contract (stable testids, important for UI tests):** top bar has
`topbar-vehicle-chip` (click = onBack/change vehicle), `topbar-wizard-btn`,
`topbar-advanced-btn` (opens drawer). Left rail `command-rail` has `rail-<tabid>` for the 5
primary panes + `rail-footer-workflow`/`rail-footer-canuniverse`. Drawer `advanced-drawer` has
`advanced-drawer-search` + `drawer-tab-<tabid>` per non-primary tab. KEY GOTCHA: any tab that is
NOT in `PRIMARY_NAV` (currently dumps/vinsync/keyxfer/uds-console/vinprog/obd/investigation) or the 2 footer
(workflow/canuniverse) is reachable ONLY by opening the drawer first — workspace UI tests that
used to click a sidebar label (e.g. MODULE INSPECTOR) must now click `topbar-advanced-btn` then
`drawer-tab-<id>`. Drawer grouping keys off WORKSPACE_CATEGORIES (PROGRAM/LIVE/ANALYZE/TOOLS/RESEARCH);
a tab missing from WORKSPACE_CATEGORIES would be stranded (rendered nowhere in the drawer).

**Adding a PRIMARY_NAV entry — two non-obvious wiring rules:** (1) The `PRIMARY_NAV` `key` MUST
also exist as a `WORKSPACE_TABS` id, because `setTab` does `VALID_TAB_IDS.has(next) ? next : 'dumps'`
— a rail item whose key is not a registered tab id silently falls back to the Dumps tab when clicked.
(2) Being in `PRIMARY_NAV` AUTO-excludes a tab from the Advanced drawer (drawer filters out PRIMARY_NAV
keys), so promoting a tab to the rail is the *only* edit needed to remove it from the drawer — do not
also delete it from WORKSPACE_TABS/CATEGORIES or it loses its content route + category home.
**Why:** the offline Charger key-transfer flow (CharRfhubKeyAdderPanel) was promoted to a `keyxfer`
rail pane this way; forgetting rule (1) makes the new rail button look broken (lands on Dumps).

**The IA collapse (old tabs -> new pane):**
- **Diagnose** (front door) = DumpDropZone + ModuleSync + AnalysisDiffView. Drop file -> cross-module verdict -> side-by-side hex diff with fix -> one-click apply.
- **UDS Command** = raw ISO 14229 console (J2534UdsConsoleTab + @workspace/uds builders).
- **VIN & Checksum** = VinProgrammerTab (read/write VIN + CRC verify across modules).
- **OBD Pull** = OBDTab (Web Serial / J2534 live bin-dump acquisition).
- **AI Copilot** = InvestigationTab / MismatchWizard + api-server Anthropic assistant.
- **Advanced / Reference drawer** = the rest (Module Census, CAN Universe, Binary Intel, External Tools, Seed calc, etc.).

**Why:** ~40 flat tabs is an unusable mental model; per-vehicle workflow ordering (drop -> diagnose -> fix) matches how a bench tech actually works.

**Mockup location:** `artifacts/mockup-sandbox/src/components/mockups/srt-command-center/`
— shared `_shared/AppShell.tsx` (top bar: vehicle chip + J2534 status + drawer button; left rail with the 5 nav items) and `_group.css` token sheet; one `.tsx` per pane. Canvas shapeIds `cc-diagnose`/`cc-uds`/`cc-vin`/`cc-obd`/`cc-copilot` on the mockup-sandbox design artifact.

**How to apply:** When the user approves the mockup, use the `mockup-graduate` skill to port panes into the real `artifacts/srt-lab` app. Architect's sign-off polish notes: normalize one visual recipe across all 5 (Vin/OBD/UDS drifted toward default shadcn gray vs the more SRT-branded Diagnose/Copilot), and align nav labels with page titles.
