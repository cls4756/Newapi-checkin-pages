globalThis.AccountTable = (() => {
    const fieldNames = ['url', 'userId', 'name', 'accessTokenEnv', 'accessToken',
        'cfClearanceEnv', 'cfClearance', 'session', 'loginUser', 'loginPass', 'type', 'accountId'];
    let rows = [];
    let nextId = 1;
    let editingId = null;
    let page = 1;
    let replacementNeeded = false;
    let initialized = false;
    let allocatedNames = new Set();
    let editorRevision = 0;
    let editorDefaultTokenName = '';
    let remoteRows = new Map();
    let originalKeys = new Map();

    function publicSnapshot(account) {
        return JSON.stringify([account.type, account.url, account.userId, account.name,
            account.accessTokenEnv, account.cfClearanceEnv, account.enabled,
            account.type === 'newapi' ? '' : account.accountId]);
    }

    function syncState(account) {
        const previous = remoteRows.get(originalKeys.get(account.id) || identity(account));
        if (previous === undefined) return 'new';
        const credentialChanged = ['accessToken', 'cfClearance', 'session', 'loginUser', 'loginPass'].some(field => account[field]);
        return credentialChanged || previous !== publicSnapshot(account) ? 'modified' : 'synced';
    }

    function markSynced() {
        remoteRows = new Map(rows.map(account => [identity(account), publicSnapshot(account)]));
        originalKeys = new Map(rows.map(account => [account.id, identity(account)]));
        render();
    }

    function orderedRows() {
        const query = element('account-search').value.trim().toLocaleLowerCase();
        return rows.filter(row => [row.url, row.name, row.userId, row.accessTokenEnv, row.type]
            .some(value => value.toLocaleLowerCase().includes(query)))
            .sort((left, right) => Number(right.enabled) - Number(left.enabled));
    }

    function element(identifier) {
        return document.getElementById(identifier);
    }

    function text(value) {
        return value === undefined || value === null ? '' : String(value).trim();
    }

    function normalize(values) {
        return {...Object.fromEntries(fieldNames.map(field => [field, text(values[field])])),
            type: values.type || 'newapi', enabled: values.enabled === undefined ? true : values.enabled};
    }

    function normalizedUrl(value) {
        const candidate = value.includes('://') ? value : 'https://' + value;
        let parsed;
        try {
            parsed = new URL(candidate);
        } catch {
            throw new Error('请填写有效的站点 URL');
        }
        if (!value || /\s/.test(value) || !['http:', 'https:'].includes(parsed.protocol)
                || !parsed.hostname || parsed.username || parsed.password
                || candidate.includes('?') || candidate.includes('#')) {
            throw new Error('站点 URL 必须是 http/https 地址，不能包含凭证、查询参数或片段');
        }
        return parsed.href.replace(/\/+$/, '');
    }

    function identity(account) {
        let url;
        try {
            url = normalizedUrl(account.url);
        } catch {
            url = account.url;
        }
        return JSON.stringify([account.type || 'newapi', url,
            account.type !== 'newapi' ? account.accountId : account.userId]);
    }

    function nextTokenName(accounts, usedNames = allocatedNames, type = 'newapi') {
        const used = new Set([...usedNames,
            ...accounts.flatMap(account => [account.accessTokenEnv, account.cfClearanceEnv])]);
        let tokenNumber = 1;
        const prefix = type === 'tokenbom' ? 'TOKENBOM_REFRESH_TOKEN_ACCOUNT' : type === 'vyceai' ? 'VYCEAI_SESSION_TOKEN_ACCOUNT' : 'NEWAPI_TOKEN_ACCOUNT';
        while (used.has(prefix + tokenNumber)) tokenNumber += 1;
        return prefix + tokenNumber;
    }

    function status(message, isError = false) {
        const target = element('account-table-status');
        target.textContent = message;
        target.className = isError ? 'account-table-status is-error' : 'account-table-status';
    }

    function validateFields(values) {
        const account = normalize(values);
        account.url = normalizedUrl(account.url);
        if (!['newapi', 'vyceai', 'tokenbom'].includes(account.type)) throw new Error('不支持的站点类型');
        if (typeof account.enabled !== 'boolean') throw new Error('enabled 必须是布尔值 true 或 false');
        if (account.type !== 'newapi') {
            if (account.type === 'tokenbom' && !account.url.startsWith('https://')) throw new Error('TokenBom 必须使用 HTTPS 地址');
            if (!/^[A-Za-z0-9_-]{1,80}$/.test(account.accountId)) throw new Error('该站点需要有效的稳定账号标识 account_id');
            for (const field of ['userId', 'cfClearanceEnv', 'cfClearance', 'session', 'loginUser', 'loginPass']) account[field] = '';
        } else if (!/^[1-9][0-9]*$/.test(account.userId)) throw new Error('用户 ID 必须是站点个人信息中的正整数');
        if (account.name.length > 200) throw new Error('备注名称不能超过 200 个字符');
        if ((account.accessTokenEnv && !/^[A-Z_][A-Z0-9_]*$/.test(account.accessTokenEnv))
                || (account.cfClearanceEnv && !/^[A-Z_][A-Z0-9_]*$/.test(account.cfClearanceEnv))) {
            throw new Error('Secret / 环境变量名只能使用大写字母、数字和下划线，不能以数字开头');
        }
        for (const name of [account.accessTokenEnv, account.cfClearanceEnv].filter(Boolean)) {
            GitHubBrowserConfig.validateEnvName(name);
        }
        return account;
    }

    function validateAccount(values, others, previous, usedNames = allocatedNames) {
        const account = validateFields(values);
        if (!account.accessTokenEnv) account.accessTokenEnv = previous?.accessTokenEnv || nextTokenName(others, usedNames, account.type);
        if (account.cfClearance && !account.cfClearanceEnv) account.cfClearanceEnv = 'CF_CLEARANCE_' + account.accessTokenEnv;
        GitHubBrowserConfig.validateEnvName(account.accessTokenEnv);
        if (account.cfClearanceEnv) GitHubBrowserConfig.validateEnvName(account.cfClearanceEnv);
        if (others.some(row => identity(row) === identity(account))) {
            throw new Error('同一站点和用户 ID 的账号已存在，请编辑已有账号');
        }
        if (others.some(row => row.accessTokenEnv === account.accessTokenEnv)) {
            throw new Error('令牌变量名已被其他账号使用，请为每个账号设置独立变量名');
        }
        const combined = [...others, account];
        const tokenNames = new Set(combined.map(row => row.accessTokenEnv));
        if (combined.some(row => row.cfClearanceEnv && tokenNames.has(row.cfClearanceEnv))) {
            throw new Error('CF Clearance 变量名不能与账号令牌变量名相同');
        }
        return account;
    }

    function saveAccount(values, identifier = null) {
        const previous = identifier === null ? null : rows.find(row => row.id === identifier);
        if (identifier !== null && !previous) throw new Error('该账号已不存在，请重新加载列表');
        if (!previous && rows.length >= 200) throw new Error('最多支持 200 个账号');
        const account = validateAccount(values, rows.filter(row => row.id !== identifier), previous);
        allocatedNames.add(account.accessTokenEnv);
        if (account.cfClearanceEnv) allocatedNames.add(account.cfClearanceEnv);
        if (previous) {
            if (identity(previous) !== identity(account)
                    || (previous.cfClearanceEnv && !account.cfClearanceEnv)) replacementNeeded = true;
            rows = rows.map(row => row.id === identifier ? {...account, id: identifier} : row);
        } else {
            identifier = nextId++;
            rows.push({...account, id: identifier});
        }
        element('account-search').value = '';
        page = Math.floor(orderedRows().findIndex(row => row.id === identifier) / pageSize()) + 1;
        render();
        status(replacementNeeded
            ? '草稿已更新。删除账号、修改站点 / 用户 ID 或清除 CF 变量后，保存到 GitHub 时需选择「替换账号列表」。'
            : '账号草稿已更新，尚未保存到 GitHub 或浏览器本地。');
        document.dispatchEvent(new CustomEvent('account-draft-saved', {detail: {url: account.url, userId: account.userId}}));
        return identifier;
    }

    function parseAccounts(data) {
        let parsed = data;
        if (typeof data === 'string') {
            if (new TextEncoder().encode(data).length > 1024 * 1024) throw new Error('导入 JSON 不能超过 1 MB');
            if (!data.trim()) throw new Error('请先粘贴账号 JSON');
            try {
                parsed = JSON.parse(data);
            } catch {
                throw new Error('JSON 格式不正确，请检查括号、引号和逗号');
            }
        }
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        if (!entries.length || entries.length > 200) throw new Error('导入数据必须包含 1 至 200 个账号');
        const imported = [];
        const identities = new Set();
        for (const entry of entries) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('账号 JSON 必须是对象或账号数组');
            const accounts = Object.prototype.hasOwnProperty.call(entry, 'accounts') ? entry.accounts : [entry];
            if (!Array.isArray(accounts) || !accounts.length) throw new Error('站点配置缺少有效的账号数组');
            for (const values of accounts) {
                if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('账号配置格式错误');
                if (imported.length >= 200) throw new Error('最多支持 200 个账号');
                const account = validateFields({
                    type: values.type ?? entry.type,
                    accountId: values.accountId ?? values.account_id,
                    enabled: values.enabled,
                    url: values.url ?? entry.url,
                    userId: values.userId ?? values.user_id,
                    name: values.name,
                    accessTokenEnv: values.accessTokenEnv ?? values.access_token_env ?? values.session_token_env ?? values.refresh_token_env,
                    accessToken: values.accessToken ?? values.access_token ?? values.session_token ?? values.refresh_token ?? values.refreshToken,
                    cfClearanceEnv: values.cfClearanceEnv ?? values.cf_clearance_env ?? entry.cfClearanceEnv ?? entry.cf_clearance_env,
                    cfClearance: values.cfClearance ?? values.cf_clearance ?? entry.cfClearance ?? entry.cf_clearance,
                    session: values.session,
                    loginUser: values.loginUser ?? values.login_username,
                    loginPass: values.loginPass ?? values.login_password
                });
                if (identities.has(identity(account))) throw new Error('导入数据中存在重复的站点和用户 ID');
                identities.add(identity(account));
                imported.push(account);
            }
        }
        return imported;
    }

    function importAccounts(data, mode = 'merge') {
        if (!['merge', 'replace'].includes(mode)) throw new Error('导入方式必须是合并或替换');
        const imported = parseAccounts(data);
        let stagedRows = mode === 'replace' ? [] : rows.map(row => ({...row}));
        const stagedNames = new Set([...allocatedNames,
            ...imported.flatMap(account => [account.accessTokenEnv, account.cfClearanceEnv].filter(Boolean))]);
        let stagedNextId = nextId;
        let added = 0;
        let updated = 0;
        for (const incoming of imported) {
            const previous = rows.find(row => identity(row) === identity(incoming));
            const values = Object.fromEntries(fieldNames.map(field => [field, incoming[field] || previous?.[field] || '']));
            values.enabled = incoming.enabled;
            const account = validateAccount(values, stagedRows.filter(row => row.id !== previous?.id), previous, stagedNames);
            stagedNames.add(account.accessTokenEnv);
            if (account.cfClearanceEnv) stagedNames.add(account.cfClearanceEnv);
            if (previous) {
                const row = {...account, id: previous.id};
                if (mode === 'replace') stagedRows.push(row);
                else stagedRows = stagedRows.map(existing => existing.id === previous.id ? row : existing);
                updated += 1;
            } else {
                stagedRows.push({...account, id: stagedNextId++});
                added += 1;
            }
            if (stagedRows.length > 200) throw new Error('最多支持 200 个账号');
        }
        rows = stagedRows;
        allocatedNames = stagedNames;
        nextId = stagedNextId;
        replacementNeeded = replacementNeeded || mode === 'replace';
        page = 1;
        element('account-search').value = '';
        render();
        status(`已导入草稿：新增 ${added} 个、更新 ${updated} 个账号；未保存到浏览器或 GitHub。`
            + (replacementNeeded ? '保存到 GitHub 时需选择「替换账号列表」，请先确认完整列表。' : ''));
        document.dispatchEvent(new CustomEvent('account-draft-changed'));
        return {added, updated, count: rows.length};
    }

    function loadGrouped(sites, history = []) {
        if (!Array.isArray(sites)) throw new Error('账号配置必须是数组');
        if (!Array.isArray(history) || history.length > 10000) throw new Error('草稿变量名记录无效');
        history.forEach(name => GitHubBrowserConfig.validateEnvName(name));
        const imported = [];
        sites.forEach(site => {
            if (!site || !Array.isArray(site.accounts)) throw new Error('站点配置缺少账号数组');
            site.accounts.forEach(account => {
                if (!account || typeof account !== 'object') throw new Error('账号配置格式错误');
                imported.push(normalize({
                    type: account.type ?? site.type,
                    accountId: account.accountId ?? account.account_id,
                    enabled: account.enabled,
                    url: site.url,
                    cfClearance: site.cfClearance || site.cf_clearance,
                    cfClearanceEnv: site.cfClearanceEnv || site.cf_clearance_env,
                    userId: account.userId || account.user_id,
                    name: account.name,
                    accessTokenEnv: account.accessTokenEnv || account.access_token_env || account.session_token_env || account.refresh_token_env,
                    accessToken: account.accessToken || account.access_token || account.session_token || account.refresh_token || account.refreshToken,
                    session: account.session,
                    loginUser: account.loginUser || account.login_username,
                    loginPass: account.loginPass || account.login_password
                }));
            });
        });
        if (imported.length > 200) throw new Error('最多支持 200 个账号');
        const stagedNames = new Set([...history, ...imported.flatMap(account => [account.accessTokenEnv, account.cfClearanceEnv].filter(Boolean))]);
        const staged = [];
        imported.forEach(values => {
            const account = validateAccount(values, staged, null, stagedNames);
            staged.push(account);
            stagedNames.add(account.accessTokenEnv);
            if (account.cfClearanceEnv) stagedNames.add(account.cfClearanceEnv);
        });
        allocatedNames = stagedNames;
        rows = staged.map(account => ({...account, id: nextId++}));
        replacementNeeded = false;
        page = 1;
        element('account-search').value = '';
        if (element('account-editor').open) element('account-editor').close();
        render();
        status('已加载 ' + rows.length + ' 个账号；表格不会显示真实令牌、Cookie 或密码。');
        document.dispatchEvent(new CustomEvent('account-draft-changed'));
    }

    function collectGrouped() {
        const grouped = new Map();
        rows.forEach(row => {
            const key = JSON.stringify([row.type, row.url, row.cfClearance, row.cfClearanceEnv]);
            if (!grouped.has(key)) grouped.set(key, {
                type: row.type, url: row.url, cfClearance: row.cfClearance, cfClearanceEnv: row.cfClearanceEnv, accounts: []
            });
            const {id, url, cfClearance, cfClearanceEnv, ...account} = row;
            grouped.get(key).accounts.push({...account});
        });
        return [...grouped.values()];
    }

    function pageSize() {
        const size = Number(element('account-page-size').value);
        return [10, 25, 50, 100].includes(size) ? size : 10;
    }

    function appendCell(row, value, className = '') {
        const cell = document.createElement('td');
        cell.textContent = value;
        cell.className = className;
        row.appendChild(cell);
        return cell;
    }

    function render() {
        const filtered = orderedRows();
        const size = pageSize();
        const pages = Math.max(1, Math.ceil(filtered.length / size));
        page = Math.min(Math.max(1, page), pages);
        const visible = filtered.slice((page - 1) * size, page * size);
        const body = element('account-table-body');
        body.replaceChildren();
        visible.forEach((account, index) => {
            const row = document.createElement('tr');
            row.dataset.accountId = String(account.id);
            appendCell(row, String((page - 1) * size + index + 1));
            let displayUrl;
            try {
                displayUrl = normalizedUrl(account.url);
            } catch {
                displayUrl = '无效站点 URL（请编辑）';
            }
            const urlCell = appendCell(row, displayUrl, 'account-url-cell');
            if (displayUrl.startsWith('http://') || displayUrl.startsWith('https://')) {
                const link = document.createElement('a');
                link.href = displayUrl;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.textContent = displayUrl;
                urlCell.replaceChildren();
                urlCell.appendChild(link);
            }
            appendCell(row, account.name || '未备注');
            appendCell(row, account.type === 'tokenbom' ? 'TokenBom' : account.type === 'vyceai' ? 'VyceAI' : account.userId);
            appendCell(row, account.accessTokenEnv, 'account-variable-cell');
            appendCell(row, account.accessToken ? '已填写，待同步' : '未填写新令牌');
            const state = syncState(account);
            const syncCell = appendCell(row, '', 'account-sync-cell');
            const badge = document.createElement('span');
            badge.className = 'account-sync-badge is-' + state;
            badge.textContent = {synced: '已同步', new: '新增未提交', modified: '修改未提交'}[state];
            badge.title = state === 'synced' ? '与最近一次从 GitHub 加载或完整保存成功的配置一致'
                : '仅存在于当前草稿，保存到 GitHub 后才影响定时任务';
            syncCell.appendChild(badge);
            row.dataset.syncState = state;
            const enabledCell = appendCell(row, '', 'account-enabled-cell');
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'account-enabled-toggle';
            toggle.textContent = account.enabled ? '已启用' : '已停用';
            toggle.setAttribute('role', 'switch');
            toggle.setAttribute('aria-checked', String(account.enabled));
            toggle.setAttribute('aria-label', '启用签到：' + (account.name || account.userId || 'VyceAI'));
            toggle.addEventListener('click', () => {
                account.enabled = !account.enabled;
                page = Math.floor(orderedRows().findIndex(row => row.id === account.id) / pageSize()) + 1;
                render();
                status('启停状态已更新到草稿；点击「保存到 GitHub」后定时签到生效，已有 Secret 会保留。');
                document.dispatchEvent(new CustomEvent('account-draft-changed'));
                body.querySelector('tr[data-account-id="' + account.id + '"] [role="switch"]')?.focus();
            });
            enabledCell.appendChild(toggle);
            row.classList.toggle('account-is-disabled', !account.enabled);
            const actions = appendCell(row, '', 'account-row-actions');
            for (const [label, action, className] of [
                ['编辑', () => openEditor(account.id), 'btn btn-secondary btn-xs'],
                ['删除', () => removeAccount(account.id), 'btn btn-danger btn-xs']
            ]) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = className;
                button.textContent = label;
                button.setAttribute('aria-label', label + '账号：' + (account.name || account.userId));
                button.addEventListener('click', action);
                actions.appendChild(button);
            }
            body.appendChild(row);
        });
        if (!visible.length) {
            const row = document.createElement('tr');
            const cell = appendCell(row, rows.length ? '没有匹配的账号，试试其他关键词。'
                : '暂无账号，点击「添加账号」或先「从 GitHub 加载」。', 'account-empty');
            cell.colSpan = 9;
            body.appendChild(row);
        }
        element('account-count').textContent = `${rows.length} 个账号 · ${rows.filter(row => row.enabled).length} 启用 / ${rows.filter(row => !row.enabled).length} 停用 · ${new Set(rows.map(row => row.url)).size} 个站点`;
        element('account-page-info').textContent = `第 ${page} / ${pages} 页 · 匹配 ${filtered.length} 个账号`;
        element('account-page-previous').disabled = page <= 1;
        element('account-page-next').disabled = page >= pages;
    }

    function openEditor(identifier = null) {
        const row = identifier === null ? normalize({accountId: 'account-' + crypto.randomUUID()}) : rows.find(account => account.id === identifier);
        if (!row) {
            status('该账号已不存在，请重新加载列表', true);
            return;
        }
        editingId = identifier;
        editorRevision += 1;
        editorDefaultTokenName = '';
        element('account-editor-form').reset();
        fieldNames.forEach(field => { element('account-field-' + field).value = row[field]; });
        element('account-field-enabled').checked = row.enabled;
        syncEditorType();
        element('account-editor-title').textContent = identifier === null ? '添加账号' : '编辑账号';
        element('account-editor-error').textContent = '';
        element('account-editor-import-status').textContent = '';
        element('account-editor-import-json').value = '';
        element('account-editor-manual-import').open = false;
        element('account-editor-bookmark-code').value = '';
        element('account-editor-bookmark-manual').open = false;
        element('account-editor-paste').disabled = false;
        element('account-editor-advanced').open = false;
        if (!element('account-editor').open) element('account-editor').showModal();
        element('account-field-url').focus();
    }

    function fillEditor(data, sourceName = '导入数据') {
        const imported = parseAccounts(data);
        if (imported.length !== 1) throw new Error('此处只填写一个账号；多个账号请使用主页面的「批量导入 JSON」');
        const account = imported[0];
        const existing = rows.find(row => identity(row) === identity(account));
        const current = rows.find(row => row.id === editingId);
        if (element('account-editor').open && current && existing?.id !== current.id) {
            throw new Error('导入账号与当前编辑账号不同，请取消后在「添加账号」中导入');
        }
        const changed = element('account-editor').open && fieldNames.some(field =>
            element('account-field-' + field).value !== (current?.[field] || ''));
        if ((changed || (existing && editingId !== existing.id))
                && !confirm((existing ? '该账号已在表格中，将打开它的编辑弹窗并填入数据。' : '将替换当前弹窗已填写的内容。')
                    + '\n其他账号不会改变，仍需点击「保存到表格」。是否继续？')) return false;
        openEditor(existing?.id ?? null);
        fieldNames.forEach(field => { element('account-field-' + field).value = account[field] || existing?.[field] || ''; });
        element('account-field-enabled').checked = account.enabled;
        syncEditorType();
        element('account-editor-advanced').open = account.type === 'newapi' && fieldNames.slice(5, 10).some(field => account[field]);
        element('account-editor-import-status').textContent = `已从${sourceName}填入一个账号；仅当前弹窗，检查后点击「保存到表格」。`;
        element('account-field-url').focus();
        return true;
    }

    async function pasteIntoEditor() {
        if (!element('account-editor').open) return;
        const revision = editorRevision;
        element('account-editor-paste').disabled = true;
        element('account-editor-error').textContent = '';
        try {
            if (!navigator.clipboard?.readText) throw new Error('Clipboard unavailable');
            const content = await navigator.clipboard.readText();
            if (!element('account-editor').open || editorRevision !== revision) return;
            fillEditor(content, '剪贴板');
        } catch (error) {
            if (!element('account-editor').open || editorRevision !== revision) return;
            element('account-editor-error').textContent = error.message === 'Clipboard unavailable'
                || ['NotAllowedError', 'SecurityError'].includes(error.name)
                ? '无法读取剪贴板，请在下方「手动粘贴单账号 JSON」中粘贴并填入。'
                : error.message;
            element('account-editor-manual-import').open = true;
            element('account-editor-import-json').focus();
        } finally {
            if (editorRevision === revision) element('account-editor-paste').disabled = false;
        }
    }

    function importEditorJSON() {
        try {
            element('account-editor-error').textContent = '';
            fillEditor(element('account-editor-import-json').value, '手动 JSON');
        } catch (error) {
            element('account-editor-error').textContent = error.message;
        }
    }

    function saveEditor(event) {
        event.preventDefault();
        const values = Object.fromEntries(fieldNames.map(field => [field, element('account-field-' + field).value]));
        values.enabled = element('account-field-enabled').checked;
        try {
            saveAccount(values, editingId);
            element('account-editor').close();
        } catch (error) {
            element('account-editor-error').textContent = error.message;
        }
    }

    function removeAccount(identifier) {
        const row = rows.find(account => account.id === identifier);
        if (!row || !confirm('确定从当前草稿删除账号「' + (row.name || row.userId)
                + '」？\n不会立即修改 GitHub。删除远端账号需确认已加载完整列表，再用「替换账号列表」保存。')) return false;
        rows = rows.filter(account => account.id !== identifier);
        replacementNeeded = true;
        render();
        status(rows.length
            ? '已从草稿删除账号；保存到 GitHub 时需选择「替换账号列表」，不会删除已有 Secrets。'
            : '当前草稿已清空；保存到 GitHub 时使用「替换账号列表」同步删除。');
        document.dispatchEvent(new CustomEvent('account-draft-changed'));
        return true;
    }

    function init() {
        if (initialized) return;
        initialized = true;
        element('account-field-type').addEventListener('change', syncEditorType);
        element('account-add').addEventListener('click', () => openEditor());
        element('account-editor-paste').addEventListener('click', pasteIntoEditor);
        element('account-editor-import-fill').addEventListener('click', importEditorJSON);
        element('account-editor-form').addEventListener('submit', saveEditor);
        element('account-editor-cancel').addEventListener('click', () => element('account-editor').close());
        element('account-editor-close').addEventListener('click', () => element('account-editor').close());
        element('account-editor').addEventListener('close', () => {
            if (element('account-editor').open) return;
            editorRevision += 1;
            element('account-editor-form').reset();
            element('account-editor-import-json').value = '';
            element('account-editor-import-status').textContent = '';
            element('account-editor-error').textContent = '';
            editingId = null;
        });
        element('account-search').addEventListener('input', () => { page = 1; render(); });
        element('account-page-size').addEventListener('change', () => { page = 1; render(); });
        element('account-page-previous').addEventListener('click', () => { page -= 1; render(); });
        element('account-page-next').addEventListener('click', () => { page += 1; render(); });
        render();
    }

    function syncEditorType() {
        const type = element('account-field-type').value;
        const vyceai = type === 'vyceai';
        const tokenbom = type === 'tokenbom';
        const special = vyceai || tokenbom;
        element('account-field-userId').required = !special;
        element('account-field-userId').closest('.form-group').hidden = special;
        element('account-editor-advanced').hidden = special;
        element('account-token-label').textContent = tokenbom ? 'TokenBom refreshToken' : vyceai ? 'VyceAI SessionToken' : '系统访问令牌';
        element('account-token-help').textContent = tokenbom
            ? '登录 TokenBom 后复制 refreshToken。首次同步会自动使用当前 GitHub PAT 配置续期，已有续期 Secret 则保留；可在设置中指定独立 PAT。' : vyceai
            ? '登录 VyceAI 后，在浏览器 Cookie 中复制 session 的值。每日北京时间 08:00 重置奖励。'
            : '登录站点 → 个人设置 → 系统访问令牌。留空保留已有 Secret。';
        element('account-field-accessTokenEnv').placeholder = tokenbom ? 'TOKENBOM_REFRESH_TOKEN_ACCOUNT1' : vyceai ? 'VYCEAI_SESSION_TOKEN_ACCOUNT1' : 'NEWAPI_TOKEN_ACCOUNT1';
        const tokenInput = element('account-field-accessTokenEnv');
        if (!tokenInput.value.trim() || tokenInput.value === editorDefaultTokenName) {
            const previous = rows.find(account => account.id === editingId);
            tokenInput.value = previous?.accessTokenEnv || nextTokenName(rows, allocatedNames, type);
            editorDefaultTokenName = previous ? '' : tokenInput.value;
        }
        if (special && !element('account-field-url').value.trim()) element('account-field-url').value = tokenbom ? 'https://tokenbom.com' : 'https://vyceai.com';
        if (special && !element('account-field-accountId').value) element('account-field-accountId').value = type + '-' + crypto.randomUUID();
    }

    return {init, openEditor, fillEditor, pasteIntoEditor, parseAccounts, importAccounts, markSynced,
        saveAccount, removeAccount, loadGrouped, collectGrouped,
        count: () => rows.length, requiresReplacement: () => replacementNeeded,
        refresh: render, allocationHistory: () => [...allocatedNames],
        markReplacement: value => { replacementNeeded = value === true; }};
})();
