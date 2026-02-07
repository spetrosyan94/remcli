import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/StyledText';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/RoundButton';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { Ionicons } from '@expo/vector-icons';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { parseP2PQRCode, P2PQRPayload } from '@/sync/p2pConnect';

export default function TerminalScreen() {
    const router = useRouter();
    const searchParams = useLocalSearchParams();
    const { theme } = useUnistyles();

    // Try to reconstruct P2P JSON payload from search params
    const { p2pPayload, rawData } = React.useMemo((): { p2pPayload: P2PQRPayload | null; rawData: string | null } => {
        // Check if search params encode a P2P payload via ?data=<url-encoded-json>
        const dataParam = searchParams.data;
        if (typeof dataParam === 'string') {
            const payload = parseP2PQRCode(dataParam);
            if (payload) {
                return { p2pPayload: payload, rawData: dataParam };
            }
        }

        // Try to reconstruct JSON from individual search params
        if (searchParams.mode === 'p2p' && searchParams.host && searchParams.key) {
            const json = JSON.stringify({
                mode: 'p2p',
                host: searchParams.host,
                port: Number(searchParams.port) || 0,
                key: searchParams.key,
                v: Number(searchParams.v) || 1,
            });
            const payload = parseP2PQRCode(json);
            if (payload) {
                return { p2pPayload: payload, rawData: json };
            }
        }

        return { p2pPayload: null, rawData: null };
    }, [searchParams]);

    const { processAuthUrl, isLoading } = useConnectTerminal({
        onSuccess: () => {
            router.back();
        }
    });

    const handleConnect = async () => {
        if (rawData) {
            await processAuthUrl(rawData);
        }
    };

    const handleReject = () => {
        router.back();
    };

    // Show error if no valid P2P payload found
    if (!p2pPayload) {
        return (
            <>
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
                                color={theme.colors.textDestructive}
                                style={{ marginBottom: 16 }}
                            />
                            <Text style={{
                                ...Typography.default('semiBold'),
                                fontSize: 16,
                                color: theme.colors.textDestructive,
                                textAlign: 'center',
                                marginBottom: 8
                            }}>
                                {t('terminal.invalidConnectionLink')}
                            </Text>
                            <Text style={{
                                ...Typography.default(),
                                fontSize: 14,
                                color: theme.colors.textSecondary,
                                textAlign: 'center',
                                lineHeight: 20
                            }}>
                                {t('terminal.invalidConnectionLinkDescription')}
                            </Text>
                        </View>
                    </ItemGroup>
                </ItemList>
            </>
        );
    }

    // Build display endpoint
    const displayEndpoint = p2pPayload.port === 0
        ? p2pPayload.host
        : `${p2pPayload.host}:${p2pPayload.port}`;

    // Show confirmation screen for valid connection
    return (
        <>
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
                            color={theme.colors.radio.active}
                            style={{ marginBottom: 16 }}
                        />
                        <Text style={{
                            ...Typography.default('semiBold'),
                            fontSize: 20,
                            textAlign: 'center',
                            marginBottom: 12,
                            color: theme.colors.text
                        }}>
                            {t('terminal.connectTerminal')}
                        </Text>
                        <Text style={{
                            ...Typography.default(),
                            fontSize: 14,
                            color: theme.colors.textSecondary,
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
                        icon={<Ionicons name="server-outline" size={29} color={theme.colors.radio.active} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('terminal.encryption')}
                        detail={t('terminal.endToEndEncrypted')}
                        icon={<Ionicons name="lock-closed-outline" size={29} color={theme.colors.success} />}
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
                    footer={t('terminal.securityFooterDevice')}
                >
                    <Item
                        title={t('terminal.clientSideProcessing')}
                        subtitle={t('terminal.linkProcessedOnDevice')}
                        icon={<Ionicons name="shield-checkmark-outline" size={29} color={theme.colors.success} />}
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        </>
    );
}
