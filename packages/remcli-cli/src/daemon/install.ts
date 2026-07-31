import { logger } from '@/ui/logger';
import { install as installMac } from './mac/install';
import {
    getLinuxSystemdAutostartStatus,
    installLinuxSystemdAutostart,
} from './autostart/linuxSystemd';
import {
    createWindowsTaskSchedulerAutostart,
    WINDOWS_AUTOSTART_TASK_NAME,
} from './autostart/windowsTaskScheduler';

export interface DaemonAutostartInstallOptions {
    isTunnelEnabled?: boolean;
}

export interface DaemonAutostartStatus {
    platform: 'linux' | 'win32';
    state: 'missing' | 'foreign' | 'installed' | 'stale';
    resource: string;
    isTunnelEnabled: boolean;
    details: string[];
}

export async function installDaemonAutostart(options: DaemonAutostartInstallOptions = {}): Promise<void> {
    const isTunnelEnabled = options.isTunnelEnabled ?? false;

    if (process.platform === 'linux') {
        const status = await installLinuxSystemdAutostart({ isTunnelEnabled });
        logger.info(`Remcli autostart installed: ${status.unitPath}`);
        return;
    }

    if (process.platform === 'win32') {
        const autostart = createWindowsTaskSchedulerAutostart();
        await autostart.install(isTunnelEnabled);
        logger.info(`Remcli autostart installed: Task Scheduler / ${WINDOWS_AUTOSTART_TASK_NAME}`);
        return;
    }

    throw new Error(`User-level daemon autostart is not supported on ${process.platform}`);
}

export async function install(options: DaemonAutostartInstallOptions = {}): Promise<void> {
    if (process.platform === 'linux' || process.platform === 'win32') {
        await installDaemonAutostart(options);
        return;
    }

    if (process.platform !== 'darwin') {
        throw new Error(`Daemon autostart is not supported on ${process.platform}`);
    }
    
    if (process.getuid && process.getuid() !== 0) {
        throw new Error('Daemon installation requires sudo privileges. Please run with sudo.');
    }
    
    logger.info('Installing Remcli daemon for macOS...');
    await installMac();
}

export async function getDaemonAutostartStatus(): Promise<DaemonAutostartStatus> {
    if (process.platform === 'linux') {
        const status = await getLinuxSystemdAutostartStatus();
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

    if (process.platform === 'win32') {
        const status = await createWindowsTaskSchedulerAutostart().getStatus();
        return {
            platform: 'win32',
            state: status.state === 'owned' ? 'installed' : status.state,
            resource: `Task Scheduler / ${WINDOWS_AUTOSTART_TASK_NAME}`,
            isTunnelEnabled: status.isTunnelEnabled,
            details: status.staleParts,
        };
    }

    throw new Error('Autostart status is currently available for Linux and Windows only');
}
