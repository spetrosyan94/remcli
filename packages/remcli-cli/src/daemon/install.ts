import { logger } from '@/ui/logger';
import {
    getLinuxSystemdAutostartStatus,
    installLinuxSystemdAutostart,
} from './autostart/linuxSystemd';
import {
    createWindowsTaskSchedulerAutostart,
    WINDOWS_AUTOSTART_TASK_NAME,
} from './autostart/windowsTaskScheduler';
import {
    createMacosLaunchAgentAutostart,
    type MacosLaunchAgentAutostart,
} from './autostart/macosLaunchAgent';

export interface DaemonAutostartInstallOptions {
    isTunnelEnabled?: boolean;
}

export interface DaemonAutostartStatus {
    platform: 'darwin' | 'linux' | 'win32';
    state: 'missing' | 'foreign' | 'installed' | 'stale';
    resource: string;
    isTunnelEnabled: boolean;
    details: string[];
}

export interface DaemonAutostartDependencies {
    platform: NodeJS.Platform;
    macosAutostart: MacosLaunchAgentAutostart;
}

const defaultDependencies: DaemonAutostartDependencies = {
    platform: process.platform,
    macosAutostart: createMacosLaunchAgentAutostart(),
};

export async function installDaemonAutostart(
    options: DaemonAutostartInstallOptions = {},
    dependencies: DaemonAutostartDependencies = defaultDependencies,
): Promise<DaemonAutostartStatus> {
    const isTunnelEnabled = options.isTunnelEnabled ?? false;

    if (dependencies.platform === 'linux') {
        const status = await installLinuxSystemdAutostart({ isTunnelEnabled });
        logger.info(`Remcli autostart installed: ${status.unitPath}`);
        return toLinuxStatus(status);
    }

    if (dependencies.platform === 'win32') {
        const autostart = createWindowsTaskSchedulerAutostart();
        await autostart.install(isTunnelEnabled);
        logger.info(`Remcli autostart installed: Task Scheduler / ${WINDOWS_AUTOSTART_TASK_NAME}`);
        return toWindowsStatus(await autostart.getStatus());
    }

    if (dependencies.platform === 'darwin') {
        const status = await dependencies.macosAutostart.install(isTunnelEnabled);
        logger.info(`Remcli autostart installed: ${status.plistPath}`);
        return toMacosStatus(status);
    }

    throw new Error(`User-level daemon autostart is not supported on ${dependencies.platform}`);
}

export async function install(
    options: DaemonAutostartInstallOptions = {},
    dependencies: DaemonAutostartDependencies = defaultDependencies,
): Promise<DaemonAutostartStatus> {
    return installDaemonAutostart(options, dependencies);
}

export async function getDaemonAutostartStatus(
    dependencies: DaemonAutostartDependencies = defaultDependencies,
): Promise<DaemonAutostartStatus> {
    if (dependencies.platform === 'linux') {
        const status = await getLinuxSystemdAutostartStatus();
        return toLinuxStatus(status);
    }

    if (dependencies.platform === 'win32') {
        return toWindowsStatus(await createWindowsTaskSchedulerAutostart().getStatus());
    }

    if (dependencies.platform === 'darwin') {
        return toMacosStatus(await dependencies.macosAutostart.getStatus());
    }

    throw new Error(`Autostart status is not supported on ${dependencies.platform}`);
}

function toLinuxStatus(status: Awaited<ReturnType<typeof getLinuxSystemdAutostartStatus>>): DaemonAutostartStatus {
    return {
        platform: 'linux',
        state: status.state,
        resource: status.unitPath,
        isTunnelEnabled: status.isTunnelEnabled,
        details: [
            ...(status.hasStalePaths ? ['runtime-path'] : []),
            ...(status.hasUnsafePolicy ? ['policy'] : []),
            ...(!status.isEnabled && status.state !== 'missing' && status.state !== 'foreign' ? ['disabled'] : []),
        ],
    };
}

function toWindowsStatus(status: Awaited<ReturnType<ReturnType<typeof createWindowsTaskSchedulerAutostart>['getStatus']>>): DaemonAutostartStatus {
    return {
        platform: 'win32',
        state: status.state === 'owned' ? 'installed' : status.state,
        resource: `Task Scheduler / ${WINDOWS_AUTOSTART_TASK_NAME}`,
        isTunnelEnabled: status.isTunnelEnabled,
        details: status.staleParts,
    };
}

function toMacosStatus(status: Awaited<ReturnType<MacosLaunchAgentAutostart['getStatus']>>): DaemonAutostartStatus {
    return {
        platform: 'darwin',
        state: status.state,
        resource: status.plistPath,
        isTunnelEnabled: status.isTunnelEnabled,
        details: status.staleParts,
    };
}
