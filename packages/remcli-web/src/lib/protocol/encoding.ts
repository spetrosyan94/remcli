/**
 * Binary <-> string encoding helpers (browser-native, no dependencies).
 * Ported 1:1 from remcli-app sources/encryption/{base64,hex,text}.ts —
 * formats must match the CLI daemon exactly.
 */

export function decodeBase64(base64: string, encoding: 'base64' | 'base64url' = 'base64'): Uint8Array {
    let normalizedBase64 = base64;

    if (encoding === 'base64url') {
        normalizedBase64 = base64
            .replace(/-/g, '+')
            .replace(/_/g, '/');

        const padding = normalizedBase64.length % 4;
        if (padding) {
            normalizedBase64 += '='.repeat(4 - padding);
        }
    }

    const binaryString = atob(normalizedBase64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);

    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }

    return bytes;
}

export function encodeBase64(buffer: Uint8Array, encoding: 'base64' | 'base64url' = 'base64'): string {
    let binaryString = '';
    for (let i = 0; i < buffer.length; i++) {
        binaryString += String.fromCharCode(buffer[i]);
    }
    const base64 = btoa(binaryString);

    if (encoding === 'base64url') {
        return base64
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
    }

    return base64;
}

export function encodeHex(buffer: Uint8Array): string {
    return Array.from(buffer)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

export function encodeUTF8(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

export function decodeUTF8(buffer: Uint8Array): string {
    return new TextDecoder().decode(buffer);
}
