/**
 * P2P-only hook for linking a new device via QR code scan.
 *
 * Opens the native barcode scanner, parses the scanned QR as a P2P payload,
 * derives the bearer token from the shared secret, and logs in. This is
 * functionally the same as useConnectTerminal but intended for the
 * account/device-linking context.
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

interface UseConnectAccountOptions {
    onSuccess?: () => void;
}

export function useConnectAccount(options?: UseConnectAccountOptions) {
    const auth = useAuth();
    const [isLoading, setIsLoading] = React.useState(false);
    const checkScannerPermissions = useCheckScannerPermissions();

    const processAuthUrl = React.useCallback(async (data: string) => {
        const payload = parseP2PQRCode(data);
        if (!payload) {
            Modal.alert(t('common.error'), t('modals.invalidAuthUrl'), [{ text: t('common.ok') }]);
            return false;
        }

        setIsLoading(true);
        try {
            const { token, secret } = await connectP2P(payload);
            await auth.login(token, encodeBase64(secret));

            Modal.alert(t('common.success'), t('modals.deviceLinkedSuccessfully'), [
                {
                    text: t('common.ok'),
                    onPress: () => options?.onSuccess?.()
                }
            ]);
            return true;
        } catch (e) {
            console.error(e);
            Modal.alert(t('common.error'), t('modals.failedToLinkDevice'), [{ text: t('common.ok') }]);
            return false;
        } finally {
            setIsLoading(false);
        }
    }, [auth, options]);

    const connectAccount = React.useCallback(async () => {
        if (await checkScannerPermissions()) {
            CameraView.launchScanner({
                barcodeTypes: ['qr']
            });
        } else {
            Modal.alert(t('common.error'), t('modals.cameraPermissionsRequiredToScanQr'), [{ text: t('common.ok') }]);
        }
    }, [checkScannerPermissions]);

    const connectWithUrl = React.useCallback(async (data: string) => {
        return await processAuthUrl(data);
    }, [processAuthUrl]);

    // Listen for barcode scans from the native scanner
    React.useEffect(() => {
        if (CameraView.isModernBarcodeScannerAvailable) {
            const subscription = CameraView.onModernBarcodeScanned(async (event) => {
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
        connectAccount,
        connectWithUrl,
        isLoading,
        processAuthUrl
    };
}
