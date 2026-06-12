# Buslog Rebuild Backlog

- Buslog classes discovered: 91
- Method/member nodes: 886
- Graph edges: 1717
- Cross-domain dependencies: 187 (proxi/diagnostic/ecu/flash/etc)

## Phase 0 - Foundation
- Build shared event bus + message DTO layer used by `BusLoggerLite` and stream commands.
- Define typed transport interface for bus log streaming and request/response correlation.
- Wire logging, state snapshots, and replay hooks before UI reconstruction.

## Phase 1 - Core Stream Engine
- Goal: Rebuild runtime logging flow, stream lifecycle, and state model.
- Classes: 39
- Dependencies: none
- Top classes: com.chrysler.cda.application.buslog.BuslogStreamCommand (50); com.chrysler.cda.event.message.buslog.BuslogStreamMessage (26); com.chrysler.cda.domain.buslog.BusLogPacket (23); com.chrysler.cda.event.message.buslog.BuslogStreamMessageFilter (7); com.chrysler.cda.application.buslog.ConfigurationStoreCommand (8); com.chrysler.cda.event.message.buslog.ExternalAppLoggerConsoleMessageFactory (6); com.chrysler.cda.application.buslog.BuslogExportCommand (6); com.chrysler.cda.event.message.buslog.BuslogExportMessage (3); com.chrysler.core.infrastructure.BuslogSerializationFilter (3); _com_chrysler_cda_presentation_component_diagnostic_busLog_BusLogControlBarComponentWatcherSetupUtil (2); _com_chrysler_cda_presentation_component_diagnostic_busLog_BusLoggerBooleanDataGridColumnInnerClass0WatcherSetupUtil (2); _com_chrysler_cda_presentation_component_diagnostic_busLog_BusLoggerLiteWatcherSetupUtil (2)
- Acceptance criteria:
- Bus stream can start, pause, resume, and stop deterministically.
- Core log model updates are replayable from recorded message batches.
- No UI dependency required to validate stream command behavior.

## Phase 2 - Config and Interaction Flows
- Goal: Rebuild configuration selectors, import/export interactions, and store/load behavior.
- Classes: 31
- Dependencies: none
- Top classes: com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogConfigurationComponentEcuSelector (76); com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogGeneratorConfigurationComponentInnerClass0 (58); com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogConfigurationComponent (55); com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogGeneratorConfigurationComponent (29); com.chrysler.cda.presentation.component.diagnostic.busLog.ConfigurationStoreLoadWindow (27); com.chrysler.cda.presentation.component.diagnostic.busLog.ConfigurationStoreSaveWindow (22); com.chrysler.cda.domain.diagnostics.buslog.BuslogConfiguration (19); com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogConfigurationComponentEcuWrapper (16); com.chrysler.cda.event.message.buslog.ConfigurationStoreRequestMessage (11); com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogConfigurationComponentInnerClass0 (13); com.chrysler.cda.presentation.component.diagnostic.busLog.ConfigurationStoreLoadWindowInnerClass0 (13); com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogConfigurationComponentEcuSelectorInnerClass0 (8)
- Acceptance criteria:
- Configuration selection and persistence paths are stable across sessions.
- Import/export/store-load interactions preserve schema and field semantics.
- Dialog and selector components emit typed events for command layer.

## Phase 3 - Message Generator and Tooling
- Goal: Rebuild generator features and supporting helper workflows.
- Classes: 4
- Dependencies: none
- Top classes: com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogGeneratorMessageItem (24); com.chrysler.Assets_buslogMessageGeneratorDown (0); com.chrysler.Assets_buslogMessageGeneratorOver (0); com.chrysler.Assets_buslogMessageGeneratorUp (0)
- Acceptance criteria:
- Message generation produces expected frame/request payload structure.
- Tooling hooks integrate with core stream APIs without hidden side effects.
- Generated content can be validated with deterministic snapshots.

## Phase 4 - UI/Polish and Residual Classes
- Goal: Complete remaining UI skins/helpers and cross-domain integration edges.
- Classes: 17
- Dependencies: none
- Top classes: com.chrysler.cda.presentation.component.diagnostic.busLog.BusLoggerLite (175); com.chrysler.cda.presentation.component.diagnostic.busLog.BusLoggerLitePM (63); com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogFilebackedList (22); com.chrysler.cda.presentation.component.diagnostic.busLog.ConsoleSkin (17); com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogSocketStreamList (15); com.chrysler.cda.presentation.component.diagnostic.busLog.BusLogControlBarComponent (12); com.chrysler.cda.presentation.component.diagnostic.busLog.Console (10); com.chrysler.cda.presentation.component.diagnostic.busLog.BusLoggerLiteExternalAppModel (7); com.chrysler.cda.presentation.component.diagnostic.busLog.BusLoggerBooleanMXDataGridItemRenderer (7); com.chrysler.cda.presentation.component.diagnostic.busLog.BusLoggerStringMXDataGridItemRenderer (6); com.chrysler.cda.presentation.component.diagnostic.busLog.BusLoggerBooleanDataGridColumnInnerClass0 (6); com.chrysler.cda.presentation.component.diagnostic.busLog.BusLoggerStringDataGridColumnInnerClass0 (6)
- Acceptance criteria:
- Residual buslog classes are linked with no unresolved class/type references.
- Cross-domain entry points (diagnostic/proxi/ecu) are explicitly mapped and tested.
- Visual and workflow parity validated against extracted asset/state map.

## Implementation Order (Class-Level)
- com.chrysler.cda.presentation.component.diagnostic.busLog.BusLoggerLite [diagnostic_ui] members=175, inbound=3, outbound=179
- com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogConfigurationComponentEcuSelector [configuration] members=76, inbound=3, outbound=79
- com.chrysler.cda.presentation.component.diagnostic.busLog.BusLoggerLitePM [diagnostic_ui] members=63, inbound=6, outbound=65
- com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogGeneratorConfigurationComponentInnerClass0 [configuration] members=58, inbound=0, outbound=60
- com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogConfigurationComponent [configuration] members=55, inbound=4, outbound=57
- com.chrysler.cda.application.buslog.BuslogStreamCommand [application_commands] members=50, inbound=0, outbound=51
- com.chrysler.cda.event.message.buslog.BuslogStreamMessage [core] members=26, inbound=68, outbound=27
- com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogGeneratorConfigurationComponent [configuration] members=29, inbound=5, outbound=31
- com.chrysler.cda.presentation.component.diagnostic.busLog.ConfigurationStoreLoadWindow [configuration] members=27, inbound=2, outbound=29
- com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogGeneratorMessageItem [message_generator] members=24, inbound=6, outbound=26
- com.chrysler.cda.domain.buslog.BusLogPacket [core] members=23, inbound=1, outbound=25
- com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogFilebackedList [diagnostic_ui] members=22, inbound=2, outbound=24
- com.chrysler.cda.presentation.component.diagnostic.busLog.ConfigurationStoreSaveWindow [configuration] members=22, inbound=0, outbound=24
- com.chrysler.cda.domain.diagnostics.buslog.BuslogConfiguration [configuration] members=19, inbound=5, outbound=21
- com.chrysler.cda.presentation.component.diagnostic.busLog.ConsoleSkin [diagnostic_ui] members=17, inbound=0, outbound=19
- com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogConfigurationComponentEcuWrapper [configuration] members=16, inbound=0, outbound=18
- com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogSocketStreamList [diagnostic_ui] members=15, inbound=2, outbound=17
- com.chrysler.cda.event.message.buslog.ConfigurationStoreRequestMessage [configuration] members=11, inbound=15, outbound=13
- com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogConfigurationComponentInnerClass0 [configuration] members=13, inbound=0, outbound=14
- com.chrysler.cda.presentation.component.diagnostic.busLog.ConfigurationStoreLoadWindowInnerClass0 [configuration] members=13, inbound=0, outbound=14
- com.chrysler.cda.presentation.component.diagnostic.busLog.BusLogControlBarComponent [diagnostic_ui] members=12, inbound=0, outbound=14
- com.chrysler.cda.presentation.component.diagnostic.busLog.Console [diagnostic_ui] members=10, inbound=3, outbound=11
- com.chrysler.cda.event.message.buslog.BuslogStreamMessageFilter [core] members=7, inbound=9, outbound=8
- com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogConfigurationComponentEcuSelectorInnerClass0 [configuration] members=8, inbound=0, outbound=10
- com.chrysler.cda.application.buslog.ConfigurationStoreCommand [application_commands] members=8, inbound=0, outbound=9
- com.chrysler.cda.presentation.component.diagnostic.busLog.BusLoggerLiteExternalAppModel [diagnostic_ui] members=7, inbound=2, outbound=9
- com.chrysler.cda.presentation.component.diagnostic.busLog.BusLoggerBooleanMXDataGridItemRenderer [diagnostic_ui] members=7, inbound=1, outbound=8
- com.chrysler.cda.event.message.buslog.ExternalAppLoggerConsoleMessageFactory [core] members=6, inbound=3, outbound=7
- com.chrysler.cda.presentation.component.diagnostic.busLog.BusLoggerStringMXDataGridItemRenderer [diagnostic_ui] members=6, inbound=1, outbound=7
- com.chrysler.cda.presentation.component.diagnostic.busLog.BusLoggerBooleanDataGridColumnInnerClass0 [diagnostic_ui] members=6, inbound=0, outbound=8
- com.chrysler.cda.presentation.component.diagnostic.busLog.BusLoggerStringDataGridColumnInnerClass0 [diagnostic_ui] members=6, inbound=0, outbound=8
- com.chrysler.cda.application.buslog.BuslogExportCommand [application_commands] members=6, inbound=0, outbound=7
- com.chrysler.cda.event.message.buslog.BuslogExportMessage [core] members=3, inbound=8, outbound=4
- com.chrysler.cda.presentation.component.diagnostic.busLog.BusLoggerMXDataGridItemRendererBase [diagnostic_ui] members=3, inbound=2, outbound=4
- com.chrysler.core.infrastructure.BuslogSerializationFilter [core] members=3, inbound=0, outbound=4
- com.chrysler.cda.presentation.component.diagnostic.busLog.BusLoggerDataGridColumnBase [diagnostic_ui] members=2, inbound=2, outbound=3
- com.chrysler.cda.presentation.component.diagnostic.busLog.BusLoggerStringDataGridColumn [diagnostic_ui] members=1, inbound=7, outbound=2
- _com_chrysler_cda_presentation_component_diagnostic_busLog_BuslogConfigurationComponentEcuSelectorInnerClass0WatcherSetupUtil [configuration] members=2, inbound=0, outbound=4
- _com_chrysler_cda_presentation_component_diagnostic_busLog_BuslogConfigurationComponentEcuSelectorWatcherSetupUtil [configuration] members=2, inbound=0, outbound=4
- _com_chrysler_cda_presentation_component_diagnostic_busLog_BuslogConfigurationComponentWatcherSetupUtil [configuration] members=2, inbound=0, outbound=4

## Notes
- Graph is static and reconstructed from AVM2 signatures/traits/types, not runtime traces.
- Use this to sequence rebuild and ownership slicing, then refine with opcode/runtime tracing.

