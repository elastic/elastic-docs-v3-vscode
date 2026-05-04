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
import { DirectiveCompletionProvider } from './directiveCompletionProvider';
import { ParameterCompletionProvider } from './parameterCompletionProvider';
import { RoleCompletionProvider } from './roleCompletionProvider';
import { DirectiveDiagnosticProvider } from './directiveDiagnosticProvider';
import { SubstitutionCompletionProvider } from './substitutionCompletionProvider';
import { SubstitutionHoverProvider } from './substitutionHoverProvider';
import { FrontmatterCompletionProvider } from './frontmatterCompletionProvider';
import { FrontmatterValidationProvider } from './frontmatterValidationProvider';
import { SubstitutionValidationProvider } from './substitutionValidationProvider';
import { SubstitutionCodeActionProvider } from './substitutionCodeActionProvider';
import { UndefinedSubstitutionValidator } from './undefinedSubstitutionValidator';
import { substitutionCache, initializeSubstitutionsForWeb } from './substitutions';
import { VersionsCache } from './versionsCache';
import { ValeUpdateChecker } from './valeUpdateChecker';
import { DocsBuilderUpdateChecker } from './docsBuilderUpdateChecker';
import { McpInstallChecker } from './mcpInstallChecker';

import { outputChannel } from './logger';
import { performanceLogger } from './performanceLogger';

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(outputChannel);

    // Debug logging
    outputChannel.appendLine('Elastic Docs V3 Utilities: Extension activated');
    outputChannel.appendLine('Registering completion providers...');

    // Initialize versions cache from GitHub (fails silently if unable to fetch)
    const versionsCache = VersionsCache.getInstance();
    versionsCache.initialize().then(() => {
        outputChannel.appendLine('Versions cache initialized from GitHub');
        // Clear substitution cache to ensure versions are picked up
        substitutionCache.clear();
    }).catch(err => {
        outputChannel.appendLine(`Failed to initialize versions cache: ${err}`);
    });

    // Initialize substitutions for web environment (async, non-blocking)
    initializeSubstitutionsForWeb().then(() => {
        outputChannel.appendLine('Substitutions for web environment initialized successfully');
        // Clear any existing cache to ensure fresh substitutions are used
        substitutionCache.clear();
    }).catch(err => {
        outputChannel.appendLine(`Failed to initialize substitutions for web: ${err}`);
    });

    // Check for Vale style guide updates (async, non-blocking)
    const valeUpdateChecker = ValeUpdateChecker.getInstance();
    valeUpdateChecker.checkForUpdates().catch(err => {
        outputChannel.appendLine(`Failed to check for Vale updates: ${err}`);
    });

    // Check for docs-builder installation and updates (async, non-blocking)
    const docsBuilderUpdateChecker = DocsBuilderUpdateChecker.getInstance();
    docsBuilderUpdateChecker.checkForUpdates().catch(err => {
        outputChannel.appendLine(`Failed to check for docs-builder updates: ${err}`);
    });

    // Check for MCP server configuration (async, non-blocking)
    const mcpInstallChecker = McpInstallChecker.getInstance(context);
    mcpInstallChecker.checkAndPrompt().catch(err => {
        outputChannel.appendLine(`Failed to check MCP installation: ${err}`);
    });

    if (vscode.workspace.getConfiguration('elasticDocs').get<boolean>('applyTokenColorCustomizations', false)) {
        applyColorCustomizations();
    }

    // Test grammar loading
    testGrammarLoading();

    // Ensure we're working with markdown files and handle potential conflicts

    // Note: getLanguages() is async, but we'll proceed without this check
    // as the extension should work fine even if markdown support is loaded later

    const directiveProvider = new DirectiveCompletionProvider();
    const parameterProvider = new ParameterCompletionProvider();
    const roleProvider = new RoleCompletionProvider();
    const diagnosticProvider = new DirectiveDiagnosticProvider();
    const substitutionProvider = new SubstitutionCompletionProvider();
    const substitutionHoverProvider = new SubstitutionHoverProvider();
    const frontmatterProvider = new FrontmatterCompletionProvider();
    const frontmatterValidator = new FrontmatterValidationProvider();
    const substitutionValidator = new SubstitutionValidationProvider();
    const undefinedSubstitutionValidator = new UndefinedSubstitutionValidator();
    const substitutionCodeActionProvider = new SubstitutionCodeActionProvider();

    // Register completion providers for markdown files
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { scheme: '*', language: 'markdown', pattern: '**/*.md' },
            directiveProvider,
            ':', '{'
        )
    );

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { scheme: '*', language: 'markdown', pattern: '**/*.md' },
            parameterProvider,
            ':'
        )
    );

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { scheme: '*', language: 'markdown', pattern: '**/*.md' },
            roleProvider,
            '{', '`'
        )
    );

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { scheme: '*', language: 'markdown', pattern: '**/*.md' },
            substitutionProvider,
            '{', '|'
        )
    );
    outputChannel.appendLine('Substitution completion provider registered');

    // Register hover provider for substitution variables
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            { scheme: '*', language: 'markdown', pattern: '**/*.md' },
            substitutionHoverProvider
        )
    );
    outputChannel.appendLine('Substitution hover provider registered');

    // Register code action provider for substitution quick fixes
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { scheme: '*', language: 'markdown', pattern: '**/*.md' },
            substitutionCodeActionProvider,
            {
                providedCodeActionKinds: SubstitutionCodeActionProvider.providedCodeActionKinds
            }
        )
    );
    outputChannel.appendLine('Substitution code action provider registered');

    // Register frontmatter completion provider
    // Trigger on colon for values, space after colon, and other key characters
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { scheme: '*', language: 'markdown', pattern: '**/*.md' },
            frontmatterProvider,
            ':', ' ', '-' // Colon triggers value completion, space triggers after colon, dash for arrays
        )
    );
    outputChannel.appendLine('Frontmatter completion provider registered');

    // Register diagnostic providers
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('elastic-directives');
    const frontmatterDiagnosticCollection = vscode.languages.createDiagnosticCollection('elastic-frontmatter');
    const substitutionDiagnosticCollection = vscode.languages.createDiagnosticCollection('elastic-substitution');
    const undefinedSubDiagnosticCollection = vscode.languages.createDiagnosticCollection('elastic-undefined-sub');
    context.subscriptions.push(diagnosticCollection);
    context.subscriptions.push(frontmatterDiagnosticCollection);
    context.subscriptions.push(substitutionDiagnosticCollection);
    context.subscriptions.push(undefinedSubDiagnosticCollection);

    // PERFORMANCE OPTIMIZATION: Debounced diagnostics update
    let diagnosticsUpdateTimeout: NodeJS.Timeout | undefined;
    const updateDiagnostics = (document: vscode.TextDocument): void => {
        if (document.languageId !== 'markdown') return;

        // Clear existing timeout to debounce rapid updates
        if (diagnosticsUpdateTimeout) {
            clearTimeout(diagnosticsUpdateTimeout);
        }

        // Debounce diagnostics updates by 500ms
        diagnosticsUpdateTimeout = setTimeout(() => {
            try {
                performanceLogger.measureSync(
                    'Extension.updateDiagnostics',
                    () => {
                        try {
                            // Directive diagnostics
                            const diagnostics = diagnosticProvider.provideDiagnostics(document);
                            diagnosticCollection.set(document.uri, diagnostics);
                        } catch (err) {
                            outputChannel.appendLine(`Error in directive diagnostics: ${err}`);
                        }

                        try {
                            // Frontmatter diagnostics
                            const frontmatterDiagnostics = frontmatterValidator.validateDocument(document);
                            frontmatterDiagnosticCollection.set(document.uri, frontmatterDiagnostics);
                        } catch (err) {
                            outputChannel.appendLine(`Error in frontmatter diagnostics: ${err}`);
                        }

                        try {
                            // Substitution diagnostics (suggests using subs instead of literals)
                            const substitutionDiagnostics = substitutionValidator.validateDocument(document);
                            substitutionDiagnosticCollection.set(document.uri, substitutionDiagnostics);
                        } catch (err) {
                            outputChannel.appendLine(`Error in substitution diagnostics: ${err}`);
                        }

                        try {
                            // Undefined substitution diagnostics (warns about undefined subs)
                            const undefinedSubDiagnostics = undefinedSubstitutionValidator.validateDocument(document);
                            undefinedSubDiagnosticCollection.set(document.uri, undefinedSubDiagnostics);
                        } catch (err) {
                            outputChannel.appendLine(`Error in undefined substitution diagnostics: ${err}`);
                        }
                    },
                    { fileName: document.fileName }
                );
            } catch (err) {
                outputChannel.appendLine(`Fatal error in updateDiagnostics: ${err}`);
            }
        }, 500);
    };

    // Initial diagnostics for already open documents
    if (vscode.window.activeTextEditor) {
        try {
            updateDiagnostics(vscode.window.activeTextEditor.document);
        } catch (err) {
            outputChannel.appendLine(`Error updating diagnostics for active editor: ${err}`);
        }
    }

    // Listen for document opens
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(document => {
            try {
                updateDiagnostics(document);
            } catch (err) {
                outputChannel.appendLine(`Error updating diagnostics on document open: ${err}`);
            }
        })
    );

    // Keep diagnostics current while authors type without running validation on every keystroke.
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            try {
                updateDiagnostics(event.document);
            } catch (err) {
                outputChannel.appendLine(`Error updating diagnostics on document change: ${err}`);
            }
        })
    );

    // PERFORMANCE OPTIMIZATION: Single document save listener with smart cache management
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(document => {
            try {
                if (document.fileName.endsWith('docset.yml') || document.fileName.endsWith('_docset.yml')) {
                    // Docset.yml changed - clear cache and re-validate all markdown documents
                    performanceLogger.measureSync(
                        'Extension.docsetFileChanged',
                        () => {
                            substitutionCache.clear();
                            outputChannel.appendLine('Substitution cache cleared due to docset.yml change');

                            // Re-validate all open markdown documents
                            const markdownDocs = vscode.workspace.textDocuments.filter(doc => doc.languageId === 'markdown');
                            markdownDocs.forEach(doc => {
                                try {
                                    updateDiagnostics(doc);
                                } catch (err) {
                                    outputChannel.appendLine(`Error updating diagnostics for ${doc.fileName}: ${err}`);
                                }
                            });
                        },
                        { docsetFile: document.fileName, markdownDocCount: vscode.workspace.textDocuments.filter(doc => doc.languageId === 'markdown').length }
                    );
                } else if (document.languageId === 'markdown') {
                    // Markdown file saved - clear cache for this document since frontmatter might have changed
                    // and update diagnostics for this specific document
                    try {
                        if (substitutionCache.has(document.uri.fsPath)) {
                            substitutionCache.delete(document.uri.fsPath);
                            outputChannel.appendLine(`Substitution cache cleared for ${document.fileName}`);
                        }
                        updateDiagnostics(document);
                    } catch (err) {
                        outputChannel.appendLine(`Error processing markdown save for ${document.fileName}: ${err}`);
                    }
                }
            } catch (err) {
                outputChannel.appendLine(`Error in save document handler: ${err}`);
            }
        })
    );

    // Register command to replace entire line
    context.subscriptions.push(
        vscode.commands.registerCommand('elastic-docs-v3.replaceEntireLine', (template: string) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            const position = editor.selection.active;
            const line = editor.document.lineAt(position.line);

            // Replace the entire line with the template
            const range = new vscode.Range(
                new vscode.Position(position.line, 0),
                new vscode.Position(position.line, line.text.length)
            );

            editor.edit(editBuilder => {
                editBuilder.replace(range, template);
            });
        })
    );

    // Register command to manually refresh versions cache
    context.subscriptions.push(
        vscode.commands.registerCommand('elastic-docs-v3.refreshVersions', async () => {
            try {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Refreshing versions from GitHub...",
                    cancellable: false
                }, async () => {
                    // Clear the cache first to force a fresh fetch
                    versionsCache.clear();

                    // Fetch new versions
                    await versionsCache.initialize();

                    // Clear substitution cache to ensure new versions are picked up
                    substitutionCache.clear();

                    // Re-validate all open markdown documents
                    const markdownDocs = vscode.workspace.textDocuments.filter(doc => doc.languageId === 'markdown');
                    markdownDocs.forEach(doc => updateDiagnostics(doc));
                });

                // Get version count for confirmation message
                const versions = versionsCache.getVersions();
                const count = Object.keys(versions).length;

                vscode.window.showInformationMessage(
                    `Versions cache refreshed successfully! Loaded ${count} version${count !== 1 ? 's' : ''}.`
                );
                outputChannel.appendLine(`Versions cache manually refreshed: ${count} versions loaded`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to refresh versions cache: ${error}`);
                outputChannel.appendLine(`Error refreshing versions cache: ${error}`);
            }
        })
    );

    // Register command to manually check for Vale style guide updates
    context.subscriptions.push(
        vscode.commands.registerCommand('elastic-docs-v3.checkValeUpdates', async () => {
            try {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Checking for Vale style guide updates...",
                    cancellable: false
                }, async () => {
                    await valeUpdateChecker.checkForUpdates();
                });
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to check for Vale updates: ${error}`);
                outputChannel.appendLine(`Error checking for Vale updates: ${error}`);
            }
        })
    );

    // Register command to test Vale update notification (for development/testing)
    context.subscriptions.push(
        vscode.commands.registerCommand('elastic-docs-v3.testValeUpdateNotification', async () => {
            await valeUpdateChecker.simulateUpdateNotification();
        })
    );

    // Register command to manually check for docs-builder updates
    context.subscriptions.push(
        vscode.commands.registerCommand('elastic-docs-v3.checkDocsBuilderUpdates', async () => {
            try {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Checking for docs-builder updates...",
                    cancellable: false
                }, async () => {
                    await docsBuilderUpdateChecker.checkForUpdates(true);
                });
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to check for docs-builder updates: ${error}`);
                outputChannel.appendLine(`Error checking for docs-builder updates: ${error}`);
            }
        })
    );

    // Register command to test docs-builder update notification (for development/testing)
    context.subscriptions.push(
        vscode.commands.registerCommand('elastic-docs-v3.testDocsBuilderUpdateNotification', async () => {
            await docsBuilderUpdateChecker.simulateUpdateNotification();
        })
    );

    // Register command to manually check/install MCP server
    context.subscriptions.push(
        vscode.commands.registerCommand('elastic-docs-v3.checkMcpInstall', async () => {
            await mcpInstallChecker.checkAndPrompt();
        })
    );

    // Register command to test MCP install notification (for development/testing)
    context.subscriptions.push(
        vscode.commands.registerCommand('elastic-docs-v3.testMcpInstallNotification', async () => {
            await mcpInstallChecker.simulateInstallNotification();
        })
    );

    // Periodically refresh versions cache (every hour)
    const refreshInterval = setInterval(() => {
        versionsCache.refreshIfNeeded().then(() => {
            // Clear substitution cache when versions are refreshed
            substitutionCache.clear();
        });
    }, 1000 * 60 * 60); // 1 hour

    // Clean up interval on deactivation
    context.subscriptions.push({
        dispose: () => clearInterval(refreshInterval)
    });

    // PERFORMANCE OPTIMIZATION: Removed debug timeout to reduce overhead
}

function applyColorCustomizations(): void {
    const config = vscode.workspace.getConfiguration('editor');
    const currentCustomizations = config.get('tokenColorCustomizations') as Record<string, unknown> || {};
    const existingRules = (currentCustomizations.textMateRules as Array<{ scope?: string }>) || [];

    // Check if our rules are already applied by looking for a known elastic scope
    const elasticRulesAlreadyApplied = existingRules.some(
        rule => rule.scope && rule.scope.includes('.elastic')
    );

    if (elasticRulesAlreadyApplied) {
        // Rules already exist, skip the expensive settings write
        return;
    }

    // Define our custom color rules
    const elasticRules = [
        {
            "scope": "markup.directive.punctuation.elastic",
            "settings": {
                "foreground": "#569cd6",
                "fontStyle": "bold"
            }
        },
        {
            "scope": "markup.directive.punctuation.brace.elastic",
            "settings": {
                "foreground": "#569cd6",
                "fontStyle": "bold"
            }
        },
        {
            "scope": "markup.directive.name.elastic",
            "settings": {
                "foreground": "#4ec9b0",
                "fontStyle": "bold"
            }
        },
        {
            "scope": "markup.directive.argument.elastic",
            "settings": {
                "foreground": "#ce9178",
                "fontStyle": "italic"
            }
        },
        {
            "scope": "markup.role.name.elastic",
            "settings": {
                "foreground": "#c586c0",
                "fontStyle": "bold"
            }
        },
        {
            "scope": "markup.role.punctuation.elastic",
            "settings": {
                "foreground": "#c586c0"
            }
        },
        {
            "scope": "markup.role.content.elastic",
            "settings": {
                "foreground": "#d7ba7d"
            }
        },
        {
            "scope": "markup.substitution.punctuation.elastic",
            "settings": {
                "foreground": "#569cd6",
                "fontStyle": "bold"
            }
        },
        {
            "scope": "markup.substitution.variable.elastic",
            "settings": {
                "foreground": "#4ec9b0",
                "fontStyle": "bold"
            }
        },
        {
            "scope": "markup.substitution.mutation.pipe.elastic",
            "settings": {
                "foreground": "#d4d4d4",
                "fontStyle": ""
            }
        },
        {
            "scope": "markup.substitution.mutation.operator.elastic",
            "settings": {
                "foreground": "#dcdcaa",
                "fontStyle": "italic"
            }
        }
    ];

    // Merge with existing rules and apply (only on first activation)
    const newRules = [...existingRules, ...elasticRules];

    config.update('tokenColorCustomizations', {
        ...currentCustomizations,
        textMateRules: newRules
    }, vscode.ConfigurationTarget.Global);
}

function testGrammarLoading(): void {
    // PERFORMANCE OPTIMIZATION: Removed debug timeout to reduce overhead
    // Grammar loading is handled automatically by VS Code
}

export function deactivate(): void {}