/**
 * P2P-only hook for connecting a terminal via QR code scan.
 *
 * Opens the native barcode scanner (expo-camera), parses the scanned QR as a
 * P2P payload ({mode:'p2p', host, port, key, v}), derives the bearer token
 * via HMAC-SHA256 from the shared secret, and logs in. Also supports manual
 * URL/JSON entry via `connectWithUrl` and direct processing via `processAuthUrl`.
 */

import * as React from 'react';
import { Platform } from 'react-native';
import { CameraView } from 'expo-camera';
import { useAuth } from '@/auth/AuthContext';
import { useCheckScannerPermissions } from '@/hooks/useCheckCameraPermissions';
import { Modal } from '@/modal';
import { t } from '@/text';
import { parseP2PQRCode, connectP2P } from '@/sync/p2pConnect';
import { encodeBase64 } from '@/encryption/base64';

interface UseConnectTerminalOptions {
    onSuccess?: () => void;
}

export function useConnectTerminal(options?: UseConnectTerminalOptions) {
    const auth = useAuth();
    const [isLoading, setIsLoading] = React.useState(false);
    const checkScannerPermissions = useCheckScannerPermissions();

    const processAuthUrl = React.useCallback(async (data: string) => {
        // Try to parse as P2P QR payload (JSON)
        const payload = parseP2PQRCode(data);
        if (!payload) {
            Modal.alert(t('common.error'), t('modals.invalidAuthUrl'), [{ text: t('common.ok') }]);
            return false;
        }

        setIsLoading(true);
        try {
            const { token, secret } = await connectP2P(payload);
            await auth.login(token, encodeBase64(secret));

            Modal.alert(t('common.success'), t('modals.terminalConnectedSuccessfully'), [
                {
                    text: t('common.ok'),
                    onPress: () => options?.onSuccess?.()
                }
            ]);
            return true;
        } catch (e) {
            console.error(e);
            Modal.alert(t('common.error'), t('modals.failedToConnectTerminal'), [{ text: t('common.ok') }]);
            return false;
        } finally {
            setIsLoading(false);
        }
    }, [auth, options]);

    const connectTerminal = React.useCallback(async () => {
        if (await checkScannerPermissions()) {
            CameraView.launchScanner({
                barcodeTypes: ['qr']
            });
        } else {
            Modal.alert(t('common.error'), t('modals.cameraPermissionsRequiredToConnectTerminal'), [{ text: t('common.ok') }]);
        }
    }, [checkScannerPermissions]);

    const connectWithUrl = React.useCallback(async (data: string) => {
        return await processAuthUrl(data);
    }, [processAuthUrl]);

    // Listen for barcode scans from the native scanner
    React.useEffect(() => {
        if (CameraView.isModernBarcodeScannerAvailable) {
            const subscription = CameraView.onModernBarcodeScanned(async (event) => {
                // Try to parse every scanned code as P2P payload
                const payload = parseP2PQRCode(event.data);
                if (payload) {
                    if (Platform.OS === 'ios') {
                        await CameraView.dismissScanner();
                    }
                    await processAuthUrl(event.data);
                }
            });
            return () => {
                subscription.remove();
            };
        }
    }, [processAuthUrl]);

    return {
        connectTerminal,
        connectWithUrl,
        isLoading,
        processAuthUrl
    };
}
