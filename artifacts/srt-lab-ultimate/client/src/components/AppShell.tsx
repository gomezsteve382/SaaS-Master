import { ReactNode, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Activity,
  Cpu,
  FileDigit,
  LayoutDashboard,
  ShieldCheck,
  Stethoscope,
  GitCompare,
  History,
  Network,
  BookOpen,
  Layers,
  HexagonIcon,
  Wrench,
  ChevronDown,
  ChevronRight,
  CircuitBoard,
  Radio,
  Zap,
  Lock,
  Key,
  Database,
  Car,
  Gauge,
  HardDrive,
  Shield,
  Cable,
  Scan,
  Settings2,
  Save,
  Clock,
  Copy,
} from "lucide-react";
import { cn } from "@/lib/utils";

export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [apiStatus, setApiStatus] = useState<"ok" | "error" | "unknown">("unknown");
  const [workbenchOpen, setWorkbenchOpen] = useState(() => location.startsWith("/workbench"));

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.ok ? setApiStatus("ok") : setApiStatus("error"))
      .catch(() => setApiStatus("error"));
  }, []);

  const navItems = [
    { href: "/", label: "Upload & Analyze", icon: LayoutDashboard },
    { href: "/history", label: "Vault / History", icon: History },
    { href: "/analysis", label: "Analyses", icon: Activity, matchPrefix: true },
    { href: "/hex", label: "Hex Viewer", icon: HexagonIcon, matchPrefix: true },
    { href: "/compare", label: "Compare", icon: GitCompare },
    { href: "/align", label: "Multi-Align", icon: Layers },
    { href: "/diff", label: "Diff", icon: FileDigit },
    { href: "/batch", label: "Batch Analysis", icon: Cpu },
    { href: "/patterns", label: "Pattern Library", icon: BookOpen },
    { href: "/knowledge-graph", label: "Knowledge Graph", icon: Network },
    { href: "/rules", label: "YARA Rules", icon: ShieldCheck },
    { href: "/doctor", label: "Doctor", icon: Stethoscope },
  ];

  const workbenchItems = [
    { href: "/workbench/bcm", label: "BCM", icon: CircuitBoard },
    { href: "/workbench/rfhub", label: "RFHUB", icon: Radio },
    { href: "/workbench/ecm", label: "ECM", icon: Zap },
    { href: "/workbench/adcm", label: "ADCM", icon: Cpu },
    { href: "/workbench/uds", label: "UDS Console", icon: Cable },
    { href: "/workbench/seed", label: "Seed/Key", icon: Key },
    { href: "/workbench/security", label: "Security", icon: Lock },
    { href: "/workbench/jailbreak", label: "Jailbreak", icon: Shield },
    { href: "/workbench/dumps", label: "Dumps", icon: Database },
    { href: "/workbench/immovin", label: "IMMO/VIN", icon: Car },
    { href: "/workbench/obd", label: "OBD", icon: Gauge },
    { href: "/workbench/bench", label: "Bench", icon: Settings2 },
    { href: "/workbench/gpec", label: "GPEC", icon: HardDrive },
    { href: "/workbench/gpec2a", label: "GPEC2A", icon: HardDrive },
    { href: "/workbench/rfhpcm", label: "RFH↔PCM", icon: Copy },
    { href: "/workbench/autelsgw", label: "Autel SGW", icon: Scan },
    { href: "/workbench/fcaanalyzer", label: "FCA Analyzer", icon: Activity },
    { href: "/workbench/programall", label: "Program All", icon: Wrench },
    { href: "/workbench/backups", label: "Backups", icon: Save },
    { href: "/workbench/sessions", label: "Sessions", icon: Clock },
    { href: "/workbench/twin", label: "Twin Builder", icon: Copy },
  ];

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden text-foreground">
      {/* Sidebar */}
      <div className="w-64 border-r border-border bg-sidebar flex flex-col justify-between shrink-0">
        <div className="overflow-y-auto">
          <div className="p-6 flex items-center gap-3">
            <Cpu className="w-8 h-8 text-primary shrink-0" />
            <div>
              <h1 className="font-bold text-sm tracking-widest uppercase text-sidebar-foreground">SRT Lab</h1>
              <div className="text-xs text-muted-foreground font-mono">Ultimate Edition</div>
            </div>
          </div>
          <nav className="px-4 space-y-1 pb-4">
            {navItems.map((item) => {
              const active =
                location === item.href ||
                (item.matchPrefix && item.href !== "/" && location.startsWith(item.href));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-sm text-sm font-medium transition-colors",
                    active
                      ? "bg-sidebar-primary/10 text-sidebar-primary-foreground border border-sidebar-primary/20"
                      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  )}
                >
                  <item.icon className="w-4 h-4 shrink-0" />
                  {item.label}
                </Link>
              );
            })}
            {/* ECU Workbench Section */}
            <div className="pt-3 mt-3 border-t border-sidebar-border">
              <button
                onClick={() => setWorkbenchOpen(!workbenchOpen)}
                className="flex items-center gap-3 px-3 py-2 rounded-sm text-sm font-bold w-full text-left text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
              >
                <Wrench className="w-4 h-4 shrink-0 text-orange-500" />
                <span className="flex-1">ECU Workbench</span>
                {workbenchOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              </button>
              {workbenchOpen && (
                <div className="ml-2 space-y-0.5 mt-1">
                  {workbenchItems.map((item) => {
                    const active = location === item.href;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={cn(
                          "flex items-center gap-2 px-3 py-1.5 rounded-sm text-xs font-medium transition-colors",
                          active
                            ? "bg-orange-500/10 text-orange-400 border border-orange-500/20"
                            : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                        )}
                      >
                        <item.icon className="w-3 h-3 shrink-0" />
                        {item.label}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          </nav>
        </div>
        <div className="border-t border-sidebar-border shrink-0">
          <div className="px-4 py-4 flex items-center gap-2">
            <div
              className={cn(
                "w-2 h-2 rounded-full",
                apiStatus === "ok"
                  ? "bg-primary"
                  : apiStatus === "error"
                  ? "bg-destructive animate-pulse"
                  : "bg-muted-foreground"
              )}
            />
            <span className="text-xs font-mono text-muted-foreground">
              API: {apiStatus === "unknown" ? "checking..." : apiStatus}
            </span>
          </div>
        </div>
      </div>
      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        <div className="absolute inset-0 pointer-events-none tactical-grid opacity-20" />
        <div className="relative flex-1 overflow-auto p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
