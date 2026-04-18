/* Paper-trail layer removed.
 * Sessions / audit logging is no longer recorded. These stubs remain so any
 * remaining call sites continue to compile and run silently. Binary backup
 * snapshots (lib/backups.js + lib/audit.js backup half) are unaffected. */
export function logSession() { return null; }
export function getSessions() { return []; }
export function deleteSession() {}
export function clearSessions() {}
export function generateSessionReport() { return ""; }
export function sessionsToCSV() { return ""; }
