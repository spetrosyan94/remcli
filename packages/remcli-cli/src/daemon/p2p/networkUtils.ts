/**
 * Network utilities for P2P server
 * LAN IP discovery and network interface helpers
 */

import os from 'os';

interface NetworkInterface {
    name: string;
    address: string;
    family: 'IPv4' | 'IPv6';
}

/**
 * Get all non-internal network interfaces
 */
export function getNetworkInterfaces(): NetworkInterface[] {
    const interfaces = os.networkInterfaces();
    const result: NetworkInterface[] = [];

    for (const [name, addrs] of Object.entries(interfaces)) {
        if (!addrs) continue;
        for (const addr of addrs) {
            if (addr.internal) continue;
            result.push({
                name,
                address: addr.address,
                family: addr.family as 'IPv4' | 'IPv6'
            });
        }
    }

    return result;
}

/**
 * Check if an IP address is in a private range (RFC 1918)
 */
export function isPrivateIP(ip: string): boolean {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4) return false;

    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;

    return false;
}

/**
 * Get the best LAN IPv4 address for P2P connections
 * Prefers en0 (WiFi on macOS) over other interfaces
 */
export function getLanIPAddress(): string | null {
    const interfaces = getNetworkInterfaces();
    const ipv4Interfaces = interfaces.filter(i => i.family === 'IPv4' && isPrivateIP(i.address));

    if (ipv4Interfaces.length === 0) return null;

    // Prefer en0 (WiFi on macOS)
    const en0 = ipv4Interfaces.find(i => i.name === 'en0');
    if (en0) return en0.address;

    // Fallback to first private IPv4
    return ipv4Interfaces[0].address;
}
