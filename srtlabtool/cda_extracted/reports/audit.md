# CDA.swf Audit Report

## Input
- SWF path: `C:\Users\gomez\Desktop\CDA.swf`
- SHA-256: `524b65c18c0f47be120fd1097da7bfe4848028d2cd33246d4c108b58c46b8c9b`
- Compression: `CWS` (version 11), size 4346734 bytes -> 8716982 bytes

## Integrity
- Decompression check: PASS
- End-tag traversal: PASS
- Parse errors: 0

## Structure
- Total tags: 371
- Raw payload exports: 371
- Typed tag JSON files: 344
- Total artifacts tracked: 1357

Top tag codes:
- 36 (DefineBitsLossless2): 311
- 39 (DefineSprite): 18
- 32 (DefineShape3): 10
- 87 (DefineBinaryData): 9
- 2 (DefineShape): 5
- 43 (FrameLabel): 2
- 82 (DoABC): 2
- 76 (SymbolClass): 2
- 1 (ShowFrame): 2
- 22 (DefineShape2): 2
- 69 (FileAttributes): 1
- 77 (Metadata): 1
- 65 (ScriptLimits): 1
- 9 (SetBackgroundColor): 1
- 41 (ProductInfo): 1
- 21 (DefineBitsJPEG2): 1
- 56 (ExportAssets): 1
- 0 (End): 1

## ActionScript / Binary
- DoABC tags: 2
- Tag 6: script `frame1`, lazy=true, ABC bytes=56660
- Tag 367: script `frame2`, lazy=true, ABC bytes=7228987
- DefineBinaryData tags: 9
- Tag 41, char 32: 1270 bytes (`bin`)
- Tag 42, char 33: 1062 bytes (`bin`)
- Tag 43, char 34: 1260 bytes (`bin`)
- Tag 44, char 35: 2256 bytes (`bin`)
- Tag 45, char 36: 1132 bytes (`bin`)
- Tag 46, char 37: 612 bytes (`bin`)
- Tag 47, char 38: 1908 bytes (`bin`)
- Tag 48, char 39: 2286 bytes (`bin`)
- Tag 52, char 43: 612 bytes (`bin`)

## Symbol Maps
- Class bindings: 342
- Exported symbols: 223
- Character IDs with multiple class bindings: 5
- Character IDs with multiple export names: 0

Top class namespaces:
- com.chrysler.cda: 86
- spark.skins.spark: 26
- mx.graphics.shaderClasses: 9
- com.diagnosticProcedures.assets: 7
- _CDA_mx_managers_SystemManager: 1
- _class_embed_css_Assets_swf__1291236433_TreeNodeIcon_1748326136: 1
- _class_embed_css_Assets_swf__1291236433_mx_skins_BoxDividerSkin_1793095157: 1
- _class_embed_css_Assets_swf__1291236433_mx_skins_cursor_DragCopy_1069901525: 1
- _class_embed_css_Assets_swf__1291236433_mx_skins_cursor_DragMove_1070189105: 1
- _class_embed_css_Assets_swf__1291236433_TreeFolderOpen_885386299: 1
- _class_embed_css_Assets_swf__1291236433_cursorStretch_1209699474: 1
- _class_embed_css_Assets_swf__1291236433_mx_skins_cursor_VBoxDivider_1337584662: 1
- _class_embed_css_Assets_swf__1291236433_mx_skins_cursor_DragReject_417351009: 1
- _class_embed_css_Assets_swf__1291236433_TreeFolderClosed_1699980247: 1
- _class_embed_css_Assets_swf__1291236433_TreeDisclosureClosed_909034458: 1

Feature keyword counts (class/export names):
- buslog: 57
- proxi: 36
- diagnostic: 20
- ecu: 18
- write: 16
- alignment: 10
- unlock: 9
- pid: 9
- flash: 8
- download: 8
- dtc: 7
- sgw: 4
- read: 2
- memory: 1
- upload: 0

Examples of multi-class character IDs:
- Character 78: com.chrysler.Assets_buslogConfigLoadDown, com.chrysler.Assets_buslogImportDown
- Character 156: com.chrysler.Assets_buslogConfigLoadUp, com.chrysler.Assets_buslogImportUp
- Character 194: com.chrysler.Assets_buslogConfigLoadOver, com.chrysler.Assets_buslogImportOver
- Character 297: com.chrysler.cda.presentation.Assets_AlignmentFailed, com.chrysler.cda.presentation.Assets_databaseVariantIsocodeMismatch
- Character 333: com.chrysler.cda.presentation.Assets_flashBackground, com.chrysler.cda.presentation.Assets_startBackground

## Largest Tag Payloads
- Tag 367: 82 (DoABC) -> 7228998 bytes
- Tag 62: 36 (DefineBitsLossless2) -> 384475 bytes
- Tag 151: 21 (DefineBitsJPEG2) -> 189081 bytes
- Tag 204: 36 (DefineBitsLossless2) -> 131284 bytes
- Tag 342: 36 (DefineBitsLossless2) -> 123629 bytes
- Tag 330: 36 (DefineBitsLossless2) -> 112034 bytes
- Tag 6: 82 (DoABC) -> 56671 bytes
- Tag 275: 36 (DefineBitsLossless2) -> 41302 bytes
- Tag 368: 76 (SymbolClass) -> 17384 bytes
- Tag 286: 36 (DefineBitsLossless2) -> 16718 bytes
- Tag 366: 56 (ExportAssets) -> 10092 bytes
- Tag 339: 36 (DefineBitsLossless2) -> 9207 bytes
- Tag 285: 36 (DefineBitsLossless2) -> 5950 bytes
- Tag 356: 36 (DefineBitsLossless2) -> 4218 bytes
- Tag 337: 36 (DefineBitsLossless2) -> 4196 bytes
- Tag 304: 36 (DefineBitsLossless2) -> 4175 bytes
- Tag 359: 36 (DefineBitsLossless2) -> 3656 bytes
- Tag 272: 36 (DefineBitsLossless2) -> 3502 bytes
- Tag 270: 36 (DefineBitsLossless2) -> 3456 bytes
- Tag 160: 36 (DefineBitsLossless2) -> 3406 bytes

## Largest Assets
- swf/uncompressed.swf -> 8716990 bytes [swf]
- tags/raw/tag_0367_082_doabc.bin -> 7228998 bytes [bin]
- assets/doabc/tag_0367_frame2.abc -> 7228987 bytes [abc]
- swf/original.swf -> 4346734 bytes [swf]
- assets/definebitslossless2/tag_0062_char_00053_bitmap.raw -> 2977792 bytes [raw]
- assets/definebitslossless2/tag_0342_char_00333_bitmap.raw -> 1048512 bytes [raw]
- assets/definebitslossless2/tag_0204_char_00195_bitmap.raw -> 544800 bytes [raw]
- assets/definebitslossless2/tag_0286_char_00277_bitmap.raw -> 462400 bytes [raw]
- tags/raw/tag_0062_036_definebitslossless2.bin -> 384475 bytes [bin]
- assets/definebitslossless2/tag_0062_char_00053_bitmap.zlib -> 384468 bytes [zlib]
- assets/definebitslossless2/tag_0330_char_00321_bitmap.raw -> 268272 bytes [raw]
- manifest/tags.jsonl -> 192479 bytes [jsonl]
- tags/raw/tag_0151_021_definebitsjpeg2.bin -> 189081 bytes [bin]
- assets/definebitsjpeg2/tag_0151_char_00142.jpg -> 189079 bytes [jpeg]
- maps/character_id_index.json -> 155240 bytes [json]
- tags/raw/tag_0204_036_definebitslossless2.bin -> 131284 bytes [bin]
- assets/definebitslossless2/tag_0204_char_00195_bitmap.zlib -> 131277 bytes [zlib]
- tags/raw/tag_0342_036_definebitslossless2.bin -> 123629 bytes [bin]
- assets/definebitslossless2/tag_0342_char_00333_bitmap.zlib -> 123622 bytes [zlib]
- assets/definebitslossless2/tag_0275_char_00266_bitmap.raw -> 119200 bytes [raw]
- tags/raw/tag_0330_036_definebitslossless2.bin -> 112034 bytes [bin]
- assets/definebitslossless2/tag_0330_char_00321_bitmap.zlib -> 112027 bytes [zlib]
- assets/definebitslossless2/tag_0249_char_00240_bitmap.raw -> 63504 bytes [raw]
- assets/definebitslossless2/tag_0245_char_00236_bitmap.raw -> 63000 bytes [raw]
- assets/definebitslossless2/tag_0246_char_00237_bitmap.raw -> 63000 bytes [raw]

## Rebuild Notes
- Use `maps/class_bindings.json` and `maps/exported_symbols.json` as canonical symbol manifests.
- Prioritize parsing `frame2` ABC block first; it contains the bulk of ActionScript logic.
- Start module reconstruction from namespaces with highest symbol density (`com.chrysler.*`, then `spark.*`, `mx.*`).
- Use keyword heatmap to stage workstreams: `buslog`, `proxi`, `ecu`, `flash`, `unlock`, `dtc`.
- Treat duplicate character ID mappings as intentional SWF overrides unless proven otherwise.

## Suggested Workstreams
- ABC Core Decompilation: priority 1 (Largest logic surface resides in frame2 DoABC block.)
- Symbol Linking and Overrides: priority 2 (Class and export maps drive runtime binding; duplicate character IDs need explicit handling.)
- UI Asset Reconstruction: priority 3 (High volume of DefineBitsLossless2 assets and named UI exports indicate heavy skinning surface.)
- Domain Feature Surface Mapping: priority 4 (Keyword density points to diagnostic modules (buslog, proxi, ecu, flash).)
- Embedded Binary Payload Triage: priority 5 (Nine DefineBinaryData blobs may contain shaders or auxiliary runtime payloads.)

