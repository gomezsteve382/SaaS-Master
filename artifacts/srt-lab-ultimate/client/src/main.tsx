import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { installApiBaseFetchPatch } from "./lib/apiBase";

installApiBaseFetchPatch();

createRoot(document.getElementById("root")!).render(<App />);
