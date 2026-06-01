import "../_group.css";
import {
  Stethoscope,
  Terminal,
  Fingerprint,
  DownloadCloud,
  Bot,
  ChevronRight,
  Wrench,
  Car,
  Plug,
  ShieldCheck,
  Search,
} from "lucide-react";

export type PaneKey = "diagnose" | "uds" | "vin" | "obd" | "copilot";

const NAV: { key: PaneKey; label: string; sub: string; icon: typeof Stethoscope }[] = [
  { key: "diagnose", label: "Diagnose", sub: "Drop \u2192 verdict \u2192 fix", icon: Stethoscope },
  { key: "uds", label: "UDS Command", sub: "Raw ISO 14229 console", icon: Terminal },
  { key: "vin", label: "VIN & Checksum", sub: "Read / write / verify", icon: Fingerprint },
  { key: "obd", label: "OBD Pull", sub: "Read bin dumps live", icon: DownloadCloud },
  { key: "copilot", label: "AI Copilot", sub: "Guided investigation", icon: Bot },
];

export function AppShell({
  active,
  children,
}: {
  active: PaneKey;
  children: React.ReactNode;
}) {
  return (
    <div
      className="srt-cc"
      style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      {/* Top bar */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 20,
          padding: "0 22px",
          height: 60,
          background: "var(--srt-ink)",
          color: "#fff",
          flexShrink: 0,
          borderBottom: "3px solid var(--srt-red)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 6,
              background: "var(--srt-red)",
              display: "grid",
              placeItems: "center",
              fontWeight: 900,
            }}
            className="font-display"
          >
            S
          </div>
          <span className="font-display" style={{ fontSize: 19, letterSpacing: ".04em" }}>
            SRT&nbsp;LAB
          </span>
        </div>

        {/* Active vehicle chip */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: "rgba(255,255,255,.08)",
            border: "1px solid rgba(255,255,255,.14)",
            borderRadius: 9,
            padding: "6px 12px",
          }}
        >
          <Car size={16} style={{ color: "var(--srt-red)" }} />
          <div style={{ lineHeight: 1.15 }}>
            <div style={{ fontWeight: 800, fontSize: 13 }}>2021 Charger SRT Hellcat</div>
            <div className="font-mono" style={{ fontSize: 11, opacity: 0.7 }}>
              2C3CDXL94MH500418
            </div>
          </div>
          <ChevronRight size={15} style={{ opacity: 0.5 }} />
        </div>

        <div style={{ flex: 1 }} />

        {/* Connection status */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
          <Plug size={15} style={{ color: "#69d36e" }} />
          <span style={{ opacity: 0.85 }}>J2534 bridge online</span>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "#69d36e",
              boxShadow: "0 0 0 3px rgba(105,211,110,.25)",
            }}
          />
        </div>

        {/* Advanced / Reference drawer entry */}
        <button
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            background: "transparent",
            color: "#fff",
            border: "1px solid rgba(255,255,255,.22)",
            borderRadius: 9,
            padding: "8px 13px",
            fontSize: 12.5,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          <Wrench size={15} />
          Advanced / Reference
          <span
            style={{
              background: "var(--srt-red)",
              borderRadius: 20,
              padding: "1px 7px",
              fontSize: 10.5,
              fontWeight: 800,
            }}
          >
            36
          </span>
        </button>
      </header>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Left rail */}
        <nav
          style={{
            width: 232,
            flexShrink: 0,
            background: "var(--srt-panel)",
            borderRight: "1px solid var(--srt-line)",
            padding: "16px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 800,
              letterSpacing: ".12em",
              color: "var(--srt-muted)",
              padding: "4px 10px 8px",
            }}
          >
            PER-VEHICLE WORKFLOW
          </div>

          {NAV.map((item) => {
            const isActive = item.key === active;
            const Icon = item.icon;
            return (
              <div
                key={item.key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 11,
                  padding: "11px 11px",
                  borderRadius: 10,
                  cursor: "pointer",
                  background: isActive ? "var(--srt-red)" : "transparent",
                  color: isActive ? "#fff" : "var(--srt-ink)",
                  boxShadow: isActive ? "0 6px 16px -6px rgba(211,47,47,.6)" : "none",
                }}
              >
                <Icon size={19} style={{ flexShrink: 0, opacity: isActive ? 1 : 0.7 }} />
                <div style={{ lineHeight: 1.2 }}>
                  <div style={{ fontWeight: 800, fontSize: 13.5 }}>{item.label}</div>
                  <div
                    style={{
                      fontSize: 11,
                      opacity: isActive ? 0.85 : 0.55,
                    }}
                  >
                    {item.sub}
                  </div>
                </div>
              </div>
            );
          })}

          <div style={{ flex: 1 }} />

          <div
            style={{
              borderTop: "1px solid var(--srt-line)",
              paddingTop: 12,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {[
              { icon: ShieldCheck, label: "Module Census" },
              { icon: Search, label: "CAN Universe \u00b7 Intel" },
            ].map((x) => (
              <div
                key={x.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 11px",
                  borderRadius: 9,
                  color: "var(--srt-muted)",
                  fontSize: 12.5,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                <x.icon size={16} />
                {x.label}
              </div>
            ))}
          </div>
        </nav>

        {/* Content slot */}
        <main style={{ flex: 1, minWidth: 0, overflow: "auto", background: "var(--srt-base)" }}>
          {children}
        </main>
      </div>
    </div>
  );
}
