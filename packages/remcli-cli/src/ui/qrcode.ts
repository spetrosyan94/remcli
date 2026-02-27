import QRCode from 'qrcode';

/**
 * Display a QR code in the terminal for the given URL
 */
export async function displayQRCode(url: string): Promise<void> {
    console.log('='.repeat(80));
    console.log('📱 To authenticate, scan this QR code with your mobile device:');
    console.log('='.repeat(80));
    const qr = await QRCode.toString(url, {
        type: 'terminal',
        small: true,
        errorCorrectionLevel: 'L',
    });
    for (const line of qr.split('\n')) {
        console.log(' '.repeat(10) + line);
    }
    console.log('='.repeat(80));
}
