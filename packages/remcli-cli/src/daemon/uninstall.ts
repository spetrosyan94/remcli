import { logger } from '@/ui/logger';
import { uninstall as uninstallMac } from './mac/uninstall';
import { uninstallLinuxSystemdAutostart } from './autostart/linuxSystemd';
import { createWindowsTaskSchedulerAutostart } from './autostart/windowsTaskScheduler';

export async function uninstallDaemonAutostart(): Promise<void> {
    if (process.platform === 'linux') {
        await uninstallLinuxSystemdAutostart();
        logger.info('Remcli systemd user autostart removed (or was not installed).');
        return;
    }

    if (process.platform === 'win32') {
        await createWindowsTaskSchedulerAutostart().uninstall();
        logger.info('Remcli Task Scheduler autostart removed.');
        return;
    }

    throw new Error(`User-level daemon autostart is not supported on ${process.platform}`);
}

export async function uninstall(): Promise<void> {
    if (process.platform === 'linux' || process.platform === 'win32') {
        await uninstallDaemonAutostart();
        return;
    }

    if (process.platform !== 'darwin') {
        throw new Error(`Daemon autostart is not supported on ${process.platform}`);
    }
    
    if (process.getuid && process.getuid() !== 0) {
        throw new Error('Daemon uninstallation requires sudo privileges. Please run with sudo.');
    }
    
    logger.info('Uninstalling Remcli daemon for macOS...');
    await uninstallMac();
}
