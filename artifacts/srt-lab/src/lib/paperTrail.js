/* Paper-trail layer — thin re-export shim over lib/audit.js so the eleven
 * existing `logSession(...)` call sites across the BCM/RFHUB/ECM/ADCM/OBD/
 * UDS/Jailbreak/ProgramAll tabs keep working at their historical import
 * path. The single source of truth lives in lib/audit.js. */
export {
  logSession,
  getSessions,
  deleteSession,
  clearSessions,
  generateSessionReport,
  sessionsToCSV,
} from "./audit.js";
