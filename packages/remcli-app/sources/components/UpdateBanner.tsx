import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Item } from './Item';
import { ItemGroup } from './ItemGroup';
import { useUnistyles } from 'react-native-unistyles';
import { useUpdates } from '@/hooks/useUpdates';
import { useNativeUpdate } from '@/hooks/useNativeUpdate';
import { Linking, Platform } from 'react-native';
import { t } from '@/text';

export const UpdateBanner = React.memo(() => {
    const { theme } = useUnistyles();
    const { updateAvailable, reloadApp } = useUpdates();
    const updateUrl = useNativeUpdate();

    // Show native app update banner (highest priority)
    if (updateUrl) {
        const handleOpenStore = async () => {
            try {
                const supported = await Linking.canOpenURL(updateUrl);
                if (supported) {
                    await Linking.openURL(updateUrl);
                }
            } catch (error) {
                console.error('Error opening app store:', error);
            }
        };

        return (
            <ItemGroup>
                <Item
                    title={t('updateBanner.nativeUpdateAvailable')}
                    subtitle={Platform.OS === 'ios' ? t('updateBanner.tapToUpdateAppStore') : t('updateBanner.tapToUpdatePlayStore')}
                    icon={<Ionicons name="download-outline" size={28} color={theme.colors.success} />}
                    showChevron={true}
                    onPress={handleOpenStore}
                />
            </ItemGroup>
        );
    }

    // Show OTA update banner if available
    if (updateAvailable) {
        return (
            <ItemGroup>
                <Item
                    title={t('updateBanner.updateAvailable')}
                    subtitle={t('updateBanner.pressToApply')}
                    icon={<Ionicons name="download-outline" size={28} color={theme.colors.success} />}
                    showChevron={false}
                    onPress={reloadApp}
                />
            </ItemGroup>
        );
    }

    return null;
});
