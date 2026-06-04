// 50 hidden BCM features for SRT/Demon/Hellcat/Redeye Chargers/Challengers.
// Each entry:
//   id    — internal id (used by profiles)
//   n     — display name
//   d     — short description
//   did   — UDS DataIdentifier (0xDE01 or 0xDE02)
//   off   — byte offset within the DID payload
//   mask  — optional bitmask for packed boolean/bitfield options
//   opts  — list of {l: label, v: byte/mask value} options
//   notes — optional caveat shown beneath the row
//   gen   — "gen1" | "gen2" | "all" — which BCM generation supports this feature

export const JAILBREAK_FEATURES = [
  { id: "vehicle_trim_level", gen: "all", n: "Vehicle Trim Level", d: "Configure vehicle trim level identification", did: 0xDE01, off: 0x00, opts: [
    { l: "SE", v: 0 }, { l: "SXT", v: 1 }, { l: "SXT Plus", v: 2 }, { l: "GT", v: 3 },
    { l: "R/T", v: 4 }, { l: "R/T Plus", v: 5 }, { l: "R/T Scat Pack", v: 6 },
    { l: "Scat Pack Widebody", v: 7 }, { l: "SRT 392", v: 8 }, { l: "SRT Hellcat", v: 9 },
    { l: "Hellcat Widebody", v: 10 }, { l: "SRT Hellcat Redeye", v: 11 },
    { l: "Redeye Widebody", v: 12 }, { l: "SRT Jailbreak", v: 13 },
    { l: "SRT Super Stock", v: 14 }, { l: "SRT Demon", v: 15 }, { l: "SRT Demon 170", v: 16 }
  ], notes: "Critical: Affects available features and performance settings" },
  { id: "engine_variant", gen: "all", n: "Engine Variant", d: "Engine configuration identifier", did: 0xDE01, off: 0x01, opts: [
    { l: "3.6L Pentastar V6", v: 1 }, { l: "5.7L HEMI V8", v: 2 }, { l: "6.4L HEMI 392 V8", v: 3 },
    { l: "6.2L Supercharged V8 (Hellcat)", v: 4 }, { l: "6.2L Supercharged V8 (Redeye)", v: 5 },
    { l: "6.2L Supercharged V8 (Demon)", v: 6 }, { l: "6.2L Supercharged V8 (Demon 170)", v: 7 }
  ] },
  { id: "launch_control", gen: "all", n: "Launch Control", d: "Enable launch control system", did: 0xDE01, off: 0x10, mask: 0x01,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 1 }], notes: "Available on SRT and performance models" },
  { id: "launch_control_rpm", gen: "all", n: "Launch Control RPM", d: "Target RPM for launch control", did: 0xDE01, off: 0x11,
    opts: [{ l: "2000 RPM", v: 20 }, { l: "2500 RPM", v: 25 }, { l: "3000 RPM", v: 30 }, { l: "3500 RPM", v: 35 }, { l: "4000 RPM", v: 40 }, { l: "4500 RPM", v: 45 }, { l: "5000 RPM", v: 50 }],
    notes: "Optimal RPM varies by tire and conditions" },
  { id: "line_lock", gen: "all", n: "Line Lock", d: "Enable line lock for burnouts and tire warming", did: 0xDE01, off: 0x12, mask: 0x01,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 1 }], notes: "For track use only — holds front brakes while spinning rears" },
  { id: "line_lock_duration", gen: "all", n: "Line Lock Duration", d: "Maximum time line lock remains engaged", did: 0xDE01, off: 0x13,
    opts: [{ l: "10 seconds", v: 10 }, { l: "15 seconds", v: 15 }, { l: "20 seconds", v: 20 }, { l: "30 seconds", v: 30 }, { l: "45 seconds", v: 45 }] },
  { id: "power_modes_available", gen: "all", n: "Power Modes Available", d: "Which drive modes are accessible", did: 0xDE01, off: 0x20,
    opts: [{ l: "Street Only", v: 1 }, { l: "Street + Sport", v: 2 }, { l: "Street + Sport + Track", v: 3 }, { l: "All Modes", v: 4 }, { l: "All + Drag", v: 5 }, { l: "SRT Modes", v: 6 }] },
  { id: "track_mode", gen: "all", n: "Track Mode", d: "Enable track mode for aggressive driving", did: 0xDE01, off: 0x21, mask: 0x01,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 1 }], notes: "Adjusts throttle, transmission, and stability systems" },
  { id: "drag_mode", gen: "all", n: "Drag Mode", d: "Enable drag strip optimized mode", did: 0xDE01, off: 0x21, mask: 0x02,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 2 }], notes: "Optimizes for straight-line acceleration" },
  { id: "custom_mode", gen: "all", n: "Custom Drive Mode", d: "Enable user-configurable custom mode", did: 0xDE01, off: 0x21, mask: 0x04,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 4 }] },
  { id: "srt_performance_pages", gen: "all", n: "SRT Performance Pages", d: "Enable SRT performance monitoring pages", did: 0xDE01, off: 0x30, mask: 0x01,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 1 }], notes: "Shows G-force meter, timers, gauges" },
  { id: "srt_pages_timers", gen: "all", n: "SRT Performance Timers", d: "Enable 0-60, 1/8 mile, 1/4 mile timers", did: 0xDE01, off: 0x30, mask: 0x02,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 2 }] },
  { id: "srt_pages_gauges", gen: "all", n: "SRT Performance Gauges", d: "Enable additional performance gauges", did: 0xDE01, off: 0x30, mask: 0x04,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 4 }], notes: "Oil temp, trans temp, boost pressure" },
  { id: "srt_pages_dyno", gen: "all", n: "SRT Dyno Test Page", d: "Enable on-board dyno testing feature", did: 0xDE01, off: 0x30, mask: 0x08,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 8 }] },
  { id: "trans_brake", gen: "gen2", n: "Trans Brake", d: "Enable transmission brake for drag racing", did: 0xDE01, off: 0x40, mask: 0x01,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 1 }], notes: "Demon/Super Stock feature — holds trans while building boost" },
  { id: "trans_brake_rpm", gen: "gen2", n: "Trans Brake Target RPM", d: "RPM target when trans brake is engaged", did: 0xDE01, off: 0x41,
    opts: [{ l: "2000 RPM", v: 20 }, { l: "2200 RPM", v: 22 }, { l: "2350 RPM", v: 23 }, { l: "2500 RPM", v: 25 }, { l: "2700 RPM", v: 27 }] },
  { id: "race_options_menu", gen: "all", n: "Race Options Menu", d: "Enable race options in driver settings", did: 0xDE01, off: 0x42, mask: 0x01,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 1 }] },
  { id: "torque_reserve", gen: "gen2", n: "Torque Reserve", d: "Pre-load supercharger for faster launch", did: 0xDE01, off: 0x43, mask: 0x01,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 1 }], notes: "Hellcat/Redeye/Demon feature — builds boost before launch" },
  { id: "torque_reserve_level", gen: "gen2", n: "Torque Reserve Level", d: "Amount of pre-load torque reserve", did: 0xDE01, off: 0x44,
    opts: [{ l: "Low", v: 1 }, { l: "Medium", v: 2 }, { l: "High", v: 3 }, { l: "Maximum", v: 4 }] },
  { id: "launch_assist", gen: "all", n: "Launch Assist", d: "Electronic launch assist system", did: 0xDE01, off: 0x45, mask: 0x01,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 1 }] },
  { id: "esc_sport_mode", gen: "all", n: "ESC Sport Mode", d: "Electronic Stability Control sport setting", did: 0xDE01, off: 0x50,
    opts: [{ l: "Full On", v: 0 }, { l: "Sport", v: 1 }, { l: "Track", v: 2 }, { l: "Off", v: 3 }],
    notes: "Adjusts traction and stability thresholds" },
  { id: "traction_control_mode", gen: "all", n: "Traction Control Mode", d: "Traction control intervention level", did: 0xDE01, off: 0x51,
    opts: [{ l: "Full", v: 0 }, { l: "Sport", v: 1 }, { l: "Minimal", v: 2 }, { l: "Off", v: 3 }] },
  { id: "paddle_shifter_mode", gen: "all", n: "Paddle Shifter Mode", d: "Paddle shifter behavior", did: 0xDE01, off: 0x52,
    opts: [{ l: "Auto Return", v: 0 }, { l: "Manual Hold", v: 1 }, { l: "Sport Auto", v: 2 }] },
  { id: "shift_light", gen: "all", n: "Shift Light", d: "Enable shift indicator light", did: 0xDE01, off: 0x53, mask: 0x01,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 1 }] },
  { id: "shift_light_rpm", gen: "all", n: "Shift Light RPM", d: "RPM at which shift light activates", did: 0xDE01, off: 0x54,
    opts: [{ l: "5000 RPM", v: 50 }, { l: "5500 RPM", v: 55 }, { l: "6000 RPM", v: 60 }, { l: "6200 RPM", v: 62 }, { l: "6400 RPM", v: 64 }, { l: "6500 RPM", v: 65 }] },
  { id: "exhaust_mode", gen: "all", n: "Active Exhaust Mode", d: "Active exhaust valve settings", did: 0xDE01, off: 0x55,
    opts: [{ l: "Auto", v: 0 }, { l: "Quiet", v: 1 }, { l: "Normal", v: 2 }, { l: "Loud", v: 3 }, { l: "Track", v: 4 }],
    notes: "Requires active exhaust option" },
  { id: "suspension_mode", gen: "all", n: "Adaptive Suspension Mode", d: "Adaptive damper settings", did: 0xDE01, off: 0x56,
    opts: [{ l: "Auto", v: 0 }, { l: "Comfort", v: 1 }, { l: "Sport", v: 2 }, { l: "Track", v: 3 }],
    notes: "Requires adaptive suspension" },
  { id: "steering_mode", gen: "all", n: "Steering Mode", d: "Electric power steering weight", did: 0xDE01, off: 0x57,
    opts: [{ l: "Comfort", v: 0 }, { l: "Normal", v: 1 }, { l: "Sport", v: 2 }] },
  { id: "widebody_enabled", gen: "gen2", n: "Widebody Mode", d: "Enable widebody specific features", did: 0xDE01, off: 0x60, mask: 0x01,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 1 }], notes: "Affects suspension and aero settings" },
  { id: "power_chiller", gen: "gen2", n: "Power Chiller", d: "Enable A/C-based supercharger cooling", did: 0xDE01, off: 0x61, mask: 0x01,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 1 }], notes: "Demon/Super Stock feature — uses A/C to cool intercooler" },
  { id: "after_run_chiller", gen: "gen2", n: "After-Run Chiller", d: "Continue cooling after engine off", did: 0xDE01, off: 0x62,
    opts: [{ l: "Disabled", v: 0 }, { l: "1 minute", v: 1 }, { l: "2 minutes", v: 2 }, { l: "5 minutes", v: 5 }, { l: "10 minutes", v: 10 }],
    notes: "Keeps supercharger cool between runs" },
  { id: "drag_mode_suspension", gen: "gen2", n: "Drag Mode Suspension", d: "Suspension settings for drag racing", did: 0xDE01, off: 0x63,
    opts: [{ l: "Street", v: 0 }, { l: "Soft Front / Stiff Rear", v: 1 }, { l: "Drag Preset", v: 2 }],
    notes: "Optimizes weight transfer for drag launches" },
  { id: "rev_match", gen: "all", n: "Automatic Rev Match", d: "Automatic throttle blip on downshifts", did: 0xDE01, off: 0x64, mask: 0x01,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 1 }], notes: "Manual transmission models" },
  { id: "supercharger_display", gen: "gen2", n: "Supercharger Boost Display", d: "Show supercharger boost gauge", did: 0xDE02, off: 0x00, mask: 0x01,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 1 }], notes: "Hellcat/Redeye/Demon models" },
  { id: "intercooler_temp_display", gen: "gen2", n: "Intercooler Temperature Display", d: "Show intercooler coolant temperature", did: 0xDE02, off: 0x00, mask: 0x02,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 2 }] },
  { id: "oil_temp_display", gen: "all", n: "Oil Temperature Display", d: "Show engine oil temperature gauge", did: 0xDE02, off: 0x00, mask: 0x04,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 4 }] },
  { id: "trans_temp_display", gen: "all", n: "Transmission Temperature Display", d: "Show transmission fluid temperature", did: 0xDE02, off: 0x00, mask: 0x08,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 8 }] },
  { id: "g_force_meter", gen: "all", n: "G-Force Meter", d: "Show real-time G-force display", did: 0xDE02, off: 0x01, mask: 0x01,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 1 }] },
  { id: "timer_0_60", gen: "all", n: "0-60 MPH Timer", d: "Built-in 0-60 mph acceleration timer", did: 0xDE02, off: 0x01, mask: 0x02,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 2 }] },
  { id: "timer_quarter_mile", gen: "all", n: "Quarter Mile Timer", d: "Built-in 1/4 mile elapsed time timer", did: 0xDE02, off: 0x01, mask: 0x04,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 4 }] },
  { id: "timer_eighth_mile", gen: "all", n: "1/8 Mile Timer", d: "Built-in 1/8 mile elapsed time timer", did: 0xDE02, off: 0x01, mask: 0x08,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 8 }] },
  { id: "reaction_time_display", gen: "all", n: "Reaction Time Display", d: "Show reaction time from launch", did: 0xDE02, off: 0x02, mask: 0x01,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 1 }] },
  { id: "brake_temp_warning", gen: "all", n: "Brake Temperature Warning", d: "Alert when brake temperatures are high", did: 0xDE02, off: 0x10, mask: 0x01,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 1 }], notes: "Requires brake temperature sensors" },
  { id: "drive_mode_memory", gen: "all", n: "Drive Mode Memory", d: "Remember last drive mode on restart", did: 0xDE02, off: 0x11,
    opts: [{ l: "Reset to Default", v: 0 }, { l: "Remember Last", v: 1 }, { l: "Remember Sport", v: 2 }, { l: "Remember All", v: 3 }] },
  { id: "launch_warning", gen: "all", n: "Launch Control Warning", d: "Show warning before launch control activation", did: 0xDE02, off: 0x12, mask: 0x01,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 1 }] },
  { id: "performance_data_recorder", gen: "all", n: "Performance Data Recorder", d: "Record performance data to USB", did: 0xDE02, off: 0x20, mask: 0x01,
    opts: [{ l: "Disabled", v: 0 }, { l: "Enabled", v: 1 }], notes: "Requires compatible USB storage" },
  { id: "valet_speed_limit", gen: "all", n: "Valet Speed Limit", d: "Maximum speed in valet mode", did: 0xDE02, off: 0x21,
    opts: [{ l: "25 mph", v: 25 }, { l: "35 mph", v: 35 }, { l: "45 mph", v: 45 }, { l: "55 mph", v: 55 }] },
  { id: "valet_rpm_limit", gen: "all", n: "Valet RPM Limit", d: "Maximum RPM in valet mode", did: 0xDE02, off: 0x22,
    opts: [{ l: "3000 RPM", v: 30 }, { l: "3500 RPM", v: 35 }, { l: "4000 RPM", v: 40 }, { l: "4500 RPM", v: 45 }] },
  { id: "throttle_response", gen: "all", n: "Throttle Response", d: "Accelerator pedal sensitivity", did: 0xDE02, off: 0x30,
    opts: [{ l: "Comfort", v: 0 }, { l: "Sport", v: 1 }, { l: "Track", v: 2 }] },
  { id: "cylinder_deactivation", gen: "all", n: "Cylinder Deactivation (MDS)", d: "Multi-Displacement System control", did: 0xDE02, off: 0x31,
    opts: [{ l: "Auto", v: 0 }, { l: "Always Off", v: 1 }], notes: "Disabling improves performance but reduces fuel economy" },
];

// Category for each feature id (used to group rows in collapsible cards).
export const FEATURE_CATEGORY = {
  vehicle_trim_level: "Vehicle Configuration", engine_variant: "Vehicle Configuration",
  launch_control: "Launch & Performance", launch_control_rpm: "Launch & Performance",
  line_lock: "Launch & Performance", line_lock_duration: "Launch & Performance",
  launch_assist: "Launch & Performance",
  power_modes_available: "Drive Modes", track_mode: "Drive Modes", drag_mode: "Drive Modes",
  custom_mode: "Drive Modes", drive_mode_memory: "Drive Modes",
  srt_performance_pages: "SRT Performance Pages", srt_pages_timers: "SRT Performance Pages",
  srt_pages_gauges: "SRT Performance Pages", srt_pages_dyno: "SRT Performance Pages",
  trans_brake: "Trans Brake & Race", trans_brake_rpm: "Trans Brake & Race",
  race_options_menu: "Trans Brake & Race", torque_reserve: "Trans Brake & Race",
  torque_reserve_level: "Trans Brake & Race",
  esc_sport_mode: "Handling & Stability", traction_control_mode: "Handling & Stability",
  paddle_shifter_mode: "Handling & Stability", suspension_mode: "Handling & Stability",
  steering_mode: "Handling & Stability", drag_mode_suspension: "Handling & Stability",
  rev_match: "Handling & Stability",
  shift_light: "Powertrain", shift_light_rpm: "Powertrain", exhaust_mode: "Powertrain",
  throttle_response: "Powertrain", cylinder_deactivation: "Powertrain",
  widebody_enabled: "Aero & Cooling", power_chiller: "Aero & Cooling", after_run_chiller: "Aero & Cooling",
  supercharger_display: "Gauges & Displays", intercooler_temp_display: "Gauges & Displays",
  oil_temp_display: "Gauges & Displays", trans_temp_display: "Gauges & Displays",
  g_force_meter: "Telemetry", timer_0_60: "Telemetry", timer_quarter_mile: "Telemetry",
  timer_eighth_mile: "Telemetry", reaction_time_display: "Telemetry",
  performance_data_recorder: "Telemetry", launch_warning: "Telemetry",
  brake_temp_warning: "Telemetry",
  valet_speed_limit: "Valet & Misc", valet_rpm_limit: "Valet & Misc",
};

export const CATEGORY_ORDER = [
  "Vehicle Configuration", "Launch & Performance", "Drive Modes",
  "SRT Performance Pages", "Trans Brake & Race", "Handling & Stability",
  "Powertrain", "Aero & Cooling", "Gauges & Displays", "Telemetry", "Valet & Misc",
];

export const PROFILES = {
  "srt-full": {
    label: "SRT Full",
    // vehicle_trim_level values this profile is fully valid for (Scat Pack and above)
    compatibleTrims: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    // VIN position-8 engine codes for which this is the recommended profile
    recommendedEngines: ["G"],
    changes: {
      srt_performance_pages: 1, srt_pages_timers: 2, srt_pages_gauges: 4, srt_pages_dyno: 8,
      launch_control: 1, track_mode: 1, drag_mode: 2, race_options_menu: 1,
      g_force_meter: 1, timer_0_60: 2, timer_quarter_mile: 4, timer_eighth_mile: 8,
      reaction_time_display: 1, shift_light: 1, performance_data_recorder: 1,
    },
  },
  "demon": {
    label: "Demon Package",
    // Only valid on Demon / Demon 170 (trim values 15 and 16) — trans brake, power chiller etc.
    // require Demon-specific hardware and cannot be confirmed from the VIN alone.
    compatibleTrims: [15, 16],
    // Never auto-recommended from VIN: VIN engine code T covers both Redeye AND Demon
    // and we cannot tell them apart without reading the trim DID. User must select manually.
    recommendedEngines: [],
    changes: {
      vehicle_trim_level: 15, engine_variant: 6, widebody_enabled: 1,
      power_chiller: 1, after_run_chiller: 5, trans_brake: 1, torque_reserve: 1, torque_reserve_level: 4,
      srt_performance_pages: 1, srt_pages_timers: 2, srt_pages_gauges: 4, srt_pages_dyno: 8,
      launch_control: 1, track_mode: 1, drag_mode: 2, race_options_menu: 1, drag_mode_suspension: 2,
      supercharger_display: 1, intercooler_temp_display: 2, oil_temp_display: 4, trans_temp_display: 8,
      g_force_meter: 1, timer_0_60: 2, timer_quarter_mile: 4, timer_eighth_mile: 8,
    },
  },
  "hellcat": {
    label: "Hellcat",
    // All supercharged models: Hellcat, Hellcat WB, Redeye, Redeye WB, Jailbreak, Super Stock, Demon
    compatibleTrims: [9, 10, 11, 12, 13, 14, 15, 16],
    // Recommended for both Hellcat (R) and Redeye/Demon (T) — the safe baseline for all SC cars
    recommendedEngines: ["R", "T"],
    changes: {
      vehicle_trim_level: 9, engine_variant: 4,
      srt_performance_pages: 1, srt_pages_timers: 2, srt_pages_gauges: 4,
      launch_control: 1, track_mode: 1, torque_reserve: 1, torque_reserve_level: 3,
      shift_light: 1, supercharger_display: 1, oil_temp_display: 4,
    },
  },
  "track": {
    label: "Track Mode",
    // Scat Pack and above — any car that can actually use launch control / performance pages
    compatibleTrims: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    recommendedEngines: [],
    changes: {
      track_mode: 1, launch_control: 1, shift_light: 1, race_options_menu: 1,
      performance_data_recorder: 1, srt_performance_pages: 1, srt_pages_gauges: 4,
      g_force_meter: 1, brake_temp_warning: 1,
    },
  },
};

// ─── VIN decode tables ───────────────────────────────────────────────────────
// WMI → make label
const VIN_WMI = {
  "1C3": "Chrysler", "1C4": "Chrysler", "1C6": "RAM", "2C3": "Dodge",
  "2C4": "Chrysler", "1J4": "Jeep", "1B3": "Dodge", "2B3": "Dodge", "1J8": "Jeep",
};
// VIN position 10 → model year
const VIN_YR = {
  A: 2010, B: 2011, C: 2012, D: 2013, E: 2014, F: 2015, G: 2016, H: 2017,
  J: 2018, K: 2019, L: 2020, M: 2021, N: 2022, P: 2023, R: 2024, S: 2025, T: 2026,
};
// VIN position 5 → Dodge/Chrysler model name (best-effort — most common FCA CAN-bus vehicles)
const VIN_MODEL_POS5 = { D: "Charger", H: "Challenger", X: "Durango" };

// VIN position 8 → engine info.
// minTrim/maxTrim are the vehicle_trim_level values this engine code can represent.
// This range is used to determine profile compatibility: if NO trim in [minTrim..maxTrim]
// appears in a profile's compatibleTrims, the profile is definitively incompatible.
const VIN_ENGINE = {
  // Engine T covers Redeye (trims 11-14) AND Demon/Demon 170 (trims 15-16).
  // We cannot distinguish them from VIN alone, so we use the full range (11-16).
  T: { desc: "6.2L SC V8 (Redeye / Demon)", trimLabel: "SRT Redeye / Demon",  minTrim: 11, maxTrim: 16 },
  R: { desc: "6.2L SC V8 (Hellcat 707hp)",  trimLabel: "SRT Hellcat",          minTrim: 9,  maxTrim: 10 },
  G: { desc: "6.4L HEMI V8 SRT 392",        trimLabel: "SRT 392",              minTrim: 8,  maxTrim: 8  },
  H: { desc: "5.7L HEMI V8",                trimLabel: "R/T",                  minTrim: 4,  maxTrim: 5  },
  E: { desc: "5.7L HEMI V8",                trimLabel: "R/T",                  minTrim: 4,  maxTrim: 5  },
  F: { desc: "3.6L Pentastar V6",           trimLabel: "SXT / Base",           minTrim: 0,  maxTrim: 3  },
  S: { desc: "3.6L Pentastar V6+",          trimLabel: "SXT / Base",           minTrim: 0,  maxTrim: 3  },
};

/**
 * Decode the key fields from a 17-character VIN string.
 * Returns null if the VIN is malformed or not 17 chars.
 *
 * @param {string} vin
 * @returns {{
 *   year: number|null, make: string, model: string,
 *   engineDesc: string, trimLabel: string,
 *   minTrim: number, maxTrim: number,
 *   engineCode: string, recommendedProfile: string|null,
 *   ambiguous: boolean
 * } | null}
 */
export function decodeVinInfo(vin) {
  if (!vin || vin.length !== 17) return null;
  const v = vin.toUpperCase();
  const wmi = v.slice(0, 3);
  const make = VIN_WMI[wmi] || "Unknown";
  const model = VIN_MODEL_POS5[v[4]] || "";
  const year = VIN_YR[v[9]] || null;
  const engineCode = v[7];
  const engineInfo = VIN_ENGINE[engineCode] || {
    desc: "Unknown engine (" + engineCode + ")",
    trimLabel: "Unknown",
    minTrim: 0, maxTrim: 0,
  };

  // Find the best recommended profile for this engine code.
  // Profiles opt in via recommendedEngines — demon never opts in (ambiguous with Redeye).
  let recommendedProfile = null;
  for (const [key, prof] of Object.entries(PROFILES)) {
    if (prof.recommendedEngines && prof.recommendedEngines.includes(engineCode)) {
      recommendedProfile = key;
      break;
    }
  }

  // Engine code T spans Redeye AND Demon — flag as ambiguous so the UI can warn
  const ambiguous = engineCode === "T";

  return {
    year,
    make,
    model,
    engineDesc: engineInfo.desc,
    trimLabel: engineInfo.trimLabel,
    minTrim: engineInfo.minTrim,
    maxTrim: engineInfo.maxTrim,
    engineCode,
    recommendedProfile,
    ambiguous,
  };
}

/**
 * Check whether a profile is compatible with a detected VIN engine range.
 * Returns false only when NO trim in [minTrim..maxTrim] appears in the
 * profile's compatibleTrims — meaning the profile is definitively incompatible
 * with this vehicle regardless of exact trim.
 *
 * Returns true if no range information is available (minTrim/maxTrim are null).
 *
 * @param {string}      profileKey
 * @param {number|null} minTrim   — lowest vehicle_trim_level value the detected engine maps to
 * @param {number|null} maxTrim   — highest vehicle_trim_level value the detected engine maps to
 * @returns {boolean}
 */
export function isProfileCompatibleWithRange(profileKey, minTrim, maxTrim) {
  if (minTrim == null || maxTrim == null) return true;
  const prof = PROFILES[profileKey];
  if (!prof?.compatibleTrims) return true;
  for (let t = minTrim; t <= maxTrim; t++) {
    if (prof.compatibleTrims.includes(t)) return true;
  }
  return false;
}

/**
 * Given a detected vehicle_trim_level value (0-16) and a profile key,
 * return whether the profile is compatible with that exact trim value.
 * Returns true when no trim has been detected (undefined/null).
 *
 * @param {string} profileKey
 * @param {number|null|undefined} trimValue
 * @returns {boolean}
 */
export function isProfileCompatible(profileKey, trimValue) {
  if (trimValue == null) return true;
  const prof = PROFILES[profileKey];
  if (!prof || !prof.compatibleTrims) return true;
  return prof.compatibleTrims.includes(trimValue);
}

// Pre-defined module targets for the workshop.
export const MODULE_TARGETS = [
  { id: "bcm-cda6",    label: "BCM (CDA6)",       tx: 0x750, rx: 0x758, unlock: "cda6", needsUnlock: true },
  { id: "bcm-claude",  label: "BCM (CLAUDE)",     tx: 0x742, rx: 0x762, unlock: "cda6", needsUnlock: true },
  { id: "bcm-legacy",  label: "BCM (Legacy)",     tx: 0x7E0, rx: 0x7E8, unlock: "cda6", needsUnlock: true },
  { id: "bcm-darkvin", label: "BCM (DarkVIN)",    tx: 0x6B0, rx: 0x6B8, unlock: "cda6", needsUnlock: true },
  { id: "adcm",        label: "ADCM (Active Damping)", tx: 0x7A8, rx: 0x7B0, unlock: null, needsUnlock: false },
  { id: "sgw-xtea",    label: "SGW (XTEA, 2018+)", tx: 0x74F, rx: 0x76F, unlock: "xtea_sgw", needsUnlock: true },
];

// Per-vehicle BCM CAN address defaults.
// Maps vehicle.id → { targetId, isGen2 }
// isGen2 = true  → Gen2 (Redeye / TRX / 2018+ Demon) BCM with SEC16 split
// isGen2 = false → Gen1 (2011–2017 Hellcat / SRT 392) BCM
const VEHICLE_BCM_DEFAULTS = {
  charger:     { targetId: "bcm-cda6", isGen2: true  },
  challenger:  { targetId: "bcm-cda6", isGen2: true  },
  durango:     { targetId: "bcm-cda6", isGen2: false },
  trackhawk:   { targetId: "bcm-claude", isGen2: false },
  trx:         { targetId: "bcm-cda6", isGen2: true  },
};

/**
 * Returns the BCM defaults for the given vehicle object.
 * Falls back to the first BCM target when the vehicle is unknown.
 *
 * @param {object|null} vehicle  — the vehicle object from VEHICLES in App.jsx
 * @returns {{ targetId: string, moduleTarget: object, isGen2: boolean } | null}
 */
export function getVehicleBcmDefaults(vehicle) {
  if (!vehicle) return null;
  const entry = VEHICLE_BCM_DEFAULTS[vehicle.id];
  if (!entry) return null;
  const moduleTarget = MODULE_TARGETS.find(m => m.id === entry.targetId) || MODULE_TARGETS[0];
  return { targetId: entry.targetId, moduleTarget, isGen2: entry.isGen2 };
}

// Pre-defined routine IDs for the "Run Routine" UI.
export const ROUTINE_PRESETS = [
  { rid: 0x0312, label: "ADCM calibration / init (0x0312)" },
  { rid: 0xFF00, label: "Erase memory (0xFF00)" },
  { rid: 0xFF01, label: "Check programming dependencies (0xFF01)" },
];
