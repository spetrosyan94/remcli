/**
 * Web UUID generation.
 * Uses crypto.getRandomValues() which works in ALL contexts (HTTP and HTTPS).
 * crypto.randomUUID() requires a secure context in some browsers, so we
 * generate UUID v4 manually from random bytes instead.
 */
export function randomUUID(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // Set version (4) and variant (RFC 4122) bits
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
