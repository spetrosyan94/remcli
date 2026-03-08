import { Platform, Linking } from 'react-native';
import { Modal } from '@/modal';
import { AudioModule } from 'expo-audio';
import { t } from '@/text';

export interface MicrophonePermissionResult {
    granted: boolean;
    canAskAgain?: boolean;
    /** When true, the failure is due to insecure context (HTTP), not user denial */
    insecureContext?: boolean;
}

// ─── Browser Detection ──────────────────────────────────────────

type WebBrowser = 'safari' | 'chrome' | 'firefox' | 'other';

function detectBrowser(): WebBrowser {
    if (Platform.OS !== 'web' || typeof navigator === 'undefined') return 'other';
    const ua = navigator.userAgent;
    // Safari: has "Safari" but NOT "Chrome" or "CriOS" (Chrome on iOS reports as Safari)
    if (/CriOS/i.test(ua)) return 'chrome';
    if (/Chrome/i.test(ua) && !/Edg/i.test(ua)) return 'chrome';
    if (/FxiOS/i.test(ua) || /Firefox/i.test(ua)) return 'firefox';
    if (/Safari/i.test(ua)) return 'safari';
    return 'other';
}

// ─── Secure Context Check ───────────────────────────────────────

function isSecureContext(): boolean {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return true;
    return window.isSecureContext === true;
}

// ─── Permissions ────────────────────────────────────────────────

/**
 * CRITICAL: Request microphone permissions BEFORE starting any audio session.
 * On web, getUserMedia requires HTTPS (secure context). Over HTTP on LAN IPs
 * navigator.mediaDevices is undefined — we detect this and return a clear error.
 */
export async function requestMicrophonePermission(): Promise<MicrophonePermissionResult> {
    try {
        if (Platform.OS === 'web') {
            if (!isSecureContext() || !navigator.mediaDevices?.getUserMedia) {
                return { granted: false, canAskAgain: false, insecureContext: true };
            }

            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                stream.getTracks().forEach(track => track.stop());
                return { granted: true };
            } catch (error: any) {
                console.error('Web microphone permission denied:', error);
                return { granted: false, canAskAgain: error.name !== 'NotAllowedError' };
            }
        } else {
            const result = await AudioModule.requestRecordingPermissionsAsync();

            if (result.granted) {
                await AudioModule.setAudioModeAsync({
                    allowsRecording: true,
                    playsInSilentMode: true,
                });
                return { granted: true, canAskAgain: result.canAskAgain };
            }

            return { granted: false, canAskAgain: result.canAskAgain };
        }
    } catch (error) {
        console.error('Error requesting microphone permission:', error);
        return { granted: false };
    }
}

/**
 * Check current microphone permission status without prompting
 */
export async function checkMicrophonePermission(): Promise<MicrophonePermissionResult> {
    try {
        if (Platform.OS === 'web') {
            if (!isSecureContext() || !navigator.mediaDevices) {
                return { granted: false, canAskAgain: false, insecureContext: true };
            }

            if ('permissions' in navigator && 'query' in navigator.permissions) {
                try {
                    const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
                    return { granted: result.state === 'granted' };
                } catch {
                    return { granted: false, canAskAgain: true };
                }
            }
            return { granted: false, canAskAgain: true };
        } else {
            const result = await AudioModule.getRecordingPermissionsAsync();
            return { granted: result.granted, canAskAgain: result.canAskAgain };
        }
    } catch (error) {
        console.error('Error checking microphone permission:', error);
        return { granted: false };
    }
}

/**
 * Show appropriate error message when permission is denied.
 * Detects browser and secure context to give precise instructions.
 */
export function showMicrophonePermissionDeniedAlert(canAskAgain: boolean = false, insecureContext: boolean = false) {
    const title = t('microphone.accessRequired');

    if (Platform.OS === 'web') {
        if (insecureContext) {
            Modal.alert(
                title,
                t('microphone.httpsRequired'),
                [{ text: t('common.ok') }]
            );
            return;
        }

        const browser = detectBrowser();
        const messageKey = browser === 'safari'
            ? 'microphone.webInstructionsSafari'
            : browser === 'chrome'
                ? 'microphone.webInstructionsChrome'
                : 'microphone.webInstructionsGeneric';

        Modal.alert(title, t(messageKey), [{ text: t('common.ok') }]);
    } else {
        const message = canAskAgain
            ? t('microphone.grantPermission')
            : t('microphone.enableInSettings');

        Modal.alert(title, message, [
            { text: t('common.cancel'), style: 'cancel' },
            {
                text: t('microphone.openSettings'),
                onPress: () => {
                    Linking.openSettings();
                }
            }
        ]);
    }
}
