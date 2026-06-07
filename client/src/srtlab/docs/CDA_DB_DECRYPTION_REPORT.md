# Reverse Engineering Report: Custom SQLite Encryption Codec

## 1. Executive Summary
The analyzed DLL (`sqlite3_drv.dll`) implements a custom SQLite Encryption Extension (SEE) codec. While the binary contains a hardcoded string `7bb07b8d471d642e`, this token serves as a **global activation flag** rather than the database encryption key. The actual database encryption utilizes **AES-128 in an Output Feedback (OFB) inspired mode**, with key derivation based on the password provided to the `sqlite3_key` interface.

## 2. Key Derivation and Algorithm
The codec supports multiple cipher types determined by password prefixes:
*   **RC4:** Triggered by `rc4:` prefix (Cipher Type 0).
*   **AES-128:** Default mode or triggered by `aes128:` prefix (Cipher Type 1).
*   **AES-256:** Triggered by `aes256:` prefix (Cipher Type 2).

### Key Expansion Logic
For the default AES-128 mode, the codec takes the provided password (e.g., `2Simple2Gu3ss`) and expands it to exactly 16 bytes by **cycling the characters**.
*   **Sample Password:** `2Simple2Gu3ss`
*   **Expanded Key:** `2Simple2Gu3ss2Si` (Hex: `3253696d706c65324775337373325369`)

## 3. Page Layout and Encryption Scheme
The database uses a page size of **1024 bytes** with a **12-byte reserve** area at the end of every page.

### Initialization Vector (IV) Generation
The IV for each page is 16 bytes, constructed as follows:
1.  **Bytes 0-3:** Page number in Little-Endian format.
2.  **Bytes 4-15:** The first 12 bytes of the page's reserve area (the "nonce").
3.  **Padding:** Any remaining bytes are zero-padded to 16 bytes.

### Encryption Mode (AES-OFB Variant)
The codec generates a keystream by repeatedly encrypting the IV (and subsequent blocks) using AES-ECB:
*   `StreamBlock_0 = AES_Encrypt(Key, IV)`
*   `StreamBlock_N = AES_Encrypt(Key, StreamBlock_{N-1})`

The plaintext is XORed with this keystream. Only the "usable" portion of the page (PageSize - ReserveSize) is encrypted; the reserve bytes themselves remain in the file to serve as part of the IV for the next decryption.

### Page 1 Special Handling
To allow SQLite to identify the file, the first page has a "hole" in its encryption:
*   **Bytes 0-15:** Encrypted.
*   **Bytes 16-23:** **Plaintext** (Contains the `SQLite format 3` signature and page size fields).
*   **Bytes 24-1011:** Encrypted.
*   **Bytes 1012-1023:** Plaintext Reserve/Nonce.

## 4. Analysis of Hardcoded Key Reference
The string `7bb07b8d471d642e` at offset `0x769e4` is checked during `driver_init`. If the check passes, a global flag at `0x10079b18` is set to `1`. This flag is required for the `sqlite3_key` wrapper to proceed with codec initialization. It appears to be a licensing or "magic" activation string for the driver rather than a cryptographic component of the database itself.
