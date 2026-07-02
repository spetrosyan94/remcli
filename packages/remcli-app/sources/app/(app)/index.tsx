import { RoundButton } from "@/components/RoundButton";
import { useAuth } from "@/auth/AuthContext";
import { Text, View, Image, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as React from 'react';
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsLandscape } from "@/utils/responsive";
import { Typography } from "@/constants/Typography";
import { HomeHeaderNotAuth } from "@/components/HomeHeader";
import { MainView } from "@/components/MainView";
import { useConnectTerminal } from "@/hooks/useConnectTerminal";
import { Modal } from "@/modal";
import { t } from '@/text';

export default function Home() {
    const auth = useAuth();
    if (!auth.isAuthenticated) {
        return <NotAuthenticated />;
    }
    return (
        <Authenticated />
    )
}

function Authenticated() {
    return <MainView variant="phone" />;
}

function NotAuthenticated() {
    const { theme } = useUnistyles();
    const isLandscape = useIsLandscape();
    const insets = useSafeAreaInsets();
    const isMobile = Platform.OS === 'android' || Platform.OS === 'ios';
    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal();

    // Manual URL entry — fallback for connecting a terminal without scanning
    // (the only option on web, where the camera scanner is unavailable).
    const enterUrlManually = async () => {
        const url = await Modal.prompt(
            t('modals.authenticateTerminal'),
            t('modals.pasteUrlFromTerminal'),
            {
                placeholder: 'remcli://terminal?...',
                cancelText: t('common.cancel'),
                confirmText: t('common.authenticate')
            }
        );
        if (url?.trim()) {
            connectWithUrl(url.trim());
        }
    };

    const connectButtons = isMobile ? (
        <>
            <View style={styles.buttonContainer}>
                <RoundButton
                    title={t('connectButton.authenticate')}
                    onPress={connectTerminal}
                    loading={isLoading}
                />
            </View>
            <View style={styles.buttonContainerSecondary}>
                <RoundButton
                    size="normal"
                    title={t('connect.enterUrlManually')}
                    onPress={enterUrlManually}
                    display="inverted"
                />
            </View>
        </>
    ) : (
        <View style={styles.buttonContainer}>
            <RoundButton
                title={t('connect.enterUrlManually')}
                onPress={enterUrlManually}
                loading={isLoading}
            />
        </View>
    );

    const landscapeConnectButtons = isMobile ? (
        <>
            <View style={styles.landscapeButtonContainer}>
                <RoundButton
                    title={t('connectButton.authenticate')}
                    onPress={connectTerminal}
                    loading={isLoading}
                />
            </View>
            <View style={styles.landscapeButtonContainerSecondary}>
                <RoundButton
                    size="normal"
                    title={t('connect.enterUrlManually')}
                    onPress={enterUrlManually}
                    display="inverted"
                />
            </View>
        </>
    ) : (
        <View style={styles.landscapeButtonContainer}>
            <RoundButton
                title={t('connect.enterUrlManually')}
                onPress={enterUrlManually}
                loading={isLoading}
            />
        </View>
    );

    const portraitLayout = (
        <View style={styles.portraitContainer}>
            <Image
                source={theme.dark ? require('@/assets/images/logotype-light.png') : require('@/assets/images/logotype-dark.png')}
                resizeMode="contain"
                style={styles.logo}
            />
            <Text style={styles.title}>
                {t('welcome.title')}
            </Text>
            <Text style={styles.subtitle}>
                {t('welcome.subtitle')}
            </Text>
            {connectButtons}
        </View>
    );

    const landscapeLayout = (
        <View style={[styles.landscapeContainer, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.landscapeInner}>
                <View style={styles.landscapeLogoSection}>
                    <Image
                        source={theme.dark ? require('@/assets/images/logotype-light.png') : require('@/assets/images/logotype-dark.png')}
                        resizeMode="contain"
                        style={styles.logo}
                    />
                </View>
                <View style={styles.landscapeContentSection}>
                    <Text style={styles.landscapeTitle}>
                        {t('welcome.title')}
                    </Text>
                    <Text style={styles.landscapeSubtitle}>
                        {t('welcome.subtitle')}
                    </Text>
                    {landscapeConnectButtons}
                </View>
            </View>
        </View>
    );

    return (
        <>
            <HomeHeaderNotAuth />
            {isLandscape ? landscapeLayout : portraitLayout}
        </>
    )
}

const styles = StyleSheet.create((theme) => ({
    // NotAuthenticated styles
    portraitContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    logo: {
        width: 300,
        height: 90,
    },
    title: {
        marginTop: 16,
        textAlign: 'center',
        fontSize: 24,
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 18,
        color: theme.colors.textSecondary,
        marginTop: 16,
        textAlign: 'center',
        marginHorizontal: 24,
        marginBottom: 64,
    },
    buttonContainer: {
        maxWidth: 280,
        width: '100%',
        marginBottom: 16,
    },
    buttonContainerSecondary: {
    },
    // Landscape styles
    landscapeContainer: {
        flexBasis: 0,
        flexGrow: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 48,
    },
    landscapeInner: {
        flexGrow: 1,
        flexBasis: 0,
        maxWidth: 800,
        flexDirection: 'row',
    },
    landscapeLogoSection: {
        flexBasis: 0,
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingRight: 24,
    },
    landscapeContentSection: {
        flexBasis: 0,
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingLeft: 24,
    },
    landscapeTitle: {
        textAlign: 'center',
        fontSize: 24,
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    landscapeSubtitle: {
        ...Typography.default(),
        fontSize: 18,
        color: theme.colors.textSecondary,
        marginTop: 16,
        textAlign: 'center',
        marginBottom: 32,
        paddingHorizontal: 16,
    },
    landscapeButtonContainer: {
        width: 280,
        marginBottom: 16,
    },
    landscapeButtonContainerSecondary: {
        width: 280,
    },
}));