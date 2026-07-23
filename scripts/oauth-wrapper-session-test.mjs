import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/oauth-wrapper.js', import.meta.url), 'utf8');

assert.match(source, /const session = isHostedMode\(\) \? readUserSession\(req\) : null;/);
assert.match(source, /isHostedMode\(\) && !session\.ok/);
assert.match(source, /!isHostedMode\(\) && !timingEqualString/);
assert.match(source, /authorizationCodeIdentityFields\(session\)/);
assert.match(source, /accessTokenIdentityClaims\(entry\)/);
assert.match(source, /isHostedMode\(\) \? '' : `<label>Owner approval code/);

console.log('Hosted OAuth session wiring regression tests passed.');
