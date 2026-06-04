// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/complete-module-database.json
// Re-extract: node scripts/codegen-alfaobd-package.mjs
//
// "Complete" FCA module catalog — 33 modules with priority ranking,
// VIN-support flag, category grouping. Source claims wiTECH/CDA6 + community
// but sequential 0x744-0x75E addressing for some modules is NOT vehicle-
// verified. Cross-reference only; SRT Lab quickRefData is source of truth.

export const COMPLETE_MODULES = {
  "BCM": {
    "code": "BCM",
    "name": "Body Control Module",
    "category": "Body",
    "tx_id": "0x7E0",
    "rx_id": "0x7E8",
    "tx_decimal": 2016,
    "rx_decimal": 2024,
    "description": "Central body electronics control - lighting, locks, windows, security",
    "common_on": [
      "All Dodge/Chrysler/Jeep vehicles (2008+)"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 5
  },
  "ECM": {
    "code": "ECM",
    "name": "Engine Control Module",
    "category": "Powertrain",
    "tx_id": "0x7E0",
    "rx_id": "0x7E8",
    "tx_decimal": 2016,
    "rx_decimal": 2024,
    "description": "Engine management - fuel injection, ignition, emissions",
    "common_on": [
      "All vehicles with electronic fuel injection"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 5
  },
  "RFHUB": {
    "code": "RFHUB",
    "name": "RF Hub / SKIM",
    "category": "Security",
    "tx_id": "0x742",
    "rx_id": "0x762",
    "tx_decimal": 1858,
    "rx_decimal": 1890,
    "description": "Wireless key fob receiver and immobilizer",
    "common_on": [
      "All Dodge/Chrysler/Jeep with keyless entry (2008+)"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 5
  },
  "TCM": {
    "code": "TCM",
    "name": "Transmission Control Module",
    "category": "Powertrain",
    "tx_id": "0x7E1",
    "rx_id": "0x7E9",
    "tx_decimal": 2017,
    "rx_decimal": 2025,
    "description": "Automatic transmission control and shift logic",
    "common_on": [
      "All vehicles with automatic transmission"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 4
  },
  "ABS": {
    "code": "ABS",
    "name": "Anti-lock Brake System",
    "category": "Safety",
    "tx_id": "0x760",
    "rx_id": "0x768",
    "tx_decimal": 1888,
    "rx_decimal": 1896,
    "description": "ABS/ESP/Traction control system",
    "common_on": [
      "All modern vehicles (2004+)"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 4
  },
  "CCM": {
    "code": "CCM",
    "name": "Climate Control Module",
    "category": "Comfort",
    "tx_id": "0x743",
    "rx_id": "0x763",
    "tx_decimal": 1859,
    "rx_decimal": 1891,
    "description": "HVAC control - heating, ventilation, air conditioning",
    "common_on": [
      "Most Dodge/Chrysler/Jeep vehicles"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 2
  },
  "ADM": {
    "code": "ADM",
    "name": "Active Dampening Module",
    "category": "Suspension",
    "tx_id": "0x744",
    "rx_id": "0x764",
    "tx_decimal": 1860,
    "rx_decimal": 1892,
    "description": "Active suspension dampening control",
    "common_on": [
      "Dodge Challenger/Charger SRT",
      "Jeep Grand Cherokee SRT/Trackhawk"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 2
  },
  "SDM": {
    "code": "SDM",
    "name": "Suspension Dampening Module",
    "category": "Suspension",
    "tx_id": "0x745",
    "rx_id": "0x765",
    "tx_decimal": 1861,
    "rx_decimal": 1893,
    "description": "Suspension control and air ride management",
    "common_on": [
      "Ram 1500 with air suspension",
      "Jeep Grand Cherokee with air suspension"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 2
  },
  "IPCM": {
    "code": "IPCM",
    "name": "Instrument Panel Cluster Module",
    "category": "Body",
    "tx_id": "0x746",
    "rx_id": "0x766",
    "tx_decimal": 1862,
    "rx_decimal": 1894,
    "description": "Instrument cluster - speedometer, tachometer, gauges, odometer",
    "common_on": [
      "All vehicles with digital instrument cluster"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 4
  },
  "ORC": {
    "code": "ORC",
    "name": "Occupant Restraint Controller",
    "category": "Safety",
    "tx_id": "0x747",
    "rx_id": "0x767",
    "tx_decimal": 1863,
    "rx_decimal": 1895,
    "description": "Airbag control module - crash detection and deployment",
    "common_on": [
      "All modern vehicles with airbags"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 4
  },
  "CGW": {
    "code": "CGW",
    "name": "Central Gateway Module",
    "category": "Body",
    "tx_id": "0x748",
    "rx_id": "0x768",
    "tx_decimal": 1864,
    "rx_decimal": 1896,
    "description": "CAN bus gateway - routes messages between different CAN networks",
    "common_on": [
      "Most modern vehicles (2012+)"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 5
  },
  "DDM": {
    "code": "DDM",
    "name": "Driver Door Module",
    "category": "Body",
    "tx_id": "0x749",
    "rx_id": "0x769",
    "tx_decimal": 1865,
    "rx_decimal": 1897,
    "description": "Driver door controls - window, lock, mirror, memory",
    "common_on": [
      "Vehicles with advanced door modules"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 2
  },
  "PDM": {
    "code": "PDM",
    "name": "Passenger Door Module",
    "category": "Body",
    "tx_id": "0x74A",
    "rx_id": "0x76A",
    "tx_decimal": 1866,
    "rx_decimal": 1898,
    "description": "Passenger door controls - window, lock, mirror",
    "common_on": [
      "Vehicles with advanced door modules"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 2
  },
  "PLGM": {
    "code": "PLGM",
    "name": "Power Liftgate Module",
    "category": "Body",
    "tx_id": "0x74B",
    "rx_id": "0x76B",
    "tx_decimal": 1867,
    "rx_decimal": 1899,
    "description": "Power liftgate/tailgate control",
    "common_on": [
      "SUVs and minivans with power liftgate"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 1
  },
  "MSM": {
    "code": "MSM",
    "name": "Memory Seat Module",
    "category": "Comfort",
    "tx_id": "0x74C",
    "rx_id": "0x76C",
    "tx_decimal": 1868,
    "rx_decimal": 1900,
    "description": "Power seat with memory settings",
    "common_on": [
      "Vehicles with memory seats"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 1
  },
  "SCCM": {
    "code": "SCCM",
    "name": "Steering Column Control Module",
    "category": "Body",
    "tx_id": "0x74D",
    "rx_id": "0x76D",
    "tx_decimal": 1869,
    "rx_decimal": 1901,
    "description": "Steering wheel controls and tilt/telescope adjustment",
    "common_on": [
      "Vehicles with electronic steering column"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 2
  },
  "PAM": {
    "code": "PAM",
    "name": "Park Assist Module",
    "category": "Safety",
    "tx_id": "0x74E",
    "rx_id": "0x76E",
    "tx_decimal": 1870,
    "rx_decimal": 1902,
    "description": "Parking sensors and automated parking",
    "common_on": [
      "Vehicles with park assist"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 2
  },
  "FCM": {
    "code": "FCM",
    "name": "Forward Collision Module",
    "category": "Safety",
    "tx_id": "0x74F",
    "rx_id": "0x76F",
    "tx_decimal": 1871,
    "rx_decimal": 1903,
    "description": "Forward collision warning and automatic emergency braking",
    "common_on": [
      "Vehicles with advanced safety features (2015+)"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 3
  },
  "BSM": {
    "code": "BSM",
    "name": "Blind Spot Module",
    "category": "Safety",
    "tx_id": "0x750",
    "rx_id": "0x770",
    "tx_decimal": 1872,
    "rx_decimal": 1904,
    "description": "Blind spot monitoring and lane change assist",
    "common_on": [
      "Vehicles with blind spot monitoring"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 2
  },
  "ACM": {
    "code": "ACM",
    "name": "Active Cruise Module",
    "category": "Safety",
    "tx_id": "0x751",
    "rx_id": "0x771",
    "tx_decimal": 1873,
    "rx_decimal": 1905,
    "description": "Adaptive cruise control with distance monitoring",
    "common_on": [
      "Vehicles with adaptive cruise control"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 2
  },
  "LDW": {
    "code": "LDW",
    "name": "Lane Departure Warning",
    "category": "Safety",
    "tx_id": "0x752",
    "rx_id": "0x772",
    "tx_decimal": 1874,
    "rx_decimal": 1906,
    "description": "Lane departure warning and lane keep assist",
    "common_on": [
      "Vehicles with lane keeping systems"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 2
  },
  "APIM": {
    "code": "APIM",
    "name": "Accessory Protocol Interface Module",
    "category": "Infotainment",
    "tx_id": "0x753",
    "rx_id": "0x773",
    "tx_decimal": 1875,
    "rx_decimal": 1907,
    "description": "Infotainment system - radio, navigation, Uconnect",
    "common_on": [
      "Vehicles with Uconnect system"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 2
  },
  "VGM": {
    "code": "VGM",
    "name": "Video Graphics Module",
    "category": "Infotainment",
    "tx_id": "0x754",
    "rx_id": "0x774",
    "tx_decimal": 1876,
    "rx_decimal": 1908,
    "description": "Rear seat entertainment and video display",
    "common_on": [
      "Vehicles with rear entertainment system"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 1
  },
  "RFH": {
    "code": "RFH",
    "name": "Radio Frequency Hub",
    "category": "Infotainment",
    "tx_id": "0x755",
    "rx_id": "0x775",
    "tx_decimal": 1877,
    "rx_decimal": 1909,
    "description": "Radio tuner and antenna amplifier",
    "common_on": [
      "Most vehicles with radio"
    ],
    "vin_support": false,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 1
  },
  "AMP": {
    "code": "AMP",
    "name": "Amplifier Module",
    "category": "Infotainment",
    "tx_id": "0x756",
    "rx_id": "0x776",
    "tx_decimal": 1878,
    "rx_decimal": 1910,
    "description": "Audio amplifier for premium sound systems",
    "common_on": [
      "Vehicles with premium audio (Alpine, Harman Kardon)"
    ],
    "vin_support": false,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 1
  },
  "RSM": {
    "code": "RSM",
    "name": "Rain Sense Module",
    "category": "Comfort",
    "tx_id": "0x757",
    "rx_id": "0x777",
    "tx_decimal": 1879,
    "rx_decimal": 1911,
    "description": "Automatic wiper control based on rain detection",
    "common_on": [
      "Vehicles with rain-sensing wipers"
    ],
    "vin_support": false,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 1
  },
  "HSM": {
    "code": "HSM",
    "name": "Heated Seat Module",
    "category": "Comfort",
    "tx_id": "0x758",
    "rx_id": "0x778",
    "tx_decimal": 1880,
    "rx_decimal": 1912,
    "description": "Heated and ventilated seat control",
    "common_on": [
      "Vehicles with heated/ventilated seats"
    ],
    "vin_support": false,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 1
  },
  "WCM": {
    "code": "WCM",
    "name": "Wireless Control Module",
    "category": "Security",
    "tx_id": "0x759",
    "rx_id": "0x779",
    "tx_decimal": 1881,
    "rx_decimal": 1913,
    "description": "Cellular/WiFi connectivity and telematics",
    "common_on": [
      "Vehicles with connected services (2015+)"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 2
  },
  "SKREEM": {
    "code": "SKREEM",
    "name": "Secure Key Remote Entry Module",
    "category": "Security",
    "tx_id": "0x75A",
    "rx_id": "0x77A",
    "tx_decimal": 1882,
    "rx_decimal": 1914,
    "description": "Advanced immobilizer and keyless entry (newer than RFHUB)",
    "common_on": [
      "Newer vehicles (2018+) replacing RFHUB"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 5
  },
  "TCCM": {
    "code": "TCCM",
    "name": "Transfer Case Control Module",
    "category": "Powertrain",
    "tx_id": "0x75B",
    "rx_id": "0x77B",
    "tx_decimal": 1883,
    "rx_decimal": 1915,
    "description": "4WD/AWD transfer case control",
    "common_on": [
      "4WD/AWD vehicles (Jeep, Ram, Durango)"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 3
  },
  "FDCM": {
    "code": "FDCM",
    "name": "Final Drive Control Module",
    "category": "Powertrain",
    "tx_id": "0x75C",
    "rx_id": "0x77C",
    "tx_decimal": 1884,
    "rx_decimal": 1916,
    "description": "Rear differential control and electronic locking",
    "common_on": [
      "Vehicles with electronic locking differential"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 2
  },
  "EAS": {
    "code": "EAS",
    "name": "Electronic Air Suspension",
    "category": "Suspension",
    "tx_id": "0x75D",
    "rx_id": "0x77D",
    "tx_decimal": 1885,
    "rx_decimal": 1917,
    "description": "Air suspension height and firmness control",
    "common_on": [
      "Vehicles with air suspension (Grand Cherokee, Ram)"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 2
  },
  "DTCM": {
    "code": "DTCM",
    "name": "Drive Train Control Module",
    "category": "Powertrain",
    "tx_id": "0x7E2",
    "rx_id": "0x7EA",
    "tx_decimal": 2018,
    "rx_decimal": 2026,
    "description": "Drivetrain coordination and torque management",
    "common_on": [
      "AWD vehicles with advanced torque vectoring"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 3
  },
  "EPS": {
    "code": "EPS",
    "name": "Electric Power Steering",
    "category": "Body",
    "tx_id": "0x75E",
    "rx_id": "0x77E",
    "tx_decimal": 1886,
    "rx_decimal": 1918,
    "description": "Electric power steering control",
    "common_on": [
      "Vehicles with electric power steering"
    ],
    "vin_support": true,
    "security_algorithm": "SBEC2/SBEC3",
    "priority": 3
  }
};

export const COMPLETE_CATEGORIES = {
  "Powertrain": [
    "ECM",
    "TCM",
    "DTCM",
    "TCCM",
    "FDCM"
  ],
  "Body": [
    "BCM",
    "CGW",
    "IPCM",
    "DDM",
    "PDM",
    "PLGM",
    "SCCM",
    "EPS"
  ],
  "Safety": [
    "ABS",
    "ORC",
    "PAM",
    "FCM",
    "BSM",
    "ACM",
    "LDW"
  ],
  "Security": [
    "RFHUB",
    "WCM",
    "SKREEM"
  ],
  "Comfort": [
    "CCM",
    "MSM",
    "RSM",
    "HSM"
  ],
  "Suspension": [
    "ADM",
    "SDM",
    "EAS"
  ],
  "Infotainment": [
    "APIM",
    "VGM",
    "RFH",
    "AMP"
  ]
};

export const COMPLETE_MODULE_DB_META = {
  "totalModules": 33,
  "vinSupportedModules": 30,
  "securityAlgorithm": "SBEC2/SBEC3 (key = seed * 4 + 0x9018)",
  "source": "Reverse-engineered from wiTECH/CDA6 + community databases",
  "caveat": "Sequential CAN addressing pattern-based, not vehicle-verified."
};
