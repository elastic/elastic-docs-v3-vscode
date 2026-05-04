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

            outputChannel.appendLine(`docs-builder update check: Installed version is ${installedVersion}`);

            const latestVersion = await this.getLatestGitHubVersion();

            if (!latestVersion) {
                outputChannel.appendLine('docs-builder update check: Could not fetch latest version from GitHub');
                if (isManual) {
                    vscode.window.showWarningMessage(
                        `docs-builder ${installedVersion} is installed, but the latest version could not be determined. Check your network connection.`
                    );
                }
                return;
            }

            outputChannel.appendLine(`docs-builder update check: Latest version is ${latestVersion}`);

            if (this.isNewerVersion(latestVersion, installedVersion)) {
                outputChannel.appendLine(`docs-builder update check: Update available (${installedVersion} -> ${latestVersion})`);
                await this.showUpdateNotification(installedVersion, latestVersion);
            } else {
                outputChannel.appendLine('docs-builder update check: Installation is up to date');
                if (isManual) {
                    vscode.window.showInformationMessage(
                        `docs-builder is up to date (${installedVersion}).`
                    );
                }
            }
        } catch (err) {
            outputChannel.appendLine(`docs-builder update check error: ${err}`);
        }
    }

    /**
     * Get the installed docs-builder version by running `docs-builder --version`.
     * Parses the version from the last non-empty line of stdout.
     * Returns null if docs-builder is not installed or not in PATH.
     */
    private async getInstalledVersion(): Promise<string | null> {
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

                    // The version is on the last non-empty line of stdout.
                    // Example output:
                    //   info ::e.d.c.tionFileProvider:: ConfigurationSource.Embedded ...
                    //   info ::m.h.Lifetime          :: Application started. ...
                    //   info ::m.h.Lifetime          :: Hosting environment: Production
                    //   info ::m.h.Lifetime          :: Content root path: /some/path
                    //   0.112.0
                    const output = (stdout || '') + (stderr || '');
                    const lines = output.split('\n').map(l => l.trim()).filter(l => l.length > 0);

                    // Find the last line that looks like a version number
                    for (let i = lines.length - 1; i >= 0; i--) {
                        const versionMatch = lines[i].match(/^(\d+\.\d+\.\d+.*)$/);
                        if (versionMatch) {
                            resolve(versionMatch[1]);
                            return;
                        }
                    }

                    outputChannel.appendLine(`docs-builder update check: Could not parse version from output: ${output}`);
                    resolve(null);
                });
            } catch (err) {
                outputChannel.appendLine(`docs-builder update check: Error spawning process: ${err}`);
                resolve(null);
            }
        });
    }

    /**
     * Fetch the latest release version from the GitHub API.
     * Uses the /releases/latest endpoint which excludes drafts and pre-releases.
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
                    path: '/repos/elastic/docs-builder/releases/latest',
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

                            const release = JSON.parse(data);
                            const tagName = release.tag_name;
                            if (tagName) {
                                // Remove leading 'v' if present
                                resolve(tagName.startsWith('v') ? tagName.substring(1) : tagName);
                            } else {
                                resolve(null);
                            }
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
        // Normalize versions by removing 'v' prefix if present
        const remote = remoteVersion.replace(/^v/, '');
        const local = localVersion.replace(/^v/, '');

        const remoteParts = remote.split('.').map(p => parseInt(p, 10) || 0);
        const localParts = local.split('.').map(p => parseInt(p, 10) || 0);

        // Ensure both have at least 3 parts
        while (remoteParts.length < 3) remoteParts.push(0);
        while (localParts.length < 3) localParts.push(0);

        for (let i = 0; i < 3; i++) {
            if (remoteParts[i] > localParts[i]) {
                return true;
            }
            if (remoteParts[i] < localParts[i]) {
                return false;
            }
        }

        return false; // Versions are equal
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
