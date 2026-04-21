#!/usr/bin/env node

const { existsSync } = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { homedir } = require('os');

function resolveBunBinary() {
  if (process.env.BUN_BIN && existsSync(process.env.BUN_BIN)) {
    return process.env.BUN_BIN;
  }

  const whichCommand = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = spawnSync(whichCommand, ['bun'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status === 0) {
      const firstMatch = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (firstMatch) {
        return firstMatch;
      }
    }
  } catch {
    // Fall through to hardcoded paths.
  }

  const candidates = process.platform === 'win32'
    ? [path.join(homedir(), '.bun', 'bin', 'bun.exe')]
    : [
        path.join(homedir(), '.bun', 'bin', 'bun'),
        '/usr/local/bin/bun',
        '/opt/homebrew/bin/bun',
        '/home/linuxbrew/.linuxbrew/bin/bun',
      ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function main() {
  const bunPath = resolveBunBinary();
  if (!bunPath) {
    console.error('Bun not found. Install Bun first: https://bun.sh');
    process.exit(1);
  }

  const targetScript = path.join(__dirname, 'delete-project-memory.ts');
  const child = spawn(bunPath, [targetScript, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('error', (error) => {
    console.error(`Failed to start Bun: ${error.message}`);
    process.exit(1);
  });

  child.on('close', (exitCode) => {
    process.exit(exitCode ?? 0);
  });
}

main();
