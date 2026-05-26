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
import { LIFECYCLE_STATES } from './appliesToValidator';
import { ICONS } from './iconNames';

// Re-export LIFECYCLE_STATES for backwards compatibility
export { LIFECYCLE_STATES };

export const KEYBOARD_SHORTCUTS = [
    'shift', 'ctrl', 'alt', 'option', 'cmd', 'win', 'up', 'down', 'left', 'right', 'space', 'tab', 'enter', 'esc', 'backspace', 'del', 'ins', 'pageup', 'pagedown', 'home', 'end', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12', 'plus', 'fn', 'pipe'
];

export const APPLIES_TO_KEYS = [
    'stack', 'deployment', 'serverless', 'product',
    'ece', 'eck', 'ech', 'ess', 'self',
    'elasticsearch', 'observability', 'security',
    'ecctl', 'curator',
    'apm_agent_android', 'apm_agent_dotnet', 'apm_agent_go', 'apm_agent_ios',
    'apm_agent_java', 'apm_agent_node', 'apm_agent_php', 'apm_agent_python',
    'apm_agent_ruby', 'apm_agent_rum',
    'edot_ios', 'edot_android', 'edot_dotnet', 'edot_java', 'edot_node',
    'edot_php', 'edot_python', 'edot_cf_aws', 'edot_cf_azure', 'edot_cf_gcp', 'edot_collector'
];

export class RoleCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
        try {
            const lineText = document.lineAt(position).text;
            const textBefore = lineText.substring(0, position.character);
        
        // Check for {icon}` pattern
        if (textBefore.endsWith('{icon}`')) {
            return this.getIconCompletions();
        }

        // Check for {kbd}` pattern
        if (textBefore.endsWith('{kbd}`')) {
            return this.getKeyboardCompletions();
        }

        // Check for {applies_to}` pattern
        if (textBefore.endsWith('{applies_to}`')) {
            return this.getAppliesToCompletions();
        }

        // Check for incomplete {icon, {kbd, or {applies_to
        if (textBefore.match(/\{(icon|kbd|applies_to)$/)) {
            const roleType = textBefore.match(/\{(icon|kbd|applies_to)$/)?.[1];
            if (roleType === 'icon') {
                return this.getRoleCompletion('icon', 'Insert icon role');
            } else if (roleType === 'kbd') {
                return this.getRoleCompletion('kbd', 'Insert keyboard shortcut role');
            } else if (roleType === 'applies_to') {
                return this.getRoleCompletion('applies_to', 'Insert applies_to role');
            }
        }
            
            return [];
        } catch (error) {
            // If there's an error during completion, return empty array to avoid breaking the editor
            return [];
        }
    }
    
    private getRoleCompletion(roleType: string, description: string): vscode.CompletionItem[] {
        const item = new vscode.CompletionItem(
            `{${roleType}}`,
            vscode.CompletionItemKind.Function
        );

        let sampleValue = 'enter';
        if (roleType === 'icon') {
            sampleValue = 'check';
        } else if (roleType === 'applies_to') {
            sampleValue = 'stack: ga 9.0';
        }

        item.insertText = new vscode.SnippetString(`{${roleType}}\`\${1:${sampleValue}}\``);
        item.detail = description;
        item.documentation = new vscode.MarkdownString(`Insert ${roleType} role with sample value`);

        return [item];
    }
    
    private getIconCompletions(): vscode.CompletionItem[] {
        return ICONS.map(icon => {
            const item = new vscode.CompletionItem(
                icon,
                vscode.CompletionItemKind.Value
            );
            
            item.insertText = icon;
            item.detail = 'Icon name';
            item.documentation = new vscode.MarkdownString(`Insert ${icon} icon`);
            
            return item;
        });
    }
    
    private getKeyboardCompletions(): vscode.CompletionItem[] {
        const completions: vscode.CompletionItem[] = [];
        
        // Add predefined keyboard shortcuts
        KEYBOARD_SHORTCUTS.forEach(key => {
            const item = new vscode.CompletionItem(
                key,
                vscode.CompletionItemKind.Value
            );
            
            item.insertText = key;
            item.detail = 'Keyboard key';
            item.documentation = new vscode.MarkdownString(`Insert ${key} key`);
            
            completions.push(item);
        });
        
        // Add common combinations
        const combinations = [
            'cmd+c', 'cmd+v', 'cmd+x', 'cmd+z', 'cmd+shift+z',
            'ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+z', 'ctrl+y',
            'ctrl|cmd + c', 'ctrl|cmd + v', 'shift+enter'
        ];
        
        combinations.forEach(combo => {
            const item = new vscode.CompletionItem(
                combo,
                vscode.CompletionItemKind.Value
            );
            
            item.insertText = combo;
            item.detail = 'Keyboard combination';
            item.documentation = new vscode.MarkdownString(`Insert ${combo} key combination`);
            
            completions.push(item);
        });
        
        return completions;
    }

    private getAppliesToCompletions(): vscode.CompletionItem[] {
        const completions: vscode.CompletionItem[] = [];

        // Add product/deployment keys with lifecycle states
        APPLIES_TO_KEYS.forEach(key => {
            LIFECYCLE_STATES.forEach(state => {
                const item = new vscode.CompletionItem(
                    `${key}: ${state}`,
                    vscode.CompletionItemKind.Value
                );

                item.insertText = `${key}: ${state}`;
                item.detail = `${key} - ${state}`;
                item.documentation = new vscode.MarkdownString(`Insert \`${key}: ${state}\` applies_to value`);
                item.sortText = `1-${key}-${state}`;

                completions.push(item);
            });
        });

        // Add common patterns with version numbers (new syntax)
        const commonPatterns = [
            // Greater than or equal (explicit)
            { pattern: 'stack: ga 9.1+', description: 'GA from 9.1 and later' },
            { pattern: 'stack: preview 9.0+', description: 'Preview from 9.0 and later' },
            // Version ranges
            { pattern: 'stack: preview 9.0-9.1', description: 'Preview from 9.0 to 9.1' },
            { pattern: 'stack: ga 9.2+, preview 9.0-9.1', description: 'GA from 9.2+, Preview 9.0-9.1' },
            // Exact versions
            { pattern: 'stack: ga =9.1', description: 'GA in exactly 9.1' },
            { pattern: 'stack: beta =9.0', description: 'Beta in exactly 9.0' },
            // Simple patterns
            { pattern: 'serverless: ga', description: 'GA in Serverless' },
            { pattern: 'edot_collector: ga 9.2+', description: 'EDOT Collector GA from 9.2+' },
            { pattern: 'edot_java: ga 1.0+', description: 'EDOT Java GA from 1.0+' }
        ];

        commonPatterns.forEach(({ pattern, description }) => {
            const item = new vscode.CompletionItem(
                pattern,
                vscode.CompletionItemKind.Snippet
            );

            item.insertText = pattern;
            item.detail = description;
            item.documentation = new vscode.MarkdownString(`Insert applies_to pattern: \`${pattern}\``);
            item.sortText = `0-${pattern}`;

            completions.push(item);
        });

        return completions;
    }
}