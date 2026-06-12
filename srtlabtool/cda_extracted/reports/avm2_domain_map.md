# AVM2 Domain Module Map

- Source classes: 3902
- Total domains: 11

## Domain Overview
- buslog: 91 classes, 833 instance members, 53 static members
- proxi: 148 classes, 1497 instance members, 120 static members
- ecu: 60 classes, 337 instance members, 16 static members
- flash: 205 classes, 2536 instance members, 354 static members
- diagnostic: 614 classes, 6458 instance members, 358 static members
- unlock: 8 classes, 6 instance members, 1 static members
- dtc: 10 classes, 17 instance members, 0 static members
- sync: 43 classes, 351 instance members, 19 static members
- auth: 5 classes, 18 instance members, 1 static members
- tracer: 68 classes, 542 instance members, 22 static members
- other: 2650 classes, 25345 instance members, 1414 static members

## buslog
- Top classes by member count: com.chrysler.cda.presentation.component.diagnostic.busLog.BusLoggerLite (175); com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogConfigurationComponentEcuSelector (76); com.chrysler.cda.presentation.component.diagnostic.busLog.BusLoggerLitePM (63); com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogGeneratorConfigurationComponentInnerClass0 (58); com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogConfigurationComponent (55); com.chrysler.cda.application.buslog.BuslogStreamCommand (50); com.chrysler.cda.presentation.component.diagnostic.busLog.BuslogGeneratorConfigurationComponent (29); com.chrysler.cda.presentation.component.diagnostic.busLog.ConfigurationStoreLoadWindow (27)
- Suggested owner slice: buslog-module-team

## proxi
- Top classes by member count: com.chrysler.cda.presentation.component.proxi.ProxiViewImplementation (162); com.chrysler.cda.presentation.component.proxi.components.tabs.editor.IdenticalEditor (61); com.chrysler.cda.presentation.component.proxi.components.popovers.PopoverSkin (50); com.chrysler.cda.presentation.component.proxi.components.popovers.file.load.ImportFilePopoverImpl (47); com.chrysler.cda.presentation.component.proxi.components.popovers.file.out.ExportFilePopoverImp (40); com.chrysler.cda.presentation.component.proxi.components.home.pideditor.ProxiPidEditorImpl (38); com.chrysler.cda.presentation.component.proxi.viewer.ProxiFileViewerImpl (36); com.chrysler.cda.presentation.component.proxi.components.tabs.skins.ProxiTabBarButtonSkin (35)
- Suggested owner slice: proxi-module-team

## ecu
- Top classes by member count: com.chrysler.cda.presentation.component.ecuconfig.ECUConfigImpl (38); com.chrysler.cda.presentation.component.ecuconfig.domain.ECUConfigurationObject (31); com.chrysler.cda.domain.EcuContext (23); com.chrysler.cda.application.views.AvailableECUsCommand (16); com.chrysler.cda.presentation.component.ecuconfig.components.ECUConfigsDataGrid (16); mx.collections.LeafNodeCursor (15); com.chrysler.cda.presentation.component.ecuconfig.ECUConfigPM (14); com.hurlant.crypto.tls.ISecurityParameters (14)
- Suggested owner slice: ecu-module-team

## flash
- Top classes by member count: flashx.textLayout.container.ContainerController (307); flashx.textLayout.elements.FlowElement (202); flashx.textLayout.formats.TextLayoutFormat (147); flashx.textLayout.container.TextContainerManager (113); flashx.textLayout.compose.TextFlowLine (100); flashx.textLayout.edit.SelectionManager (82); flashx.textLayout.edit.EditManager (67); flashx.textLayout.formats.ITextLayoutFormat (63)
- Suggested owner slice: flash-module-team

## diagnostic
- Top classes by member count: com.chrysler.cda.presentation.component.diagnostic.EcuDiagnostics (157); com.chrysler.cda.presentation.component.rawdiagnostics.presentation.RawDiagnosticsImplementation (147); com.chrysler.cda.presentation.component.diagnostic.vehicleWideDTCs.VehicleWideDTC (120); com.chrysler.cda.presentation.component.diagnostic.ecu.calibration.ReadCalibrationImpl (118); com.chrysler.cda.presentation.component.diagnostic.ecu.dtcs.DTC (115); com.chrysler.cda.domain.diagnostics.ecuList.ECU (112); com.chrysler.cda.presentation.component.diagnostic.functionalMessages.Broadcast (105); com.chrysler.cda.presentation.component.diagnostic.flash.Flash (102)
- Suggested owner slice: diagnostic-module-team

## unlock
- Top classes by member count: com.chrysler.cda.application.state.UnlockStateCommand (3); com.chrysler.cda.event.message.state.UnlockStateMessage (3); com.chrysler.cda.domain.UnlockVO (1); com.chrysler.Assets_unlockDown (0); com.chrysler.Assets_unlockOver (0); com.chrysler.Assets_unlockUp (0); com.chrysler.cda.presentation.Assets_sgwUnlocked (0); com.chrysler.cda.presentation.Assets_unlock (0)
- Suggested owner slice: unlock-module-team

## dtc
- Top classes by member count: com.chrysler.cda.event.message.report.GetDtcSnapshotDataForScanReportMessage (5); com.chrysler.cda.event.message.report.GetDtcComponentQualificationDataForScanReportMessage (4); com.chrysler.cda.event.message.report.RequestDTCEnvironmentalDataForReportMessage (4); com.chrysler.cda.event.message.report.GetDtcEnvironmentalDataForScanReportMessage (2); com.chrysler.cda.event.message.report.RequestDTCForReportMessage (2); com.chrysler.Assets_vehicleDTCDown (0); com.chrysler.Assets_vehicleDTCOver (0); com.chrysler.Assets_vehicleDTCUp (0)
- Suggested owner slice: dtc-module-team

## sync
- Top classes by member count: com.chrysler.cda.presentation.component.sync.SyncStatus (83); com.chrysler.cda.presentation.setup.SyncStartupMonitor (56); com.chrysler.cda.presentation.component.sync.SyncLogin (55); com.chrysler.cda.presentation.component.sync.SyncLoginPM (32); com.chrysler.cda.presentation.component.sync.SyncPM (32); com.chrysler.cda.presentation.component.sync.SyncLoginController (20); com.chrysler.cda.presentation.component.sync.SyncLoginBase (11); mx.rpc.AsyncToken (9)
- Suggested owner slice: sync-module-team

## auth
- Top classes by member count: com.chrysler.cda.application.license.AuthenticateCommand (8); PrivateNs.AuthenticationAgent (5); com.chrysler.cda.event.message.license.AuthenticateMessage (4); PrivateNs.AuthenticationMessageResponder (2); com.chrysler.cda.event.message.license.ShowAuthenticationMessage (0)
- Suggested owner slice: auth-module-team

## tracer
- Top classes by member count: com.chrysler.cda.presentation.component.tracer.components.support.report.eshd.CdaReportViewImpl (49); com.chrysler.cda.presentation.component.tracer.TracerPopupImpl (40); com.chrysler.cda.presentation.component.tracer.skins.CollapsableContainerSkin (37); com.chrysler.cda.presentation.component.tracer.TracerPopupPM (27); com.chrysler.cda.application.tracer.TracerModel (25); com.chrysler.cda.presentation.component.tracer.TracerLauncherImpl (22); com.chrysler.cda.presentation.component.tracer.TracerSupportImpl (20); com.chrysler.cda.application.tracer.TracerSupportModel (18)
- Suggested owner slice: tracer-module-team

