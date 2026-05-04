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

const MCP_SERVER_URL = 'https://www.elastic.co/docs/_mcp/';
const MCP_SERVER_NAME = 'elastic-docs';
const MCP_DOCS_URL = 'https://docs-v3-preview.elastic.dev/elastic/docs-builder/tree/main/mcp';
const DISMISSED_KEY = 'mcpInstallDismissed';

// Cursor deeplink that triggers the native MCP install prompt (server is enabled on accept)
// The config payload is base64-encoded: {"url":"https://www.elastic.co/docs/_mcp/"}
const CURSOR_DEEPLINK = 'cursor://anysphere.cursor-deeplink/mcp/install?name=elastic-docs&config=eyJ1cmwiOiJodHRwczovL3d3dy5lbGFzdGljLmNvL2RvY3MvX21jcC8ifQ==';

// VS Code deeplink (requires VS Code 1.99+ with GitHub Copilot agent mode)
const VSCODE_DEEPLINK = 'vscode:mcp/install?%7B%22name%22%3A%22elastic-docs%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fwww.elastic.co%2Fdocs%2F_mcp%2F%22%7D';

type EditorKind = 'cursor' | 'vscode' | 'other';

interface McpConfigInfo {
    editorKind: EditorKind;
    configDir: string;
    configFileName: string;
    serversKey: string;
    serverEntry: Record<string, unknown>;
}

/**
 * Checks whether the Elastic Docs MCP server is configured for the current
 * editor (Cursor or VS Code) and offers to install it via a notification popup.
 */
export class McpInstallChecker {
    private static instance: McpInstallChecker;
    private globalState: vscode.Memento;

    private constructor(globalState: vscode.Memento) {
        this.globalState = globalState;
    }

    public static getInstance(context: vscode.ExtensionContext): McpInstallChecker {
        if (!McpInstallChecker.instance) {
            McpInstallChecker.instance = new McpInstallChecker(context.globalState);
        }
        return McpInstallChecker.instance;
    }

    /**
     * Check whether the MCP server is configured and prompt to install if not.
     * Designed to be non-blocking and fail silently during activation.
     */
    public async checkAndPrompt(): Promise<void> {
        if (isWeb) {
            outputChannel.appendLine('MCP install check: Skipping in web environment');
            return;
        }

        try {
            if (this.globalState.get<boolean>(DISMISSED_KEY)) {
                outputChannel.appendLine('MCP install check: User previously dismissed, skipping');
                return;
            }

            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                outputChannel.appendLine('MCP install check: No workspace folder open, skipping');
                return;
            }

            const configInfo = this.getConfigInfo();
            const isConfigured = await this.isMcpConfigured(workspaceFolder.uri, configInfo);

            if (isConfigured) {
                outputChannel.appendLine('MCP install check: Elastic Docs MCP server is already configured');
                return;
            }

            outputChannel.appendLine('MCP install check: Elastic Docs MCP server not found, prompting user');
            await this.showInstallNotification(workspaceFolder.uri, configInfo);
        } catch (err) {
            outputChannel.appendLine(`MCP install check error: ${err}`);
        }
    }

    private getEditorKind(): EditorKind {
        const appName = (vscode.env.appName || '').toLowerCase();
        if (appName.includes('cursor')) {
            return 'cursor';
        }
        if (appName.includes('visual studio code') || appName.includes('vscode')) {
            return 'vscode';
        }
        return 'other';
    }

    private getConfigInfo(): McpConfigInfo {
        const editorKind = this.getEditorKind();

        if (editorKind === 'cursor') {
            return {
                editorKind,
                configDir: '.cursor',
                configFileName: 'mcp.json',
                serversKey: 'mcpServers',
                serverEntry: {
                    url: MCP_SERVER_URL
                }
            };
        }

        // VS Code and unknown forks both use the .vscode convention
        return {
            editorKind,
            configDir: '.vscode',
            configFileName: 'mcp.json',
            serversKey: 'servers',
            serverEntry: {
                type: 'http',
                url: MCP_SERVER_URL
            }
        };
    }

    /**
     * Check whether the elastic-docs MCP server is already present in any
     * of the supported config locations for the detected editor.
     */
    private async isMcpConfigured(workspaceUri: vscode.Uri, configInfo: McpConfigInfo): Promise<boolean> {
        // Check workspace-level config file (.cursor/mcp.json or .vscode/mcp.json)
        if (await this.checkConfigFile(
            vscode.Uri.joinPath(workspaceUri, configInfo.configDir, configInfo.configFileName),
            configInfo.serversKey
        )) {
            outputChannel.appendLine('MCP install check: Found in workspace config file');
            return true;
        }

        // Check user-level config file (e.g. ~/.cursor/mcp.json)
        const userConfigPath = this.getUserConfigPath(configInfo);
        if (userConfigPath) {
            if (await this.checkConfigFile(
                vscode.Uri.file(userConfigPath),
                configInfo.serversKey
            )) {
                outputChannel.appendLine('MCP install check: Found in user-level config file');
                return true;
            }
        }

        // Check VS Code settings API (covers user, workspace, and folder settings.json)
        if (this.checkVscodeSettings()) {
            outputChannel.appendLine('MCP install check: Found in VS Code settings');
            return true;
        }

        return false;
    }

    private async checkConfigFile(configUri: vscode.Uri, serversKey: string): Promise<boolean> {
        try {
            const fileContent = await vscode.workspace.fs.readFile(configUri);
            const json = JSON.parse(Buffer.from(fileContent).toString('utf8'));

            const servers = json[serversKey];
            return servers && typeof servers === 'object' && MCP_SERVER_NAME in servers;
        } catch {
            return false;
        }
    }

    /**
     * Check VS Code's settings.json for the MCP server (the `mcp.servers` key).
     * This covers user-level, workspace-level, and folder-level settings,
     * which is where the VS Code deeplink installs servers.
     */
    private checkVscodeSettings(): boolean {
        try {
            const mcpConfig = vscode.workspace.getConfiguration('mcp');
            const servers = mcpConfig.get<Record<string, unknown>>('servers');
            if (servers && typeof servers === 'object' && MCP_SERVER_NAME in servers) {
                return true;
            }

            // Cursor uses "mcpServers" in settings as well
            const mcpServers = mcpConfig.get<Record<string, unknown>>('mcpServers');
            if (mcpServers && typeof mcpServers === 'object' && MCP_SERVER_NAME in mcpServers) {
                return true;
            }

            return false;
        } catch {
            return false;
        }
    }

    /**
     * Return the absolute path to the user-level MCP config file, or null
     * if it cannot be determined (e.g. in a web environment).
     */
    private getUserConfigPath(configInfo: McpConfigInfo): string | null {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const os = require('os');
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const path = require('path');

            const homeDir: string = os.homedir();

            if (configInfo.editorKind === 'cursor') {
                return path.join(homeDir, '.cursor', configInfo.configFileName);
            }

            // VS Code doesn't have a standard user-level mcp.json path;
            // its user-level MCP servers live in settings.json which we
            // cannot easily parse here, so we skip user-level for VS Code.
            return null;
        } catch {
            return null;
        }
    }

    private async showInstallNotification(workspaceUri: vscode.Uri, configInfo: McpConfigInfo): Promise<void> {
        const editorLabels: Record<EditorKind, string> = {
            cursor: 'Cursor',
            vscode: 'VS Code',
            other: vscode.env.appName || 'your editor'
        };
        const editorLabel = editorLabels[configInfo.editorKind];
        const hasDeeplink = configInfo.editorKind === 'cursor' || configInfo.editorKind === 'vscode';

        const message = `The Elastic Docs MCP server is not configured for ${editorLabel}. Install it to enable AI-assisted documentation tools.`;

        const learnMoreAction = 'Learn More';
        const dismissAction = "Don't Show Again";

        // Only show the one-click "Install" button for editors with a known deeplink
        const actions = hasDeeplink
            ? ['Install', learnMoreAction, dismissAction]
            : [learnMoreAction, dismissAction];

        const selection = await vscode.window.showInformationMessage(message, ...actions);

        if (selection === 'Install') {
            await this.triggerInstall(configInfo);
        } else if (selection === learnMoreAction) {
            await vscode.env.openExternal(vscode.Uri.parse(MCP_DOCS_URL));
        } else if (selection === dismissAction) {
            await this.globalState.update(DISMISSED_KEY, true);
            outputChannel.appendLine('MCP install check: User dismissed, will not prompt again');
        }
    }

    /**
     * Trigger the native MCP install flow via the editor's deeplink protocol.
     * Only called for editors with a known deeplink (Cursor, VS Code).
     */
    private async triggerInstall(configInfo: McpConfigInfo): Promise<void> {
        try {
            const deeplink = configInfo.editorKind === 'cursor' ? CURSOR_DEEPLINK : VSCODE_DEEPLINK;
            outputChannel.appendLine(`MCP install: Opening ${configInfo.editorKind} deeplink`);
            await vscode.env.openExternal(vscode.Uri.parse(deeplink));
        } catch (err) {
            outputChannel.appendLine(`MCP install error: ${err}`);
            vscode.window.showErrorMessage(
                `Failed to open the MCP install prompt. You can install manually — see: ${MCP_DOCS_URL}`
            );
        }
    }

    /**
     * Simulate the install notification for testing purposes.
     */
    public async simulateInstallNotification(): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showWarningMessage('No workspace folder open.');
            return;
        }
        outputChannel.appendLine('MCP install check: Simulating install notification for testing');
        const configInfo = this.getConfigInfo();
        await this.showInstallNotification(workspaceFolder.uri, configInfo);
    }
}
