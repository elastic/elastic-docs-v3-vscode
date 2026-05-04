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

import { parse } from 'yaml';

export type YamlObject = Record<string, unknown>;

function isRecord(value: unknown): value is YamlObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalarToString(value: unknown): string | null {
    if (typeof value === 'string') {
        return value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }

    return null;
}

export function parseYamlObject(content: string): YamlObject {
    const parsed = parse(content, { schema: 'failsafe' });
    return isRecord(parsed) ? parsed : {};
}

export function getStringRecordField(data: YamlObject, fieldName: string): Record<string, string> {
    const field = data[fieldName];
    if (!isRecord(field)) {
        return {};
    }

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(field)) {
        const scalar = scalarToString(value);
        if (scalar !== null) {
            result[key] = scalar;
        }
    }

    return result;
}

export function extractStringRecordField(content: string, fieldName: string): Record<string, string> {
    return getStringRecordField(parseYamlObject(content), fieldName);
}

export function extractVersionSubstitutions(content: string): Record<string, string> {
    const root = parseYamlObject(content);
    const versioningSystems = root.versioning_systems;
    if (!isRecord(versioningSystems)) {
        return {};
    }

    const versions: Record<string, string> = {};
    for (const [key, value] of Object.entries(versioningSystems)) {
        if (!isRecord(value)) {
            continue;
        }

        const normalizedKey = key.replace(/-/g, '_');
        const current = scalarToString(value.current);
        if (!current) {
            continue;
        }

        versions[normalizedKey] = current;

        const base = scalarToString(value.base);
        if (base) {
            versions[`${normalizedKey}.base`] = base;
        }
    }

    return versions;
}
