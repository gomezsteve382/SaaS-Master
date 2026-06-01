---
name: SRT Command Center 5-pane redesign (canvas mockup)
description: The approved IA for collapsing SRT Lab's ~40 tabs into 5 per-vehicle panes; lives as a canvas mockup pending graduation into the real app.
---

# SRT Command Center — 5-pane UX redesign

A canvas/mockup-sandbox prototype (NOT yet in the real srt-lab app) that collapses SRT Lab's
~40 sprawling tabs into 5 focused per-vehicle panes plus an "Advanced / Reference" drawer for
the long tail of read-only/expert tabs.

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
