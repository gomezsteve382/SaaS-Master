/**
 * VehicleYearGuard — shows a contextual banner on key-related tabs when:
 *   1. A VIN is loaded in the workspace AND
 *   2. The derived vehicle year does NOT fall within any generation of the
 *      currently selected vehicle profile.
 *
 * The banner is informational only — it never blocks the operator.
 * Pass `vehicle` (from VEHICLES[vehicleId]) and optionally `vinYear`
 * (number, e.g. 2019). If `vinYear` is null the banner is suppressed.
 *
 * Usage:
 *   import VehicleYearGuard from "../components/VehicleYearGuard.jsx";
 *   <VehicleYearGuard vehicle={vehicle} vinYear={vinYear} />
 */
import React, {useContext, useState, useMemo} from "react";
import {C} from "../lib/constants.js";
import {MasterVinContext} from "../lib/masterVinContext.jsx";
import {parseVinYear} from "../lib/vin.js";

/**
 * Parse a generation `years` string like "11-14" or "18-23" into
 * a [startYear, endYear] pair using full 4-digit years.
 */
function parseGenYears(yearsStr) {
  if (!yearsStr) return null;
  const m = /^(\d{2})-(\d{2})$/.exec(yearsStr.trim());
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end   = parseInt(m[2], 10);
  // Assume 2000s: 00-99 → 2000-2099
  return [2000 + start, 2000 + end];
}

/**
 * Returns true when `year` falls within any generation of `vehicle`.
 */
function yearInVehicle(vehicle, year) {
  if (!vehicle || !year) return true; // no data → no warning
  for (const gen of (vehicle.generations || [])) {
    const range = parseGenYears(gen.years);
    if (!range) continue;
    if (year >= range[0] && year <= range[1]) return true;
  }
  return false;
}

export default function VehicleYearGuard({ vehicle, vinYear: propVinYear }) {
  const { vin: masterVin } = useContext(MasterVinContext);
  const [dismissed, setDismissed] = useState(false);

  const vinYear = useMemo(() => {
    if (propVinYear != null) return propVinYear;
    if (!masterVin || masterVin.length !== 17) return null;
    return parseVinYear(masterVin);
  }, [masterVin, propVinYear]);

  if (!vehicle || !vinYear || dismissed) return null;
  if (yearInVehicle(vehicle, vinYear)) return null;

  // Find the closest generation by year range for a helpful hint
  const genLabels = (vehicle.generations || []).map(g => g.label).join(', ');

  return (
    <div data-testid="vehicle-year-guard" style={{
      background: '#FFF8E1',
      border: '1.5px solid #F9A825',
      borderRadius: 10,
      padding: '10px 14px',
      marginBottom: 12,
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 12,
    }}>
      <div>
        <div style={{fontSize: 11, fontWeight: 900, color: '#E65100', letterSpacing: 1, marginBottom: 4}}>
          ⚠ YEAR MISMATCH
        </div>
        <div style={{fontSize: 12, color: C.tx, lineHeight: 1.5}}>
          VIN year <b>{vinYear}</b> is outside the supported range for{' '}
          <b>{vehicle.full || vehicle.name}</b>.
          {genLabels && (
            <> Supported generations: <span style={{color: C.ts}}>{genLabels}</span>.</>
          )}
          {' '}Verify you have the correct vehicle profile selected before programming.
        </div>
      </div>
      <button
        onClick={() => setDismissed(true)}
        style={{
          cursor: 'pointer',
          border: '1.5px solid #9E9E9E',
          padding: '5px 10px',
          borderRadius: 7,
          background: '#fff',
          color: '#9E9E9E',
          fontWeight: 800,
          fontSize: 10,
          letterSpacing: 0.5,
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        DISMISS
      </button>
    </div>
  );
}
