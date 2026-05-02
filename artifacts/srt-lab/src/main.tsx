import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { loadDidDescriptions } from "./lib/dids.js";

// Warm the DID dictionary so diagnostic UIs render labels alongside hex
// codes on first paint. Failure is non-fatal — `getDidDescription` falls
// back to the curated CRITICAL_DIDS baseline.
loadDidDescriptions();

createRoot(document.getElementById("root")!).render(<App />);
