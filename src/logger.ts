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

const channel = vscode.window.createOutputChannel('Elastic Docs V3');

function getBooleanSetting(name: string, defaultValue: boolean): boolean {
    return vscode.workspace.getConfiguration('elasticDocs').get<boolean>(name, defaultValue);
}

export function isDebugLoggingEnabled(): boolean {
    return getBooleanSetting('debugLogging', false);
}

export function isPerformanceLoggingEnabled(): boolean {
    return getBooleanSetting('performanceLogging', false);
}

// Most extension logging is diagnostic noise, so keep it opt-in for users.
export const outputChannel = {
    appendLine(value: string): void {
        if (isDebugLoggingEnabled()) {
            channel.appendLine(value);
        }
    },

    show(): void {
        channel.show();
    },

    dispose(): void {
        channel.dispose();
    }
};