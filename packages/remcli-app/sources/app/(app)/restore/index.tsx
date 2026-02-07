import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { StyleSheet } from 'react-native-unistyles';

const stylesheet = StyleSheet.create((theme) => ({
    scrollView: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    container: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: 24,
    },
    contentWrapper: {
        width: '100%',
        maxWidth: layout.maxWidth,
        paddingVertical: 24,
    },
    instructionText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        marginBottom: 20,
        ...Typography.default(),
    },
}));

export default function Restore() {
    const styles = stylesheet;
    const router = useRouter();

    return (
        <ScrollView style={styles.scrollView}>
            <View style={styles.container}>
                <View style={styles.contentWrapper}>
                    <Text style={styles.instructionText}>
                        {t('connect.enterSecretKey')}
                    </Text>

                    <RoundButton
                        title={t('navigation.restoreWithSecretKey')}
                        onPress={() => router.push('/restore/manual')}
                    />
                </View>
            </View>
        </ScrollView>
    );
}
