// Current technician identity for the bench session.
//
// One source of truth for "who is signing for the work happening on this
// browser right now". The Read-First pre-write modal, the diff report saver,
// and the dedicated tech picker in the Backups tab all read and write through
// here so a switch made in any one of them is immediately reflected
// everywhere else. The picker also surfaces a most-recently-used list so a
// shop with a small fixed roster of techs can claim reports with a click
// instead of retyping their name every shift.
//
// Storage layout:
//   srtlab_tech         -> string, current tech display name (legacy key,
//                          left intact so existing entries keep working)
//   srtlab_tech_recent  -> JSON array of recently-used names, newest first

const CURRENT_KEY = "srtlab_tech";
const RECENT_KEY = "srtlab_tech_recent";
const MAX_RECENT = 8;
const MAX_NAME_LEN = 120;
const EVENT = "srtlab:tech";

function normalize(name) {
  if (typeof name !== "string") return "";
  return name.trim().slice(0, MAX_NAME_LEN);
}

function notify() {
  try { window.dispatchEvent(new Event(EVENT)); } catch { /* ignore */ }
}

export function getCurrentTech() {
  try {
    const v = localStorage.getItem(CURRENT_KEY);
    const norm = normalize(v || "");
    return norm || null;
  } catch { return null; }
}

export function getRecentTechs() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((n) => normalize(n))
      .filter((n) => n.length > 0)
      .slice(0, MAX_RECENT);
  } catch { return []; }
}

function writeRecents(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT))); }
  catch { /* ignore */ }
}

/* Set (or clear) the active technician. Passing an empty value clears the
 * current tech without erasing the recents list, so a tech can sign out at
 * the end of a shift without losing the dropdown suggestions for next time.
 * Returns the resolved name (or null when cleared). */
export function setCurrentTech(name) {
  const norm = normalize(name);
  try {
    if (!norm) {
      localStorage.removeItem(CURRENT_KEY);
    } else {
      localStorage.setItem(CURRENT_KEY, norm);
      const existing = getRecentTechs();
      const deduped = [norm, ...existing.filter((n) => n.toLowerCase() !== norm.toLowerCase())];
      writeRecents(deduped);
    }
  } catch { /* ignore quota */ }
  notify();
  return norm || null;
}

/* Drop a name from the suggestion list — used when a tech mistypes their
 * name and the bad entry keeps reappearing in the dropdown. */
export function forgetRecentTech(name) {
  const norm = normalize(name);
  if (!norm) return;
  const filtered = getRecentTechs().filter((n) => n.toLowerCase() !== norm.toLowerCase());
  writeRecents(filtered);
  notify();
}

export function subscribeTechIdentity(handler) {
  const listener = () => handler();
  try { window.addEventListener(EVENT, listener); } catch { /* ignore */ }
  try { window.addEventListener("storage", listener); } catch { /* ignore */ }
  return () => {
    try { window.removeEventListener(EVENT, listener); } catch { /* ignore */ }
    try { window.removeEventListener("storage", listener); } catch { /* ignore */ }
  };
}
