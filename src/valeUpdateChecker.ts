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

const VALE_RULES_REPO_URL = 'https://github.com/elastic/vale-rules';

// Install script URLs
const INSTALL_SCRIPTS = {
    darwin: 'https://raw.githubusercontent.com/elastic/vale-rules/main/install-macos.sh',
    linux: 'https://raw.githubusercontent.com/elastic/vale-rules/main/install-linux.sh',
    win32: 'https://raw.githubusercontent.com/elastic/vale-rules/main/install-windows.ps1'
};

/**
 * Checks for updates to the Elastic Vale style guide.
 * Compares locally installed version against the latest GitHub release.
 */
export class ValeUpdateChecker {
    private static instance: ValeUpdateChecker;

    private constructor() {}

    public static getInstance(): ValeUpdateChecker {
        if (!ValeUpdateChecker.instance) {
            ValeUpdateChecker.instance = new ValeUpdateChecker();
        }
        return ValeUpdateChecker.instance;
    }

    /**
     * Check for updates and show notification if a newer version is available.
     * Called on extension activation.
     * 
     * This method is designed to be non-blocking and fail silently:
     * - Runs asynchronously without blocking extension activation.
     * - Any errors (network issues, timeouts, etc.) are logged to the output channel only.
     * - No user-facing error messages are shown on failure.
     */
    public async checkForUpdates(): Promise<void> {
        // Skip in web environment - no local file system access
        if (isWeb) {
            outputChannel.appendLine('Vale update check: Skipping in web environment');
            return;
        }

        try {
            const localVersion = this.getLocalVersion();
            
            if (!localVersion) {
                outputChannel.appendLine('Vale update check: No local installation found, skipping');
                return;
            }

            outputChannel.appendLine(`Vale update check: Local version is ${localVersion}`);

            const latestVersion = await this.getLatestGitHubVersion();
            
            if (!latestVersion) {
                outputChannel.appendLine('Vale update check: Could not fetch latest version from GitHub');
                return;
            }

            outputChannel.appendLine(`Vale update check: Latest version is ${latestVersion}`);

            if (this.isNewerVersion(latestVersion, localVersion)) {
                outputChannel.appendLine(`Vale update check: Update available (${localVersion} -> ${latestVersion})`);
                await this.showUpdateNotification(localVersion, latestVersion);
            } else {
                outputChannel.appendLine('Vale update check: Local installation is up to date');
            }
        } catch (err) {
            outputChannel.appendLine(`Vale update check error: ${err}`);
        }
    }

    /**
     * Get the locally installed version from the VERSION file.
     * Returns null if not installed or version file not found.
     */
    private getLocalVersion(): string | null {
        const versionFilePath = this.getVersionFilePath();
        
        if (!versionFilePath) {
            return null;
        }

        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const fs = require('fs');
            
            if (!fs.existsSync(versionFilePath)) {
                return null;
            }

            const version = fs.readFileSync(versionFilePath, 'utf8').trim();
            return version || null;
        } catch {
            return null;
        }
    }

    /**
     * Get the path to the VERSION file based on the current OS.
     */
    private getVersionFilePath(): string | null {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const os = require('os');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('path');
        
        const platform = os.platform();
        const homeDir = os.homedir();

        switch (platform) {
            case 'darwin':
                // macOS: ~/Library/Application Support/vale/styles/Elastic/VERSION
                return path.join(homeDir, 'Library', 'Application Support', 'vale', 'styles', 'Elastic', 'VERSION');
            case 'linux':
                // Linux: ~/.local/share/vale/styles/Elastic/VERSION
                return path.join(homeDir, '.local', 'share', 'vale', 'styles', 'Elastic', 'VERSION');
            case 'win32':
                // Windows: %LOCALAPPDATA%\vale\styles\Elastic\VERSION
                const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
                return path.join(localAppData, 'vale', 'styles', 'Elastic', 'VERSION');
            default:
                outputChannel.appendLine(`Vale update check: Unsupported platform: ${platform}`);
                return null;
        }
    }

    /**
     * Fetch the latest release version from GitHub API.
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
                    path: '/repos/elastic/vale-rules/releases/latest',
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
                                outputChannel.appendLine(`Vale update check: GitHub API returned status ${res.statusCode}`);
                                resolve(null);
                                return;
                            }

                            const release = JSON.parse(data);
                            // tag_name is typically "v1.0.0" format
                            const tagName = release.tag_name;
                            if (tagName) {
                                // Remove leading 'v' if present
                                resolve(tagName.startsWith('v') ? tagName.substring(1) : tagName);
                            } else {
                                resolve(null);
                            }
                        } catch (err) {
                            outputChannel.appendLine(`Vale update check: Failed to parse GitHub response: ${err}`);
                            resolve(null);
                        }
                    });
                });

                req.on('timeout', () => {
                    outputChannel.appendLine('Vale update check: Request timed out');
                    req.destroy();
                    resolve(null);
                });

                req.on('error', (err: Error) => {
                    outputChannel.appendLine(`Vale update check: Failed to fetch from GitHub: ${err.message}`);
                    resolve(null);
                });

                req.end();
            } catch (err) {
                // Catch any synchronous errors during request setup
                outputChannel.appendLine(`Vale update check: Error setting up request: ${err}`);
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
     * Simulate an update notification for testing purposes.
     * Shows the notification with mock versions regardless of actual installed version.
     */
    public async simulateUpdateNotification(): Promise<void> {
        outputChannel.appendLine('Vale update check: Simulating update notification for testing');
        await this.showUpdateNotification('1.0.0', '99.0.0');
    }

    /**
     * Show a notification to the user about the available update.
     */
    private async showUpdateNotification(localVersion: string, latestVersion: string): Promise<void> {
        const message = `A new version of the Elastic Vale style guide is available (v${latestVersion}). You have ${localVersion} installed.`;
        
        const updateAction = 'Update';
        const moreInfoAction = 'More Info';

        const selection = await vscode.window.showInformationMessage(
            message,
            updateAction,
            moreInfoAction
        );

        if (selection === updateAction) {
            await this.runUpdateScript();
        } else if (selection === moreInfoAction) {
            await vscode.env.openExternal(vscode.Uri.parse(VALE_RULES_REPO_URL));
        }
    }

    /**
     * Run the appropriate install script in the integrated terminal.
     */
    private async runUpdateScript(): Promise<void> {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const os = require('os');
        const platform = os.platform();

        let command: string;

        switch (platform) {
            case 'darwin':
                command = `curl -fsSL ${INSTALL_SCRIPTS.darwin} | bash`;
                break;
            case 'linux':
                command = `curl -fsSL ${INSTALL_SCRIPTS.linux} | bash`;
                break;
            case 'win32':
                // For Windows, we download and run the PowerShell script
                command = `powershell -Command "& { Invoke-WebRequest -Uri '${INSTALL_SCRIPTS.win32}' -OutFile '$env:TEMP\\install-vale.ps1'; powershell -ExecutionPolicy Bypass -File '$env:TEMP\\install-vale.ps1' }"`;
                break;
            default:
                vscode.window.showErrorMessage(`Unsupported platform for automatic update: ${platform}. Please visit ${VALE_RULES_REPO_URL} for manual installation instructions.`);
                return;
        }

        // Create and show terminal
        const terminal = vscode.window.createTerminal({
            name: 'Vale Style Guide Update',
            hideFromUser: false
        });
        
        terminal.show();
        terminal.sendText(command);

        outputChannel.appendLine(`Vale update: Running install script for ${platform}`);
    }
}
