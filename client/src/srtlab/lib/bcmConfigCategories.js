/**
 * bcmConfigCategories.js — bucket every BCM Configuration DID
 * (DE00..DE0C plus the 0x04C0..0x05DF body extras) into one of ten
 * themed categories, each with a Pixar-style hero banner, accent
 * colour and short tagline used by BcmConfigTab.
 *
 * Anything not in CATEGORY_DID_MAP falls into the OTHER bucket so a
 * future generator that introduces a new DID still renders.
 */

import { perfImg } from '../assets/bcm-cat-urls.js';
import { perfLaunchImg } from '../assets/bcm-cat-urls.js';
import { perfDynoImg } from '../assets/bcm-cat-urls.js';
import { perfModesImg } from '../assets/bcm-cat-urls.js';
import { perfEngineImg } from '../assets/bcm-cat-urls.js';
import { identityImg } from '../assets/bcm-cat-urls.js';
import { lightingImg } from '../assets/bcm-cat-urls.js';
import { doorsImg } from '../assets/bcm-cat-urls.js';
import { comfortImg } from '../assets/bcm-cat-urls.js';
import { camerasImg } from '../assets/bcm-cat-urls.js';
import { safetyImg } from '../assets/bcm-cat-urls.js';
import { keysImg } from '../assets/bcm-cat-urls.js';
import { suspImg } from '../assets/bcm-cat-urls.js';
import { towingImg } from '../assets/bcm-cat-urls.js';

export const BCM_CATEGORIES = [
  {
    id: 'perf',
    label: 'PERFORMANCE & SRT',
    tag: 'TRACK · DRAG · LAUNCH · TRANS BRAKE · LINE LOCK',
    accent: '#FF1744',
    image: perfImg,
    glyph: '🏁',
    blurb: 'Performance Pages, Track Mode, Drag Mode, Launch Control, Line Lock, Trans Brake, Eco/Sport/Custom drive modes.',
  },
  {
    id: 'identity',
    label: 'VEHICLE IDENTITY',
    tag: 'BRAND · CLASS · PACKAGE · MODEL YEAR',
    accent: '#FF6D00',
    image: identityImg,
    glyph: '🏷',
    blurb: 'Brand badge, vehicle class, option package, model year, fleet flag, PTO and the BCM\'s built-in vehicle profile.',
  },
  {
    id: 'lighting',
    label: 'LIGHTING & SIGNALS',
    tag: 'HEADLIGHTS · DRL · POLICE · AMBIENT',
    accent: '#FFB300',
    image: lightingImg,
    glyph: '💡',
    blurb: 'DRL, auto highbeam, fog, cornering, welcome, ambient interior lighting, hard-braking flash, police lighting.',
  },
  {
    id: 'doors',
    label: 'DOORS, LOCKS & GLASS',
    tag: 'PASSIVE ENTRY · AUTO LOCK · WINDOWS · SUNROOF',
    accent: '#2979FF',
    image: doorsImg,
    glyph: '🔒',
    blurb: 'Auto lock, passive entry, fob range, window express, sunroof / panoramic, trunk and tailgate behaviour.',
  },
  {
    id: 'comfort',
    label: 'COMFORT & CLIMATE',
    tag: 'HVAC · MIRRORS · WIPERS · DISPLAY · CHIMES',
    accent: '#00BFA5',
    image: comfortImg,
    glyph: '🛋',
    blurb: 'Heated seats, A/C, mirrors, wipers, cluster display, horn / chime volume, comfort and convenience defaults.',
  },
  {
    id: 'cameras',
    label: 'CAMERAS & VISION',
    tag: 'REAR VIEW · SURROUND · FULL CENTRAL VISION',
    accent: '#7C4DFF',
    image: camerasImg,
    glyph: '📷',
    blurb: 'Rear view camera, front / rear park assist, surround view and Full Central Vision processing presence.',
  },
  {
    id: 'safety',
    label: 'SAFETY & DRIVER ASSIST',
    tag: 'FCW · BLIND SPOT · LANE KEEP · TPMS',
    accent: '#00C853',
    image: safetyImg,
    glyph: '🛡',
    blurb: 'Forward collision warning, active blind spot, lane keep, hill-start assist, auto park, TPMS configuration.',
  },
  {
    id: 'keys',
    label: 'KEYS & SECURITY',
    tag: 'RED KEY · SKIM · SMART KEY · ALARM',
    accent: '#FF1744',
    image: keysImg,
    glyph: '🗝',
    blurb: 'Red Key feature presence, SKIM immobiliser, smart-key configuration, alarm and security wake behaviour.',
  },
  {
    id: 'suspension',
    label: 'SUSPENSION & DRIVETRAIN',
    tag: 'AIR RIDE · ACTIVE DAMPING · TRANS · PARK BRAKE',
    accent: '#AA00FF',
    image: suspImg,
    glyph: '🛞',
    blurb: 'Air Suspension Control, Active Damping, automatic transmission profile, electric park brake, engine + start.',
  },
  {
    id: 'towing',
    label: 'TOWING & ACCESSORIES',
    tag: 'HITCH · POWER LIFTGATE · TRAILER · 7-PIN',
    accent: '#FFAB00',
    image: towingImg,
    glyph: '🚛',
    blurb: 'Trailer features, tow / haul mode, power liftgate, 7-pin connector, accessory and PTO related body flags.',
  },
];

export const OTHER_CATEGORY = {
  id: 'other',
  label: 'OTHER BODY DIDs',
  tag: 'UNCATEGORISED · RAW',
  accent: '#9E9E9E',
  image: null,
  glyph: '⚙',
  blurb: 'Body parameter DIDs that have not been hand-bucketed into a themed category yet.',
};

/* DID → category id. Anything not in this map renders under OTHER. */
export const CATEGORY_DID_MAP = {
  // Performance & SRT
  0xDE0A: 'perf',
  0x0503: 'perf',
  0x04F4: 'perf',
  0x04F8: 'perf',

  // Vehicle identity
  0xDE0B: 'identity',
  0x04DE: 'identity',
  0x0504: 'identity',
  0x0536: 'identity',
  0x0538: 'identity',
  0x05B0: 'identity',
  0x05B2: 'identity',

  // Lighting & signals
  0xDE00: 'lighting',
  0x04C8: 'lighting',
  0x04C9: 'lighting',
  0x04CA: 'lighting',
  0x04DA: 'lighting',

  // Doors, locks & glass
  0xDE01: 'doors',
  0xDE05: 'doors',
  0x04D0: 'doors',
  0x04D2: 'doors',
  0x04D3: 'doors',
  0x05B1: 'doors',

  // Comfort & climate
  0xDE02: 'comfort',
  0xDE03: 'comfort',
  0xDE04: 'comfort',
  0xDE06: 'comfort',
  0xDE07: 'comfort',
  0x052B: 'comfort',
  0x052C: 'comfort',
  0x052D: 'comfort',
  0x052E: 'comfort',
  0x052F: 'comfort',

  // Cameras & vision
  0x04CC: 'cameras',
  0x052A: 'cameras',
  0x05AE: 'cameras',

  // Safety & driver assist
  0xDE0C: 'safety',
  0x04E0: 'safety',
  0x04EE: 'safety',
  0x05D6: 'safety',
  0x05D7: 'safety',

  // Keys & security
  0xDE09: 'keys',
  0x04D1: 'keys',
  0x04DB: 'keys',
  0x04DC: 'keys',
  0x04DD: 'keys',
  0x04DF: 'keys',
  0x04E4: 'keys',

  // Suspension & drivetrain
  0xDE08: 'suspension',
  0x05AC: 'suspension',
  0x05AD: 'suspension',
  0x05AF: 'suspension',

  // Towing & accessories
  0x0505: 'towing',
  0x0506: 'towing',
  0x0507: 'towing',
  0x0508: 'towing',
  0x0530: 'towing',
  0x0534: 'towing',
  0x0535: 'towing',
  0x0537: 'towing',
  0x0539: 'towing',
  0x05D4: 'towing',
};

/**
 * Performance & SRT sub-groups — buckets the 42 fields of DE0A
 * "Performance & SRT Configuration" into themed sub-panels, each with
 * its own Pixar hero image, accent gradient and blurb. Used by the
 * special PerfShowcase renderer in BcmConfigTab.
 *
 * Anything not listed in any sub-group's `fields` set falls into the
 * "MORE" sub-panel at the bottom so we never silently drop a field.
 */
export const PERF_SUBGROUPS = [
  {
    id: 'perf-pages',
    label: 'PERFORMANCE PAGES',
    tag: 'CLUSTER · GAUGES · TIMERS · DYNO · G-FORCE',
    accent: '#FF1744',
    image: perfDynoImg,
    glyph: '📊',
    blurb: 'On-screen Performance Pages — toggle the Gauges, Timers, Dyno, G-Force meter, reaction time, 0-60 / 1/8 / 1/4 mile timers and the Performance Data Recorder.',
    fields: [
      'SRT Performance Pages', 'SRT Gauges Page', 'SRT Timers Page', 'SRT Dyno Page',
      'G-Force Meter', 'Reaction Time Display',
      '0-60 Timer', '1/8 Mile Timer', '1/4 Mile Timer',
      'Performance Data Recorder',
    ],
  },
  {
    id: 'perf-drag',
    label: 'DRAG STRIP',
    tag: 'LAUNCH CTRL · LINE LOCK · TRANS BRAKE · TORQUE RES',
    accent: '#FF3D00',
    image: perfLaunchImg,
    glyph: '🏁',
    blurb: 'Christmas-tree weaponry — Launch Control with target RPM, Launch Assist & Warning, Line Lock duration, Trans Brake target RPM, Torque Reserve level and the dedicated Drag Mode profile.',
    fields: [
      'Launch Control', 'Launch Control RPM', 'Launch Assist', 'Launch Warning',
      'Line Lock', 'Line Lock Duration',
      'Trans Brake', 'Trans Brake RPM',
      'Torque Reserve', 'Torque Reserve Level',
      'Drag Mode', 'Drag Mode Suspension',
    ],
  },
  {
    id: 'perf-modes',
    label: 'DRIVE MODES & RACE OPTIONS',
    tag: 'TRACK · CUSTOM · POWER · RACE MENU · WIDEBODY',
    accent: '#D500F9',
    image: perfModesImg,
    glyph: '🎛',
    blurb: 'Master drive-mode rotary plumbing — Track / Custom presence, Drive Mode Memory, Race Options Menu unlock, available Power Modes (Eco/Sport/Track/Snow/Tow…) and the Widebody chassis flag.',
    fields: [
      'Custom Mode', 'Track Mode', 'Drive Mode Memory',
      'Race Options Menu', 'Power Modes Available', 'Widebody Enabled',
    ],
  },
  {
    id: 'perf-dyn',
    label: 'CHASSIS DYNAMICS',
    tag: 'PADDLES · EXHAUST · SUSP · STEER · TC · MDS',
    accent: '#7C4DFF',
    image: perfEngineImg,
    glyph: '⚙',
    blurb: 'How the car *feels* — paddle, exhaust, suspension, steering, throttle and traction-control mapping, ESC Sport unlock and Cylinder Deactivation (MDS) strategy.',
    fields: [
      'Paddle Shifter Mode', 'Exhaust Mode', 'Suspension Mode', 'Steering Mode',
      'Throttle Response', 'Traction Control Mode', 'ESC Sport Mode',
      'Cylinder Deactivation (MDS)',
    ],
  },
  {
    id: 'perf-tells',
    label: 'TELLTALES & TEMPERATURES',
    tag: 'SHIFT LIGHT · REV MATCH · S/C · IC · BRAKE TEMP',
    accent: '#FFB300',
    image: perfImg,
    glyph: '🌡',
    blurb: 'Cluster telltales — Rev Match, Shift Light with target RPM, Supercharger and Intercooler temp readouts, Brake Temperature warning.',
    fields: [
      'Rev Match', 'Shift Light', 'Shift Light RPM',
      'Supercharger Temp Display', 'Intercooler Temp Display',
      'Brake Temperature Warning',
    ],
  },
];

const _byId = new Map(BCM_CATEGORIES.map((c) => [c.id, c]));

/**
 * Bucket DE0A decoded rows into the PERF_SUBGROUPS above.
 * `decodedRows` is the output of decodeBcmDid(0xDE0A, payload).
 * Returns [{ group, rows }, ...] in PERF_SUBGROUPS order, plus an
 * extra { group: PERF_MORE, rows } at the end for any unbucketed
 * fields so we never silently drop a row.
 */
export const PERF_MORE_GROUP = {
  id: 'perf-more',
  label: 'MORE PERFORMANCE FIELDS',
  tag: 'UNCATEGORISED',
  accent: '#9E9E9E',
  image: null,
  glyph: '➕',
  blurb: 'Additional DE0A fields not yet hand-bucketed into a perf sub-panel.',
  fields: [],
};

export function bucketPerfRows(decodedRows) {
  if (!Array.isArray(decodedRows)) return [];
  const seen = new Set();
  const out = PERF_SUBGROUPS.map((group) => {
    const set = new Set(group.fields);
    const rows = decodedRows.filter((r) => {
      const name = r?.field?.name;
      if (!name || !set.has(name) || seen.has(name)) return false;
      seen.add(name);
      return true;
    });
    return { group, rows };
  });
  const leftover = decodedRows.filter((r) => r?.field?.name && !seen.has(r.field.name));
  if (leftover.length > 0) out.push({ group: PERF_MORE_GROUP, rows: leftover });
  return out;
}

export function categoryForDid(did) {
  const id = CATEGORY_DID_MAP[did];
  if (id && _byId.has(id)) return _byId.get(id);
  return OTHER_CATEGORY;
}

/** Return [{ category, dids: number[] }] in BCM_CATEGORIES order, with OTHER appended if any unmapped DIDs. */
export function bucketDids(allDids) {
  const buckets = new Map(BCM_CATEGORIES.map((c) => [c.id, []]));
  const others = [];
  for (const did of allDids) {
    const id = CATEGORY_DID_MAP[did];
    if (id && buckets.has(id)) buckets.get(id).push(did);
    else others.push(did);
  }
  const out = BCM_CATEGORIES
    .map((c) => ({ category: c, dids: buckets.get(c.id) }))
    .filter((b) => b.dids.length > 0);
  if (others.length > 0) out.push({ category: OTHER_CATEGORY, dids: others });
  return out;
}
