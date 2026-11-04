const assert = require('node:assert/strict');
require('../github_browser_config.js');
require('../account_exports.js');
const build = global.AccountExports.build;
const site = overrides => ({url: 'https://fictional.example/', cfClearanceEnv: 'FICTIONAL_CF',
    accounts: [{userId: '123', name: 'Fictional', accessTokenEnv: 'FICTIONAL_TOKEN', ...overrides}]});
const result = build([site({accessToken: 'fictional-private-token', session: 'fictional-session'})]);
assert.equal(result.publicAccounts[0].url, 'https://fictional.example');
assert.ok(!JSON.stringify(result.publicAccounts).includes('fictional-private-token'));
assert.equal(result.secrets.FICTIONAL_TOKEN, 'fictional-private-token');
assert.equal(result.legacyAccounts[0].cf_clearance_env, 'FICTIONAL_CF');
assert.match(global.AccountExports.simple(result.legacyAccounts), /用户 ID/);
assert.equal(global.AccountExports.simple([{url: 'https://fictional.example', session: 'fictional-session'}]),
    'https://fictional.example#fictional-session');
for (const name of ['PATH', 'GITHUB_TOKEN', 'NEWAPI_PROXY', 'NEWAPI_CAPTCHA_OCR', 'EMAIL_PASS']) {
    assert.throws(() => build([site({accessTokenEnv: name})]), /保留变量/);
}
assert.throws(() => build([site({}), site({accessTokenEnv: 'SECOND'})]), /重复/);
assert.throws(() => build([{...site({}), url: 'https://user:secret@fictional.example'}]), /凭证/);
assert.throws(() => build([site({userId: 'not-a-number'})]), /用户 ID/);
assert.throws(() => build([{...site({}), cfClearance: 'first'},
    {...site({userId: '456', accessTokenEnv: 'SECOND'}), cfClearance: 'second'}]), /不同的凭证/);
const defaults = build([{url: 'https://fictional.example', accounts: [
    {userId: '123'}, {userId: '456', accessTokenEnv: 'NEWAPI_TOKEN_ACCOUNT1'}]}]);
assert.equal(defaults.publicAccounts[0].access_token_env, 'NEWAPI_TOKEN_ACCOUNT2');
console.log('PASS shared exports: public/legacy/Secrets consistency, reserved names, duplicate identities, conflicting credentials, safe simple format');
