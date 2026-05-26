import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { AppShell } from "./components/AppShell";
import Home from "./pages/Home";
import Analysis from "./pages/Analysis";
import History from "./pages/History";
import Compare from "./pages/Compare";
import Align from "./pages/Align";
import Diff from "./pages/Diff";
import PatternLibrary from "./pages/PatternLibrary";
import KnowledgeGraph from "./pages/KnowledgeGraph";
import BatchAnalysis from "./pages/BatchAnalysis";
import HexViewer from "./pages/HexViewer";
import SharedAnalysis from "./pages/SharedAnalysis";
import Rules from "./pages/Rules";
import Doctor from "./pages/Doctor";
import AnalysisList from "./pages/AnalysisList";
import HexViewerLanding from "./pages/HexViewerLanding";
import AnalysisChat from "./pages/AnalysisChat";

// ECU Workbench tabs (ported from SRT Lab monorepo)
import { lazy, Suspense } from "react";
import { MasterVinProvider } from "./contexts/MasterVinContext.jsx";
const BcmTab = lazy(() => import("./pages/srt-tabs/BcmTab.jsx"));
const RfhubTab = lazy(() => import("./pages/srt-tabs/RfhubTab.jsx"));
const EcmTab = lazy(() => import("./pages/srt-tabs/EcmTab.jsx"));
const AdcmTab = lazy(() => import("./pages/srt-tabs/AdcmTab.jsx"));
const UdsTab = lazy(() => import("./pages/srt-tabs/UdsTab.jsx"));
const SeedTab = lazy(() => import("./pages/srt-tabs/SeedTab.jsx"));
const SecurityTab = lazy(() => import("./pages/srt-tabs/SecurityTab.jsx"));
const JailbreakTab = lazy(() => import("./pages/srt-tabs/JailbreakTab.jsx"));
const DumpsTab = lazy(() => import("./pages/srt-tabs/DumpsTab.jsx"));
const ImmoVINTab = lazy(() => import("./pages/srt-tabs/ImmoVINTab.jsx"));
const OBDTab = lazy(() => import("./pages/srt-tabs/OBDTab.jsx"));
const BenchTab = lazy(() => import("./pages/srt-tabs/BenchTab.jsx"));
const GpecTab = lazy(() => import("./pages/srt-tabs/GpecTab.jsx"));
const Gpec2aTab = lazy(() => import("./pages/srt-tabs/Gpec2aTab.jsx"));
const RFHPCMTab = lazy(() => import("./pages/srt-tabs/RFHPCMTab.jsx"));
const AutelSgwTab = lazy(() => import("./pages/srt-tabs/AutelSgwTab.jsx"));
const FcaAnalyzerTab = lazy(() => import("./pages/srt-tabs/FcaAnalyzerTab.jsx"));
const ProgramAllTab = lazy(() => import("./pages/srt-tabs/ProgramAllTab.jsx"));
const BackupsTab = lazy(() => import("./pages/srt-tabs/BackupsTab.jsx"));
const SessionsTab = lazy(() => import("./pages/srt-tabs/SessionsTab.jsx"));
const TwinTab = lazy(() => import("./pages/srt-tabs/TwinTab.jsx"));

function WorkbenchWrapper({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <div className="animate-pulse text-muted-foreground font-mono text-sm">Loading module...</div>
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

function Router() {
  return (
    <Switch>
      {/* Public routes (no AppShell) */}
      <Route path={"/share/:token"} component={SharedAnalysis} />
      {/* Protected routes (with AppShell) */}
      <Route>
        <AppShell>
          <Switch>
            {/* Dashboard & Main */}
            <Route path={"/"} component={Home} />
            {/* Binaries & Analyses */}
            <Route path={"/analysis"} component={AnalysisList} />
            <Route path={"/analysis/:id/chat"} component={AnalysisChat} />
            <Route path={"/analysis/:id"} component={AnalysisChat} />
            {/* Tools & Features */}
            <Route path={"/history"} component={History} />
            <Route path={"/compare"} component={Compare} />
            <Route path={"/align"} component={Align} />
            <Route path={"/diff"} component={Diff} />
            <Route path={"/patterns"} component={PatternLibrary} />
            <Route path={"/knowledge-graph"} component={KnowledgeGraph} />
            <Route path={"/batch"} component={BatchAnalysis} />
            <Route path={"/hex"} component={HexViewerLanding} />
            <Route path={"/hex/:id"} component={HexViewer} />
            <Route path={"/rules"} component={Rules} />
            <Route path={"/doctor"} component={Doctor} />
            {/* ECU Workbench */}
            <Route path={"/workbench/bcm"}>{() => <WorkbenchWrapper><BcmTab /></WorkbenchWrapper>}</Route>
            <Route path={"/workbench/rfhub"}>{() => <WorkbenchWrapper><RfhubTab /></WorkbenchWrapper>}</Route>
            <Route path={"/workbench/ecm"}>{() => <WorkbenchWrapper><EcmTab /></WorkbenchWrapper>}</Route>
            <Route path={"/workbench/adcm"}>{() => <WorkbenchWrapper><AdcmTab /></WorkbenchWrapper>}</Route>
            <Route path={"/workbench/uds"}>{() => <WorkbenchWrapper><UdsTab /></WorkbenchWrapper>}</Route>
            <Route path={"/workbench/seed"}>{() => <WorkbenchWrapper><SeedTab /></WorkbenchWrapper>}</Route>
            <Route path={"/workbench/security"}>{() => <WorkbenchWrapper><SecurityTab /></WorkbenchWrapper>}</Route>
            <Route path={"/workbench/jailbreak"}>{() => <WorkbenchWrapper><JailbreakTab /></WorkbenchWrapper>}</Route>
            {/* @ts-expect-error WorkbenchWrapper has upstream-loose prop types (files/setFiles/loadF) supplied by context. */}
            <Route path={"/workbench/dumps"}>{() => <WorkbenchWrapper><DumpsTab /></WorkbenchWrapper>}</Route>
            <Route path={"/workbench/immovin"}>{() => <WorkbenchWrapper><ImmoVINTab /></WorkbenchWrapper>}</Route>
            <Route path={"/workbench/obd"}>{() => <WorkbenchWrapper><OBDTab /></WorkbenchWrapper>}</Route>
            <Route path={"/workbench/bench"}>{() => <WorkbenchWrapper><BenchTab /></WorkbenchWrapper>}</Route>
            <Route path={"/workbench/gpec"}>{() => <WorkbenchWrapper><GpecTab /></WorkbenchWrapper>}</Route>
            <Route path={"/workbench/gpec2a"}>{() => <WorkbenchWrapper><Gpec2aTab /></WorkbenchWrapper>}</Route>
            <Route path={"/workbench/rfhpcm"}>{() => <WorkbenchWrapper><RFHPCMTab /></WorkbenchWrapper>}</Route>
            <Route path={"/workbench/autelsgw"}>{() => <WorkbenchWrapper><AutelSgwTab /></WorkbenchWrapper>}</Route>
            <Route path={"/workbench/fcaanalyzer"}>{() => <WorkbenchWrapper><FcaAnalyzerTab /></WorkbenchWrapper>}</Route>
            <Route path={"/workbench/programall"}>{() => <WorkbenchWrapper><ProgramAllTab /></WorkbenchWrapper>}</Route>
            <Route path={"/workbench/backups"}>{() => <WorkbenchWrapper><BackupsTab /></WorkbenchWrapper>}</Route>
            <Route path={"/workbench/sessions"}>{() => <WorkbenchWrapper><SessionsTab /></WorkbenchWrapper>}</Route>
            <Route path={"/workbench/twin"}>{() => <WorkbenchWrapper><TwinTab /></WorkbenchWrapper>}</Route>
            {/* 404 */}
            <Route path={"/404"} component={NotFound} />
            <Route component={NotFound} />
          </Switch>
        </AppShell>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        {/* @ts-expect-error MasterVinProvider has upstream-loose prop types (setPg) supplied by context. */}
        <MasterVinProvider>
          <TooltipProvider>
            <Toaster />
            <Router />
          </TooltipProvider>
        </MasterVinProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
