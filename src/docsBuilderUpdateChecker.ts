/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *	http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import * as vscode from 'vscode';
import { outputChannel } from './logger';
import { isWeb } from './fileSystem';

const DOCS_BUILDER_INSTALL_URL = 'https://www.elastic.co/docs/contribute-docs/locally';
const GITHUB_RELEASES_PATH = '/repos/elastic/docs-builder/releases?per_page=30';

type SemVer = {
    major: number;
    minor: number;
    patch: number;
    prerelease: string | null;
};

type InstalledVersion = {
    version: string | null;
    rawVersion: string | null;
};

type GitHubRelease = {
    tag_name?: unknown;
    draft?: unknown;
    prerelease?: unknown;
};

// Install commands per platform (from the official docs)
const INSTALL_COMMANDS: Record<string, string> = {
    darwin: 'curl -sL https://ela.st/docs-builder-install | sh',
    linux: 'curl -sL https://ela.st/docs-builder-install | sh',
    win32: "iex (New-Object System.Net.WebClient).DownloadString('https://ela.st/docs-builder-install-win')"
};

/**
 * Checks whether docs-builder is installed and up to date.
 * If not installed, suggests installation. If outdated, offers to update.
 * Compares the locally installed version against the latest GitHub release.
 */
export class DocsBuilderUpdateChecker {
    private static instance: DocsBuilderUpdateChecker;

    private constructor() {}

    public static getInstance(): DocsBuilderUpdateChecker {
        if (!DocsBuilderUpdateChecker.instance) {
            DocsBuilderUpdateChecker.instance = new DocsBuilderUpdateChecker();
        }
        return DocsBuilderUpdateChecker.instance;
    }

    /**
     * Check for docs-builder installation and updates.
     * 
     * @param isManual - If true, shows feedback even when up to date (for command palette usage).
     * 
     * This method is designed to be non-blocking and fail silently:
     * - Runs asynchronously without blocking extension activation.
     * - Any errors (network issues, timeouts, etc.) are logged to the output channel only.
     * - No user-facing error messages are shown on failure (unless invoked manually).
     */
    public async checkForUpdates(isManual: boolean = false): Promise<void> {
        // Skip in web environment - no local file system or shell access
        if (isWeb) {
            outputChannel.appendLine('docs-builder update check: Skipping in web environment');
            return;
        }

        try {
            const installedVersion = await this.getInstalledVersion();

            if (!installedVersion) {
                outputChannel.appendLine('docs-builder update check: Not installed');
                await this.showNotInstalledNotification();
                return;
            }

            if (!installedVersion.version) {
                const rawVersion = installedVersion.rawVersion ? ` (${installedVersion.rawVersion})` : '';
                outputChannel.appendLine(`docs-builder update check: Installed version is not valid semver${rawVersion}`);
                if (isManual) {
                    vscode.window.showWarningMessage(
                        `docs-builder is installed, but its version output is not valid semver${rawVersion}.`
                    );
                }
                return;
            }

            outputChannel.appendLine(`docs-builder update check: Installed version is ${installedVersion.version}`);

            const latestVersion = await this.getLatestGitHubVersion();

            if (!latestVersion) {
                outputChannel.appendLine('docs-builder update check: Could not fetch latest version from GitHub');
                if (isManual) {
                    vscode.window.showWarningMessage(
                        `docs-builder ${installedVersion.version} is installed, but the latest version could not be determined. Check your network connection.`
                    );
                }
                return;
            }

            outputChannel.appendLine(`docs-builder update check: Latest version is ${latestVersion}`);

            if (this.isNewerVersion(latestVersion, installedVersion.version)) {
                outputChannel.appendLine(`docs-builder update check: Update available (${installedVersion.version} -> ${latestVersion})`);
                await this.showUpdateNotification(installedVersion.version, latestVersion);
            } else {
                outputChannel.appendLine('docs-builder update check: Installation is up to date');
                if (isManual) {
                    vscode.window.showInformationMessage(
                        `docs-builder is up to date (${installedVersion.version}).`
                    );
                }
            }
        } catch (err) {
            outputChannel.appendLine(`docs-builder update check error: ${err}`);
        }
    }

    /**
     * Get the installed docs-builder version by running `docs-builder --version`.
     * Parses the version from the last non-empty line of stdout that is valid semver.
     * Returns null only if docs-builder is not installed or not in PATH.
     */
    private async getInstalledVersion(): Promise<InstalledVersion | null> {
        return new Promise((resolve) => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { execFile } = require('child_process');

                execFile('docs-builder', ['--version'], { timeout: 15000 }, (error: Error | null, stdout: string, stderr: string) => {
                    if (error) {
                        outputChannel.appendLine(`docs-builder update check: Failed to run docs-builder --version: ${error.message}`);
                        resolve(null);
                        return;
                    }

                    // The version should be on the last non-empty line of stdout.
                    // Example output:
                    //   info ::e.d.c.tionFileProvider:: ConfigurationSource.Embedded ...
                    //   info ::m.h.Lifetime          :: Application started. ...
                    //   info ::m.h.Lifetime          :: Hosting environment: Production
                    //   info ::m.h.Lifetime          :: Content root path: /some/path
                    //   0.112.0
                    const output = (stdout || '') + (stderr || '');
                    const parsedVersion = this.parseInstalledVersionOutput(output);
                    if (!parsedVersion.version) {
                        outputChannel.appendLine(`docs-builder update check: Could not parse semver from output: ${output}`);
                    }
                    resolve(parsedVersion);
                });
            } catch (err) {
                outputChannel.appendLine(`docs-builder update check: Error spawning process: ${err}`);
                resolve(null);
            }
        });
    }

    /**
     * Fetch the latest release version from the GitHub API.
     * Uses the releases list so drafts and pre-releases are filtered explicitly.
     * Includes a timeout to prevent hanging on slow networks.
     * Fails silently and returns null on any error.
     */
    private async getLatestGitHubVersion(): Promise<string | null> {
        const TIMEOUT_MS = 10000; // 10 second timeout

        return new Promise((resolve) => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const https = require('https');

                const options = {
                    hostname: 'api.github.com',
                    path: GITHUB_RELEASES_PATH,
                    method: 'GET',
                    timeout: TIMEOUT_MS,
                    headers: {
                        'User-Agent': 'elastic-docs-v3-vscode-extension',
                        'Accept': 'application/vnd.github.v3+json'
                    }
                };

                const req = https.request(options, (res: { statusCode?: number; on: (event: string, callback: (chunk: Buffer) => void) => void }) => {
                    let data = '';

                    res.on('data', (chunk: Buffer) => {
                        data += chunk.toString();
                    });

                    res.on('end', () => {
                        try {
                            if (res.statusCode !== 200) {
                                outputChannel.appendLine(`docs-builder update check: GitHub API returned status ${res.statusCode}`);
                                resolve(null);
                                return;
                            }

                            const releases = JSON.parse(data);
                            if (!Array.isArray(releases)) {
                                outputChannel.appendLine('docs-builder update check: GitHub API response was not a release list');
                                resolve(null);
                                return;
                            }

                            for (const release of releases as GitHubRelease[]) {
                                if (release.draft === true || release.prerelease === true || typeof release.tag_name !== 'string') {
                                    continue;
                                }

                                const version = this.parseSemVer(release.tag_name);
                                if (version) {
                                    resolve(this.formatSemVer(version));
                                    return;
                                }
                            }

                            resolve(null);
                        } catch (err) {
                            outputChannel.appendLine(`docs-builder update check: Failed to parse GitHub response: ${err}`);
                            resolve(null);
                        }
                    });
                });

                req.on('timeout', () => {
                    outputChannel.appendLine('docs-builder update check: Request timed out');
                    req.destroy();
                    resolve(null);
                });

                req.on('error', (err: Error) => {
                    outputChannel.appendLine(`docs-builder update check: Failed to fetch from GitHub: ${err.message}`);
                    resolve(null);
                });

                req.end();
            } catch (err) {
                // Catch any synchronous errors during request setup
                outputChannel.appendLine(`docs-builder update check: Error setting up request: ${err}`);
                resolve(null);
            }
        });
    }

    /**
     * Compare two version strings (semver format).
     * Returns true if remoteVersion is newer than localVersion.
     */
    private isNewerVersion(remoteVersion: string, localVersion: string): boolean {
        const remote = this.parseSemVer(remoteVersion);
        const local = this.parseSemVer(localVersion);
        if (!remote || !local) {
            return false;
        }

        for (const key of ['major', 'minor', 'patch'] as const) {
            if (remote[key] > local[key]) return true;
            if (remote[key] < local[key]) return false;
        }

        if (!remote.prerelease && local.prerelease) {
            return true;
        }
        if (remote.prerelease && !local.prerelease) {
            return false;
        }

        return this.comparePrerelease(remote.prerelease, local.prerelease) > 0;
    }

    private parseInstalledVersionOutput(output: string): InstalledVersion {
        const lines = output.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let rawVersion: string | null = null;

        for (let i = lines.length - 1; i >= 0; i--) {
            const exactVersion = this.parseSemVer(lines[i]);
            if (exactVersion) {
                return {
                    version: this.formatSemVer(exactVersion),
                    rawVersion: lines[i]
                };
            }

            const versionLikeMatch = lines[i].match(/\bv?\d+(?:\.\d+){2,}(?:[-+][0-9A-Za-z.-]+)?\b/);
            if (!rawVersion && versionLikeMatch) {
                rawVersion = versionLikeMatch[0];
            }
        }

        return {
            version: null,
            rawVersion
        };
    }

    private parseSemVer(version: string): SemVer | null {
        // docs-builder's native binary currently reports a .NET-style assembly
        // version such as 1.10.0.0. Treat a trailing .0 revision as semver.
        const match = version.trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.0)?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
        if (!match) {
            return null;
        }

        return {
            major: Number(match[1]),
            minor: Number(match[2]),
            patch: Number(match[3]),
            prerelease: match[4] || null
        };
    }

    private formatSemVer(version: SemVer): string {
        const prerelease = version.prerelease ? `-${version.prerelease}` : '';
        return `${version.major}.${version.minor}.${version.patch}${prerelease}`;
    }

    private comparePrerelease(remotePrerelease: string | null, localPrerelease: string | null): number {
        if (remotePrerelease === localPrerelease) {
            return 0;
        }
        if (!remotePrerelease) {
            return 1;
        }
        if (!localPrerelease) {
            return -1;
        }

        const remoteParts = remotePrerelease.split('.');
        const localParts = localPrerelease.split('.');
        const length = Math.max(remoteParts.length, localParts.length);

        for (let i = 0; i < length; i++) {
            const remotePart = remoteParts[i];
            const localPart = localParts[i];

            if (remotePart === undefined) return -1;
            if (localPart === undefined) return 1;
            if (remotePart === localPart) continue;

            const remoteNumeric = /^\d+$/.test(remotePart);
            const localNumeric = /^\d+$/.test(localPart);

            if (remoteNumeric && localNumeric) {
                return Number(remotePart) > Number(localPart) ? 1 : -1;
            }
            if (remoteNumeric) return -1;
            if (localNumeric) return 1;

            return remotePart > localPart ? 1 : -1;
        }

        return 0;
    }

    /**
     * Show a notification when docs-builder is not installed.
     * Offers to open the installation documentation.
     */
    private async showNotInstalledNotification(): Promise<void> {
        const installAction = 'View Install Instructions';

        const selection = await vscode.window.showWarningMessage(
            'docs-builder is not installed. It is required to build and preview Elastic documentation locally.',
            installAction
        );

        if (selection === installAction) {
            await vscode.env.openExternal(vscode.Uri.parse(DOCS_BUILDER_INSTALL_URL));
        }
    }

    /**
     * Show a notification about an available docs-builder update.
     */
    private async showUpdateNotification(installedVersion: string, latestVersion: string): Promise<void> {
        const message = `A new version of docs-builder is available (${latestVersion}). You have ${installedVersion} installed.`;

        const installAction = 'Install';
        const skipAction = 'Skip';

        const selection = await vscode.window.showInformationMessage(
            message,
            installAction,
            skipAction
        );

        if (selection === installAction) {
            await this.runInstallCommand();
        }
    }

    /**
     * Run the appropriate install command in the integrated terminal.
     */
    private async runInstallCommand(): Promise<void> {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const os = require('os');
        const platform: string = os.platform();

        const command = INSTALL_COMMANDS[platform];

        if (!command) {
            vscode.window.showErrorMessage(
                `Unsupported platform for automatic installation: ${platform}. Please visit ${DOCS_BUILDER_INSTALL_URL} for manual installation instructions.`
            );
            return;
        }

        // Create and show terminal
        const terminal = vscode.window.createTerminal({
            name: 'docs-builder Install',
            hideFromUser: false
        });

        terminal.show();
        terminal.sendText(command);

        outputChannel.appendLine(`docs-builder update: Running install command for ${platform}`);
    }

    /**
     * Simulate an update notification for testing purposes.
     * Shows the notification with mock versions regardless of actual installed version.
     */
    public async simulateUpdateNotification(): Promise<void> {
        outputChannel.appendLine('docs-builder update check: Simulating update notification for testing');
        await this.showUpdateNotification('0.100.0', '99.0.0');
    }
}
