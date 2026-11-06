const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const workflow = `name: synthetic workflow
on:
  schedule:
    - cron: '10 0 * * *'
jobs:
  checkin:
    runs-on: ubuntu-latest
    steps:
      - name: synthetic check-in
        env:
          OLD_TOKEN: \${{ secrets.OLD_TOKEN }}
          NEWAPI_CONFIG_FILE: \${{ inputs.config_file }}
          EMAIL_PASS: \${{ secrets.EMAIL_PASS }}
        run: xvfb-run --auto-servernum python checkin.py
      - name: unrelated step
        run: echo done
`;
const workflowFiles = ['.github/workflows/checkin.yml', '.github/workflows/checkin-gha-test.yml'];

function account(tokenName = 'NEW_TOKEN', userId = '456', name = '新增账号') {
    return {url: 'https://api.example.com', user_id: userId, name, access_token_env: tokenName};
}

class FakeAPI {
    constructor() {
        this.files = new Map([['accounts.config.json', JSON.stringify([account('OLD_TOKEN', '123', '原有账号')])],
            ...workflowFiles.map(filename => [filename, workflow])]);
        this.secrets = new Set(['OLD_TOKEN']);
        this.calls = [];
        this.readPaths = [];
        this.blobs = new Map();
        this.head = 'a'.repeat(40);
        this.tree = 'b'.repeat(40);
        this.commitCount = 0;
        this.private = true;
        this.metadataReads = 0;
        this.changeVisibility = false;
        this.conflict = false;
        this.failedSecrets = new Set();
        this.pair = null;
    }

    response(status, data = {}) {
        return {status, ok: status >= 200 && status < 300,
            text: async () => data === null ? '' : JSON.stringify(data)};
    }

    async fetch(url, options) {
        const base = 'https://api.github.com/repos/synthetic-owner/synthetic-repo';
        assert.ok(url === base || url.startsWith(base + '/'), 'Credentials must only go to api.github.com');
        const endpoint = url.slice(base.length).replace(/^\//, '');
        const method = options.method;
        const payload = options.body === undefined ? undefined : JSON.parse(options.body);
        this.calls.push({endpoint, method, payload, options});
        if (method === 'GET' && endpoint === '') {
            this.metadataReads += 1;
            if (this.changeVisibility && this.metadataReads > 1) this.private = false;
            return this.response(200, {private: this.private, default_branch: 'main'});
        }
        if (method === 'GET' && endpoint === 'git/ref/heads/main') return this.response(200, {object: {sha: this.head}});
        if (method === 'GET' && endpoint === 'git/commits/' + this.head) return this.response(200, {tree: {sha: this.tree}});
        if (method === 'GET' && endpoint === `git/trees/${this.tree}?recursive=1`) {
            const entries = [...this.files].map(([filename, content], index) => {
                const sha = (index + 1).toString(16).padStart(40, '0');
                this.blobs.set(sha, {filename, content});
                return {path: filename, sha, type: 'blob', mode: '100644'};
            });
            return this.response(200, {tree: entries, truncated: false});
        }
        if (method === 'GET' && endpoint.startsWith('git/blobs/')) {
            const blob = this.blobs.get(endpoint.split('/').at(-1));
            this.readPaths.push(blob.filename);
            return this.response(200, {encoding: 'base64', size: Buffer.byteLength(blob.content),
                content: Buffer.from(blob.content).toString('base64')});
        }
        if (method === 'GET' && endpoint.startsWith('actions/secrets?')) {
            const page = Number(new URL(url).searchParams.get('page'));
            return this.response(200, {secrets: [...this.secrets].slice((page - 1) * 100, page * 100).map(name => ({name}))});
        }
        if (method === 'GET' && endpoint === 'actions/secrets/public-key') {
            return this.response(200, {key_id: 'synthetic-key-id', key: Buffer.from(this.pair.publicKey).toString('base64')});
        }
        if (method === 'POST' && endpoint === 'git/trees') {
            assert.equal(payload.base_tree, this.tree);
            this.pending = new Map(this.files);
            payload.tree.forEach(entry => this.pending.set(entry.path, entry.content));
            return this.response(201, {sha: 'c'.repeat(40)});
        }
        if (method === 'POST' && endpoint === 'git/commits') {
            assert.deepEqual(payload.parents, [this.head]);
            this.commitCount += 1;
            return this.response(201, {sha: this.commitCount.toString(16).padStart(40, '0')});
        }
        if (method === 'PATCH' && endpoint === 'git/refs/heads/main') {
            assert.equal(payload.force, false);
            if (this.conflict) return this.response(422, {message: 'synthetic-sensitive-upstream-error'});
            this.files = this.pending;
            this.head = payload.sha;
            this.tree = 'c'.repeat(40);
            return this.response(200, {object: {sha: this.head}});
        }
        if (method === 'PUT' && endpoint.startsWith('actions/secrets/')) {
            const name = endpoint.split('/').at(-1);
            if (this.failedSecrets.has(name)) return this.response(403, {message: 'synthetic-sensitive-upstream-error'});
            this.secrets.add(name);
            return this.response(201, null);
        }
        throw new Error('Unexpected synthetic API endpoint: ' + method + ' ' + endpoint);
    }
}

async function createService() {
    const api = new FakeAPI();
    const context = vm.createContext({crypto: crypto.webcrypto, TextEncoder, TextDecoder, Uint8Array,
        URL, atob, btoa, WebAssembly, AbortController, setTimeout, clearTimeout,
        fetch: (...argumentsList) => api.fetch(...argumentsList)});
    context.window = context;
    context.self = context;
    for (const filename of ['vendor/libsodium.js', 'vendor/libsodium-wrappers.js', 'github_browser_config.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, filename), 'utf8'), context, {filename});
    }
    await context.sodium.ready;
    api.pair = context.sodium.crypto_box_keypair();
    const payload = {action: 'save', repository: 'synthetic-owner/synthetic-repo', token: 'synthetic-pages-pat',
        accounts: [account()], secrets: {NEW_TOKEN: 'synthetic-pages-token'}};
    return {api, context, service: context.GitHubBrowserConfig, payload};
}

function mutations(api) {
    return api.calls.filter(call => call.method !== 'GET');
}

async function runTest(name, callback) {
    await callback();
    console.log(`PASS ${name}`);
}

async function main() {

    await runTest('TokenBom automatically seals the current GitHub PAT with stable merge and pause support', async () => {
        const {api, context, service, payload} = await createService();
        const bom = {type: 'tokenbom', url: 'https://tokenbom.example', account_id: 'stable', name: 'Synthetic', refresh_token_env: 'BOM_REFRESH'};
        await assert.rejects(() => service.handle({...payload, accounts: [bom], secrets: {}}), /BOM_REFRESH/);
        assert.equal(mutations(api).length, 0);
        const provided = {BOM_REFRESH: 'synthetic-refresh'};
        const credentials = {...provided, TOKENBOM_SECRETS_PAT: payload.token};
        const saved = await service.handle({...payload, token: ' ' + payload.token + ' ', accounts: [bom], secrets: provided});
        assert.deepEqual(provided, {BOM_REFRESH: 'synthetic-refresh'});
        assert.equal(saved.complete, true);
        assert.deepEqual([...saved.saved_secrets].sort(), Object.keys(credentials).sort());
        assert.equal(saved.accounts.length, 2);
        for (const call of api.calls.filter(call => call.method === 'PUT')) {
            assert.deepEqual(Object.keys(call.payload).sort(), ['encrypted_value', 'key_id']);
            const value = context.sodium.crypto_box_seal_open(new Uint8Array(Buffer.from(call.payload.encrypted_value, 'base64')),
                api.pair.publicKey, api.pair.privateKey, 'text');
            assert.equal(value, credentials[call.endpoint.split('/').at(-1)]);
        }
        for (const path of workflowFiles) {
            assert.ok(api.files.get(path).includes('BOM_REFRESH: ' + String.fromCharCode(36) + '{{ secrets.BOM_REFRESH }}'));
            assert.ok(api.files.get(path).includes('TOKENBOM_SECRETS_PAT: ' + String.fromCharCode(36) + '{{ secrets.TOKENBOM_SECRETS_PAT }}'));
            assert.ok(api.files.get(path).includes("cron: '10 0 * * *'"));
        }
        const publicText = JSON.stringify(saved) + [...api.files.values()].join('')
            + JSON.stringify(mutations(api).map(call => call.payload));
        for (const value of Object.values(credentials)) assert.ok(!publicText.includes(value));
        assert.ok(!api.readPaths.includes('.env'));
        const uploads = api.calls.filter(call => call.method === 'PUT').length;
        const paused = await service.handle({...payload, accounts: [{...bom, enabled: false}], secrets: {}});
        assert.equal(paused.accounts[1].enabled, false);
        const resumed = await service.handle({...payload, accounts: [{...bom, name: 'Updated', enabled: true}], secrets: {}});
        assert.equal(resumed.accounts.length, 2);
        assert.equal(resumed.accounts[1].name, 'Updated');
        assert.equal(api.calls.filter(call => call.method === 'PUT').length, uploads);
    });
    await runTest('TokenBom uses an explicit renewal PAT and preserves it when the connection PAT changes', async () => {
        for (const alreadyConfigured of [false, true]) {
            const {api, context, service, payload} = await createService();
            const bom = {type: 'tokenbom', url: 'https://tokenbom.example', account_id: 'stable', refresh_token_env: 'BOM_REFRESH'};
            if (alreadyConfigured) api.secrets.add('TOKENBOM_SECRETS_PAT');
            const result = await service.handle({...payload, accounts: [bom], secrets: {
                BOM_REFRESH: 'synthetic-refresh', TOKENBOM_SECRETS_PAT: 'synthetic-dedicated-pat'}});
            const upload = api.calls.find(call => call.method === 'PUT' && call.endpoint === 'actions/secrets/TOKENBOM_SECRETS_PAT');
            assert.ok(upload);
            const value = context.sodium.crypto_box_seal_open(new Uint8Array(Buffer.from(upload.payload.encrypted_value, 'base64')),
                api.pair.publicKey, api.pair.privateKey, 'text');
            assert.equal(value, 'synthetic-dedicated-pat');
            assert.ok(!JSON.stringify(result).includes(value));
            assert.ok(![...api.files.values()].join('').includes(value));
            api.calls.length = 0;
            const preserved = await service.handle({...payload, token: 'synthetic-new-connection-pat', accounts: [bom], secrets: {}});
            assert.equal(preserved.complete, true);
            assert.equal(preserved.saved_secrets.length, 0);
            assert.equal(mutations(api).length, 0);
        }
    });
    await runTest('TokenBom fallback includes merged remote accounts but requires an active account and Secret sync', async () => {
        const bom = {type: 'tokenbom', url: 'https://tokenbom.example', account_id: 'stable', refresh_token_env: 'BOM_REFRESH'};
        const {api, service, payload} = await createService();
        api.files.set('accounts.config.json', JSON.stringify([bom]));
        api.secrets.add('BOM_REFRESH');
        const merged = await service.handle(payload);
        assert.equal(merged.accounts.length, 2);
        assert.ok(merged.saved_secrets.includes('TOKENBOM_SECRETS_PAT'));
        for (const accounts of [[account()], [{...bom, enabled: false}]]) {
            const {api, service, payload} = await createService();
            api.secrets.add('NEW_TOKEN');
            const result = await service.handle({...payload, accounts, secrets: {}});
            assert.equal(result.complete, true);
            assert.ok(!api.secrets.has('TOKENBOM_SECRETS_PAT'));
            assert.ok(!api.calls.some(call => call.method === 'PUT'));
        }
        const blocked = await createService();
        await assert.rejects(() => blocked.service.handle({...blocked.payload, accounts: [bom],
            secrets: {BOM_REFRESH: 'synthetic-refresh'}, sync_secrets: false}), /必须同步 Secrets/);
        assert.equal(mutations(blocked.api).length, 0);
    });
    await runTest('Failed automatic renewal PAT upload reports partial save without credentials and can be retried', async () => {
        const {api, context, service, payload} = await createService();
        const bom = {type: 'tokenbom', url: 'https://tokenbom.example', account_id: 'stable', refresh_token_env: 'BOM_REFRESH'};
        api.failedSecrets.add('TOKENBOM_SECRETS_PAT');
        const failed = await service.handle({...payload, accounts: [bom], secrets: {BOM_REFRESH: 'synthetic-refresh'}});
        assert.equal(failed.complete, false);
        assert.deepEqual([...failed.failed_secrets], ['TOKENBOM_SECRETS_PAT']);
        for (const value of [payload.token, 'synthetic-refresh', 'synthetic-sensitive-upstream-error']) {
            assert.ok(!JSON.stringify(failed).includes(value));
        }
        assert.ok(!api.secrets.has('TOKENBOM_SECRETS_PAT'));
        api.failedSecrets.clear();
        api.calls.length = 0;
        const retried = await service.handle({...payload, accounts: [bom], secrets: {}});
        assert.equal(retried.complete, true);
        assert.deepEqual([...retried.saved_secrets], ['TOKENBOM_SECRETS_PAT']);
        assert.equal(api.commitCount, 1);
        const upload = api.calls.find(call => call.method === 'PUT');
        const value = context.sodium.crypto_box_seal_open(new Uint8Array(Buffer.from(upload.payload.encrypted_value, 'base64')),
            api.pair.publicKey, api.pair.privateKey, 'text');
        assert.equal(value, payload.token);
    });
    await runTest('TokenBom rejects public repositories, mixed credentials and duplicate names before writes', async () => {
        const bom = {type: 'tokenbom', url: 'https://tokenbom.example', account_id: 'stable', refresh_token_env: 'BOM_REFRESH'};
        for (const changes of [{private: false}, {changeVisibility: true}]) {
            const {api, service, payload} = await createService();
            Object.assign(api, changes);
            await assert.rejects(() => service.handle({...payload, accounts: [bom], secrets: {
                BOM_REFRESH: 'synthetic-refresh'}}));
            assert.equal(mutations(api).length, 0);
        }
        const {service} = await createService();
        for (const changes of [{refresh_token: 'synthetic-refresh'}, {refreshToken: 'synthetic-refresh'},
            {session_token_env: 'OTHER'}, {refresh_token_env: 'TOKENBOM_SECRETS_PAT'}, {url: 'http://tokenbom.example'}]) {
            assert.throws(() => service.validateAccounts([{...bom, ...changes}]));
        }
        assert.throws(() => service.validateAccounts([bom, {...bom, account_id: 'second'}]), /冲突/);
    });
    await runTest('TokenBom renewal PAT is excluded from explicitly hosted synthetic env content', async () => {
        for (const explicit of [false, true]) {
            const {api, service, payload} = await createService();
            const result = await service.handle({...payload, accounts: [{type: 'tokenbom', url: 'https://tokenbom.example',
                account_id: 'stable', refresh_token_env: 'BOM_REFRESH'}],
                secrets: {BOM_REFRESH: 'synthetic-refresh', ...(explicit ? {TOKENBOM_SECRETS_PAT: 'synthetic-renewal-pat'} : {})},
                include_env: true, confirm_plaintext_env: true}, {readEnvTemplate: async () => 'OLD_TOKEN=synthetic-old\n'});
            assert.ok(result.saved_secrets.includes('TOKENBOM_SECRETS_PAT'));
            assert.ok(!api.files.get('.env').includes('TOKENBOM_SECRETS_PAT'));
            for (const value of [payload.token, 'synthetic-renewal-pat']) {
                assert.ok(![...api.files.values()].join('').includes(value));
                assert.ok(!JSON.stringify(result).includes(value));
            }
        }
    });


    await runTest('account pause and resume preserve identity, workflow references and Secrets', async () => {
        for (const original of [account(), {type: 'vyceai', url: 'https://synthetic.example', account_id: 'synthetic-stable', name: 'VyceAI', session_token_env: 'NEW_TOKEN'}]) {
            const {api, service, payload} = await createService();
            const paused = {...original, enabled: false};
            const saved = await service.handle({...payload, accounts: [paused], secrets: {}});
            assert.equal(saved.accounts[1].enabled, false);
            assert.equal(api.secrets.size, 1);
            assert.ok(!api.readPaths.includes('.env'));
            for (const path of workflowFiles) assert.ok(api.files.get(path).includes('NEW_TOKEN: ' + String.fromCharCode(36) + '{{ secrets.NEW_TOKEN }}'));
            await assert.rejects(() => service.handle({...payload, accounts: [{...paused, enabled: true}], secrets: {}}), /Secret/);
            api.secrets.add('NEW_TOKEN');
            const resumed = await service.handle({...payload, accounts: [{...paused, enabled: true}], secrets: {}});
            assert.equal(resumed.accounts.length, 2);
            assert.equal(resumed.accounts[1].enabled, true);
            assert.ok(!api.calls.some(call => ['PUT', 'DELETE'].includes(call.method)));
            for (const value of ['false', null, 0, 1]) {
                assert.throws(() => service.validateAccounts([{...original, enabled: value}]), /enabled/);
            }
        }
    });
    await runTest('bundled crypto has pinned integrity values and never requires a third-party CDN', async () => {
        const expected = {
            'vendor/libsodium.js': '8abec6b42fafb418f58bff3fd665005b3e700ee02dae5042ce5704d27e6fcb23',
            'vendor/libsodium-wrappers.js': '828884732c06fa4443688b33ceb4ab42e6e1b99200e4749be375faa289e94158'
        };
        const html = fs.readFileSync(path.join(root, 'config_generator.html'), 'utf8');
        for (const [filename, digest] of Object.entries(expected)) {
            const content = fs.readFileSync(path.join(root, filename));
            assert.equal(crypto.createHash('sha256').update(content).digest('hex'), digest);
            const integrity = 'sha384-' + crypto.createHash('sha384').update(content).digest('base64');
            assert.ok(html.includes(`src="${filename}" integrity="${integrity}"`));
        }
        const {api} = await createService();
        assert.equal(api.calls.length, 0);
    });

    await runTest('Pages saves all public files in one commit and uploads only sealed-box Secrets', async () => {
        const {api, service, payload, context} = await createService();
        const result = await service.handle(payload);
        assert.equal(result.account_count, 2);
        assert.equal(api.commitCount, 1);
        assert.deepEqual([...result.changed_files].sort(), ['accounts.config.json', ...workflowFiles].sort());
        assert.ok(![...api.files.values()].join('').includes('synthetic-pages-token'));
        assert.ok(!JSON.stringify(result).includes('synthetic-pages-token'));
        assert.ok(!JSON.stringify(result).includes('synthetic-pages-pat'));
        assert.equal(result.accounts[0].name, '原有账号');
        const upload = api.calls.find(call => call.method === 'PUT');
        assert.deepEqual(Object.keys(upload.payload).sort(), ['encrypted_value', 'key_id']);
        const cipher = Uint8Array.from(Buffer.from(upload.payload.encrypted_value, 'base64'));
        const opened = context.sodium.crypto_box_seal_open(cipher, api.pair.publicKey, api.pair.privateKey);
        assert.equal(context.sodium.to_string(opened), 'synthetic-pages-token');
        assert.ok(api.calls.every(call => call.options.credentials === 'omit' && call.options.mode === 'cors'
            && call.options.redirect === 'error' && call.options.headers.Authorization === 'Bearer synthetic-pages-pat'));
    });

    await runTest('Pages loading reads only public metadata and never reads an env file or Secret value', async () => {
        const {api, service, payload} = await createService();
        api.files.set('.env', 'TOKEN=synthetic-private-env');
        const result = await service.handle({...payload, action: 'load'}, {
            readEnvTemplate: () => { throw new Error('Environment import must not happen during load'); }
        });
        assert.deepEqual(api.readPaths, ['accounts.config.json']);
        assert.equal(mutations(api).length, 0);
        assert.ok(!JSON.stringify(result).includes('synthetic-private-env'));
    });

    await runTest('default Pages save never reads a tracked env file or selected local template', async () => {
        const {api, service, payload} = await createService();
        api.files.set('.env', 'OTHER=synthetic-private-env');
        await service.handle(payload, {readEnvTemplate: () => { throw new Error('Unexpected private file read'); }});
        assert.ok(!api.readPaths.includes('.env'));
        assert.equal(api.files.get('.env'), 'OTHER=synthetic-private-env');
    });

    await runTest('public repositories cannot read or upload a selected env template', async () => {
        const {api, service, payload} = await createService();
        api.private = false;
        await assert.rejects(service.handle({...payload, include_env: true, confirm_plaintext_env: true}, {
            readEnvTemplate: () => { throw new Error('Private template must not be read'); }
        }), /公开仓库/);
        assert.equal(mutations(api).length, 0);
        assert.equal(api.readPaths.length, 0);
    });

    await runTest('env hosting requires explicit confirmation before reading files', async () => {
        const {api, service, payload} = await createService();
        await assert.rejects(service.handle({...payload, include_env: true}), /明确确认/);
        assert.equal(mutations(api).length, 0);
        assert.equal(api.readPaths.length, 0);
    });

    await runTest('first private env hosting uses a user-selected template and creates missing Secrets', async () => {
        const {api, service, payload} = await createService();
        api.secrets.clear();
        let reads = 0;
        const result = await service.handle({...payload, include_env: true, confirm_plaintext_env: true}, {
            readEnvTemplate: async () => {
                reads += 1;
                return '# synthetic env comment\nOTHER=synthetic-private-setting\nOLD_TOKEN=synthetic-old-token\n';
            }
        });
        assert.equal(reads, 1);
        assert.equal(result.changed_files.length, 4);
        assert.equal(api.commitCount, 1);
        assert.ok(api.files.get('.env').includes('# synthetic env comment'));
        assert.equal(service.envValues(api.files.get('.env')).OTHER, 'synthetic-private-setting');
        assert.equal(service.envValues(api.files.get('.env')).NEW_TOKEN, 'synthetic-pages-token');
        assert.deepEqual([...result.saved_secrets].sort(), ['NEW_TOKEN', 'OLD_TOKEN']);
        assert.ok(!JSON.stringify(result).includes('synthetic-private-setting'));
    });

    await runTest('existing remote env wins over a selected template and preserves unrelated variables', async () => {
        const {api, service, payload} = await createService();
        api.files.set('.env', 'OTHER=synthetic-remote-setting\nOLD_TOKEN=synthetic-old-token\n');
        await service.handle({...payload, include_env: true, confirm_plaintext_env: true}, {
            readEnvTemplate: () => { throw new Error('Existing remote env must be preserved'); }
        });
        assert.equal(service.envValues(api.files.get('.env')).OTHER, 'synthetic-remote-setting');
    });

    await runTest('a private env can be created entirely from form values without any local file', async () => {
        const {api, service, payload} = await createService();
        await service.handle({...payload, mode: 'replace', include_env: true, confirm_plaintext_env: true});
        assert.equal(service.envValues(api.files.get('.env')).NEW_TOKEN, 'synthetic-pages-token');
    });

    await runTest('repository privacy is rechecked immediately before uploading env', async () => {
        const {api, service, payload} = await createService();
        api.changeVisibility = true;
        await assert.rejects(service.handle({...payload, mode: 'replace', include_env: true, confirm_plaintext_env: true}), /已变为公开/);
        assert.equal(mutations(api).length, 0);
    });

    await runTest('branch conflicts cannot overwrite a remote branch or mutate Secrets', async () => {
        const {api, service, payload} = await createService();
        api.conflict = true;
        await assert.rejects(service.handle(payload), error => /并发变更/.test(error.message)
            && !error.message.includes('synthetic-sensitive-upstream-error'));
        assert.equal(api.calls.filter(call => call.method === 'PUT').length, 0);
        assert.equal(JSON.parse(api.files.get('accounts.config.json')).length, 1);
    });

    await runTest('Secret failure reports partial success without exposing upstream details or values', async () => {
        const {api, service, payload} = await createService();
        api.failedSecrets.add('NEW_TOKEN');
        const result = await service.handle({...payload, accounts: [account(), account('THIRD_TOKEN', '789')],
            secrets: {NEW_TOKEN: 'synthetic-pages-token', THIRD_TOKEN: 'synthetic-third-token'}});
        assert.deepEqual([...result.saved_secrets], ['THIRD_TOKEN']);
        assert.equal(result.complete, false);
        assert.deepEqual([...result.failed_secrets], ['NEW_TOKEN']);
        assert.ok(result.warnings[0].includes('不会自动回滚') && result.warnings[0].includes('NEW_TOKEN'));
        assert.ok(!JSON.stringify(result).includes('synthetic-sensitive-upstream-error'));
        assert.ok(!JSON.stringify(result).includes('synthetic-pages-token'));
    });

    await runTest('blank existing Secrets remain unchanged and a second save is idempotent', async () => {
        const {api, service, payload} = await createService();
        await service.handle(payload);
        api.calls = [];
        const result = await service.handle({...payload, secrets: {NEW_TOKEN: ''}});
        assert.equal(result.changed_files.length, 0);
        assert.equal(api.commitCount, 1);
        assert.ok(!api.calls.some(call => call.method === 'PUT' || call.endpoint === 'actions/secrets/public-key'));
    });

    await runTest('replace removes obsolete account mappings but preserves cron and unrelated workflow env', async () => {
        const {api, service, payload} = await createService();
        await service.handle({...payload, mode: 'replace'});
        for (const filename of workflowFiles) {
            const content = api.files.get(filename);
            assert.ok(!content.includes('OLD_TOKEN:'));
            assert.ok(content.includes('NEW_TOKEN: ${{ secrets.NEW_TOKEN }}'));
            assert.ok(content.includes('NEWAPI_CONFIG_FILE: ${{ inputs.config_file }}'));
            assert.ok(content.includes('EMAIL_PASS: ${{ secrets.EMAIL_PASS }}'));
            assert.ok(content.includes("cron: '10 0 * * *'"));
            assert.ok(content.includes('run: echo done'));
        }
        assert.ok(api.secrets.has('OLD_TOKEN'));
    });

    await runTest('missing credentials and conflicting names abort before any mutations', async () => {
        const {api, service, payload} = await createService();
        await assert.rejects(service.handle({...payload, secrets: {}}), /缺少 (?:Actions )?Secret/);
        await assert.rejects(service.handle({...payload, accounts: [account('OLD_TOKEN')],
            secrets: {OLD_TOKEN: 'synthetic-value'}}), /变量名冲突/);
        assert.equal(mutations(api).length, 0);
    });

    await runTest('invalid repository names, PATs and local-write requests never send API calls', async () => {
        const {api, service, payload} = await createService();
        for (const overrides of [{repository: 'https://evil.example/repo'}, {repository: '../repo'},
            {token: 'synthetic\npat'}, {sync_local: true}]) {
            await assert.rejects(service.handle({...payload, ...overrides}));
        }
        assert.equal(api.calls.length, 0);
    });

    await runTest('public metadata rejects plaintext credentials, reserved env names and guessed user IDs', async () => {
        const {service} = await createService();
        for (const overrides of [{access_token: 'synthetic-token'}, {session: 'synthetic-cookie'},
            {access_token_env: 'GITHUB_TOKEN'}, {access_token_env: 'PATH'}, {access_token_env: 'EMAIL_PASS'},
            {access_token_env: 'NEWAPI_PROXY'}, {cf_clearance_env: 'NEWAPI_PROXY'},
            {access_token_env: 'NEWAPI_CAPTCHA_OCR'}, {cf_clearance_env: 'NEWAPI_CAPTCHA_OCR'},
            {user_id: 'username_123'}, {user_id: true}, {url: 'https://user:pass@example.com'},
            {url: 'https://api.example.com?token=synthetic'}, {cf_clearance_env: 'NEW_TOKEN'}]) {
            assert.throws(() => service.validateAccounts([{...account(), ...overrides}]));
        }
    });

    await runTest('explicit invalid save flags and modes cannot silently use default values', async () => {
        const {api, service, payload} = await createService();
        for (const key of ['include_env', 'sync_secrets', 'sync_local']) {
            for (const value of [null, '', 0, 'false']) {
                await assert.rejects(service.handle({...payload, [key]: value}));
            }
        }
        for (const mode of [null, '', 0, false, 'unsupported']) {
            await assert.rejects(service.handle({...payload, mode}), /保存模式/);
        }
        assert.equal(mutations(api).length, 0);
        assert.ok(!api.readPaths.includes('.env'));
    });

    await runTest('PushPlus remains compatible with account exports and encrypted settings', async () => {
        const {api, service, payload} = await createService();
        const result = await service.handle({...payload,
            notifications: {pushplus: {mode: 'enable', only_failure: true}},
            secrets: {...payload.secrets, PUSHPLUS_TOKEN: 'synthetic-pushplus-token'}});
        assert.equal(result.complete, true);
        assert.ok(result.saved_secrets.includes('PUSHPLUS_TOKEN'));
        for (const content of api.files.values()) assert.ok(!content.includes('synthetic-pushplus-token'));
        for (const filename of workflowFiles) {
            const content = api.files.get(filename);
            assert.ok(content.includes('PushPlus result notification (Pages)'));
            assert.ok(content.includes('PUSHPLUS_TOKEN: ${{ secrets.PUSHPLUS_TOKEN }}'));
            assert.equal(service.updatePushplusWorkflow(content, {mode: 'enable', only_failure: true}), content);
        }
    });

    await runTest('provided credentials cannot be discarded with every destination off', async () => {
        const {api, service, payload} = await createService();
        await assert.rejects(service.handle({...payload, sync_secrets: false}), /避免丢失凭证/);
        assert.equal(mutations(api).length, 0);
        const result = await service.handle({...payload, sync_secrets: false, secrets: {}});
        assert.equal(result.complete, true);
        assert.deepEqual([...result.failed_secrets], []);
        assert.ok(result.warnings.length);
        assert.ok(!api.calls.some(call => call.method === 'PUT'));
    });

    await runTest('unsupported and multiline env mappings are rejected instead of corrupting YAML', async () => {
        const {service} = await createService();
        for (const content of [workflow.replace('env:\n', 'env: {}\n'), workflow.replace('python checkin.py', 'echo noop'),
            workflow.replace('OLD_TOKEN: ${{ secrets.OLD_TOKEN }}', 'OLD_TOKEN: | # synthetic comment\n            synthetic multiline')]) {
            assert.throws(() => service.updateWorkflow(content, ['OLD_TOKEN'], ['NEW_TOKEN']));
        }
    });

    await runTest('env updates preserve comments, unrelated variables, exports and CRLF without duplicate stale values', async () => {
        const {service} = await createService();
        const updated = service.updateEnvContent('# synthetic comment\r\nexport NEW_TOKEN=synthetic-old\r\n'
            + 'OTHER=synthetic-other\r\nNEW_TOKEN=synthetic-duplicate', ['NEW_TOKEN', 'OTHER', 'THIRD_TOKEN'],
            {NEW_TOKEN: 'synthetic=value#token'});
        assert.ok(updated.includes('# synthetic comment\r\n'));
        assert.ok(updated.includes('OTHER=synthetic-other\r\n'));
        assert.ok(!updated.includes('synthetic-old') && !updated.includes('synthetic-duplicate'));
        assert.equal(service.envValues(updated).NEW_TOKEN, 'synthetic=value#token');
        assert.equal(service.envValues(updated).THIRD_TOKEN, '');
    });
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
