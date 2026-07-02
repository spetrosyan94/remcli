/**
 * Copies the remcli-web client build (packages/remcli-web/dist) into web-dist/
 * so the published `remcli` package can serve the web client from the daemon.
 *
 * Non-fatal when the web build is absent (e.g. CI smoke tests that only build
 * the CLI) — the daemon falls back with a runtime warning in that case.
 */
const { existsSync, rmSync, cpSync } = require('fs');
const { join, resolve } = require('path');

const pkgRoot = resolve(__dirname, '..');
const source = resolve(pkgRoot, '../remcli-web/dist');
const target = join(pkgRoot, 'web-dist');

if (!existsSync(join(source, 'index.html'))) {
    console.warn(`[copy-web-dist] Web client build not found at ${source} — skipping.`);
    console.warn('[copy-web-dist] Run "npm -w remcli-web run build" first to bundle the web client into the package.');
    process.exit(0);
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`[copy-web-dist] Copied web client build to ${target}`);
