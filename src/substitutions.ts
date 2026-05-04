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
import { PRODUCTS } from './products';
import { performanceLogger } from './performanceLogger';
import { VersionsCache } from './versionsCache';
import { pathUtils, existsSync, readFileSync, isDirectorySync, isWeb, readFile } from './fileSystem';
import { extractStringRecordField } from './yaml';

interface SubstitutionVariables {
    [key: string]: string;
}

// Centralized cache for substitutions
class SubstitutionCache {
    private cache: Map<string, SubstitutionVariables> = new Map();

    get(key: string): SubstitutionVariables | undefined {
        return this.cache.get(key);
    }

    set(key: string, value: SubstitutionVariables): void {
        this.cache.set(key, value);
    }

    clear(): void {
        this.cache.clear();
    }

    has(key: string): boolean {
        return this.cache.has(key);
    }

    delete(key: string): boolean {
        return this.cache.delete(key);
    }
}

// Export a singleton cache instance
export const substitutionCache = new SubstitutionCache();

// Store for pre-loaded docset files in web environment
const preloadedDocsets = new Map<string, SubstitutionVariables>();
let webInitializationComplete = false;
let webInitializationPromise: Promise<void> | null = null;

/**
 * Initialize substitutions for web environment by pre-loading docset files
 * This should be called during extension activation
 */
export async function initializeSubstitutionsForWeb(): Promise<void> {
    if (!isWeb) {
        return; // Only needed in web environment
    }

    // Return existing promise if already initializing
    if (webInitializationPromise) {
        return webInitializationPromise;
    }

    webInitializationPromise = doInitializeWeb();
    return webInitializationPromise;
}

async function doInitializeWeb(): Promise<void> {
    outputChannel.appendLine('[Substitutions] Initializing for web environment...');

    try {
        // Find all docset.yml files in the workspace
        const docsetFiles = await vscode.workspace.findFiles('**/docset.yml', '**/node_modules/**', 10);
        const _docsetFiles = await vscode.workspace.findFiles('**/_docset.yml', '**/node_modules/**', 10);
        const allDocsetFiles = [...docsetFiles, ..._docsetFiles];

        outputChannel.appendLine(`[Substitutions] Found ${allDocsetFiles.length} docset files in workspace`);

        for (const docsetUri of allDocsetFiles) {
            try {
                outputChannel.appendLine(`[Substitutions] Pre-loading: ${docsetUri.toString()}`);
                const content = await readFile(docsetUri);
                const result = extractStringRecordField(content, 'subs');
                if (Object.keys(result).length > 0) {
                    preloadedDocsets.set(docsetUri.fsPath, result);
                    outputChannel.appendLine(`[Substitutions] Loaded ${Object.keys(result).length} substitutions from ${docsetUri.fsPath}`);
                }
            } catch (error) {
                outputChannel.appendLine(`[Substitutions] Error loading ${docsetUri.toString()}: ${error}`);
            }
        }

        outputChannel.appendLine(`[Substitutions] Web initialization complete. Loaded ${preloadedDocsets.size} docset files.`);
        webInitializationComplete = true;
    } catch (error) {
        outputChannel.appendLine(`[Substitutions] Error during web initialization: ${error}`);
        webInitializationComplete = true; // Mark as complete even on error to avoid hanging
    }
}

/**
 * Resolves a shorthand variable name (e.g., ".elasticsearch") to its full form ("product.elasticsearch")
 * @param variableName The variable name, possibly with shorthand notation
 * @param substitutions The available substitutions
 * @returns The resolved variable name and value, or null if not found
 */
export function resolveShorthand(variableName: string, substitutions: SubstitutionVariables): {
    resolvedName: string;
    value: string;
    isShorthand: boolean;
} | null {
    // Check if it's a shorthand starting with a dot
    if (variableName.startsWith('.')) {
        const productKey = variableName.substring(1); // Remove the leading dot
        const fullForm = `product.${productKey}`;

        if (substitutions[fullForm]) {
            return {
                resolvedName: fullForm,
                value: substitutions[fullForm],
                isShorthand: true
            };
        }
        return null;
    }

    // Not a shorthand, check if it exists as-is
    if (substitutions[variableName]) {
        return {
            resolvedName: variableName,
            value: substitutions[variableName],
            isShorthand: false
        };
    }

    return null;
}

export function getSubstitutions(documentUri: vscode.Uri): SubstitutionVariables {
  return performanceLogger.measureSync(
    'Substitutions.getSubstitutions',
    () => {
      // Check cache first
      const cached = substitutionCache.get(documentUri.fsPath);
      if (cached) {
          return cached;
      }

      const substitutions: SubstitutionVariables = {};

      // Log environment for debugging
      outputChannel.appendLine(`[Substitutions] Environment: ${isWeb ? 'WEB' : 'NODE'}`);
      outputChannel.appendLine(`[Substitutions] Document URI: ${documentUri.toString()}`);

      try {
          // Find all docset.yml files in the workspace
          const docsetFiles = findDocsetFiles(documentUri);
          outputChannel.appendLine(`[Substitutions] Found ${docsetFiles.length} docset files`);

          for (const docsetFile of docsetFiles) {
              outputChannel.appendLine(`[Substitutions] Parsing: ${docsetFile}`);
              const unorderedSubs = parseDocsetFile(docsetFile);
              // Allow all custom substitutions from docset.yml, including product name overrides
              Object.assign(substitutions, unorderedSubs);
          }

      } catch (error) {
          outputChannel.appendLine(`Error reading docset files: ${error}`);
      }

      // Parse frontmatter subs from the current document
      try {
          const frontmatterSubs = parseFrontmatterSubs(documentUri);
          Object.assign(substitutions, frontmatterSubs);
      } catch (error) {
          outputChannel.appendLine(`Error parsing frontmatter subs: ${error}`);
      }

      // Add versions from the remote versions.yml cache
      try {
          const versionsCache = VersionsCache.getInstance();
          const versions = versionsCache.getVersions();
          for (const [key, value] of Object.entries(versions)) {
              substitutions[`version.${key}`] = value;
          }
      } catch (error) {
          // Fail silently as requested
          outputChannel.appendLine(`Error loading versions from cache: ${error}`);
      }

      // Add centralized product name subs
      for (const [key, value] of Object.entries(PRODUCTS)) {
          substitutions[`product.${key}`] = value;
      }

      const orderedKeys = Object.keys(substitutions).sort((a: string, b: string) => {
          return substitutions[b].length - substitutions[a].length;
      });
      const orderedSubs = orderedKeys.reduce(
          (obj: { [key: string]: string }, key: string) => {
              obj[key] = substitutions[key];
              return obj;
          },
          {} as { [key: string]: string }
      );

      // Cache the result before returning
      substitutionCache.set(documentUri.fsPath, orderedSubs);

      return orderedSubs;
    },
    { documentPath: documentUri.fsPath }
  );
}

// PERFORMANCE OPTIMIZATION: Helper functions moved outside main function for better performance
function findDocsetFiles(documentUri: vscode.Uri): string[] {
    return performanceLogger.measureSync(
        'Substitutions.findDocsetFiles',
        () => {
            const docsetFiles: string[] = [];
            
            // In web environment, use preloaded docsets
            if (isWeb) {
                outputChannel.appendLine(`[findDocsetFiles] Web environment - initialization complete: ${webInitializationComplete}`);
                outputChannel.appendLine(`[findDocsetFiles] Using preloaded docsets (${preloadedDocsets.size} available)`);
                
                if (!webInitializationComplete) {
                    outputChannel.appendLine(`[findDocsetFiles] WARNING: Web initialization not complete yet, returning empty list`);
                    return [];
                }
                
                return Array.from(preloadedDocsets.keys());
            }

            const documentPath = documentUri.fsPath;
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);

            outputChannel.appendLine(`[findDocsetFiles] documentPath: ${documentPath}`);
            outputChannel.appendLine(`[findDocsetFiles] workspaceFolder: ${workspaceFolder?.uri.toString()}`);

            if (!workspaceFolder) {
                outputChannel.appendLine(`[findDocsetFiles] No workspace folder found`);
                return docsetFiles;
            }

            const workspaceRoot = workspaceFolder.uri.fsPath;
            outputChannel.appendLine(`[findDocsetFiles] workspaceRoot: ${workspaceRoot}`);
            outputChannel.appendLine(`[findDocsetFiles] isWeb: ${isWeb}`);

            // Define possible docset file names
            const docsetFileNames = ['docset.yml', '_docset.yml'];

            // Check workspace root
            for (const fileName of docsetFileNames) {
                const rootDocsetPath = pathUtils.join(workspaceRoot, fileName);
                outputChannel.appendLine(`[findDocsetFiles] Checking: ${rootDocsetPath}`);
                if (existsSync(rootDocsetPath)) {
                    outputChannel.appendLine(`[findDocsetFiles] Found: ${rootDocsetPath}`);
                    docsetFiles.push(rootDocsetPath);
                } else {
                    outputChannel.appendLine(`[findDocsetFiles] Not found: ${rootDocsetPath}`);
                }
            }

            // Check /docs folder in workspace root
            const docsFolderPath = pathUtils.join(workspaceRoot, 'docs');
            if (existsSync(docsFolderPath) && isDirectorySync(docsFolderPath)) {
                for (const fileName of docsetFileNames) {
                    const docsDocsetPath = pathUtils.join(docsFolderPath, fileName);
                    if (existsSync(docsDocsetPath)) {
                        docsetFiles.push(docsDocsetPath);
                    }
                }
            }

            // Also search upwards from the document location for backward compatibility
            let currentDir = pathUtils.dirname(documentPath);
            while (currentDir && currentDir.startsWith(workspaceRoot)) {
                for (const fileName of docsetFileNames) {
                    const docsetPath = pathUtils.join(currentDir, fileName);
                    if (existsSync(docsetPath)) {
                        docsetFiles.push(docsetPath);
                    }
                }

                const parentDir = pathUtils.dirname(currentDir);
                if (parentDir === currentDir) {
                    break; // Reached root
                }
                currentDir = parentDir;
            }

            // Remove duplicates while preserving order
            return [...new Set(docsetFiles)];
        },
        { documentPath: documentUri.fsPath }
    );
}

function parseDocsetFile(filePath: string): SubstitutionVariables {
    return performanceLogger.measureSync(
        'Substitutions.parseDocsetFile',
        () => {
            try {
                // In web environment, use preloaded data
                if (isWeb) {
                    const preloaded = preloadedDocsets.get(filePath);
                    if (preloaded) {
                        outputChannel.appendLine(`[parseDocsetFile] Using preloaded data for: ${filePath}`);
                        return preloaded;
                    }
                    outputChannel.appendLine(`[parseDocsetFile] No preloaded data for: ${filePath}`);
                    return {};
                }

                const content = readFileSync(filePath);
                return extractStringRecordField(content, 'subs');
            } catch (error) {
                outputChannel.appendLine(`Error parsing docset file ${filePath}: ${error}`);
                return {};
            }
        },
        { filePath }
    );
}

function parseFrontmatterSubs(documentUri: vscode.Uri): SubstitutionVariables {
    return performanceLogger.measureSync(
        'Substitutions.parseFrontmatterSubs',
        () => {
            try {
                // Read the document content
                const document = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === documentUri.fsPath);
                if (!document) {
                    // If document is not open, try to read from file system
                    const content = readFileSync(documentUri.fsPath);
                    return extractSubsFromFrontmatter(content);
                }

                return extractSubsFromFrontmatter(document.getText());
            } catch (error) {
                outputChannel.appendLine(`Error parsing frontmatter subs from ${documentUri.fsPath}: ${error}`);
                return {};
            }
        },
        { documentPath: documentUri.fsPath }
    );
}

function extractSubsFromFrontmatter(content: string): SubstitutionVariables {
    // Match frontmatter: starts with --- and ends with ---
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
        return {};
    }

    return extractStringRecordField(frontmatterMatch[1], 'sub');
}
