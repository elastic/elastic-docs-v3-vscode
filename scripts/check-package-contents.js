#!/usr/bin/env node

const { execFileSync } = require('child_process');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const vsceBin = path.join(
  rootDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vsce.cmd' : 'vsce'
);

const forbiddenPrefixes = [
  '.github/',
  '.idea/',
  '.vscode/',
  '.vscode-test/',
  'docs/',
  'scripts/',
  'src/',
  'test/',
  'out-test/',
  'node_modules/',
];

const forbiddenFiles = new Set([
  '.eslintrc.json',
  'docset.yml',
  'esbuild.js',
  'tsconfig.json',
  'tsconfig.test.json',
]);

const requiredFiles = [
  'package.json',
  'README.md',
  'LICENSE.txt',
  'NOTICE.txt',
  'images/icon.png',
  'out/extension.js',
  'out/extension-web.js',
  'syntaxes/elastic-markdown.tmLanguage.json',
];

function main() {
  const output = execFileSync(vsceBin, ['ls'], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const files = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const violations = files.filter(file =>
    forbiddenPrefixes.some(prefix => file.startsWith(prefix)) ||
    forbiddenFiles.has(file)
  );

  const missing = requiredFiles.filter(file => !files.includes(file));

  if (violations.length > 0 || missing.length > 0) {
    if (violations.length > 0) {
      console.error('Forbidden files would be included in the VSIX:');
      violations.forEach(file => console.error(`  - ${file}`));
    }

    if (missing.length > 0) {
      console.error('Required files are missing from the VSIX:');
      missing.forEach(file => console.error(`  - ${file}`));
    }

    process.exit(1);
  }

  console.log(`Package contents verified (${files.length} files).`);
}

main();
