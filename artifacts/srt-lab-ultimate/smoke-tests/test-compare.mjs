// Generate two test binary files: BCM and RFHUB with deliberate mismatches
import fs from "fs";

// Create a BCM dump (8KB = 95640 EEPROM)
const bcm = Buffer.alloc(8192, 0xFF);

// BCM PIN at 0x838 (4 bytes)
bcm.writeUInt32BE(0x12345678, 0x838);

// BCM VIN at 0x160 (17 bytes) - "1C4RJFAG0FC123456"
const vin = Buffer.from("1C4RJFAG0FC123456", "ascii");
vin.copy(bcm, 0x160);

// BCM VIN CRC at 0x1F0
bcm.writeUInt16BE(0xABCD, 0x1F0);

// BCM SKIM Verification at 0x01A0 (9 bytes)
const skimBytes = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03, 0x04, 0x05]);
skimBytes.copy(bcm, 0x01A0);

// BCM Immobilizer Status at 0x840
bcm.writeUInt16BE(0x0001, 0x840);

// Create an RFHUB dump (32KB)
const rfhub = Buffer.alloc(32768, 0xFF);

// RFHUB SKIM Pairing at 0x01A0 (9 bytes) - SHOULD be REVERSED of BCM
// Deliberately WRONG - not reversed, just random bytes
const wrongSkim = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0x11, 0x22, 0x33, 0x44]);
wrongSkim.copy(rfhub, 0x01A0);

// RFHUB VIN at 0x160 (17 bytes) - SHOULD be reversed of BCM VIN
// Deliberately WRONG - different VIN entirely
const wrongVin = Buffer.from("2B3CL5CT9BH500001", "ascii");
wrongVin.copy(rfhub, 0x160);

// RFHUB Secret Key at 0xF1A0 (16 bytes) - SHOULD match BCM
// BCM doesn't have one set (all 0xFF), so RFHUB has different bytes
const rfhubKey = Buffer.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF, 0xFE, 0xDC, 0xBA, 0x98, 0x76, 0x54, 0x32, 0x10]);
rfhubKey.copy(rfhub, 0xF1A0);

// RFHUB CRC at 0x1F0
rfhub.writeUInt16BE(0x1234, 0x1F0);
rfhub.writeUInt16BE(0x5678, 0x1F2);

// RFHUB Key Fob Slots at 0x200 (40 bytes)
for (let i = 0; i < 40; i++) {
  rfhub[0x200 + i] = (i * 7) & 0xFF;
}

// Write test files
fs.writeFileSync("/home/ubuntu/test_bcm_dump.bin", bcm);
fs.writeFileSync("/home/ubuntu/test_rfhub_dump.bin", rfhub);

console.log("Test files created:");
console.log(`  BCM:   /home/ubuntu/test_bcm_dump.bin (${bcm.length} bytes)`);
console.log(`  RFHUB: /home/ubuntu/test_rfhub_dump.bin (${rfhub.length} bytes)`);
console.log("");
console.log("Deliberate mismatches:");
console.log("  1. SKIM bytes: BCM has DE AD BE EF..., RFHUB has AA BB CC DD... (should be reversed)");
console.log("  2. VIN: BCM has '1C4RJFAG0FC123456', RFHUB has '2B3CL5CT9BH500001' (should match reversed)");
console.log("  3. Secret Key: BCM has FF FF... (blank), RFHUB has 01 23 45 67... (should match BCM)");
