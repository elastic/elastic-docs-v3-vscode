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

import { isPerformanceLoggingEnabled, outputChannel } from './logger';

interface PerformanceMetrics {
    operation: string;
    startTime: number;
    endTime?: number;
    duration?: number;
    metadata?: Record<string, unknown>;
}

class PerformanceLogger {
    private metrics: Map<string, PerformanceMetrics> = new Map();
    private readonly SLOW_OPERATION_THRESHOLD = 100; // milliseconds

    startTiming(operation: string, metadata?: Record<string, unknown>): void {
        if (!isPerformanceLoggingEnabled()) return;

        const startTime = Date.now();
        this.metrics.set(operation, {
            operation,
            startTime,
            metadata
        });
    }

    endTiming(operation: string): number | undefined {
        if (!isPerformanceLoggingEnabled()) return undefined;

        const metric = this.metrics.get(operation);
        if (!metric) {
            outputChannel.appendLine(`[Performance] Warning: No start timing found for operation: ${operation}`);
            return undefined;
        }

        const endTime = Date.now();
        const duration = endTime - metric.startTime;
        
        metric.endTime = endTime;
        metric.duration = duration;

        // Log slow operations
        if (duration > this.SLOW_OPERATION_THRESHOLD) {
            const metadataStr = metric.metadata ? ` | ${JSON.stringify(metric.metadata)}` : '';
            outputChannel.appendLine(`[Performance] SLOW OPERATION: ${operation} took ${duration}ms${metadataStr}`);
        }

        this.metrics.delete(operation);
        return duration;
    }

    logOperation(operation: string, duration: number, metadata?: Record<string, unknown>): void {
        if (!isPerformanceLoggingEnabled()) return;

        const metadataStr = metadata ? ` | ${JSON.stringify(metadata)}` : '';
        const level = duration > this.SLOW_OPERATION_THRESHOLD ? 'SLOW' : 'OK';
        outputChannel.appendLine(`[Performance] ${level}: ${operation} took ${duration}ms${metadataStr}`);
    }

    // Utility method to wrap async operations
    async measureAsync<T>(
        operation: string, 
        fn: () => Promise<T>, 
        metadata?: Record<string, unknown>
    ): Promise<T> {
        this.startTiming(operation, metadata);
        try {
            const result = await fn();
            this.endTiming(operation);
            return result;
        } catch (error) {
            this.endTiming(operation);
            throw error;
        }
    }

    // Utility method to wrap sync operations
    measureSync<T>(
        operation: string, 
        fn: () => T, 
        metadata?: Record<string, unknown>
    ): T {
        this.startTiming(operation, metadata);
        try {
            const result = fn();
            this.endTiming(operation);
            return result;
        } catch (error) {
            this.endTiming(operation);
            throw error;
        }
    }

    // Get current performance summary
    getSummary(): string {
        const activeOperations = Array.from(this.metrics.values());
        if (activeOperations.length === 0) {
            return '[Performance] No active operations';
        }

        const now = Date.now();
        const summary = activeOperations.map(op => {
            const duration = now - op.startTime;
            const metadataStr = op.metadata ? ` | ${JSON.stringify(op.metadata)}` : '';
            return `  ${op.operation}: ${duration}ms${metadataStr}`;
        }).join('\n');

        return `[Performance] Active operations:\n${summary}`;
    }
}

export const performanceLogger = new PerformanceLogger();
