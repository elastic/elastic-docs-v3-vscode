import * as assert from 'assert';
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
