// Hand-curated dispatcher metadata that does NOT come from the AlfaOBD
// catalog JSON. The catalog only resolves the 8 fully-traced families
// plus 2 fully-traced ECU rows; the upstream RE README documents 31
// additional explicit `eEcutype` equality checks inside `abf()` whose
// wrapper names have not yet been catalogued.
//
// Listing those branches here lets consumers SEE the dispatcher's
// actual scope (UCONNECT and RADIO_FGA are NOT the only ECU-specific
// branches) without polluting the auto-generated module — which must
// stay a pure projection of the catalog JSON.
//
// Source: attached_assets/alfaobd_seedkey_README_1776573875647.md,
// "Plus 41 explicit eEcutype equality checks for individual ECUs..."
//
// Once the upstream RE traces a wrapper name for one of these ECUs,
// it should be moved INTO the catalog JSON (and out of this file) so
// the codegen picks it up automatically. Removing an entry here is
// safe — consumers must treat it as advisory metadata, never as a
// computable algorithm.
const README_ECU_BRANCHES = [
  "ORC","OCM_PN","ABS_PN","ABS_CHRYSLER","TIPM_CGW",
  "RADIO_NON_PN","DDM_DT","PDM_DT","AFLS_PN","IPC_PN","EPS_PN",
  "ADCM","ADCM_PN","ASCM_PN","ASBS_PN","TTPM_PN","CSWM_PN",
  "LBSS_PN","RBSS_PN","APM_PN","OBCM","BPCM","BPCM_PN","EVCU",
  "TGW_PN","ICS_PN","CVPM_PN","AMP_PN","ANC_PN","TBM2","TBM2_PN",
];

// Status marker used by SeedTab to render these rows as advisory-only
// (no compute affordance), distinguishable from the resolved rows.
const STATUS_BRANCH_KNOWN = "branch_known_algo_not_traced";

// One advisory entry per README ECU. Empty levels map = no level
// resolves to a wrapper today; `_status` is documentation, not data.
const AOBD_DISPATCH_AUX = Object.fromEntries(
  README_ECU_BRANCHES.map((ecu) => [`ecu_${ecu}`, { _status: STATUS_BRANCH_KNOWN }])
);

// Convenience: merged view of the catalog's resolved dispatch and the
// auxiliary advisory rows. Consumers (e.g. SeedTab) call this to get
// the full dispatcher scope; the resolved entries take precedence so
// a future RE finding in the catalog JSON automatically wins over the
// placeholder here.
function mergeDispatch(catalogDispatch) {
  return { ...AOBD_DISPATCH_AUX, ...catalogDispatch };
}

export { README_ECU_BRANCHES, AOBD_DISPATCH_AUX, STATUS_BRANCH_KNOWN, mergeDispatch };
