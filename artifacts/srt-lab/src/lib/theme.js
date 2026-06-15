/* theme — the dark "bench" palette for the rebuilt back-side workbench UI.

   The audit flagged that the app mixed a light shell with dark hero screens
   (Topology). For a professional bench/diagnostic tool (Topdon / Autel / wiTECH
   are all dark), dark is the right call — and ONE source of truth stops the tabs
   from drifting. The light `C` palette (constants.js) still drives the main
   vehicle/landing page; everything after it uses this. */

import { TC } from './constants.js';

export const T = {
  // surfaces
  bg: '#0A0A0F', panel: '#12121A', panel2: '#0D0D14', card: '#16161F', raise: '#1B1B26',
  border: '#1E1E2E', borderLit: '#2A2A3A',
  // text
  text: '#E8E8EE', dim: '#8B91A0', faint: '#565B6A',
  // status / accents
  red: '#FF4D5E', green: '#19E08A', blue: '#3AA0FF', yellow: '#FFB020', purple: '#B98CFF', teal: '#2DD4BF', orange: '#FF8A3D',
  // type
  font: '"Nunito", system-ui, sans-serif', mono: '"JetBrains Mono", monospace',
};

// Per-workbench accent colour (used for the rail + headers).
export const WB_ACCENT = {
  live: T.blue, keys: T.purple, bench: T.orange, gpec: T.teal,
};

// Module-type colours (reuse the existing catalog).
export const MOD_COLOR = TC;

export default T;
