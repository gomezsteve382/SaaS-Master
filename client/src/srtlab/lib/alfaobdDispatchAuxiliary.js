// Hand-curated dispatcher metadata that does NOT come from the AlfaOBD
// catalog JSON. The catalog only resolves the 8 fully-traced families
// plus 2 fully-traced ECU rows; the upstream RE README documents 31
// additional explicit `eEcutype` equality checks inside `abf()` whose
// wrapper names have not yet been fully catalogued.
//
// The authoritative data file is ecuBranchAlgorithms.js. This module
// re-exports the relevant pieces so existing consumers keep working
// without changes. When the RE agent returns the full 31-entry table,
// update ecuBranchAlgorithms.js ONLY — everything here auto-updates.
//
// Source: attached_assets/alfaobd_seedkey_README_1776573875647.md,
// "Plus 41 explicit eEcutype equality checks for individual ECUs..."

import {
  ECU_BRANCH_ALGORITHMS,
  getBranchByName,
  getBranchByEcuType,
  getComputableBranches,
  getPendingBranches,
  getBranchCoverage,
} from './ecuBranchAlgorithms.js';

// Flat name list for backward compatibility with SeedTab / AlfaObdIntelTab
const README_ECU_BRANCHES = ECU_BRANCH_ALGORITHMS.map(e => e.name);

// Status marker used by SeedTab to render pending rows as advisory-only
const STATUS_BRANCH_KNOWN = 'branch_known_algo_not_traced';
const STATUS_CONFIRMED    = 'confirmed';
const STATUS_INFERRED     = 'inferred';

// Legacy AOBD_DISPATCH_AUX shape — pending entries get the old advisory
// marker; confirmed/inferred entries get their algorithm data.
const AOBD_DISPATCH_AUX = Object.fromEntries(
  ECU_BRANCH_ALGORITHMS.map(e => [
    `ecu_${e.name}`,
    e.confidence === 'pending'
      ? { _status: STATUS_BRANCH_KNOWN }
      : {
          _status: e.confidence,
          algo: e.algo,
          wrapper: e.wrapper,
          level: e.level,
          ecuType: e.ecuType,
          note: e.note,
        },
  ])
);

// Convenience: merged view of the catalog's resolved dispatch and the
// auxiliary advisory rows. Consumers (e.g. SeedTab) call this to get
// the full dispatcher scope; the resolved entries take precedence.
function mergeDispatch(catalogDispatch) {
  return { ...AOBD_DISPATCH_AUX, ...catalogDispatch };
}

export {
  README_ECU_BRANCHES,
  AOBD_DISPATCH_AUX,
  STATUS_BRANCH_KNOWN,
  STATUS_CONFIRMED,
  STATUS_INFERRED,
  mergeDispatch,
  // Re-export from ecuBranchAlgorithms for direct consumers
  ECU_BRANCH_ALGORITHMS,
  getBranchByName,
  getBranchByEcuType,
  getComputableBranches,
  getPendingBranches,
  getBranchCoverage,
};
