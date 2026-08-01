import { logger } from '@/ui/logger';
import { uninstallLinuxSystemdAutostart } from './autostart/linuxSystemd';
import {
    createWindowsTaskSchedulerAutostart,
    WINDOWS_AUTOSTART_TASK_NAME,
} from './autostart/windowsTaskScheduler';
import {
    createMacosLaunchAgentAutostart,
    type MacosLaunchAgentAutostart,
} from './autostart/macosLaunchAgent';
import type { DaemonAutostartStatus } from './install';

export interface DaemonAutostartUninstallDependencies {
    platform: NodeJS.Platform;
    macosAutostart: MacosLaunchAgentAutostart;
}

const defaultDependencies: DaemonAutostartUninstallDependencies = {
    platform: process.platform,
    macosAutostart: createMacosLaunchAgentAutostart(),
};

export async function uninstallDaemonAutostart(
    dependencies: DaemonAutostartUninstallDependencies = defaultDependencies,
): Promise<DaemonAutostartStatus> {
    if (dependencies.platform === 'linux') {
        const status = await uninstallLinuxSystemdAutostart();
        logger.info('Remcli systemd user autostart removed (or was not installed).');
        return {
            platform: 'linux',
            state: status.state,
            resource: status.unitPath,
            isTunnelEnabled: status.isTunnelEnabled,
            details: [],
        };
    }

    if (dependencies.platform === 'win32') {
        const autostart = createWindowsTaskSchedulerAutostart();
        await autostart.uninstall();
        logger.info('Remcli Task Scheduler autostart removed.');
        return {
            platform: 'win32',
            state: 'missing',
            resource: `Task Scheduler / ${WINDOWS_AUTOSTART_TASK_NAME}`,
            isTunnelEnabled: false,
            details: [],
        };
    }

    if (dependencies.platform === 'darwin') {
        const status = await dependencies.macosAutostart.uninstall();
        logger.info('Remcli macOS LaunchAgent autostart removed (or was not installed).');
        return {
            platform: 'darwin',
            state: status.state,
            resource: status.plistPath,
            isTunnelEnabled: status.isTunnelEnabled,
            details: status.staleParts,
        };
    }

    throw new Error(`User-level daemon autostart is not supported on ${dependencies.platform}`);
}

export async function uninstall(
    dependencies: DaemonAutostartUninstallDependencies = defaultDependencies,
): Promise<DaemonAutostartStatus> {
    return uninstallDaemonAutostart(dependencies);
}
