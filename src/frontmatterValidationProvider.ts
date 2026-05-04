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
import { frontmatterSchema } from './frontmatterSchema';
import { performanceLogger } from './performanceLogger';
import { validateAppliesToValue, parseVersion, parseVersionEntry } from './appliesToValidator';
import { VersionsCache } from './versionsCache';
import { parseYamlObject } from './yaml';

interface SchemaProperty {
    type?: string;
    description?: string;
    properties?: { [key: string]: SchemaProperty };
    items?: SchemaProperty;
    enum?: readonly string[] | string[];
    $ref?: string;
    additionalProperties?: boolean | SchemaProperty;
    [key: string]: unknown;
}

interface FrontmatterSchema {
    properties: { [key: string]: SchemaProperty };
    definitions: { [key: string]: SchemaProperty };
    metadata: {
        lifecycleStates: {
            values: Array<{ key: string; description: string }>;
        };
        knownKeys: {
            keys: string[];
        };
    };
}

interface ValidationError {
    range: vscode.Range;
    message: string;
    severity: vscode.DiagnosticSeverity;
    code?: string;
}

export class FrontmatterValidationProvider {
    private schema: FrontmatterSchema;
    private readonly FRONTMATTER_START = /^---\s*$/;
    private readonly FRONTMATTER_END = /^---\s*$/;

    constructor() {
        this.schema = frontmatterSchema as unknown as FrontmatterSchema;
    }

    public validateDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
        return performanceLogger.measureSync(
            'FrontmatterValidation.validateDocument',
            () => {
                const frontmatterRange = this.getFrontmatterRange(document);
                if (!frontmatterRange) {
                    return [];
                }

                const errors: ValidationError[] = [];
                
                try {
                    const frontmatterText = document.getText(frontmatterRange);
                    const lines = frontmatterText.split('\n').slice(1, -1); // Remove --- markers
                    
                    // Parse YAML and validate structure
                    const yamlData = this.parseYamlForValidation(lines, frontmatterRange.start.line + 1);
                    
                    // Validate against schema
                    this.validateFrontmatterData(yamlData, errors, document, frontmatterRange.start.line + 1);
                    
                } catch (error) {
                    // YAML parsing error
                    errors.push({
                        range: frontmatterRange,
                        message: `Invalid YAML syntax: ${error}`,
                        severity: vscode.DiagnosticSeverity.Error,
                        code: 'yaml_syntax_error'
                    });
                }

                // Convert validation errors to diagnostics
                return errors.map(error => {
                    const diagnostic = new vscode.Diagnostic(error.range, error.message, error.severity);
                    if (error.code) {
                        diagnostic.code = error.code;
                    }
                    diagnostic.source = 'Elastic Docs Frontmatter';
                    return diagnostic;
                });
            },
            { fileName: document.fileName }
        );
    }

    private getFrontmatterRange(document: vscode.TextDocument): vscode.Range | null {
        if (document.lineCount < 2) return null;

        // Check if document starts with frontmatter
        if (!this.FRONTMATTER_START.test(document.lineAt(0).text)) {
            return null;
        }

        // Find the end of frontmatter
        for (let i = 1; i < document.lineCount; i++) {
            if (this.FRONTMATTER_END.test(document.lineAt(i).text)) {
                return new vscode.Range(0, 0, i, 0);
            }
        }

        return null;
    }

    private parseYamlForValidation(lines: string[], _startLine: number): Record<string, unknown> {
        return performanceLogger.measureSync(
            'FrontmatterValidation.parseYaml',
            () => {
                return parseYamlObject(lines.join('\n'));
            },
            { lineCount: lines.length }
        );
    }

    private validateFrontmatterData(data: Record<string, unknown>, errors: ValidationError[], document: vscode.TextDocument, startLine: number): void {

        // Check for required fields
        this.validateRequiredFields(data, errors, document, startLine);
        
        // Validate each field
        for (const [fieldName, fieldValue] of Object.entries(data)) {
            this.validateField(fieldName, fieldValue, [], errors, document, startLine);
        }

        // Validate applies_to specifically
        if (data.applies_to) {
            this.validateAppliesTo(data.applies_to, errors, document, startLine);
        }

        // Validate products array
        if (data.products && Array.isArray(data.products)) {
            this.validateProducts(data.products, errors, document, startLine);
        }
    }

    private validateRequiredFields(data: Record<string, unknown>, errors: ValidationError[], document: vscode.TextDocument, startLine: number): void {
        // applies_to is mandatory according to schema
        if (!data.applies_to) {
            const range = new vscode.Range(startLine, 0, startLine, 0);
            errors.push({
                range,
                message: 'Missing required field: applies_to',
                severity: vscode.DiagnosticSeverity.Error,
                code: 'missing_required_field'
            });
        }
    }

    private validateField(fieldName: string, fieldValue: unknown, path: string[], errors: ValidationError[], document: vscode.TextDocument, startLine: number): void {

        const fieldSchema = this.getFieldSchema(fieldName, path);
        if (!fieldSchema) {
            // Unknown field warning
            const fieldRange = this.findFieldRange(fieldName, document, startLine);
            if (fieldRange) {
                errors.push({
                    range: fieldRange,
                    message: `Unknown field: ${fieldName}`,
                    severity: vscode.DiagnosticSeverity.Warning,
                    code: 'unknown_field'
                });
            }
            return;
        }

        // Validate based on field type
        if (fieldSchema.type === 'string') {
            if (typeof fieldValue !== 'string') {
                const valueRange = this.findValueRange(fieldName, document, startLine);
                if (valueRange) {
                    errors.push({
                        range: valueRange,
                        message: `Expected string value for field: ${fieldName}`,
                        severity: vscode.DiagnosticSeverity.Error,
                        code: 'type_error'
                    });
                }
            }
        } else if (fieldSchema.type === 'array') {
            if (!Array.isArray(fieldValue)) {
                const valueRange = this.findValueRange(fieldName, document, startLine);
                if (valueRange) {
                    errors.push({
                        range: valueRange,
                        message: `Expected array value for field: ${fieldName}`,
                        severity: vscode.DiagnosticSeverity.Error,
                        code: 'type_error'
                    });
                }
            }
        }

        // Validate enum values
        if (fieldSchema.enum && Array.isArray(fieldSchema.enum)) {
            if (!fieldSchema.enum.includes(fieldValue as string)) {
                const valueRange = this.findValueRange(fieldName, document, startLine);
                if (valueRange) {
                    errors.push({
                        range: valueRange,
                        message: `Invalid value '${fieldValue}' for field '${fieldName}'. Expected one of: ${fieldSchema.enum.join(', ')}`,
                        severity: vscode.DiagnosticSeverity.Error,
                        code: 'invalid_enum_value'
                    });
                }
            }
        }

        // Validate string length
        if (fieldSchema.maxLength && typeof fieldValue === 'string' && fieldValue.length > fieldSchema.maxLength) {
            const valueRange = this.findValueRange(fieldName, document, startLine);
            if (valueRange) {
                errors.push({
                    range: valueRange,
                    message: `Field '${fieldName}' exceeds maximum length of ${fieldSchema.maxLength} characters`,
                    severity: vscode.DiagnosticSeverity.Warning,
                    code: 'max_length_exceeded'
                });
            }
        }
    }

    private validateAppliesTo(appliesTo: unknown, errors: ValidationError[], document: vscode.TextDocument, startLine: number): void {
        if (typeof appliesTo !== 'object' || appliesTo === null) {
            return;
        }

        const appliesToObj = appliesTo as Record<string, unknown>;
        const knownKeys = this.schema.metadata.knownKeys.keys;

        for (const [key, value] of Object.entries(appliesToObj)) {
            // Validate known keys
            if (!knownKeys.includes(key)) {
                const keyRange = this.findFieldRange(key, document, startLine);
                if (keyRange) {
                    errors.push({
                        range: keyRange,
                        message: `Unknown applies_to key: ${key}. Valid keys: ${knownKeys.join(', ')}`,
                        severity: vscode.DiagnosticSeverity.Warning,
                        code: 'unknown_applies_key'
                    });
                }
            }

            // Validate lifecycle values
            if (typeof value === 'string') {
                this.validateLifecycleValue(key, value, errors, document, startLine);
                this.validateNoVersionOnDeploymentType(key, value, errors, document, startLine);
                this.validateVersionInRange(key, key, value, errors, document, startLine);
            } else if (typeof value === 'object' && value !== null) {
                // Nested object (like deployment/serverless)
                for (const [nestedKey, nestedValue] of Object.entries(value)) {
                    // Validate nested keys based on parent context
                    this.validateNestedAppliesKey(key, nestedKey, errors, document, startLine);
                    
                    if (typeof nestedValue === 'string') {
                        this.validateLifecycleValue(`${key}.${nestedKey}`, nestedValue, errors, document, startLine);

                        if (key === 'deployment') {
                            this.validateNoVersionOnDeploymentType(nestedKey, nestedValue, errors, document, startLine);
                        }

                        this.validateVersionInRange(nestedKey, nestedKey, nestedValue, errors, document, startLine);
                    }
                }

                // Warn when ech and ess coexist under deployment
                if (key === 'deployment') {
                    this.validateEchEssMutualExclusion(value as Record<string, unknown>, errors, document, startLine);
                }
            }
        }

        // Warn when ech and ess coexist as top-level applies_to keys
        this.validateEchEssMutualExclusion(appliesToObj, errors, document, startLine);
    }

    private static readonly DEPLOYMENT_TYPES_NO_VERSION = ['ech', 'ess'];
    private static readonly HAS_VERSION_PATTERN = /^[a-z]+\s+\S/;

    private validateNoVersionOnDeploymentType(key: string, value: string, errors: ValidationError[], document: vscode.TextDocument, startLine: number): void {
        if (!FrontmatterValidationProvider.DEPLOYMENT_TYPES_NO_VERSION.includes(key)) {
            return;
        }

        const entries = value.split(',').map(e => e.trim());
        const hasVersion = entries.some(e => FrontmatterValidationProvider.HAS_VERSION_PATTERN.test(e));
        if (!hasVersion) {
            return;
        }

        const valueRange = this.findValueRange(key, document, startLine);
        if (valueRange) {
            errors.push({
                range: valueRange,
                message: `Deployment type '${key}' should not include a version. Only 'self', 'ece', and 'eck' support version specifiers.`,
                severity: vscode.DiagnosticSeverity.Warning,
                code: 'deployment_type_with_version'
            });
        }
    }

    private static readonly VERSION_RANGE_MAJOR_BUFFER = 2;

    private validateVersionInRange(cacheKey: string, fieldKey: string, value: string, errors: ValidationError[], document: vscode.TextDocument, startLine: number): void {
        const versionsCache = VersionsCache.getInstance();
        const versions = versionsCache.getVersions();

        if (Object.keys(versions).length === 0) {
            return;
        }

        const currentStr = versions[cacheKey];
        const baseStr = versions[`${cacheKey}.base`];
        if (!currentStr || !baseStr) {
            return;
        }

        const currentVer = parseVersion(currentStr);
        const baseVer = parseVersion(baseStr);
        if (!currentVer || !baseVer) {
            return;
        }

        const baseMajor = baseVer[0];
        const currentMajor = currentVer[0];
        const entries = value.split(',').map(e => e.trim());

        for (const entry of entries) {
            const parsed = parseVersionEntry(entry);
            if (!parsed) {
                continue;
            }

            const versionsToCheck = [parsed.startVersion, parsed.endVersion].filter(
                (v): v is number[] => v !== null
            );

            for (const ver of versionsToCheck) {
                const major = ver[0];
                if (major < baseMajor || major > currentMajor + FrontmatterValidationProvider.VERSION_RANGE_MAJOR_BUFFER) {
                    const valueRange = this.findValueRange(fieldKey, document, startLine);
                    if (valueRange) {
                        errors.push({
                            range: valueRange,
                            message: `Version ${ver.join('.')} seems out of range for '${cacheKey}' (known versions: ${baseStr}–${currentStr}).`,
                            severity: vscode.DiagnosticSeverity.Warning,
                            code: 'version_out_of_range'
                        });
                    }
                    return;
                }
            }
        }
    }

    private validateEchEssMutualExclusion(obj: Record<string, unknown>, errors: ValidationError[], document: vscode.TextDocument, startLine: number): void {
        const hasEch = 'ech' in obj;
        const hasEss = 'ess' in obj;
        if (!hasEch || !hasEss) {
            return;
        }

        const essRange = this.findFieldRange('ess', document, startLine);
        if (essRange) {
            errors.push({
                range: essRange,
                message: `'ess' and 'ech' should not be used together. 'ess' is deprecated; use 'ech' instead.`,
                severity: vscode.DiagnosticSeverity.Warning,
                code: 'ech_ess_coexist'
            });
        }
    }

    private validateNestedAppliesKey(parentKey: string, nestedKey: string, errors: ValidationError[], document: vscode.TextDocument, startLine: number): void {
        let validNestedKeys: string[] = [];
        
        switch (parentKey) {
            case 'deployment':
                // Get keys from deploymentApplicability definition in schema
                const deploymentDef = this.schema.definitions.deploymentApplicability;
                if (deploymentDef && deploymentDef.properties) {
                    validNestedKeys = Object.keys(deploymentDef.properties);
                }
                break;
            case 'serverless':
                // Get keys from serverlessProjectApplicability definition in schema
                const serverlessDef = this.schema.definitions.serverlessProjectApplicability;
                if (serverlessDef && serverlessDef.properties) {
                    validNestedKeys = Object.keys(serverlessDef.properties);
                }
                break;
            case 'product':
                // For product objects, validate against individual product keys from schema
                validNestedKeys = this.schema.metadata.knownKeys.keys.filter(key => 
                    !['stack', 'deployment', 'serverless', 'product'].includes(key)
                );
                break;
            default:
                return; // Don't validate other nested contexts
        }
        
        if (!validNestedKeys.includes(nestedKey)) {
            const keyRange = this.findFieldRange(nestedKey, document, startLine);
            if (keyRange) {
                errors.push({
                    range: keyRange,
                    message: `Unknown ${parentKey} key: ${nestedKey}. Valid keys: ${validNestedKeys.join(', ')}`,
                    severity: vscode.DiagnosticSeverity.Warning,
                    code: 'unknown_nested_key'
                });
            }
        }
    }

    private validateLifecycleValue(fieldPath: string, value: string, errors: ValidationError[], document: vscode.TextDocument, startLine: number): void {
        // Use shared validator
        const diagnostics = validateAppliesToValue(value);
        
        if (diagnostics.length === 0) {
            return;
        }

        // Find the value range in the document
        const valueRange = this.findValueRange(fieldPath.split('.').pop()!, document, startLine);
        if (!valueRange) return;

        // Convert shared diagnostics to ValidationError format
        for (const diag of diagnostics) {
            errors.push({
                range: valueRange,
                message: diag.message,
                severity: diag.severity,
                code: diag.code
            });
        }
    }

    private validateProducts(products: unknown[], errors: ValidationError[], document: vscode.TextDocument, startLine: number): void {
        // Get valid product IDs from schema
        const productsSchema = this.schema.properties.products;
        const validProductIds: string[] = [];
        
        if (productsSchema && productsSchema.items && productsSchema.items.properties && productsSchema.items.properties.id && productsSchema.items.properties.id.enum) {
            validProductIds.push(...productsSchema.items.properties.id.enum);
        }

        for (let i = 0; i < products.length; i++) {
            const product = products[i];

            if (typeof product !== 'object' || product === null || !('id' in product)) {
                const productRange = this.findArrayItemRange('products', i, document, startLine);
                if (productRange) {
                    errors.push({
                        range: productRange,
                        message: 'Product item must be an object with an "id" field',
                        severity: vscode.DiagnosticSeverity.Error,
                        code: 'invalid_product_format'
                    });
                }
                continue;
            }

            const productObj = product as Record<string, unknown>;
            const productId = productObj.id as string;

            if (!validProductIds.includes(productId)) {
                // Find the specific id value in the array item
                const idRange = this.findProductIdRange(productId, i, document, startLine);
                if (idRange) {
                    errors.push({
                        range: idRange,
                        message: `Invalid product ID '${productId}'. Valid IDs: ${validProductIds.join(', ')}`,
                        severity: vscode.DiagnosticSeverity.Error,
                        code: 'invalid_product_id'
                    });
                }
            }
        }
    }

    private getFieldSchema(fieldName: string, path: string[]): SchemaProperty | undefined {

        let currentSchema = this.schema.properties;

        for (const segment of path) {
            if (currentSchema[segment] && currentSchema[segment].properties) {
                currentSchema = currentSchema[segment].properties!;
            }
        }

        return currentSchema[fieldName];
    }

    private findFieldRange(fieldName: string, document: vscode.TextDocument, startLine: number): vscode.Range | null {
        // Find the field name in the document
        for (let i = startLine; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const fieldMatch = line.text.match(new RegExp(`^(\\s*)(${fieldName})\\s*:`));
            if (fieldMatch) {
                const startChar = fieldMatch[1].length;
                const endChar = startChar + fieldMatch[2].length;
                return new vscode.Range(i, startChar, i, endChar);
            }
        }
        return null;
    }

    private findValueRange(fieldName: string, document: vscode.TextDocument, startLine: number): vscode.Range | null {
        // Find the value for a field in the document
        // Escape special regex characters in fieldName
        const escapedFieldName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        
        for (let i = startLine; i < document.lineCount; i++) {
            const lineText = document.lineAt(i).text;
            
            // Simple approach: find the field name followed by colon
            const fieldPattern = new RegExp(`(^|\\s)${escapedFieldName}\\s*:`);
            const fieldMatch = lineText.match(fieldPattern);
            
            if (fieldMatch) {
                // Find the colon position
                const colonIndex = lineText.indexOf(':', fieldMatch.index);
                if (colonIndex !== -1) {
                    // Value starts after the colon and any whitespace
                    let valueStart = colonIndex + 1;
                    while (valueStart < lineText.length && lineText[valueStart] === ' ') {
                        valueStart++;
                    }
                    // Value ends at end of line (trimming trailing whitespace)
                    let valueEnd = lineText.length;
                    while (valueEnd > valueStart && lineText[valueEnd - 1] === ' ') {
                        valueEnd--;
                    }
                    
                    if (valueEnd > valueStart) {
                        return new vscode.Range(i, valueStart, i, valueEnd);
                    }
                }
            }
        }
        return null;
    }

    private findProductIdRange(productId: string, itemIndex: number, document: vscode.TextDocument, startLine: number): vscode.Range | null {
        // Find the specific product ID value in the array
        let productsFound = 0;
        let inProductsArray = false;
        
        for (let i = startLine; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const text = line.text;
            
            // Check if we've entered the products array
            if (text.match(/^\s*products\s*:/)) {
                inProductsArray = true;
                continue;
            }
            
            // Exit if we're no longer in products array (reached another top-level field)
            if (inProductsArray && text.match(/^[a-zA-Z_]/)) {
                break;
            }
            
            // Look for array items with id field
            if (inProductsArray && text.match(/^\s*-\s+id\s*:\s*(.+)$/)) {
                if (productsFound === itemIndex) {
                    // This is our target item, find the id value
                    const valueMatch = text.match(/^\s*-\s+id\s*:\s*(.+)$/);
                    if (valueMatch) {
                        const valueStart = text.indexOf(valueMatch[1]);
                        const valueEnd = valueStart + valueMatch[1].length;
                        return new vscode.Range(i, valueStart, i, valueEnd);
                    }
                }
                productsFound++;
            }
        }
        
        return null;
    }

    private findArrayItemRange(_arrayName: string, _itemIndex: number, _document: vscode.TextDocument, _startLine: number): vscode.Range | null {
        // This is a simplified implementation
        // In practice, you'd need more sophisticated YAML parsing to find exact array item positions
        return null;
    }
}