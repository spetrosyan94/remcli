import React, { useState, useEffect } from 'react';
import { View, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/RoundButton';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { Ionicons } from '@expo/vector-icons';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { t } from '@/text';
import { parseP2PQRCode, P2PQRPayload } from '@/sync/p2pConnect';

export default function TerminalConnectScreen() {
    const router = useRouter();
    const [p2pPayload, setP2pPayload] = useState<P2PQRPayload | null>(null);
    const [rawData, setRawData] = useState<string | null>(null);
    const [hashProcessed, setHashProcessed] = useState(false);
    const { processAuthUrl, isLoading } = useConnectTerminal({
        onSuccess: () => {
            router.back();
        }
    });

    // Extract P2P payload from hash on web platform
    useEffect(() => {
        if (Platform.OS === 'web' && typeof window !== 'undefined' && !hashProcessed) {
            const hash = window.location.hash;
            if (hash.length > 1) {
                const data = decodeURIComponent(hash.substring(1));
                const payload = parseP2PQRCode(data);
                if (payload) {
                    setP2pPayload(payload);
                    setRawData(data);
                }

                // Clear the hash from URL to prevent exposure in browser history
                window.history.replaceState(null, '', window.location.pathname + window.location.search);
            }
            setHashProcessed(true);
        }
    }, [hashProcessed]);

    const handleConnect = async () => {
        if (rawData) {
            await processAuthUrl(rawData);
        }
    };

    const handleReject = () => {
        router.back();
    };

    // Show placeholder for mobile platforms
    if (Platform.OS !== 'web') {
        return (
            <ItemList>
                <ItemGroup>
                    <View style={{
                        alignItems: 'center',
                        paddingVertical: 32,
                        paddingHorizontal: 16
                    }}>
                        <Ionicons
                            name="laptop-outline"
                            size={64}
                            color="#8E8E93"
                            style={{ marginBottom: 16 }}
                        />
                        <Text style={{
                            ...Typography.default('semiBold'),
                            fontSize: 18,
                            textAlign: 'center',
                            marginBottom: 12
                        }}>
                            {t('terminal.webBrowserRequired')}
                        </Text>
                        <Text style={{
                            ...Typography.default(),
                            fontSize: 14,
                            color: '#666',
                            textAlign: 'center',
                            lineHeight: 20
                        }}>
                            {t('terminal.webBrowserRequiredDescription')}
                        </Text>
                    </View>
                </ItemGroup>
            </ItemList>
        );
    }

    // Show loading state while processing hash
    if (!hashProcessed) {
        return (
            <ItemList>
                <ItemGroup>
                    <View style={{
                        alignItems: 'center',
                        paddingVertical: 32,
                        paddingHorizontal: 16
                    }}>
                        <Text style={{ ...Typography.default(), color: '#666' }}>
                            {t('terminal.processingConnection')}
                        </Text>
                    </View>
                </ItemGroup>
            </ItemList>
        );
    }

    // Show error if no valid P2P payload found
    if (!p2pPayload) {
        return (
            <ItemList>
                <ItemGroup>
                    <View style={{
                        alignItems: 'center',
                        paddingVertical: 32,
                        paddingHorizontal: 16
                    }}>
                        <Ionicons
                            name="warning-outline"
                            size={48}
                            color="#FF3B30"
                            style={{ marginBottom: 16 }}
                        />
                        <Text style={{
                            ...Typography.default('semiBold'),
                            fontSize: 16,
                            color: '#FF3B30',
                            textAlign: 'center',
                            marginBottom: 8
                        }}>
                            {t('terminal.invalidConnectionLink')}
                        </Text>
                        <Text style={{
                            ...Typography.default(),
                            fontSize: 14,
                            color: '#666',
                            textAlign: 'center',
                            lineHeight: 20
                        }}>
                            {t('terminal.invalidConnectionLinkDescription')}
                        </Text>
                    </View>
                </ItemGroup>
            </ItemList>
        );
    }

    // Build display endpoint
    const displayEndpoint = p2pPayload.port === 0
        ? p2pPayload.host
        : `${p2pPayload.host}:${p2pPayload.port}`;

    // Show confirmation screen for valid connection
    return (
        <ItemList>
            {/* Connection Request Header */}
            <ItemGroup>
                <View style={{
                    alignItems: 'center',
                    paddingVertical: 24,
                    paddingHorizontal: 16
                }}>
                    <Ionicons
                        name="terminal-outline"
                        size={48}
                        color="#007AFF"
                        style={{ marginBottom: 16 }}
                    />
                    <Text style={{
                        ...Typography.default('semiBold'),
                        fontSize: 20,
                        textAlign: 'center',
                        marginBottom: 12
                    }}>
                        {t('terminal.connectTerminal')}
                    </Text>
                    <Text style={{
                        ...Typography.default(),
                        fontSize: 14,
                        color: '#666',
                        textAlign: 'center',
                        lineHeight: 20
                    }}>
                        {t('terminal.terminalRequestDescription')}
                    </Text>
                </View>
            </ItemGroup>

            {/* Connection Details */}
            <ItemGroup title={t('terminal.connectionDetails')}>
                <Item
                    title={t('terminal.endpoint')}
                    detail={displayEndpoint}
                    icon={<Ionicons name="server-outline" size={29} color="#007AFF" />}
                    showChevron={false}
                />
                <Item
                    title={t('terminal.encryption')}
                    detail={t('terminal.endToEndEncrypted')}
                    icon={<Ionicons name="lock-closed-outline" size={29} color="#34C759" />}
                    showChevron={false}
                />
            </ItemGroup>

            {/* Action Buttons */}
            <ItemGroup>
                <View style={{
                    paddingHorizontal: 16,
                    paddingVertical: 16,
                    gap: 12
                }}>
                    <RoundButton
                        title={isLoading ? t('terminal.connecting') : t('terminal.acceptConnection')}
                        onPress={handleConnect}
                        size="large"
                        disabled={isLoading}
                        loading={isLoading}
                    />
                    <RoundButton
                        title={t('terminal.reject')}
                        onPress={handleReject}
                        size="large"
                        display="inverted"
                        disabled={isLoading}
                    />
                </View>
            </ItemGroup>

            {/* Security Notice */}
            <ItemGroup
                title={t('terminal.security')}
                footer={t('terminal.securityFooter')}
            >
                <Item
                    title={t('terminal.clientSideProcessing')}
                    subtitle={t('terminal.linkProcessedLocally')}
                    icon={<Ionicons name="shield-checkmark-outline" size={29} color="#34C759" />}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
}
