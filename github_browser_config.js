globalThis.GitHubBrowserConfig = (() => {
    const accountFile = 'accounts.config.json';
    const workflowFiles = ['.github/workflows/checkin.yml', '.github/workflows/checkin-gha-test.yml'];
    const publicFields = new Set(['url', 'user_id', 'name', 'access_token_env', 'cf_clearance_env']);
    const reservedNames = new Set([
        'NEWAPI_CONFIG_FILE', 'NEWAPI_ACCOUNTS', 'CONFIG_URL', 'CONFIG_AUTH', 'NOTIFY_ONLY_FAILURE',
        'PATH', 'HOME', 'PYTHONPATH', 'PYTHONHOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'ENV',
        'DINGTALK_WEBHOOK', 'DINGTALK_SECRET', 'SERVERCHAN_SENDKEY', 'EMAIL_SMTP_HOST',
        'EMAIL_SMTP_PORT', 'EMAIL_USER', 'EMAIL_PASS', 'EMAIL_TO', 'EMAIL_FROM'
    ]);

    function validateEnvName(name) {
        if (typeof name !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(name) || name.length > 100
                || /^(GITHUB_|RUNNER_)/.test(name) || reservedNames.has(name)) {
            throw new Error('令牌变量名必须为大写字母、数字和下划线，且不能使用系统或通知保留变量');
        }
        return name;
    }

    function validateAccounts(accounts) {
        if (!Array.isArray(accounts) || accounts.length > 200) throw new Error('账号配置必须是数组，且不超过 200 个账号');
        const identities = new Set();
        const tokenNames = new Set();
        const validated = accounts.map(account => {
            if (!account || typeof account !== 'object' || Array.isArray(account)
                    || Object.keys(account).some(field => !publicFields.has(field))) {
                throw new Error('账号 JSON 只能包含公开字段，真实令牌、Cookie 和密码必须单独保存');
            }
            const rawUrl = account.url;
            let parsed;
            try {
                if (typeof rawUrl !== 'string' || rawUrl.length > 2048 || /\s/.test(rawUrl)) throw new Error();
                parsed = new URL(rawUrl);
                if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname
                        || parsed.username || parsed.password || rawUrl.includes('?') || rawUrl.includes('#')) throw new Error();
            } catch {
                throw new Error('站点 URL 必须是 http/https 地址，不能包含凭证、查询参数或片段');
            }
            const url = parsed.href.replace(/\/+$/, '');
            if (!['string', 'number'].includes(typeof account.user_id)
                    || (typeof account.user_id === 'number' && !Number.isSafeInteger(account.user_id))) {
                throw new Error('用户 ID 必须是来自站点个人信息的正整数');
            }
            const userId = String(account.user_id).trim();
            if (!/^[1-9][0-9]*$/.test(userId)) throw new Error('用户 ID 必须是来自站点个人信息的正整数');
            const tokenName = validateEnvName(account.access_token_env);
            const identity = JSON.stringify([url, userId]);
            if (identities.has(identity) || tokenNames.has(tokenName)) {
                throw new Error('账号重复或令牌变量名冲突；请先从 GitHub 加载，并为不同账号使用独立变量名');
            }
            const name = account.name || `${parsed.hostname}-${userId}`;
            if (typeof name !== 'string' || name.length > 200) throw new Error('备注名称必须是不超过 200 个字符的文本');
            const publicAccount = {url, user_id: userId, name, access_token_env: tokenName};
            if (account.cf_clearance_env) publicAccount.cf_clearance_env = validateEnvName(account.cf_clearance_env);
            identities.add(identity);
            tokenNames.add(tokenName);
            return publicAccount;
        });
        if (validated.some(account => tokenNames.has(account.cf_clearance_env))) {
            throw new Error('CF Clearance 和系统访问令牌不能使用同一个变量名');
        }
        return validated;
    }

    function envNames(accounts) {
        return [...new Set(accounts.flatMap(account => [account.access_token_env, account.cf_clearance_env].filter(Boolean)))];
    }

    function mergeAccounts(existing, incoming, mode) {
        if (mode === 'replace') return validateAccounts(incoming);
        if (mode !== 'merge') throw new Error('账号保存模式必须是 merge 或 replace');
        const merged = new Map(existing.map(account => [JSON.stringify([account.url, account.user_id]), {...account}]));
        incoming.forEach(account => {
            const identity = JSON.stringify([account.url, account.user_id]);
            merged.set(identity, {...merged.get(identity), ...account});
        });
        return validateAccounts([...merged.values()]);
    }

    function contentLines(content) {
        return content.match(/[^\n]*\n|[^\n]+$/g) || [];
    }

    function indentation(line) {
        return line.length - line.trimStart().length;
    }

    function updateWorkflow(content, previousNames, currentNames) {
        const lines = contentLines(content);
        const runIndexes = lines.flatMap((line, index) => /^\s+run:.*\bcheckin\.py\b/.test(line) ? [index] : []);
        if (!runIndexes.length) throw new Error('工作流中未找到单行 run: ... checkin.py，未修改文件');
        const managed = new Set([...previousNames, ...currentNames]);
        const newline = content.includes('\r\n') ? '\r\n' : '\n';
        for (const runIndex of runIndexes.reverse()) {
            const runIndent = indentation(lines[runIndex]);
            const stepPattern = new RegExp(`^ {${runIndent - 2}}-\\s`);
            let stepStart = runIndex - 1;
            while (stepStart >= 0 && !stepPattern.test(lines[stepStart])) stepStart -= 1;
            if (stepStart < 0) throw new Error('无法识别签到工作流的步骤边界');
            let stepEnd = runIndex + 1;
            while (stepEnd < lines.length && !stepPattern.test(lines[stepEnd])) stepEnd += 1;
            const envPattern = new RegExp(`^ {${runIndent}}env:`);
            const envIndexes = [];
            for (let index = stepStart; index < stepEnd; index += 1) {
                if (envPattern.test(lines[index])) envIndexes.push(index);
            }
            const generated = currentNames.map(name => `${' '.repeat(runIndent + 2)}${name}: \${{ secrets.${name} }}${newline}`);
            if (!envIndexes.length) {
                lines.splice(runIndex, 0, `${' '.repeat(runIndent)}env:${newline}`, ...generated);
                continue;
            }
            if (envIndexes.length !== 1 || !/^\s+env:\s*(?:#[^\r\n]*)?\r?\n?$/.test(lines[envIndexes[0]])) {
                throw new Error('签到步骤的 env 必须是普通 YAML 映射，未修改文件');
            }
            const envIndex = envIndexes[0];
            let envEnd = envIndex + 1;
            while (envEnd < stepEnd && (!lines[envEnd].trim() || indentation(lines[envEnd]) > runIndent)) envEnd += 1;
            const variablePattern = new RegExp(`^ {${runIndent + 2}}([A-Z_][A-Z0-9_]*):\\s*(.*)`);
            const preserved = [];
            for (let index = envIndex + 1; index < envEnd; index += 1) {
                const matched = lines[index].match(variablePattern);
                if (matched && managed.has(matched[1])) {
                    let nextIndex = index + 1;
                    while (nextIndex < envEnd && (!lines[nextIndex].trim() || lines[nextIndex].trimStart().startsWith('#'))) nextIndex += 1;
                    if (/^[|>]/.test(matched[2].trim())
                            || (nextIndex < envEnd && indentation(lines[nextIndex]) > runIndent + 2)) {
                        throw new Error('账号变量必须使用单行映射，未修改工作流');
                    }
                } else preserved.push(lines[index]);
            }
            lines.splice(envIndex + 1, envEnd - envIndex - 1, ...generated, ...preserved);
        }
        return lines.join('');
    }

    function envValues(content) {
        const values = Object.create(null);
        for (const line of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
            const matched = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=(.*)$/);
            if (!matched) continue;
            const value = matched[2].trim();
            const quoted = value.match(/^(["'])(.*?)\1(?:\s+#.*)?$/);
            values[matched[1]] = quoted ? quoted[2] : value.split(' #')[0].trimEnd();
        }
        return values;
    }

    function updateEnvContent(content, names, values) {
        const newline = content.includes('\r\n') ? '\r\n' : '\n';
        const lines = contentLines(content.replace(/^\uFEFF/, ''));
        const present = new Set();
        const assignments = new Map();
        for (const [name, value] of Object.entries(values)) {
            if (!names.includes(name)) continue;
            const delimiter = value.includes("'") ? '"' : "'";
            if (value.includes(delimiter)) throw new Error('保存到 .env 的令牌不能同时包含两种引号');
            assignments.set(name, `${name}=${delimiter}${value}${delimiter}${newline}`);
        }
        lines.forEach((line, index) => {
            const matched = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/);
            if (!matched) return;
            present.add(matched[1]);
            if (assignments.has(matched[1])) lines[index] = assignments.get(matched[1]);
        });
        const missing = names.filter(name => !present.has(name));
        if (missing.length && lines.length && !/[\r\n]$/.test(lines[lines.length - 1])) lines[lines.length - 1] += newline;
        lines.push(...missing.map(name => assignments.get(name) || `${name}=${newline}`));
        return lines.join('');
    }

    function validateSha(sha) {
        if (typeof sha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) {
            throw new Error('GitHub 返回了无效的 Git 对象标识');
        }
        return sha;
    }

    class Client {
        constructor(repository, token) {
            if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
                    || repository.split('/').some(part => ['.', '..'].includes(part))) {
                throw new Error('仓库格式必须是 owner/repo，不要填写 URL');
            }
            if (typeof token !== 'string' || !token.trim() || /[^\x21-\x7e]/.test(token.trim())) {
                throw new Error('请填写有效的 GitHub Personal Access Token');
            }
            this.repository = repository;
            this.token = token.trim();
        }

        async request(method, endpoint = '', payload) {
            const url = `https://api.github.com/repos/${this.repository}` + (endpoint ? '/' + endpoint : '');
            const headers = {Authorization: 'Bearer ' + this.token, Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28'};
            if (payload !== undefined) headers['Content-Type'] = 'application/json';
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30000);
            try {
                let response;
                try {
                    response = await fetch(url, {method, headers, body: payload === undefined ? undefined : JSON.stringify(payload),
                        credentials: 'omit', mode: 'cors', redirect: 'error', cache: 'no-store',
                        referrerPolicy: 'no-referrer', signal: controller.signal});
                } catch {
                    throw new Error('无法连接 GitHub API，请检查网络或浏览器限制后重试；不会使用第三方代理');
                }
                if (!response.ok) {
                    const messages = {
                        401: 'GitHub PAT 无效或已过期',
                        403: 'GitHub 拒绝操作：请检查 Contents、Workflows、Secrets 权限、分支保护和 API 限流',
                        404: 'GitHub 仓库或分支不存在，或 PAT 未获得该私有仓库的访问权限',
                        409: 'GitHub 分支已变更或仓库为空，请刷新配置后重试',
                        422: 'GitHub 拒绝更新：可能是分支并发变更、分支保护或仓库规则，请刷新后重试'
                    };
                    throw new Error(messages[response.status] || 'GitHub API 操作失败，请稍后重试');
                }
                if (response.status === 204) return {};
                const text = await response.text();
                if (!text.trim()) return {};
                try {
                    return JSON.parse(text);
                } catch {
                    throw new Error('GitHub API 返回了无效的 JSON 响应');
                }
            } finally {
                clearTimeout(timeout);
            }
        }

        async snapshot(requestedBranch) {
            const info = await this.request('GET');
            const branch = requestedBranch || info.default_branch;
            if (typeof branch !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(branch) || branch.includes('..')
                    || branch.includes('//') || /(?:\/|\.|\.lock)$/.test(branch) || /^[/.]/.test(branch)) {
                throw new Error('分支名称格式错误');
            }
            const reference = await this.request('GET', 'git/ref/heads/' + encodeURIComponent(branch));
            const head = validateSha(reference.object?.sha);
            const commit = await this.request('GET', 'git/commits/' + head);
            const treeSha = validateSha(commit.tree?.sha);
            const tree = await this.request('GET', `git/trees/${treeSha}?recursive=1`);
            if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('仓库文件树过大或格式错误，无法安全同步');
            return new Snapshot(this, branch, info.private === true, head, treeSha, tree.tree);
        }

        async secretNames() {
            const names = new Set();
            for (let page = 1; page <= 100; page += 1) {
                const result = await this.request('GET', `actions/secrets?per_page=100&page=${page}`);
                if (!Array.isArray(result.secrets)) throw new Error('GitHub Secrets 列表格式错误');
                result.secrets.forEach(secret => names.add(secret.name));
                if (result.secrets.length < 100) return names;
            }
            throw new Error('Secrets 列表过大，已停止同步');
        }
    }

    class Snapshot {
        constructor(client, branch, privateRepository, head, treeSha, entries) {
            Object.assign(this, {client, branch, privateRepository, head, treeSha});
            this.entries = new Map(entries.map(entry => [entry.path, entry]));
            this.contents = new Map();
        }

        async read(path) {
            if (this.contents.has(path)) return this.contents.get(path);
            const entry = this.entries.get(path);
            if (!entry) {
                this.contents.set(path, null);
                return null;
            }
            if (entry.type !== 'blob' || entry.mode !== '100644') throw new Error('配置文件必须是普通文本文件，不能是符号链接或可执行文件');
            const blob = await this.client.request('GET', 'git/blobs/' + validateSha(entry.sha));
            if (blob.encoding !== 'base64' || blob.size > 1024 * 1024 || typeof blob.content !== 'string') {
                throw new Error('配置文件编码不支持或超过 1 MB');
            }
            let content;
            try {
                const bytes = Uint8Array.from(atob(blob.content.replace(/\s/g, '')), character => character.charCodeAt(0));
                if (bytes.length > 1024 * 1024) throw new Error();
                content = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
            } catch {
                throw new Error('配置文件必须使用有效的 Base64 和 UTF-8 编码');
            }
            this.contents.set(path, content);
            return content;
        }

        async commit(files) {
            const changed = [];
            for (const [path, content] of files) {
                if (content !== await this.read(path)) changed.push({path, mode: '100644', type: 'blob', content});
            }
            if (!changed.length) return {sha: this.head, files: []};
            const tree = await this.client.request('POST', 'git/trees', {base_tree: this.treeSha, tree: changed});
            const commit = await this.client.request('POST', 'git/commits', {
                message: 'chore: sync check-in account configuration', tree: validateSha(tree.sha), parents: [this.head]
            });
            const sha = validateSha(commit.sha);
            await this.client.request('PATCH', 'git/refs/heads/' + encodeURIComponent(this.branch), {sha, force: false});
            return {sha, files: changed.map(entry => entry.path)};
        }
    }

    async function readAccounts(snapshot) {
        const content = await snapshot.read(accountFile);
        if (content === null) return [];
        let accounts;
        try {
            accounts = JSON.parse(content);
        } catch {
            throw new Error('远端 accounts.config.json 不是有效的 JSON，未修改仓库');
        }
        return validateAccounts(accounts);
    }

    async function encryptSecrets(client, values) {
        if (!Object.keys(values).length) return new Map();
        if (!globalThis.sodium?.ready) throw new Error('浏览器加密库未加载，请刷新页面并检查 vendor 静态资源');
        await globalThis.sodium.ready;
        const sodium = globalThis.sodium;
        const info = await client.request('GET', 'actions/secrets/public-key');
        let publicKey;
        try {
            publicKey = sodium.from_base64(info.key, sodium.base64_variants.ORIGINAL);
            if (publicKey.length !== sodium.crypto_box_PUBLICKEYBYTES || !info.key_id) throw new Error();
        } catch {
            throw new Error('GitHub Secrets 公钥格式错误');
        }
        const encrypted = new Map();
        for (const [name, value] of Object.entries(values)) {
            const message = sodium.from_string(value);
            try {
                encrypted.set(name, {key_id: info.key_id,
                    encrypted_value: sodium.to_base64(sodium.crypto_box_seal(message, publicKey), sodium.base64_variants.ORIGINAL)});
            } finally {
                sodium.memzero(message);
            }
        }
        return encrypted;
    }

    async function handle(payload, options = {}) {
        if (!payload || !['load', 'save'].includes(payload.action)) throw new Error('操作必须是 load 或 save');
        if (payload.action === 'save' && payload.sync_local) throw new Error('远程网页无法修改设备本地文件；请取消本地回写，改为从仓库拉取');
        const client = new Client(payload.repository, payload.token);
        try {
            const snapshot = await client.snapshot(payload.branch);
            if (payload.action === 'load') {
                return {accounts: await readAccounts(snapshot), repository: client.repository,
                    branch: snapshot.branch, private: snapshot.privateRepository};
            }
            const flags = {};
            for (const [key, defaultValue] of [['include_env', false], ['sync_secrets', true], ['sync_local', false]]) {
                flags[key] = Object.prototype.hasOwnProperty.call(payload, key) ? payload[key] : defaultValue;
                if (typeof flags[key] !== 'boolean') throw new Error('保存选项必须是布尔值');
            }
            if (flags.include_env && payload.confirm_plaintext_env !== true) throw new Error('必须明确确认将明文 .env 写入 Git 历史的风险');
            if (flags.include_env && !snapshot.privateRepository) throw new Error('禁止向公开仓库提交 .env；仅允许明确确认后的私有仓库');
            const incoming = validateAccounts(payload.accounts);
            if (!incoming.length) throw new Error('至少需要配置一个账号');
            const existing = await readAccounts(snapshot);
            const accounts = mergeAccounts(existing, incoming, payload.mode === undefined ? 'merge' : payload.mode);
            const names = envNames(accounts);
            const inputValues = payload.secrets ?? {};
            if (!inputValues || typeof inputValues !== 'object' || Array.isArray(inputValues)
                    || Object.keys(inputValues).some(name => !names.includes(name))) throw new Error('凭证只能对应当前账号的环境变量名');
            const providedValues = Object.create(null);
            for (const [name, rawValue] of Object.entries(inputValues)) {
                if (typeof rawValue !== 'string' || new TextEncoder().encode(rawValue).length > 48 * 1024) throw new Error('令牌必须是小于 48 KB 的文本');
                const value = rawValue.trim();
                if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('令牌不能包含换行或控制字符');
                if (value) providedValues[name] = value;
            }
            const files = new Map([[accountFile, JSON.stringify(accounts, null, 2) + '\n']]);
            for (const path of workflowFiles) {
                const content = await snapshot.read(path);
                if (content === null) throw new Error('远端缺少签到工作流，请先将项目代码推送到仓库');
                files.set(path, updateWorkflow(content, envNames(existing), names));
            }
            if (flags.include_env) {
                const remoteEnv = await snapshot.read('.env');
                const template = remoteEnv === null ? await (options.readEnvTemplate?.() ?? '') : remoteEnv;
                if (typeof template !== 'string' || new TextEncoder().encode(template).length > 1024 * 1024) throw new Error('.env 模板必须是小于 1 MB 的文本');
                const updatedEnv = updateEnvContent(template, names, providedValues);
                const missing = names.filter(name => !envValues(updatedEnv)[name]);
                if (missing.length) throw new Error('.env 缺少令牌：' + missing.join('、')
                    + '。请在表单中填写，或首次选择 .env 文件；首次创建需要保存后全部账号的令牌，已有 Actions Secrets 的值无法读回。也可取消明文 .env 托管。本次尚未写入任何文件或 Secrets。');
                files.set('.env', updatedEnv);
            }
            let encrypted = new Map();
            if (flags.sync_secrets) {
                const existingSecrets = await client.secretNames();
                const secretValues = {...providedValues};
                const hostedValues = envValues(files.get('.env') || '');
                names.forEach(name => {
                    if (!existingSecrets.has(name) && !secretValues[name] && hostedValues[name]) secretValues[name] = hostedValues[name];
                });
                const missing = names.filter(name => !existingSecrets.has(name) && !secretValues[name]);
                if (missing.length) throw new Error('新账号缺少 Secret，请填写令牌：' + missing.join('、'));
                encrypted = await encryptSecrets(client, secretValues);
            }
            if (flags.include_env && (await client.request('GET')).private !== true) throw new Error('仓库已变为公开，已取消 .env 上传；请检查仓库可见性后重试');
            const commit = await snapshot.commit(files);
            const savedSecrets = [];
            const failedSecrets = [];
            const warnings = [];
            for (const [name, value] of encrypted) {
                try {
                    await client.request('PUT', 'actions/secrets/' + name, value);
                    savedSecrets.push(name);
                } catch (error) {
                    failedSecrets.push(name);
                    warnings.push(`Secret ${name} 同步失败或结果无法确认：${error.message}。已写入的文件和 Secrets 不会自动回滚，请核对后重试。`);
                }
            }
            if (!flags.sync_secrets) warnings.push('未自动同步 Secrets；请确保所有账号变量已有同名 GitHub Actions Secret。');
            return {repository: client.repository, branch: snapshot.branch, private: snapshot.privateRepository,
                accounts, account_count: accounts.length, commit_sha: commit.sha,
                commit_url: `https://github.com/${client.repository}/commit/${commit.sha}`,
                changed_files: commit.files, saved_secrets: savedSecrets, failed_secrets: failedSecrets,
                complete: failedSecrets.length === 0, local_updated: false, warnings};
        } finally {
            client.token = '';
        }
    }

    return Object.freeze({handle, validateAccounts, mergeAccounts, envNames, updateWorkflow,
        envValues, updateEnvContent, encryptSecrets});
})();
