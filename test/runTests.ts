import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ICONS } from '../src/iconNames';
import { applyMutation, applyMutationChain } from '../src/mutationEngine';
import { extractStringRecordField, extractVersionSubstitutions, parseYamlObject } from '../src/yaml';

type TestCase = {
    name: string;
    run: () => void;
};

const tests: TestCase[] = [
    {
        name: 'mutation engine applies text mutations',
        run: () => {
            assert.strictEqual(applyMutation('Hello World', 'lc'), 'hello world');
            assert.strictEqual(applyMutation('Hello World', 'kc'), 'hello-world');
            assert.deepStrictEqual(applyMutationChain('  Hello World!  ', ['trim', 'sc']), [
                '  Hello World!  ',
                'Hello World',
                'hello_world'
            ]);
        }
    },
    {
        name: 'mutation engine applies version mutations',
        run: () => {
            assert.strictEqual(applyMutation('9.1.5', 'M'), '9');
            assert.strictEqual(applyMutation('9.1.5', 'M.x'), '9.x');
            assert.strictEqual(applyMutation('9.1.5', 'M.M+1'), '9.2');
            assert.strictEqual(applyMutation('not-a-version', 'M'), 'not-a-version');
        }
    },
    {
        name: 'YAML parser handles quoted substitution values and colons',
        run: () => {
            const substitutions = extractStringRecordField(`
subs:
  product.name: "Elastic: Search"
  retries: 3
  enabled: true
`, 'subs');

            assert.deepStrictEqual(substitutions, {
                'product.name': 'Elastic: Search',
                retries: '3',
                enabled: 'true'
            });
        }
    },
    {
        name: 'YAML parser preserves nested frontmatter structures',
        run: () => {
            const parsed = parseYamlObject(`
applies_to:
  deployment:
    eck: ga 9.1+
products:
  - id: elasticsearch
`);

            assert.deepStrictEqual(parsed, {
                applies_to: {
                    deployment: {
                        eck: 'ga 9.1+'
                    }
                },
                products: [
                    {
                        id: 'elasticsearch'
                    }
                ]
            });
        }
    },
    {
        name: 'versions YAML parser resolves anchors and normalizes keys',
        run: () => {
            const versions = extractVersionSubstitutions(`
versioning_systems:
  stack: &stack
    base: 9.0
    current: 9.1.5
  self: *stack
  edot-collector:
    base: 1.0
    current: 1.2.3
`);

            assert.deepStrictEqual(versions, {
                stack: '9.1.5',
                'stack.base': '9.0',
                self: '9.1.5',
                'self.base': '9.0',
                edot_collector: '1.2.3',
                'edot_collector.base': '1.0'
            });
        }
    },
    {
        name: 'icon completions use the synced canonical icon names',
        run: () => {
            const iconNames: readonly string[] = ICONS;

            assert.strictEqual(iconNames.length, 581);
            assert.ok(iconNames.includes('analyze_event'));
            assert.ok(iconNames.includes('magnify_sparkles'));
            assert.ok(iconNames.includes('transition_bottom_in'));
            assert.ok(iconNames.includes('warning_fill'));
            assert.ok(!iconNames.includes('analyzeEvent'));
            assert.ok(!iconNames.includes('warningFilled'));
            assert.ok(!iconNames.includes('pipeBreaks'));
        }
    },
    {
        name: 'icon syntax grammar matches snake_case icon names',
        run: () => {
            const grammarPath = path.resolve(__dirname, '..', '..', 'syntaxes', 'elastic-markdown.tmLanguage.json');
            const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf8')) as {
                repository: {
                    'elastic-roles': {
                        patterns: Array<{ name?: string; match?: string }>;
                    };
                };
            };
            const iconPattern = grammar.repository['elastic-roles'].patterns.find(
                pattern => pattern.name === 'markup.role.icon.elastic'
            )?.match;

            assert.ok(iconPattern);

            const match = '{icon}`magnify_sparkles`'.match(new RegExp(iconPattern!));
            assert.ok(match);
            assert.strictEqual(match?.[2], 'icon');
            assert.strictEqual(match?.[5], 'magnify_sparkles');
        }
    }
];

let failures = 0;
for (const test of tests) {
    try {
        test.run();
        console.log(`ok - ${test.name}`);
    } catch (error) {
        failures++;
        console.error(`not ok - ${test.name}`);
        console.error(error);
    }
}

if (failures > 0) {
    process.exitCode = 1;
} else {
    console.log(`${tests.length} tests passed.`);
}
