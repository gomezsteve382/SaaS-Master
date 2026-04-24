import React, { useState, useMemo } from "react";

/* ═══ EMBEDDED ANALYSIS DATA — 36 real bin files ═══ */
const D = {"f":[{"name":"17RFHUB_EEE_OG.bin","size":4096,"kb":4,"type":"RFHUB","vins":[{"off":"0x0EA5","vin":"2C3CDXHG7GH214845","algo":"REV"},{"off":"0x0EB9","vin":"2C3CDXHG7GH214845","algo":"REV"},{"off":"0x0ECD","vin":"2C3CDXHG7GH214845","algo":"REV"},{"off":"0x0EE1","vin":"2C3CDXHG7GH214845","algo":"REV"}],"sec16":{"g1m":true,"g1v":false},"sk":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","skb":true},{"name":"18_TRACKHAWK_DFLASH_BCM.bin","size":65536,"kb":64,"type":"BCM","vins":[{"off":"0x1320","vin":"1C4RJFN99JC198740","crc":"0xDC79","algo":"CRC16","count":4}],"pn":["68354769","68354770"],"immoBlank":true,"bakBlank":false,"b0":5699,"b1":5700,"act":1,"sec16":[{"off":"0x81A0","idx":255,"hex":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","sepOk":false,"blank":true},{"off":"0x81C0","idx":255,"hex":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","sepOk":false,"blank":true},{"off":"0x81E0","idx":255,"hex":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","sepOk":false,"blank":true}],"hImmo":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","hSec":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"},{"name":"18_TRACKHAWK_DFLASH_BCM_VIN_CRC_1C4RJEAG9HC748138.bin","size":65536,"kb":64,"type":"BCM","vins":[{"off":"0x1320","vin":"1C4RJEAG9HC748138","crc":"0x3DA2","algo":"CRC16","count":4}],"pn":["68354769","68354770"],"immoBlank":true,"bakBlank":false,"b0":5699,"b1":5700,"act":1,"sec16":[{"off":"0x81A0","idx":255,"hex":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","sepOk":false,"blank":true},{"off":"0x81C0","idx":255,"hex":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","sepOk":false,"blank":true},{"off":"0x81E0","idx":255,"hex":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","sepOk":false,"blank":true}]},{"name":"19_rfhub_EEE_OG_FILE.bin","size":4096,"kb":4,"type":"RFHUB","vins":[{"off":"0x0ECD","vin":"2C3CDXGJ3KH728648","algo":"REV"},{"off":"0x0EE1","vin":"2C3CDXGJ3KH728648","algo":"REV"}],"sec16":{"g":2,"s1":"AB8015D77ED943C1AB45EC16896969DA","s2":"AB8015D77ED943C1AB45EC16896969DA","m":true,"v":false,"g1m":true,"g1v":false},"sk":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","skb":true},{"name":"20CHRGR6_2RFHUBFILE_EEE_OG_CRC2C3CDXCT1HH652640.bin","size":4096,"kb":4,"type":"RFHUB","vins":[{"off":"0x0EA5","vin":"2C3CDXCT1HH652640","algo":"REV"},{"off":"0x0EB9","vin":"2C3CDXCT1HH652640","algo":"REV"},{"off":"0x0ECD","vin":"2C3CDXCT1HH652640","algo":"REV"},{"off":"0x0EE1","vin":"2C3CDXCT1HH652640","algo":"REV"}],"sec16":{"g":2,"s1":"AB8015D77ED943C1AB45EC16896969DA","s2":"AB8015D77ED943C1AB45EC16896969DA","m":true,"v":false,"g1m":true,"g1v":false},"sk":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","skb":true},{"name":"20CHRGR6_2RFHUBFILE_P-FLASH_OG_CRC2C3CDXCT1HH652640.bin","size":393216,"kb":384,"type":"FW","vins":[],"ulk":"0x3A","isUlk":false},{"name":"20SCAT_RFHUB_OG_ZO.bin","size":4096,"kb":4,"type":"RFHUB","vins":[{"off":"0x0EA5","vin":"2C3CDXGJ3KH728648","algo":"REV"},{"off":"0x0EB9","vin":"2C3CDXGJ3KH728648","algo":"REV"},{"off":"0x0ECD","vin":"2C3CDXGJ3KH728648","algo":"REV"},{"off":"0x0EE1","vin":"2C3CDXGJ3KH728648","algo":"REV"}],"sec16":{"g":2,"s1":"CBBABBA95CB6303CDC876DB0330C0C51","s2":"CBBABBA95CB6303CDC876DB0330C0C51","m":true,"v":false,"g1m":true,"g1v":false},"sk":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","skb":true},{"name":"21DFLASH_SCAT392_OG_ZO.bin","size":65536,"kb":64,"type":"BCM","vins":[{"off":"0x1308","vin":"2C3CDXHG5EH219538","crc":"0x7753","algo":"CRC16","count":4}],"pn":["68309504","68309505","68396561","68396562"],"immoBlank":true,"bakBlank":false,"b0":1623,"b1":1624,"act":1,"sec16":[{"off":"0x81A0","idx":1,"hex":"E2C19713BDD60C6170C0BEB7E182BD56","sepOk":true,"blank":false},{"off":"0x81C0","idx":2,"hex":"E2C19713BDD60C6170C0BEB7E182BD56","sepOk":true,"blank":false},{"off":"0x81E0","idx":2,"hex":"E2C19713BDD60C6170C0BEB7E182BD56","sepOk":true,"blank":false}]},{"name":"21DFLASH_SCAT392_OG_ZO_EDIT.bin","size":65536,"kb":64,"type":"BCM","vins":[{"off":"0x1308","vin":"2C3CDXGJ3KH728648","crc":"0xAB62","algo":"CRC16","count":4}],"pn":["68309504","68309505","68396561","68396562"],"immoBlank":true,"bakBlank":false,"b0":1623,"b1":1624,"act":1,"sec16":[{"off":"0x81A0","idx":1,"hex":"E2C19713BDD60C6170C0BEB7E182BD56","sepOk":true,"blank":false},{"off":"0x81C0","idx":2,"hex":"E2C19713BDD60C6170C0BEB7E182BD56","sepOk":true,"blank":false},{"off":"0x81E0","idx":2,"hex":"E2C19713BDD60C6170C0BEB7E182BD56","sepOk":true,"blank":false}]},{"name":"21RFHUB_VIRGIN_EEE_ALREADYSYNCHED.bin","size":4096,"kb":4,"type":"RFHUB","vins":[{"off":"0x0EA5","vin":"2C3CDXGJ3KH728648","algo":"REV"},{"off":"0x0EB9","vin":"2C3CDXGJ3KH728648","algo":"REV"},{"off":"0x0ECD","vin":"2C3CDXGJ3KH728648","algo":"REV"},{"off":"0x0EE1","vin":"2C3CDXGJ3KH728648","algo":"REV"}],"sec16":{"g":2,"s1":"816531F7CDE32E33C25A415C8440C72A","s2":"816531F7CDE32E33C25A415C8440C72A","m":true,"v":false,"g1m":true,"g1v":false},"sk":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","skb":true},{"name":"22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN.bin","size":65536,"kb":64,"type":"BCM","vins":[{"off":"0x5328","vin":"2C3CDXCT1HH652640","crc":"0x9282","algo":"CRC16","count":4}],"pn":["68525720","68525721"],"immoBlank":false,"bakBlank":true,"b0":6671,"b1":6670,"act":0,"sec16":[{"off":"0x81A0","idx":1,"hex":"2AC740845C415AC2332EE3CDF7316581","sepOk":true,"blank":false},{"off":"0x81C0","idx":2,"hex":"2AC740845C415AC2332EE3CDF7316581","sepOk":true,"blank":false},{"off":"0x81E0","idx":2,"hex":"2AC740845C415AC2332EE3CDF7316581","sepOk":true,"blank":false}]},{"name":"22CHARGER_REDEYE_6_2_797RFHUB_EEE_OGFILE.bin","size":4096,"kb":4,"type":"RFHUB","vins":[{"off":"0x0EA5","vin":"2C3CDXGJXNH176487","algo":"REV"},{"off":"0x0EB9","vin":"2C3CDXGJXNH176487","algo":"REV"},{"off":"0x0ECD","vin":"2C3CDXGJXNH176487","algo":"REV"},{"off":"0x0EE1","vin":"2C3CDXGJXNH176487","algo":"REV"}],"sec16":{"g":2,"s1":"816531F7CDE32E33C25A415C8440C72A","s2":"816531F7CDE32E33C25A415C8440C72A","m":true,"v":false,"g1m":true,"g1v":false},"sk":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","skb":true},{"name":"AGNRFHUBPFLASH.bin","size":262144,"kb":256,"type":"FW","vins":[],"ulk":"0xB7","isUlk":false},{"name":"BCM_22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN_SYNC.bin","size":65536,"kb":64,"type":"BCM","vins":[{"off":"0x5328","vin":"2C3CDXGJ3KH728648","crc":"0xAB62","algo":"CRC16","count":4}],"pn":["68525720","68525721"],"immoBlank":false,"bakBlank":true,"b0":6671,"b1":6670,"act":0,"sec16":[{"off":"0x81A0","idx":1,"hex":"DA69698916EC45ABC143D97ED71580AB","sepOk":true,"blank":false},{"off":"0x81C0","idx":2,"hex":"DA69698916EC45ABC143D97ED71580AB","sepOk":true,"blank":false},{"off":"0x81E0","idx":2,"hex":"DA69698916EC45ABC143D97ED71580AB","sepOk":true,"blank":false}]},{"name":"BCM_DFLASH_OGFILE.bin","size":65536,"kb":64,"type":"BCM","vins":[{"off":"0x5328","vin":"2C3CDXGJ3KH728648","crc":"0xAB62","algo":"CRC16","count":4}],"pn":["68309504","68525720","68525721"],"immoBlank":false,"bakBlank":true,"b0":6671,"b1":6670,"act":0,"sec16":[{"off":"0x81A0","idx":1,"hex":"DA69698916EC45ABC143D97ED71580AB","sepOk":true,"blank":false},{"off":"0x81C0","idx":2,"hex":"DA69698916EC45ABC143D97ED71580AB","sepOk":true,"blank":false},{"off":"0x81E0","idx":2,"hex":"DA69698916EC45ABC143D97ED71580AB","sepOk":true,"blank":false}]},{"name":"BCM_HERMANADO_22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN.bin","size":65536,"kb":64,"type":"BCM","vins":[{"off":"0x5328","vin":"2C3CDXCT1HH652640","crc":"0x9282","algo":"CRC16","count":4}],"pn":["68525720","68525721"],"immoBlank":false,"bakBlank":true,"b0":6671,"b1":6670,"act":0,"sec16":[{"off":"0x81A0","idx":1,"hex":"DA69698916EC45ABC143D97ED71580AB","sepOk":true,"blank":false},{"off":"0x81C0","idx":2,"hex":"DA69698916EC45ABC143D97ED71580AB","sepOk":true,"blank":false},{"off":"0x81E0","idx":2,"hex":"DA69698916EC45ABC143D97ED71580AB","sepOk":true,"blank":false}]},{"name":"BCM_HERMANADO_BCM_HERMANADO_22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN.bin","size":65536,"kb":64,"type":"BCM","vins":[{"off":"0x5328","vin":"2C3CDXCT1HH652640","crc":"0x9282","algo":"CRC16","count":4}],"pn":["68525720","68525721"],"immoBlank":false,"bakBlank":true,"b0":6671,"b1":6670,"act":0,"sec16":[{"off":"0x81A0","idx":1,"hex":"DA69698916EC45ABC143D97ED71580AB","sepOk":true,"blank":false},{"off":"0x81C0","idx":2,"hex":"DA69698916EC45ABC143D97ED71580AB","sepOk":true,"blank":false},{"off":"0x81E0","idx":2,"hex":"DA69698916EC45ABC143D97ED71580AB","sepOk":true,"blank":false}]},{"name":"FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_20260422004145_test_ramtrx.bin","size":4096,"kb":4,"type":"GPEC2A","vins":[{"off":"0x0000","vin":"2C3CDXGJ3KH728648","algo":"ASCII"},{"off":"0x01F0","vin":"2C3CDXGJ3KH728648","algo":"ASCII"},{"off":"0x0224","vin":"2C3CDXGJ3KH728648","algo":"ASCII"}],"skim":"0x00","skimOn":false,"sec6":"AB8015D77ED9","key":"0100000100130919","mir":"0100000100130919","km":true,"zz":false},{"name":"FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_2C3CDXEJ1FH857853_OG.bin","size":4096,"kb":4,"type":"GPEC2A","vins":[{"off":"0x0000","vin":"2C3CDXEJ1FH857853","algo":"ASCII"},{"off":"0x01F0","vin":"2C3CDXEJ1FH857853","algo":"ASCII"},{"off":"0x0224","vin":"2C3CDXEJ1FH857853","algo":"ASCII"}],"skim":"0x00","skimOn":false,"key":"0101234567030801","mir":"C20000000A250211","km":false,"zz":false},{"name":"FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_CRC_Jailbreak_synched.bin","size":8192,"kb":8,"type":"GPEC8K","vins":[{"off":"0x0000","vin":"2C3CDXCT1HH652640","algo":"ASCII"},{"off":"0x01F0","vin":"2C3CDXCT1HH652640","algo":"ASCII"},{"off":"0x0224","vin":"2C3CDXCT1HH652640","algo":"ASCII"}],"sec6":"AB8015D77ED9"},{"name":"FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_OGZO.bin","size":4096,"kb":4,"type":"GPEC2A","vins":[{"off":"0x0000","vin":"2C3CDXGJ3KH728648","algo":"ASCII"},{"off":"0x01F0","vin":"2C3CDXGJ3KH728648","algo":"ASCII"},{"off":"0x0224","vin":"2C3CDXGJ3KH728648","algo":"ASCII"}],"skim":"0x00","skimOn":false,"sec6":"CBBABBA95CB6","key":"0100000100130919","mir":"0100000100130919","km":true,"zz":false},{"name":"FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_OG_FILES.bin","size":4096,"kb":4,"type":"GPEC2A","vins":[{"off":"0x0000","vin":"2C3CDXGJ3KH728648","algo":"ASCII"},{"off":"0x01F0","vin":"2C3CDXGJ3KH728648","algo":"ASCII"},{"off":"0x0224","vin":"2C3CDXGJ3KH728648","algo":"ASCII"}],"skim":"0x00","skimOn":false,"sec6":"AB8015D77ED9","key":"0100000100130919","mir":"0100000100130919","km":true,"zz":false},{"name":"FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_OG_FILES_ramtrx.bin","size":4096,"kb":4,"type":"GPEC2A","vins":[{"off":"0x0000","vin":"2C3CDXGJ3KH728648","algo":"ASCII"},{"off":"0x01F0","vin":"2C3CDXGJ3KH728648","algo":"ASCII"},{"off":"0x0224","vin":"2C3CDXGJ3KH728648","algo":"ASCII"}],"skim":"0x00","skimOn":false,"sec6":"AB8015D77ED9","key":"0100000100130919","mir":"0100000100130919","km":true,"zz":false},{"name":"FCA_CONTINENTAL_GPEC2A_INT_FLASH_JAILBREAK_OG_6_2.bin","size":4194304,"kb":4096,"type":"FW","vins":[],"ulk":"0x08","isUlk":false},{"name":"FIXED_RFH_ZO_PAIRED_TO_MODULES.bin","size":4096,"kb":4,"type":"RFHUB","vins":[{"off":"0x0EA5","vin":"2C3CDXGJ3KH728648","algo":"REV"},{"off":"0x0EB9","vin":"2C3CDXGJ3KH728648","algo":"REV"},{"off":"0x0ECD","vin":"2C3CDXGJ3KH728648","algo":"REV"},{"off":"0x0EE1","vin":"2C3CDXGJ3KH728648","algo":"REV"}],"sec16":{"g":2,"s1":"AB8015D77ED943C1AB45EC16896969DA","s2":"AB8015D77ED943C1AB45EC16896969DA","m":true,"v":false,"g1m":true,"g1v":false},"sk":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","skb":true},{"name":"MPC5606B_DFLASH_17SCAT_RAMON_CHERRY.bin","size":65536,"kb":64,"type":"BCM","vins":[{"off":"0x1308","vin":"2C3CDXHG7GH214845","crc":"0x0D7F","algo":"CRC16","count":4}],"pn":["68277389","68277390"],"immoBlank":true,"bakBlank":false,"b0":23369,"b1":23370,"act":1,"sec16":[{"off":"0x81A0","idx":1,"hex":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","sepOk":false,"blank":true},{"off":"0x81C0","idx":255,"hex":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","sepOk":false,"blank":true},{"off":"0x81E0","idx":255,"hex":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","sepOk":false,"blank":true}]},{"name":"MPC5606B_DFLASH_17SCAT_RAMON_CHERRY_EDIT.bin","size":65536,"kb":64,"type":"BCM","vins":[{"off":"0x1308","vin":"2C3CDXEJ1FH857853","crc":"0x74B0","algo":"CRC16","count":4}],"pn":["68277389","68277390"],"immoBlank":true,"bakBlank":false,"b0":23369,"b1":23370,"act":1,"sec16":[{"off":"0x81A0","idx":1,"hex":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","sepOk":false,"blank":true},{"off":"0x81C0","idx":255,"hex":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","sepOk":false,"blank":true},{"off":"0x81E0","idx":255,"hex":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","sepOk":false,"blank":true}]},{"name":"RFH_HERMANADO_19_rfhub_EEE_OG_FILE.bin","size":4096,"kb":4,"type":"RFHUB","vins":[{"off":"0x0EA5","vin":"2C3CDXGJ3KH728648","algo":"REV"},{"off":"0x0EB9","vin":"2C3CDXGJ3KH728648","algo":"REV"},{"off":"0x0ECD","vin":"2C3CDXGJ3KH728648","algo":"REV"},{"off":"0x0EE1","vin":"2C3CDXGJ3KH728648","algo":"REV"}],"sec16":{"g":2,"s1":"AB8015D77ED943C1AB45EC16896969DA","s2":"AB8015D77ED943C1AB45EC16896969DA","m":true,"v":false,"g1m":true,"g1v":false},"sk":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","skb":true},{"name":"RFH_HERMANADO_20CHRGR6_2RFHUBFILE_EEE_OG_CRC2C3CDXCT1HH652640.bin","size":4096,"kb":4,"type":"RFHUB","vins":[{"off":"0x0EA5","vin":"2C3CDXCT1HH652640","algo":"REV"},{"off":"0x0EB9","vin":"2C3CDXCT1HH652640","algo":"REV"},{"off":"0x0ECD","vin":"2C3CDXCT1HH652640","algo":"REV"},{"off":"0x0EE1","vin":"2C3CDXCT1HH652640","algo":"REV"}],"sec16":{"g":2,"s1":"AB8015D77ED943C1AB45EC16896969DA","s2":"AB8015D77ED943C1AB45EC16896969DA","m":true,"v":false,"g1m":true,"g1v":false},"sk":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","skb":true},{"name":"VIN_CRC_22CHARGER_REDEYE_6_2_797BCM_DFLASH_2C3CDXL95GH203366.bin","size":65536,"kb":64,"type":"BCM","vins":[{"off":"0x5328","vin":"2C3CDXL95GH203366","crc":"0x21A6","algo":"CRC16","count":4}],"pn":["68525720","68525721"],"immoBlank":false,"bakBlank":true,"b0":6671,"b1":6670,"act":0,"sec16":[{"off":"0x81A0","idx":1,"hex":"2AC740845C415AC2332EE3CDF7316581","sepOk":true,"blank":false},{"off":"0x81C0","idx":2,"hex":"2AC740845C415AC2332EE3CDF7316581","sepOk":true,"blank":false},{"off":"0x81E0","idx":2,"hex":"2AC740845C415AC2332EE3CDF7316581","sepOk":true,"blank":false}]},{"name":"VIN_CRC_____22CHARGER_REDEYE_6_2_797RFHUB_EEE_OGFILE.bin","size":4096,"kb":4,"type":"RFHUB","vins":[{"off":"0x0EA5","vin":"2C3CDXL95GH203366","algo":"REV"},{"off":"0x0EB9","vin":"2C3CDXL95GH203366","algo":"REV"},{"off":"0x0ECD","vin":"2C3CDXL95GH203366","algo":"REV"},{"off":"0x0EE1","vin":"2C3CDXL95GH203366","algo":"REV"}],"sec16":{"g":2,"s1":"816531F7CDE32E33C25A415C8440C72A","s2":"816531F7CDE32E33C25A415C8440C72A","m":true,"v":false,"g1m":true,"g1v":false},"sk":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","skb":true},{"name":"ZO_BCM_SYNCED_2C3CDXGJ3KH728648_20260421_204941.bin","size":65536,"kb":64,"type":"BCM","vins":[{"off":"0x1308","vin":"2C3CDXGJ3KH728648","crc":"0xAB62","algo":"CRC16","count":4}],"pn":["68309504","68309505","68396561","68396562"],"immoBlank":true,"bakBlank":false,"b0":1623,"b1":1624,"act":1,"sec16":[{"off":"0x81A0","idx":1,"hex":"E2C19713BDD60C6170C0BEB7E182BD56","sepOk":true,"blank":false},{"off":"0x81C0","idx":2,"hex":"E2C19713BDD60C6170C0BEB7E182BD56","sepOk":true,"blank":false},{"off":"0x81E0","idx":2,"hex":"E2C19713BDD60C6170C0BEB7E182BD56","sepOk":true,"blank":false}]},{"name":"ZO_RFH_SYNCED_VIRGIN_2C3CDXGJ3KH728648_20260421_204941.bin","size":4096,"kb":4,"type":"RFHUB","vins":[{"off":"0x0EA5","vin":"2C3CDXGJ3KH728648","algo":"REV"},{"off":"0x0EB9","vin":"2C3CDXGJ3KH728648","algo":"REV"},{"off":"0x0ECD","vin":"2C3CDXGJ3KH728648","algo":"REV"},{"off":"0x0EE1","vin":"2C3CDXGJ3KH728648","algo":"REV"}],"sec16":{"g":2,"s1":"CBBABBA95CB6303CDC876DB0330C0C51","s2":"CBBABBA95CB6303CDC876DB0330C0C51","m":true,"v":false,"g1m":true,"g1v":true},"sk":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","skb":true},{"name":"angelrfhubog.bin","size":4096,"kb":4,"type":"RFHUB","vins":[{"off":"0x0EA5","vin":"2B3CL5CT4BH572163","algo":"REV"},{"off":"0x0EB9","vin":"2B3CL5CT4BH572163","algo":"REV"},{"off":"0x0ECD","vin":"2B3CL5CT4BH572163","algo":"REV"},{"off":"0x0EE1","vin":"2B3CL5CT4BH572163","algo":"REV"}],"sec16":{"g1m":true,"g1v":false},"sk":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","skb":true},{"name":"immovin_ad60888a13ac48a1987a790ab8c0000e_bin_VIN_APPLIED.bin","size":4096,"kb":4,"type":"RFHUB","vins":[{"off":"0x0EA5","vin":"2C3CDXGJ3KH728648","algo":"REV"},{"off":"0x0EB9","vin":"2C3CDXGJ3KH728648","algo":"REV"},{"off":"0x0ECD","vin":"2C3CDXGJ3KH728648","algo":"REV"},{"off":"0x0EE1","vin":"2C3CDXGJ3KH728648","algo":"REV"}],"sec16":{"g":2,"s1":"CBBABBA95CB6303CDC876DB0330C0C51","s2":"CBBABBA95CB6303CDC876DB0330C0C51","m":true,"v":false,"g1m":true,"g1v":false},"sk":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","skb":true},{"name":"immovin_f1bf3d1830604c8b96fe15cbc1d0dc0a_bin_VIN_APPLIED.bin","size":4096,"kb":4,"type":"RFHUB","vins":[{"off":"0x0EA5","vin":"2C3CDXEJ1FH857853","algo":"REV"},{"off":"0x0EB9","vin":"2C3CDXEJ1FH857853","algo":"REV"},{"off":"0x0ECD","vin":"2C3CDXEJ1FH857853","algo":"REV"},{"off":"0x0EE1","vin":"2C3CDXEJ1FH857853","algo":"REV"}],"sec16":{"g1m":true,"g1v":false},"sk":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","skb":true}],"vm":{"2C3CDXHG7GH214845":["17RFHUB_EEE_OG.bin","MPC5606B_DFLASH_17SCAT_RAMON_CHERRY.bin"],"1C4RJFN99JC198740":["18_TRACKHAWK_DFLASH_BCM.bin"],"1C4RJEAG9HC748138":["18_TRACKHAWK_DFLASH_BCM_VIN_CRC_1C4RJEAG9HC748138.bin"],"2C3CDXGJ3KH728648":["19_rfhub_EEE_OG_FILE.bin","20SCAT_RFHUB_OG_ZO.bin","21DFLASH_SCAT392_OG_ZO_EDIT.bin","21RFHUB_VIRGIN_EEE_ALREADYSYNCHED.bin","BCM_22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN_SYNC.bin","BCM_DFLASH_OGFILE.bin","FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_20260422004145_test_ramtrx.bin","FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_OGZO.bin","FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_OG_FILES.bin","FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_OG_FILES_ramtrx.bin","FIXED_RFH_ZO_PAIRED_TO_MODULES.bin","RFH_HERMANADO_19_rfhub_EEE_OG_FILE.bin","ZO_BCM_SYNCED_2C3CDXGJ3KH728648_20260421_204941.bin","ZO_RFH_SYNCED_VIRGIN_2C3CDXGJ3KH728648_20260421_204941.bin","immovin_ad60888a13ac48a1987a790ab8c0000e_bin_VIN_APPLIED.bin"],"2C3CDXCT1HH652640":["20CHRGR6_2RFHUBFILE_EEE_OG_CRC2C3CDXCT1HH652640.bin","22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN.bin","BCM_HERMANADO_22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN.bin","BCM_HERMANADO_BCM_HERMANADO_22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN.bin","FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_CRC_Jailbreak_synched.bin","RFH_HERMANADO_20CHRGR6_2RFHUBFILE_EEE_OG_CRC2C3CDXCT1HH652640.bin"],"2C3CDXHG5EH219538":["21DFLASH_SCAT392_OG_ZO.bin"],"2C3CDXGJXNH176487":["22CHARGER_REDEYE_6_2_797RFHUB_EEE_OGFILE.bin"],"2C3CDXEJ1FH857853":["FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_2C3CDXEJ1FH857853_OG.bin","MPC5606B_DFLASH_17SCAT_RAMON_CHERRY_EDIT.bin","immovin_f1bf3d1830604c8b96fe15cbc1d0dc0a_bin_VIN_APPLIED.bin"],"2C3CDXL95GH203366":["VIN_CRC_22CHARGER_REDEYE_6_2_797BCM_DFLASH_2C3CDXL95GH203366.bin","VIN_CRC_____22CHARGER_REDEYE_6_2_797RFHUB_EEE_OGFILE.bin"],"2B3CL5CT4BH572163":["angelrfhubog.bin"]},"ch":[{"rf":"19_rfhub_EEE_OG_FILE.bin","rs":"AB8015D77ED943C1AB45EC16896969DA","eb":"DA69698916EC45ABC143D97ED71580AB","bm":["BCM_22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN_SYNC.bin","BCM_DFLASH_OGFILE.bin","BCM_HERMANADO_22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN.bin","BCM_HERMANADO_BCM_HERMANADO_22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN.bin"]},{"rf":"20CHRGR6_2RFHUBFILE_EEE_OG_CRC2C3CDXCT1HH652640.bin","rs":"AB8015D77ED943C1AB45EC16896969DA","eb":"DA69698916EC45ABC143D97ED71580AB","bm":["BCM_22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN_SYNC.bin","BCM_DFLASH_OGFILE.bin","BCM_HERMANADO_22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN.bin","BCM_HERMANADO_BCM_HERMANADO_22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN.bin"]},{"rf":"20SCAT_RFHUB_OG_ZO.bin","rs":"CBBABBA95CB6303CDC876DB0330C0C51","eb":"510C0C33B06D87DC3C30B65CA9BBBACB","bm":[]},{"rf":"21RFHUB_VIRGIN_EEE_ALREADYSYNCHED.bin","rs":"816531F7CDE32E33C25A415C8440C72A","eb":"2AC740845C415AC2332EE3CDF7316581","bm":["22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN.bin","VIN_CRC_22CHARGER_REDEYE_6_2_797BCM_DFLASH_2C3CDXL95GH203366.bin"]},{"rf":"22CHARGER_REDEYE_6_2_797RFHUB_EEE_OGFILE.bin","rs":"816531F7CDE32E33C25A415C8440C72A","eb":"2AC740845C415AC2332EE3CDF7316581","bm":["22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN.bin","VIN_CRC_22CHARGER_REDEYE_6_2_797BCM_DFLASH_2C3CDXL95GH203366.bin"]},{"rf":"FIXED_RFH_ZO_PAIRED_TO_MODULES.bin","rs":"AB8015D77ED943C1AB45EC16896969DA","eb":"DA69698916EC45ABC143D97ED71580AB","bm":["BCM_22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN_SYNC.bin","BCM_DFLASH_OGFILE.bin","BCM_HERMANADO_22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN.bin","BCM_HERMANADO_BCM_HERMANADO_22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN.bin"]},{"rf":"RFH_HERMANADO_19_rfhub_EEE_OG_FILE.bin","rs":"AB8015D77ED943C1AB45EC16896969DA","eb":"DA69698916EC45ABC143D97ED71580AB","bm":["BCM_22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN_SYNC.bin","BCM_DFLASH_OGFILE.bin","BCM_HERMANADO_22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN.bin","BCM_HERMANADO_BCM_HERMANADO_22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN.bin"]},{"rf":"RFH_HERMANADO_20CHRGR6_2RFHUBFILE_EEE_OG_CRC2C3CDXCT1HH652640.bin","rs":"AB8015D77ED943C1AB45EC16896969DA","eb":"DA69698916EC45ABC143D97ED71580AB","bm":["BCM_22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN_SYNC.bin","BCM_DFLASH_OGFILE.bin","BCM_HERMANADO_22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN.bin","BCM_HERMANADO_BCM_HERMANADO_22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN.bin"]},{"rf":"VIN_CRC_____22CHARGER_REDEYE_6_2_797RFHUB_EEE_OGFILE.bin","rs":"816531F7CDE32E33C25A415C8440C72A","eb":"2AC740845C415AC2332EE3CDF7316581","bm":["22CHARGER_REDEYE_6_2_797BCM_DFLASH_VIRGIN.bin","VIN_CRC_22CHARGER_REDEYE_6_2_797BCM_DFLASH_2C3CDXL95GH203366.bin"]},{"rf":"ZO_RFH_SYNCED_VIRGIN_2C3CDXGJ3KH728648_20260421_204941.bin","rs":"CBBABBA95CB6303CDC876DB0330C0C51","eb":"510C0C33B06D87DC3C30B65CA9BBBACB","bm":[]},{"rf":"immovin_ad60888a13ac48a1987a790ab8c0000e_bin_VIN_APPLIED.bin","rs":"CBBABBA95CB6303CDC876DB0330C0C51","eb":"510C0C33B06D87DC3C30B65CA9BBBACB","bm":[]}],"s6":[{"pf":"FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_20260422004145_test_ramtrx.bin","s6":"AB8015D77ED9","rm":["19_rfhub_EEE_OG_FILE.bin","20CHRGR6_2RFHUBFILE_EEE_OG_CRC2C3CDXCT1HH652640.bin","FIXED_RFH_ZO_PAIRED_TO_MODULES.bin","RFH_HERMANADO_19_rfhub_EEE_OG_FILE.bin","RFH_HERMANADO_20CHRGR6_2RFHUBFILE_EEE_OG_CRC2C3CDXCT1HH652640.bin"]},{"pf":"FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_CRC_Jailbreak_synched.bin","s6":"AB8015D77ED9","rm":["19_rfhub_EEE_OG_FILE.bin","20CHRGR6_2RFHUBFILE_EEE_OG_CRC2C3CDXCT1HH652640.bin","FIXED_RFH_ZO_PAIRED_TO_MODULES.bin","RFH_HERMANADO_19_rfhub_EEE_OG_FILE.bin","RFH_HERMANADO_20CHRGR6_2RFHUBFILE_EEE_OG_CRC2C3CDXCT1HH652640.bin"]},{"pf":"FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_OGZO.bin","s6":"CBBABBA95CB6","rm":["20SCAT_RFHUB_OG_ZO.bin","ZO_RFH_SYNCED_VIRGIN_2C3CDXGJ3KH728648_20260421_204941.bin","immovin_ad60888a13ac48a1987a790ab8c0000e_bin_VIN_APPLIED.bin"]},{"pf":"FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_OG_FILES.bin","s6":"AB8015D77ED9","rm":["19_rfhub_EEE_OG_FILE.bin","20CHRGR6_2RFHUBFILE_EEE_OG_CRC2C3CDXCT1HH652640.bin","FIXED_RFH_ZO_PAIRED_TO_MODULES.bin","RFH_HERMANADO_19_rfhub_EEE_OG_FILE.bin","RFH_HERMANADO_20CHRGR6_2RFHUBFILE_EEE_OG_CRC2C3CDXCT1HH652640.bin"]},{"pf":"FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_OG_FILES_ramtrx.bin","s6":"AB8015D77ED9","rm":["19_rfhub_EEE_OG_FILE.bin","20CHRGR6_2RFHUBFILE_EEE_OG_CRC2C3CDXCT1HH652640.bin","FIXED_RFH_ZO_PAIRED_TO_MODULES.bin","RFH_HERMANADO_19_rfhub_EEE_OG_FILE.bin","RFH_HERMANADO_20CHRGR6_2RFHUBFILE_EEE_OG_CRC2C3CDXCT1HH652640.bin"]}],"st":{"t":36,"b":13,"r":14,"g":6,"w":3,"v":10}};

/* ═══ DESIGN ═══ */
const C={bg:'#08080D',c1:'#0E0E15',c2:'#16161F',bd:'#252530',sr:'#D32F2F',sl:'#FF5252',a1:'#FF6D00',a2:'#00BFA5',a3:'#2979FF',a4:'#AA00FF',tx:'#E0DDD8',ts:'#777',gn:'#00C853',wn:'#FFB300',er:'#FF1744'};
const TC={BCM:'#FF6D00',RFHUB:'#2979FF',GPEC2A:'#00BFA5',GPEC8K:'#00BFA5',FW:'#9E9E9E'};
const TN={BCM:'BCM D-FLASH',RFHUB:'RFHUB EEE',GPEC2A:'GPEC2A EXT',GPEC8K:'GPEC2A 8K',FW:'Firmware'};

const T=({children,c=C.sr})=><span style={{fontSize:9,fontWeight:800,padding:'2px 7px',borderRadius:5,background:c+'18',color:c,letterSpacing:.4,display:'inline-block',lineHeight:'16px'}}>{children}</span>;
const M=({c})=><span style={{fontFamily:'"Fira Code",monospace',fontSize:10,color:c||C.tx,letterSpacing:1,wordBreak:'break-all'}}></span>;

/* ═══ SEED KEY ENGINE ═══ */
const u32=n=>n>>>0;
const sxor=(s,c)=>{let k=u32(s);for(let i=0;i<5;i++)k=k&0x80000000?u32((k<<1)^u32(c)):u32(k<<1);return k;};
const cda6=s=>{let k=u32(s);k=u32(k^0x4B129F);k=u32((k<<3)|(k>>>29));k=u32(k+0x1234);k=u32(k^0xABCD);return u32((k>>>5)|(k<<27));};
const ALGOS=[
  {id:'cda6',n:'CDA6',h:'BCM/ABS/IPC',fn:s=>cda6(s)},
  {id:'gpec2',n:'GPEC2',h:'Continental',fn:s=>sxor(s,0xE72E3799)},
  {id:'gpec3',n:'GPEC3',h:'2018+',fn:s=>sxor(s,0x129D657F)},
  {id:'gpec2a',n:'GPEC2A',h:'GPEC2A',fn:s=>sxor(s,0xCE853A6F)},
  {id:'ecm',n:'ECM',h:'sxor 0x8A3C71',fn:s=>sxor(s,0x8A3C71)},
  {id:'tcm',n:'TCM',h:'sxor 0x6E4B92',fn:s=>sxor(s,0x6E4B92)},
  {id:'rfhub',n:'RFHUB',h:'sxor 0xD5F1',fn:s=>sxor(s,0xD5F1)},
];

/* ═══ MAIN APP ═══ */
export default function App(){
  const[tab,setTab]=useState('overview');
  const[sel,setSel]=useState(null);
  const[filt,setFilt]=useState('ALL');
  const[vinFilt,setVinFilt]=useState('');
  const[seedHex,setSeedHex]=useState('');

  const files=useMemo(()=>{
    let ff=D.f;
    if(filt!=='ALL')ff=ff.filter(f=>f.type===filt);
    if(vinFilt)ff=ff.filter(f=>f.vins?.some(v=>v.vin.includes(vinFilt)));
    return ff;
  },[filt,vinFilt]);

  const sf=sel!==null?D.f.find(f=>f.name===sel):null;
  const tabs=[
    {id:'overview',icon:'📊',label:'OVERVIEW'},
    {id:'files',icon:'📂',label:'FILES'},
    {id:'pairing',icon:'🔗',label:'PAIRING'},
    {id:'seedkey',icon:'🔑',label:'SEED→KEY'},
  ];

  return(
    <div style={{minHeight:'100vh',background:C.bg,color:C.tx,fontFamily:'"Inter","Segoe UI",system-ui,sans-serif'}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;700&family=Inter:wght@400;600;700;800;900&display=swap');
        *{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:#333 transparent}
        ::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#333;border-radius:3px}
      `}</style>
      {/* HEADER */}
      <div style={{background:'linear-gradient(135deg, #0E0E15 0%, #16161F 50%, rgba(211,47,47,0.15) 100%)',borderBottom:`1px solid ${C.bd}`,padding:'14px 20px',display:'flex',alignItems:'center',gap:14}}>
        <div style={{width:40,height:40,borderRadius:10,background:'linear-gradient(135deg, #FF5252, #D32F2F)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:20,fontWeight:900,color:'#fff',boxShadow:'0 4px 20px rgba(211,47,47,0.4)'}}>S</div>
        <div style={{flex:1}}>
          <div style={{fontSize:20,fontWeight:900,letterSpacing:2,color:'#fff'}}>SRT LAB</div>
          <div style={{fontSize:8,letterSpacing:5,color:'rgba(255,255,255,0.3)',fontWeight:700}}>JAILBREAK EDITION · {D.st.t} FILES LOADED</div>
        </div>
        <div style={{display:'flex',gap:2}}>
          {tabs.map(t=>{const a=tab===t.id;return<button key={t.id} onClick={()=>{setTab(t.id);setSel(null);}} style={{padding:'8px 14px',border:'none',borderRadius:8,cursor:'pointer',background:a?C.sr+'20':'transparent',color:a?C.sl:C.ts,fontWeight:a?800:600,fontSize:10,letterSpacing:.5,fontFamily:'inherit',transition:'all 0.15s'}}><span style={{marginRight:4}}>{t.icon}</span>{t.label}</button>;})}
        </div>
      </div>

      <div style={{maxWidth:1200,margin:'0 auto',padding:'16px 16px 60px'}}>
        {tab==='overview'&&<Overview/>}
        {tab==='files'&&<Files files={files} filt={filt} setFilt={setFilt} vinFilt={vinFilt} setVinFilt={setVinFilt} sel={sel} setSel={setSel} sf={sf}/>}
        {tab==='pairing'&&<Pairing/>}
        {tab==='seedkey'&&<SeedKey seedHex={seedHex} setSeedHex={setSeedHex}/>}
      </div>
    </div>
  );
}

/* ═══ OVERVIEW TAB ═══ */
function Overview(){
  const stats=[
    {n:'BCM',v:D.st.b,c:TC.BCM,d:'64KB D-FLASH'},
    {n:'RFHUB',v:D.st.r,c:TC.RFHUB,d:'4KB EEE'},
    {n:'GPEC2A',v:D.st.g,c:TC.GPEC2A,d:'4-8KB EXT'},
    {n:'Firmware',v:D.st.w,c:TC.FW,d:'P-FLASH/INT'},
    {n:'Unique VINs',v:D.st.v,c:C.a4,d:'Across all files'},
    {n:'SEC16 Chains',v:D.ch.length,c:C.gn,d:'RFH→BCM pairs'},
  ];
  const vinEntries=Object.entries(D.vm).sort((a,b)=>b[1].length-a[1].length);

  return(<>
    <div style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:10,marginBottom:16}}>
      {stats.map(s=><div key={s.n} style={{padding:14,borderRadius:10,background:C.c1,border:`1px solid ${C.bd}`,textAlign:'center'}}>
        <div style={{fontSize:26,fontWeight:900,color:s.c}}>{s.v}</div>
        <div style={{fontSize:10,fontWeight:800,color:C.tx,marginTop:2}}>{s.n}</div>
        <div style={{fontSize:8,color:C.ts,marginTop:2}}>{s.d}</div>
      </div>)}
    </div>

    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
      {/* VIN MAP */}
      <div style={{padding:16,borderRadius:12,background:C.c1,border:`1px solid ${C.bd}`}}>
        <div style={{fontSize:12,fontWeight:800,marginBottom:10,color:C.a1}}>VIN MAP — {vinEntries.length} Unique VINs</div>
        {vinEntries.map(([vin,files])=>(
          <div key={vin} style={{padding:'8px 10px',borderRadius:8,background:C.c2,border:`1px solid ${C.bd}`,marginBottom:6}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{fontFamily:'"Fira Code",monospace',fontSize:11,fontWeight:700,color:C.a1,letterSpacing:1}}>{vin}</span>
              <T c={files.length>=10?C.gn:files.length>=3?C.a3:C.ts}>{files.length} file{files.length>1?'s':''}</T>
            </div>
            <div style={{fontSize:8,color:C.ts,marginTop:4,lineHeight:1.5}}>{files.map(f=>f.replace('.bin','').slice(0,35)).join(' · ')}</div>
          </div>
        ))}
      </div>

      {/* SEC16 CHAIN SUMMARY */}
      <div style={{padding:16,borderRadius:12,background:C.c1,border:`1px solid ${C.bd}`}}>
        <div style={{fontSize:12,fontWeight:800,marginBottom:10,color:C.gn}}>SEC16 PAIRING CHAINS</div>
        {/* Deduplicate by SEC16 value */}
        {[...new Map(D.ch.map(c=>[c.rs,c])).values()].map((ch,i)=>(
          <div key={i} style={{padding:10,borderRadius:8,background:C.c2,border:`1px solid ${C.bd}`,marginBottom:8}}>
            <div style={{fontSize:9,fontWeight:800,color:C.a3,marginBottom:4}}>RFH SEC16</div>
            <div style={{fontFamily:'"Fira Code",monospace',fontSize:9,color:C.a3,letterSpacing:.5,marginBottom:6}}>{ch.rs}</div>
            <div style={{fontSize:9,fontWeight:800,color:C.a1,marginBottom:4}}>Expected BCM (reversed)</div>
            <div style={{fontFamily:'"Fira Code",monospace',fontSize:9,color:C.a1,letterSpacing:.5,marginBottom:6}}>{ch.eb}</div>
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              {ch.bm.length>0?<T c={C.gn}>MATCHED {ch.bm.length} BCM</T>:<T c={C.wn}>NO BCM MATCH</T>}
            </div>
            {ch.bm.length>0&&<div style={{fontSize:8,color:C.ts,marginTop:4}}>{ch.bm.map(b=>b.replace('.bin','').slice(0,40)).join(', ')}</div>}
          </div>
        ))}

        <div style={{fontSize:12,fontWeight:800,marginTop:16,marginBottom:10,color:C.a2}}>PCM SEC6 → RFH Verification</div>
        {D.s6.map((s,i)=>(
          <div key={i} style={{padding:8,borderRadius:8,background:C.c2,border:`1px solid ${C.bd}`,marginBottom:6}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{fontFamily:'"Fira Code",monospace',fontSize:10,color:C.a2,fontWeight:700}}>{s.s6}</span>
              <T c={s.rm.length>0?C.gn:C.er}>{s.rm.length>0?`${s.rm.length} RFH match`:'NO MATCH'}</T>
            </div>
            <div style={{fontSize:8,color:C.ts,marginTop:3}}>{s.pf.replace('.bin','').slice(0,50)}</div>
          </div>
        ))}
      </div>
    </div>
  </>);
}

/* ═══ FILES TAB ═══ */
function Files({files,filt,setFilt,vinFilt,setVinFilt,sel,setSel,sf}){
  const types=['ALL','BCM','RFHUB','GPEC2A','GPEC8K','FW'];
  return(
    <div style={{display:'grid',gridTemplateColumns:'280px 1fr',gap:14,alignItems:'start'}}>
      <div>
        <div style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:8}}>
          {types.map(t=><button key={t} onClick={()=>setFilt(t)} style={{padding:'4px 10px',borderRadius:6,border:`1px solid ${filt===t?(TC[t]||C.sr):C.bd}`,background:filt===t?(TC[t]||C.sr)+'15':'transparent',color:filt===t?(TC[t]||C.sr):C.ts,fontSize:9,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}}>{t}</button>)}
        </div>
        <input value={vinFilt} onChange={e=>setVinFilt(e.target.value.toUpperCase())} placeholder="Filter by VIN..." style={{width:'100%',padding:'7px 10px',borderRadius:8,border:`1px solid ${C.bd}`,background:C.c2,color:C.tx,fontSize:10,marginBottom:8,outline:'none',boxSizing:'border-box',fontFamily:'"Fira Code",monospace',letterSpacing:1}}/>
        <div style={{maxHeight:'70vh',overflow:'auto'}}>
          {files.map(f=>{const a=sel===f.name;const tc=TC[f.type]||C.ts;return(
            <div key={f.name} onClick={()=>setSel(a?null:f.name)} style={{padding:10,borderRadius:8,background:a?C.c2:C.c1,border:`1.5px solid ${a?tc:C.bd}`,marginBottom:5,cursor:'pointer',transition:'all 0.15s'}}>
              <div style={{fontSize:10,fontWeight:800,color:a?tc:C.tx,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{f.name.replace('.bin','')}</div>
              <div style={{display:'flex',gap:4,marginTop:4,alignItems:'center',flexWrap:'wrap'}}>
                <T c={tc}>{TN[f.type]||f.type}</T>
                <span style={{fontSize:8,color:C.ts}}>{f.kb}KB</span>
              </div>
              {f.vins?.[0]&&<div style={{fontFamily:'"Fira Code",monospace',fontSize:9,color:C.a1,fontWeight:700,marginTop:4}}>{f.vins[0].vin}</div>}
            </div>
          );})}
        </div>
      </div>

      {/* DETAIL PANEL */}
      {sf?<FileDetail f={sf}/>:<div style={{padding:40,textAlign:'center',color:C.ts,fontSize:12}}>Select a file to inspect</div>}
    </div>
  );
}

function FileDetail({f}){
  const tc=TC[f.type]||C.ts;
  return(
    <div>
      <div style={{padding:16,borderRadius:12,background:C.c1,border:`1px solid ${C.bd}`,marginBottom:12}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
          <div style={{fontSize:14,fontWeight:900,color:tc}}>{f.name}</div>
          <div style={{display:'flex',gap:4}}><T c={tc}>{TN[f.type]}</T><T c={C.ts}>{f.kb}KB</T></div>
        </div>

        {/* VINs */}
        {f.vins?.length>0&&<div style={{marginBottom:12}}>
          <div style={{fontSize:10,fontWeight:800,color:C.ts,letterSpacing:2,marginBottom:6}}>VIN LOCATIONS</div>
          {f.vins.map((v,i)=>(
            <div key={i} style={{padding:'5px 8px',borderRadius:6,background:C.c2,border:`1px solid ${C.bd}`,marginBottom:3,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div>
                <span style={{fontFamily:'"Fira Code",monospace',fontSize:9,color:C.ts}}>{v.off} </span>
                <span style={{fontFamily:'"Fira Code",monospace',fontSize:11,fontWeight:800,color:C.a1,letterSpacing:1}}>{v.vin}</span>
              </div>
              <div style={{display:'flex',gap:3}}>
                <T c={v.algo==='CRC16'?C.gn:v.algo==='REV'?C.a3:C.a2}>{v.algo}{v.count>1?` ×${v.count}`:''}</T>
                {v.crc&&<T c={C.gn}>{v.crc}</T>}
              </div>
            </div>
          ))}
        </div>}

        {/* BCM SPECIFICS */}
        {f.type==='BCM'&&<>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,marginBottom:12}}>
            <div style={{padding:10,borderRadius:8,background:C.c2,border:`1px solid ${C.bd}`}}>
              <div style={{fontSize:8,color:C.ts,fontWeight:700,letterSpacing:1}}>IMMO @0x40C0</div>
              <div style={{fontSize:12,fontWeight:800,color:f.immoBlank?C.wn:C.gn,marginTop:4}}>{f.immoBlank?'BLANK':'SET'}</div>
            </div>
            <div style={{padding:10,borderRadius:8,background:C.c2,border:`1px solid ${C.bd}`}}>
              <div style={{fontSize:8,color:C.ts,fontWeight:700,letterSpacing:1}}>BACKUP @0x2000</div>
              <div style={{fontSize:12,fontWeight:800,color:f.bakBlank?C.ts:C.gn,marginTop:4}}>{f.bakBlank?'BLANK':'SET'}</div>
            </div>
            <div style={{padding:10,borderRadius:8,background:C.c2,border:`1px solid ${C.bd}`}}>
              <div style={{fontSize:8,color:C.ts,fontWeight:700,letterSpacing:1}}>FEE BANKS</div>
              <div style={{fontSize:10,fontWeight:700,color:C.tx,marginTop:4}}>B0={f.b0} B1={f.b1} Act={f.act}</div>
            </div>
          </div>
          {f.pn&&<div style={{marginBottom:8}}>
            <span style={{fontSize:9,color:C.ts,fontWeight:700}}>P/N: </span>
            {f.pn.map(p=><span key={p} style={{fontFamily:'"Fira Code",monospace',fontSize:10,color:C.a4,marginRight:8,fontWeight:700}}>{p}</span>)}
          </div>}
          {/* SEC16 split records */}
          <div style={{fontSize:10,fontWeight:800,color:C.ts,letterSpacing:2,marginBottom:6}}>SEC16 SPLIT RECORDS</div>
          {f.sec16?.map((s,i)=>(
            <div key={i} style={{padding:'6px 8px',borderRadius:6,background:C.c2,border:`1px solid ${C.bd}`,marginBottom:3}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <span style={{fontSize:9,color:C.ts}}>{s.off} idx={s.idx}</span>
                <div style={{display:'flex',gap:3}}>
                  <T c={s.sepOk?C.gn:C.er}>{s.sepOk?'SEP✓':'SEP✗'}</T>
                  <T c={s.blank?C.wn:C.gn}>{s.blank?'BLANK':'SET'}</T>
                </div>
              </div>
              {!s.blank&&<div style={{fontFamily:'"Fira Code",monospace',fontSize:9,color:C.a3,marginTop:3,letterSpacing:.5}}>{s.hex}</div>}
            </div>
          ))}
        </>}

        {/* RFHUB SPECIFICS */}
        {f.type==='RFHUB'&&<>
          <div style={{fontSize:10,fontWeight:800,color:C.ts,letterSpacing:2,marginBottom:6}}>SEC16</div>
          {f.sec16?.g===2&&<div style={{padding:10,borderRadius:8,background:C.c2,border:`1px solid ${C.bd}`,marginBottom:8}}>
            <div style={{display:'flex',gap:4,marginBottom:6}}>
              <T c={f.sec16.v?C.wn:C.gn}>{f.sec16.v?'VIRGIN':'PAIRED'}</T>
              <T c={f.sec16.m?C.gn:C.er}>{f.sec16.m?'Slots match':'MISMATCH'}</T>
              <T c={C.a3}>Gen2</T>
            </div>
            <div style={{fontFamily:'"Fira Code",monospace',fontSize:9,color:C.a3,letterSpacing:.5}}>S1: {f.sec16.s1}</div>
            <div style={{fontFamily:'"Fira Code",monospace',fontSize:9,color:C.a3,letterSpacing:.5,marginTop:2}}>S2: {f.sec16.s2}</div>
          </div>}
          <div style={{padding:8,borderRadius:6,background:C.c2,border:`1px solid ${C.bd}`,marginBottom:8}}>
            <span style={{fontSize:9,color:C.ts}}>Gen1: </span>
            <T c={f.sec16?.g1v?C.wn:f.sec16?.g1m?C.gn:C.er}>{f.sec16?.g1v?'VIRGIN':f.sec16?.g1m?'MATCH':'MISMATCH'}</T>
          </div>
          <div style={{padding:8,borderRadius:6,background:C.c2,border:`1px solid ${C.bd}`}}>
            <span style={{fontSize:9,color:C.ts}}>Secret Key @0x40: </span>
            <T c={f.skb?C.wn:C.gn}>{f.skb?'ERASED (all FF)':'SET'}</T>
          </div>
        </>}

        {/* GPEC2A SPECIFICS */}
        {f.type==='GPEC2A'&&<>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,marginBottom:10}}>
            <div style={{padding:10,borderRadius:8,background:C.c2,border:`1px solid ${C.bd}`}}>
              <div style={{fontSize:8,color:C.ts,fontWeight:700}}>SKIM</div>
              <div style={{fontSize:12,fontWeight:800,color:f.skimOn?C.gn:C.wn,marginTop:4}}>{f.skimOn?'ON':'OFF'} {f.skim}</div>
            </div>
            <div style={{padding:10,borderRadius:8,background:C.c2,border:`1px solid ${C.bd}`}}>
              <div style={{fontSize:8,color:C.ts,fontWeight:700}}>KEY MIRROR</div>
              <div style={{fontSize:12,fontWeight:800,color:f.km?C.gn:C.er,marginTop:4}}>{f.km?'MATCH':'MISMATCH'}</div>
            </div>
            <div style={{padding:10,borderRadius:8,background:C.c2,border:`1px solid ${C.bd}`}}>
              <div style={{fontSize:8,color:C.ts,fontWeight:700}}>ZZZZ TAMPER</div>
              <div style={{fontSize:12,fontWeight:800,color:f.zz?C.gn:C.er,marginTop:4}}>{f.zz?'INTACT':'TAMPERED'}</div>
            </div>
          </div>
          {f.sec6&&<div style={{padding:8,borderRadius:6,background:C.c2,border:`1px solid ${C.bd}`,marginBottom:6}}>
            <span style={{fontSize:9,color:C.ts}}>SEC6: </span>
            <span style={{fontFamily:'"Fira Code",monospace',fontSize:11,color:C.a2,fontWeight:700}}>{f.sec6}</span>
          </div>}
          <div style={{padding:8,borderRadius:6,background:C.c2,border:`1px solid ${C.bd}`,marginBottom:4}}>
            <div style={{fontSize:8,color:C.ts}}>Key @0x203</div>
            <div style={{fontFamily:'"Fira Code",monospace',fontSize:9,color:C.a4}}>{f.key}</div>
          </div>
          <div style={{padding:8,borderRadius:6,background:C.c2,border:`1px solid ${C.bd}`}}>
            <div style={{fontSize:8,color:C.ts}}>Mirror @0x361</div>
            <div style={{fontFamily:'"Fira Code",monospace',fontSize:9,color:f.km?C.a4:C.er}}>{f.mir}</div>
          </div>
        </>}

        {/* GPEC8K */}
        {f.type==='GPEC8K'&&f.sec6&&<div style={{padding:8,borderRadius:6,background:C.c2,border:`1px solid ${C.bd}`}}>
          <span style={{fontSize:9,color:C.ts}}>SEC6: </span>
          <span style={{fontFamily:'"Fira Code",monospace',fontSize:11,color:C.a2,fontWeight:700}}>{f.sec6}</span>
        </div>}

        {/* FIRMWARE */}
        {f.type==='FW'&&<div style={{padding:10,borderRadius:8,background:C.c2,border:`1px solid ${C.bd}`}}>
          <div style={{display:'flex',gap:8,alignItems:'center'}}>
            <span style={{fontSize:10,color:C.ts}}>Unlock @0x2FFFC:</span>
            <span style={{fontFamily:'"Fira Code",monospace',fontSize:12,fontWeight:800,color:f.isUlk?C.gn:C.a1}}>{f.ulk||'N/A'}</span>
            <T c={f.isUlk?C.gn:C.wn}>{f.isUlk?'UNLOCKED':'LOCKED'}</T>
          </div>
        </div>}
      </div>
    </div>
  );
}

/* ═══ PAIRING TAB ═══ */
function Pairing(){
  const unique=[...new Map(D.ch.map(c=>[c.rs,c])).values()];
  return(<>
    <div style={{fontSize:13,fontWeight:900,color:C.gn,marginBottom:12}}>SEC16 PAIRING CHAIN VERIFICATION</div>
    <div style={{padding:14,borderRadius:12,background:C.c1,border:`1px solid ${C.bd}`,marginBottom:16}}>
      <div style={{fontFamily:'"Fira Code",monospace',fontSize:10,color:C.ts,lineHeight:1.8}}>
        RFH SEC16 (16 bytes) ← stored at 0x050E/0x0522<br/>
        BCM stores reverse(RFH_SEC16) in split records at 0x81A0/C0/E0<br/>
        PCM stores RFH_SEC16[0:6] as SEC6 after FF FF FF AA marker<br/>
        Mirror CRC = CRC-16/CCITT over 20 bytes [idx + SEC16 + 0x8F + FF + FF]
      </div>
    </div>

    {unique.map((ch,i)=>(
      <div key={i} style={{padding:16,borderRadius:12,background:C.c1,border:`1px solid ${ch.bm.length>0?C.gn+'44':C.wn+'44'}`,marginBottom:12}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
          <div style={{display:'flex',gap:6,alignItems:'center'}}>
            <span style={{fontSize:18}}>{ch.bm.length>0?'✅':'⚠️'}</span>
            <span style={{fontSize:12,fontWeight:800,color:ch.bm.length>0?C.gn:C.wn}}>{ch.bm.length>0?'CHAIN VERIFIED':'NO BCM MATCH FOUND'}</span>
          </div>
          <T c={C.a3}>SEC16 #{i+1}</T>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 30px 1fr',gap:8,alignItems:'center',marginBottom:10}}>
          <div style={{padding:10,borderRadius:8,background:C.c2,border:`1px solid ${C.bd}`}}>
            <div style={{fontSize:8,color:C.ts,fontWeight:700,letterSpacing:2,marginBottom:4}}>RFH SEC16</div>
            <div style={{fontFamily:'"Fira Code",monospace',fontSize:9,color:C.a3,letterSpacing:.5,wordBreak:'break-all'}}>{ch.rs}</div>
          </div>
          <div style={{textAlign:'center',fontSize:16,color:C.ts}}>→</div>
          <div style={{padding:10,borderRadius:8,background:C.c2,border:`1px solid ${C.bd}`}}>
            <div style={{fontSize:8,color:C.ts,fontWeight:700,letterSpacing:2,marginBottom:4}}>EXPECTED BCM (reversed)</div>
            <div style={{fontFamily:'"Fira Code",monospace',fontSize:9,color:C.a1,letterSpacing:.5,wordBreak:'break-all'}}>{ch.eb}</div>
          </div>
        </div>
        {ch.bm.length>0&&<div>
          <div style={{fontSize:9,color:C.ts,fontWeight:700,marginBottom:4}}>Matched BCM files:</div>
          {ch.bm.map(b=><div key={b} style={{fontSize:9,color:C.gn,padding:'2px 0'}}>✓ {b}</div>)}
        </div>}
        <div style={{fontSize:9,color:C.ts,fontWeight:700,marginTop:8,marginBottom:4}}>RFH files with this SEC16:</div>
        {D.ch.filter(c=>c.rs===ch.rs).map(c=><div key={c.rf} style={{fontSize:9,color:C.a3,padding:'2px 0'}}>{c.rf}</div>)}
      </div>
    ))}

    <div style={{fontSize:13,fontWeight:900,color:C.a2,marginTop:20,marginBottom:12}}>PCM SEC6 → RFH SEC16[0:6]</div>
    {[...new Map(D.s6.map(s=>[s.s6,s])).values()].map((s,i)=>(
      <div key={i} style={{padding:14,borderRadius:12,background:C.c1,border:`1px solid ${s.rm.length>0?C.gn+'44':C.er+'44'}`,marginBottom:10}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
          <div>
            <span style={{fontFamily:'"Fira Code",monospace',fontSize:14,fontWeight:800,color:C.a2}}>{s.s6}</span>
          </div>
          <T c={s.rm.length>0?C.gn:C.er}>{s.rm.length} RFH match{s.rm.length!==1?'es':''}</T>
        </div>
        {s.rm.map(r=><div key={r} style={{fontSize:9,color:C.gn,padding:'2px 0'}}>✓ {r}</div>)}
      </div>
    ))}
  </>);
}

/* ═══ SEED→KEY TAB ═══ */
function SeedKey({seedHex,setSeedHex}){
  const res=useMemo(()=>{
    const raw=seedHex.replace(/\s/g,'');
    const v=parseInt(raw,16);
    if(isNaN(v)||!raw)return null;
    return ALGOS.map(a=>({n:a.n,h:a.h,k:a.fn(v).toString(16).toUpperCase().padStart(8,'0')}));
  },[seedHex]);
  const sv=seedHex.replace(/\s/g,'');
  const seedDec=parseInt(sv,16);

  return(
    <div style={{maxWidth:700}}>
      <div style={{padding:20,borderRadius:14,background:C.c1,border:`1px solid ${C.bd}`}}>
        <div style={{fontSize:16,fontWeight:900,color:C.sr,marginBottom:4}}>SEED → KEY CALCULATOR</div>
        <div style={{fontSize:10,color:C.ts,marginBottom:14}}>{ALGOS.length} verified algorithms · FCA security access levels 1/3/11</div>
        <div style={{fontSize:9,fontWeight:800,color:C.ts,letterSpacing:2,marginBottom:4}}>SEED (HEX · 4 BYTES)</div>
        <input value={seedHex} onChange={e=>setSeedHex(e.target.value.toUpperCase().replace(/[^A-F0-9\s]/g,''))} placeholder="e.g. A1B2C3D4"
          style={{width:'100%',padding:'14px',borderRadius:10,border:`2px solid ${C.bd}`,background:C.c2,color:C.tx,fontSize:22,fontWeight:700,letterSpacing:4,textAlign:'center',outline:'none',boxSizing:'border-box',fontFamily:'"Fira Code",monospace'}}
          onFocus={e=>e.target.style.borderColor=C.sr} onBlur={e=>e.target.style.borderColor=C.bd}/>
        <div style={{display:'flex',justifyContent:'space-between',marginTop:6}}>
          <span style={{fontSize:10,color:sv.length===8?C.gn:C.ts,fontWeight:700}}>{sv.length}/8 hex chars</span>
          {!isNaN(seedDec)&&sv&&<span style={{fontSize:10,color:C.ts}}>= {seedDec.toString().replace(/\B(?=(\d{3})+(?!\d))/g,',')} dec</span>}
        </div>
        {res&&<div style={{marginTop:16}}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
            {res.map((r,i)=>(
              <div key={i} style={{padding:'10px 12px',borderRadius:10,background:C.c2,border:`1px solid ${C.bd}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div>
                  <div style={{fontSize:11,fontWeight:800,color:C.tx}}>{r.n}</div>
                  <div style={{fontSize:8,color:C.ts}}>{r.h}</div>
                </div>
                <div style={{fontFamily:'"Fira Code",monospace',fontSize:14,fontWeight:800,color:C.sr,letterSpacing:1}}>{r.k}</div>
              </div>
            ))}
          </div>
        </div>}
      </div>
    </div>
  );
}
