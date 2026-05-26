import fs from "fs";

// Create 3 sample binary files (BCM, RFHUB, PCM) with deliberate mismatches

// BCM dump - 64KB
const bcm = Buffer.alloc(65536, 0xFF);
// BCM VIN @ 0x160
bcm.write("1G1ZT51806F109186", 0x160, "ascii");
// BCM Secret Key @ 0xF1A0
bcm.write("0123456789ABCDEF", 0xF1A0, "ascii");
// BCM SKIM @ 0x01A0
bcm.write("SKIM_BCM_", 0x01A0, "ascii");
fs.writeFileSync("bcm_dump.bin", bcm);
console.log("✓ bcm_dump.bin (65KB)");

// RFHUB dump - 64KB with MISMATCHED VIN (should be reversed)
const rfhub = Buffer.alloc(65536, 0xFF);
// RFHUB VIN @ 0x160 - WRONG (should be reversed)
rfhub.write("1G1ZT51806F109186", 0x160, "ascii");
// RFHUB Secret Key @ 0xF1A0 - WRONG (should match BCM)
rfhub.write("FEDCBA9876543210", 0xF1A0, "ascii");
// RFHUB SKIM @ 0x01A0 - WRONG (should be reversed BCM SKIM)
rfhub.write("SKIM_RFH_", 0x01A0, "ascii");
fs.writeFileSync("rfhub_dump.bin", rfhub);
console.log("✓ rfhub_dump.bin (64KB)");

// PCM dump - 64KB with MISMATCHED VIN
const pcm = Buffer.alloc(65536, 0xFF);
// PCM VIN @ 0x160 - WRONG
pcm.write("DIFFERENT_VIN_123", 0x160, "ascii");
// PCM Secret Key @ 0xF1A0 - WRONG
pcm.write("AAAAAAAAAAAAAAAA", 0xF1A0, "ascii");
fs.writeFileSync("pcm_dump.bin", pcm);
console.log("✓ pcm_dump.bin (48KB)");

console.log("\n3 sample binaries created with deliberate mismatches:");
console.log("- BCM: Master module (correct VIN, Secret Key, SKIM)");
console.log("- RFHUB: Mismatched VIN, Secret Key, SKIM");
console.log("- PCM: Mismatched VIN, Secret Key");
