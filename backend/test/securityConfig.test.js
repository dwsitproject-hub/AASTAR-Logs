'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('JWT configuration fails closed without a strong secret', () => {
  const backend = path.join(__dirname, '..');
  const run = secret => spawnSync(process.execPath, ['-e', "require('./config/config')"], {
    cwd: backend,
    env: { ...process.env, JWT_SECRET: secret },
    encoding: 'utf8',
  });
  assert.notEqual(run('').status, 0);
  assert.notEqual(run('short-secret').status, 0);
  assert.notEqual(run('erp-secret-change-in-production').status, 0);
  assert.equal(run('a-unique-random-test-secret-that-is-long-enough').status, 0);
});
