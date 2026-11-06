globalThis.GitHubBrowserConfig = (() => {
    const accountFile = 'accounts.config.json';
    const workflowFiles = ['.github/workflows/checkin.yml', '.github/workflows/checkin-gha-test.yml'];
    const publicFields = new Set(['type', 'url', 'user_id', 'name', 'access_token_env', 'cf_clearance_env', 'account_id', 'session_token_env', 'refresh_token_env', 'enabled']);
    const automationSecret = 'TOKENBOM_SECRETS_PAT';
    const reservedNames = new Set([automationSecret, 'TOKENBOM_WRITE_CHECK',
        'NEWAPI_CONFIG_FILE', 'NEWAPI_ACCOUNTS', 'NEWAPI_PROXY', 'NEWAPI_CAPTCHA_OCR', 'CONFIG_URL', 'CONFIG_AUTH', 'NOTIFY_ONLY_FAILURE',
        'PATH', 'HOME', 'PYTHONPATH', 'PYTHONHOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'ENV',
        'DINGTALK_WEBHOOK', 'DINGTALK_SECRET', 'SERVERCHAN_SENDKEY', 'PUSHPLUS_TOKEN', 'EMAIL_SMTP_HOST',
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
            const kind = account.type === undefined ? 'newapi' : account.type;
            if (!['newapi', 'vyceai', 'tokenbom'].includes(kind)) throw new Error('不支持的站点类型，仅支持 newapi / vyceai / tokenbom');
            let identifier, tokenName, publicAccount;
            if (kind === 'vyceai' || kind === 'tokenbom') {
                const reference = kind === 'tokenbom' ? 'refresh_token_env' : 'session_token_env';
                const label = kind === 'tokenbom' ? 'TokenBom' : 'VyceAI';
                if (kind === 'tokenbom' && parsed.protocol !== 'https:') throw new Error('TokenBom 必须使用 HTTPS 站点地址');
                const fields = new Set(['type', 'url', 'account_id', 'name', reference, 'enabled']);
                if (Object.keys(account).some(key => !fields.has(key))) throw new Error(label + ' 不能混用其他站点的认证字段');
                identifier = account.account_id;
                if (typeof identifier !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(identifier)) {
                    throw new Error(label + ' account_id 必须是 1–80 位字母、数字、下划线或短横线');
                }
                tokenName = validateEnvName(account[reference]);
                publicAccount = {type: kind, url, account_id: identifier, [reference]: tokenName};
            } else {
                if ('account_id' in account || 'session_token_env' in account || 'refresh_token_env' in account) throw new Error('NewAPI 不使用 VyceAI 认证字段');
                if (!['string', 'number'].includes(typeof account.user_id)
                        || (typeof account.user_id === 'number' && !Number.isSafeInteger(account.user_id))) {
                    throw new Error('用户 ID 必须是来自站点个人信息的正整数');
                }
                identifier = String(account.user_id).trim();
                if (!/^[1-9][0-9]*$/.test(identifier)) throw new Error('用户 ID 必须是来自站点个人信息的正整数');
                tokenName = validateEnvName(account.access_token_env);
                publicAccount = {url, user_id: identifier, access_token_env: tokenName};
            }
            const identity = JSON.stringify([kind, url, identifier]);
            if (identities.has(identity) || tokenNames.has(tokenName)) {
                throw new Error('账号重复或令牌变量名冲突；请先从 GitHub 加载，并为不同账号使用独立变量名');
            }
            const name = account.name || `${parsed.hostname}-${identifier}`;
            if (typeof name !== 'string' || name.length > 200) throw new Error('备注名称必须是不超过 200 个字符的文本');
            publicAccount.name = name;
            if ('enabled' in account) {
                if (typeof account.enabled !== 'boolean') throw new Error('enabled 必须是布尔值 true 或 false');
                publicAccount.enabled = account.enabled;
            }
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
        return [...new Set(accounts.flatMap(account => [account.access_token_env, account.session_token_env, account.refresh_token_env, account.cf_clearance_env].filter(Boolean)))];
    }

    function workflowNames(accounts) {
        return [...envNames(accounts), ...(accounts.some(account => account.type === 'tokenbom') ? [automationSecret] : [])];
    }

    function accountIdentity(account) {
        return JSON.stringify([account.type || 'newapi', account.url,
            ['vyceai', 'tokenbom'].includes(account.type) ? account.account_id : account.user_id]);
    }

    function mergeAccounts(existing, incoming, mode) {
        if (mode === 'replace') return validateAccounts(incoming);
        if (mode !== 'merge') throw new Error('账号保存模式必须是 merge 或 replace');
        const merged = new Map(existing.map(account => [accountIdentity(account), {...account}]));
        incoming.forEach(account => {
            const identity = accountIdentity(account);
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

    function workflowSteps(lines) {
        const steps = [];
        for (let header = 0; header < lines.length; header += 1) {
            if (!/^\s+steps:\s*(?:#[^\r\n]*)?\r?\n?$/.test(lines[header])) continue;
            const headerIndent = indentation(lines[header]);
            let end = header + 1;
            while (end < lines.length && (!lines[end].trim() || lines[end].trimStart().startsWith('#')
                    || indentation(lines[end]) > headerIndent
                    || (indentation(lines[end]) === headerIndent && /^\s+-\s/.test(lines[end])))) end += 1;
            let stepIndent;
            let start;
            for (let index = header + 1; index < end; index += 1) {
                if (!/^\s+-\s/.test(lines[index])) continue;
                if (stepIndent === undefined) stepIndent = indentation(lines[index]);
                if (indentation(lines[index]) !== stepIndent) continue;
                if (start !== undefined) steps.push({start, end: index, indent: stepIndent});
                start = index;
            }
            if (start !== undefined) steps.push({start, end, indent: stepIndent});
            header = end - 1;
        }
        return steps;
    }

    function stepField(lines, step, key) {
        const pattern = new RegExp(`^ {${step.indent + 2}}${key}:\\s*(.*?)\\s*$`);
        for (let index = step.start; index < step.end; index += 1) {
            const line = index === step.start ? lines[index].replace(/^(\s*)-\s/, '$1  ') : lines[index];
            const matched = line.match(pattern);
            if (matched) return {index, value: matched[1]};
        }
        return null;
    }

    function pushplusOptions(payload) {
        const config = payload.notifications;
        if (config === undefined) return {mode: 'preserve', only_failure: false};
        if (!config || typeof config !== 'object' || Array.isArray(config)
                || Object.keys(config).some(key => key !== 'pushplus')) throw new Error('结果推送配置格式错误');
        const pushplus = config.pushplus;
        if (!pushplus || typeof pushplus !== 'object' || Array.isArray(pushplus)
                || Object.keys(pushplus).some(key => !['mode', 'only_failure'].includes(key))
                || !['preserve', 'enable', 'disable'].includes(pushplus.mode)
                || typeof pushplus.only_failure !== 'boolean') throw new Error('PushPlus 保存方式或失败推送选项无效');
        return pushplus;
    }

    function pushplusStep(stepIndent, identifier, notificationIdentifier, onlyFailure, newline) {
        const script = [
            'import json',
            'import os',
            'import urllib.error',
            'import urllib.request',
            '',
            'class NoRedirect(urllib.request.HTTPRedirectHandler):',
            '    def redirect_request(self, request, response, code, message, headers, new_url):',
            '        return None',
            '',
            'token = os.environ.get("PUSHPLUS_TOKEN", "").strip()',
            'if not token:',
            '    raise SystemExit("PUSHPLUS_TOKEN is missing; configure the Actions Secret.")',
            'outcome = os.environ["CHECKIN_OUTCOME"]',
            'status = "成功" if outcome == "success" else "失败"',
            'run_url = "{}/{}/actions/runs/{}".format(os.environ["GITHUB_SERVER_URL"], os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_RUN_ID"])',
            'content = "签到任务：{}\\n仓库：{}\\n工作流：{}\\n任务：{}\\n分支：{}\\n详情：{}".format(status, os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_WORKFLOW"], os.environ["GITHUB_JOB"], os.environ["GITHUB_REF_NAME"], run_url)',
            'payload = json.dumps({"token": token, "title": "NewAPI 签到任务" + status, "content": content, "template": "txt"}, ensure_ascii=False).encode("utf-8")',
            'request = urllib.request.Request("https://www.pushplus.plus/send", data=payload, headers={"Content-Type": "application/json"}, method="POST")',
            'try:',
            '    opener = urllib.request.build_opener(NoRedirect())',
            '    with opener.open(request, timeout=30) as response:',
            '        result = json.loads(response.read(65536).decode("utf-8"))',
            'except (urllib.error.URLError, ValueError, OSError):',
            '    raise SystemExit("PushPlus request failed; check the service and network. No automatic retry was sent.")',
            'if not isinstance(result, dict) or result.get("code") != 200:',
            '    raise SystemExit("PushPlus did not accept the notification; check the token and service limits.")',
            'print("PushPlus accepted the notification; delivery is managed by PushPlus.")'
        ];
        const outcome = `steps['${identifier}'].outcome`;
        const condition = onlyFailure ? `${outcome} == 'failure'`
            : `(${outcome} == 'success' || ${outcome} == 'failure')`;
        const lines = [
            '- name: PushPlus result notification (Pages)',
            `  id: ${notificationIdentifier}`,
            `  if: \${{ !cancelled() && ${condition} }}`,
            '  continue-on-error: true',
            '  timeout-minutes: 2',
            '  shell: bash',
            '  env:',
            '    PUSHPLUS_TOKEN: ${{ secrets.PUSHPLUS_TOKEN }}',
            `    CHECKIN_OUTCOME: \${{ ${outcome} }}`,
            '  run: |',
            "    python3 - <<'NEWAPI_PUSHPLUS_PY'",
            ...script.map(line => '    ' + line),
            '    NEWAPI_PUSHPLUS_PY'
        ];
        return lines.map(line => ' '.repeat(stepIndent) + line + newline).join('');
    }

    function updatePushplusWorkflow(content, options) {
        if (options.mode === 'preserve') return content;
        const lines = contentLines(content);
        const newline = content.includes('\r\n') ? '\r\n' : '\n';
        for (const step of workflowSteps(lines).reverse()) {
            const identifier = stepField(lines, step, 'id')?.value;
            const name = stepField(lines, step, 'name')?.value;
            if (identifier?.startsWith('newapi_pages_pushplus_') && name === 'PushPlus result notification (Pages)') {
                lines.splice(step.start, step.end - step.start);
            }
        }
        if (options.mode === 'disable') return lines.join('');
        const steps = workflowSteps(lines);
        const identifiers = new Set(steps.map(step => stepField(lines, step, 'id')?.value).filter(Boolean));
        const checkinSteps = steps.filter(step => /\bcheckin\.py\b/.test(stepField(lines, step, 'run')?.value || ''));
        if (!checkinSteps.length) throw new Error('PushPlus 需要单行 run: ... checkin.py 的签到步骤；本次尚未写入任何文件或 Secrets');
        let sequence = 1;
        for (const step of checkinSteps.reverse()) {
            let identifier = stepField(lines, step, 'id')?.value;
            if (identifier && !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(identifier)) {
                throw new Error('签到步骤 ID 必须是普通标识符，无法安全配置 PushPlus');
            }
            if (!identifier) {
                while (identifiers.has(`newapi_pages_checkin_${sequence}`)) sequence += 1;
                identifier = `newapi_pages_checkin_${sequence++}`;
            }
            let notificationIdentifier = 'newapi_pages_pushplus_' + identifier;
            let suffix = 2;
            while (identifiers.has(notificationIdentifier)) {
                notificationIdentifier = `newapi_pages_pushplus_${identifier}_${suffix++}`;
            }
            if (step.end && !/[\r\n]$/.test(lines[step.end - 1])) lines[step.end - 1] += newline;
            lines.splice(step.end, 0, pushplusStep(step.indent, identifier, notificationIdentifier, options.only_failure, newline));
            if (!stepField(lines, step, 'id')) {
                lines.splice(step.end, 0, ' '.repeat(step.indent + 2) + `id: ${identifier}${newline}`);
            }
            identifiers.add(identifier);
            identifiers.add(notificationIdentifier);
        }
        return lines.join('');
    }

    function updateWorkflow(content, previousNames, currentNames) {
        const lines = contentLines(content);
        const steps = workflowSteps(lines).filter(step => /\bcheckin\.py\b/.test(stepField(lines, step, 'run')?.value || ''));
        if (!steps.length) throw new Error('工作流中未找到单行 run: ... checkin.py，未修改文件');
        const managed = new Set([...previousNames, ...currentNames]);
        const newline = content.includes('\r\n') ? '\r\n' : '\n';
        for (const step of steps.reverse()) {
            const runIndex = stepField(lines, step, 'run').index;
            const runIndent = step.indent + 2;
            const stepStart = step.start;
            const stepEnd = step.end;
            const envPattern = new RegExp(`^ {${runIndent}}env:`);
            const envIndexes = [];
            for (let index = stepStart; index < stepEnd; index += 1) {
                const line = index === stepStart ? lines[index].replace(/^(\s*)-\s/, '$1  ') : lines[index];
                if (envPattern.test(line)) envIndexes.push(index);
            }
            const generated = currentNames.map(name => `${' '.repeat(runIndent + 2)}${name}: \${{ secrets.${name} }}${newline}`);
            if (!envIndexes.length) {
                if (runIndex === stepStart) {
                    if (!/[\r\n]$/.test(lines[stepEnd - 1])) lines[stepEnd - 1] += newline;
                    lines.splice(stepEnd, 0, `${' '.repeat(runIndent)}env:${newline}`, ...generated);
                } else lines.splice(runIndex, 0, `${' '.repeat(runIndent)}env:${newline}`, ...generated);
                continue;
            }
            const envHeader = envIndexes[0] === stepStart
                ? lines[stepStart].replace(/^(\s*)-\s/, '$1  ') : lines[envIndexes[0]];
            if (envIndexes.length !== 1 || !/^\s+env:\s*(?:#[^\r\n]*)?\r?\n?$/.test(envHeader)) {
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
            const pushplus = pushplusOptions(payload);
            if (pushplus.mode === 'enable' && !flags.sync_secrets) throw new Error('启用 PushPlus 必须勾选自动同步 Actions Secrets，Token 只通过加密 Secret 保存');
            const incoming = validateAccounts(payload.accounts);
            if (!incoming.length && payload.mode !== 'replace') throw new Error('至少需要配置一个账号');
            const existing = await readAccounts(snapshot);
            const accounts = mergeAccounts(existing, incoming, payload.mode === undefined ? 'merge' : payload.mode);
            const names = envNames(accounts);
            const requiredNames = envNames(accounts.filter(account => account.enabled !== false));
            const hasTokenbom = accounts.some(account => account.type === 'tokenbom');
            const activeTokenbom = accounts.some(account => account.type === 'tokenbom' && account.enabled !== false);
            if (hasTokenbom && !snapshot.privateRepository) throw new Error('TokenBom 自动续期仅支持私有签到仓库');
            if (activeTokenbom && !flags.sync_secrets) throw new Error('启用 TokenBom 必须同步 Secrets，以便校验自动续期凭证');
            const requiredSecrets = [...requiredNames, ...(activeTokenbom ? [automationSecret] : [])];
            const secretNames = [...workflowNames(accounts), ...(pushplus.mode === 'enable' ? ['PUSHPLUS_TOKEN'] : [])];
            const inputValues = payload.secrets ?? {};
            if (!inputValues || typeof inputValues !== 'object' || Array.isArray(inputValues)
                    || Object.keys(inputValues).some(name => !secretNames.includes(name))) throw new Error('凭证只能对应当前账号的环境变量名或本次启用的 PUSHPLUS_TOKEN');
            const providedValues = Object.create(null);
            for (const [name, rawValue] of Object.entries(inputValues)) {
                if (typeof rawValue !== 'string' || new TextEncoder().encode(rawValue).length > 48 * 1024) throw new Error('令牌必须是小于 48 KB 的文本');
                const value = rawValue.trim();
                if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('令牌不能包含换行或控制字符');
                if (value) providedValues[name] = value;
            }
            if (Object.keys(providedValues).length && !flags.include_env && !flags.sync_secrets) {
                throw new Error('已填写令牌，请选择同步 Secrets 或私有仓库 .env，避免丢失凭证');
            }
            const automationPat = providedValues[automationSecret];
            delete providedValues[automationSecret];
            if (automationPat && !flags.sync_secrets) throw new Error('TOKENBOM_SECRETS_PAT 只能加密同步到 Actions Secrets');
            const files = new Map([[accountFile, JSON.stringify(accounts, null, 2) + '\n']]);
            for (const path of workflowFiles) {
                const content = await snapshot.read(path);
                if (content === null) throw new Error('远端缺少签到工作流，请先将项目代码推送到仓库');
                files.set(path, updatePushplusWorkflow(updateWorkflow(content, workflowNames(existing), workflowNames(accounts)), pushplus));
            }
            if (flags.include_env) {
                const remoteEnv = await snapshot.read('.env');
                const template = remoteEnv === null ? await (options.readEnvTemplate?.() ?? '') : remoteEnv;
                if (typeof template !== 'string' || new TextEncoder().encode(template).length > 1024 * 1024) throw new Error('.env 模板必须是小于 1 MB 的文本');
                const updatedEnv = updateEnvContent(template, names, providedValues);
                const missing = requiredNames.filter(name => !envValues(updatedEnv)[name]);
                if (missing.length) throw new Error('.env 缺少令牌：' + missing.join('、')
                    + '。请在表单中填写，或首次选择 .env 文件；首次创建需要保存后全部账号的令牌，已有 Actions Secrets 的值无法读回。也可取消明文 .env 托管。本次尚未写入任何文件或 Secrets。');
                files.set('.env', updatedEnv);
            }
            let encrypted = new Map();
            if (flags.sync_secrets) {
                const existingSecrets = await client.secretNames();
                const secretValues = {...providedValues};
                if (automationPat) secretValues[automationSecret] = automationPat;
                else if (activeTokenbom && !existingSecrets.has(automationSecret)) {
                    secretValues[automationSecret] = client.token;
                }
                const hostedValues = envValues(files.get('.env') || '');
                names.forEach(name => {
                    if (!existingSecrets.has(name) && !secretValues[name] && hostedValues[name]) secretValues[name] = hostedValues[name];
                });
                const missing = [...new Set([...requiredSecrets, ...(pushplus.mode === 'enable' ? ['PUSHPLUS_TOKEN'] : [])])].filter(name => !existingSecrets.has(name) && !secretValues[name]);
                if (missing.length) throw new Error('缺少 Actions Secret，请填写对应令牌：' + missing.join('、') + '。本次尚未写入任何文件或 Secrets。');
                encrypted = await encryptSecrets(client, secretValues);
            }
            if ((flags.include_env || hasTokenbom) && (await client.request('GET')).private !== true) throw new Error('仓库已变为公开，已取消 .env 上传；请检查仓库可见性后重试');
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

    return Object.freeze({handle, validateAccounts, validateEnvName, mergeAccounts, envNames, updateWorkflow, updatePushplusWorkflow,
        envValues, updateEnvContent, encryptSecrets});
})();
