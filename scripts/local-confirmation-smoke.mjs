import assert from 'node:assert/strict';
import { listLocalConfirmations, requestLocalConfirmation, resolveLocalConfirmation } from '../dist/local-confirmations.js';

const risk = { level: 'high', categories: ['destructive_command'], reasons: ['smoke'], networkIntent: false };
const approved = requestLocalConfirmation('smoke', 'Approve smoke action', risk, 1000);
const pending = listLocalConfirmations();
assert.equal(pending.length, 1);
assert.equal(resolveLocalConfirmation(pending[0].id, true), true);
assert.equal(await approved, true);
assert.equal(listLocalConfirmations().length, 0);

const denied = requestLocalConfirmation('smoke', 'Timeout smoke action', risk, 10);
await new Promise((resolve) => setTimeout(resolve, 25));
assert.equal(await denied, false);
assert.equal(listLocalConfirmations().length, 0);

console.log(JSON.stringify({ ok: true, checks: ['approve', 'timeout'] }, null, 2));
