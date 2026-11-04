globalThis.AccountTable = (() => {
    const fieldNames = ['url', 'userId', 'name', 'accessTokenEnv', 'accessToken',
        'cfClearanceEnv', 'cfClearance', 'session', 'loginUser', 'loginPass'];
    let rows = [];
    let nextId = 1;
    let editingId = null;
    let page = 1;
    let replacementNeeded = false;
    let initialized = false;
    let allocatedNames = new Set();

    function element(identifier) {
        return document.getElementById(identifier);
    }

    function text(value) {
        return value === undefined || value === null ? '' : String(value).trim();
    }

    function normalize(values) {
        return Object.fromEntries(fieldNames.map(field => [field, text(values[field])]));
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
        return JSON.stringify([url, account.userId]);
    }

    function nextTokenName(accounts) {
        const used = new Set([...allocatedNames,
            ...accounts.flatMap(account => [account.accessTokenEnv, account.cfClearanceEnv])]);
        let tokenNumber = 1;
        while (used.has('NEWAPI_TOKEN_ACCOUNT' + tokenNumber)) tokenNumber += 1;
        return 'NEWAPI_TOKEN_ACCOUNT' + tokenNumber;
    }

    function status(message, isError = false) {
        const target = element('account-table-status');
        target.textContent = message;
        target.className = isError ? 'account-table-status is-error' : 'account-table-status';
    }

    function saveAccount(values, identifier = null) {
        const account = normalize(values);
        const previous = identifier === null ? null : rows.find(row => row.id === identifier);
        if (identifier !== null && !previous) throw new Error('该账号已不存在，请重新加载列表');
        if (!previous && rows.length >= 200) throw new Error('最多支持 200 个账号');
        account.url = normalizedUrl(account.url);
        if (!/^[1-9][0-9]*$/.test(account.userId)) throw new Error('用户 ID 必须是站点个人信息中的正整数');
        if (account.name.length > 200) throw new Error('备注名称不能超过 200 个字符');
        const others = rows.filter(row => row.id !== identifier);
        if (!account.accessTokenEnv) account.accessTokenEnv = previous?.accessTokenEnv || nextTokenName(others);
        if (!/^[A-Z_][A-Z0-9_]*$/.test(account.accessTokenEnv)
                || (account.cfClearanceEnv && !/^[A-Z_][A-Z0-9_]*$/.test(account.cfClearanceEnv))) {
            throw new Error('Secret / 环境变量名只能使用大写字母、数字和下划线，不能以数字开头');
        }
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
        page = previous ? Math.floor(rows.findIndex(row => row.id === identifier) / pageSize()) + 1
            : Math.ceil(rows.length / pageSize());
        render();
        status(replacementNeeded
            ? '草稿已更新。删除账号、修改站点 / 用户 ID 或清除 CF 变量后，保存到 GitHub 时需选择「替换账号列表」。'
            : '账号草稿已更新，尚未保存到 GitHub 或浏览器本地。');
        return identifier;
    }

    function loadGrouped(sites) {
        if (!Array.isArray(sites)) throw new Error('账号配置必须是数组');
        const imported = [];
        sites.forEach(site => {
            if (!site || !Array.isArray(site.accounts)) throw new Error('站点配置缺少账号数组');
            site.accounts.forEach(account => {
                if (!account || typeof account !== 'object') throw new Error('账号配置格式错误');
                imported.push(normalize({
                    url: site.url,
                    cfClearance: site.cfClearance || site.cf_clearance,
                    cfClearanceEnv: site.cfClearanceEnv || site.cf_clearance_env,
                    userId: account.userId || account.user_id,
                    name: account.name,
                    accessTokenEnv: account.accessTokenEnv || account.access_token_env,
                    accessToken: account.accessToken || account.access_token,
                    session: account.session,
                    loginUser: account.loginUser || account.login_username,
                    loginPass: account.loginPass || account.login_password
                }));
            });
        });
        if (imported.length > 200) throw new Error('最多支持 200 个账号');
        allocatedNames = new Set(imported.flatMap(account => [account.accessTokenEnv, account.cfClearanceEnv]));
        imported.forEach(account => {
            if (!account.accessTokenEnv) account.accessTokenEnv = nextTokenName(imported);
            allocatedNames.add(account.accessTokenEnv);
        });
        rows = imported.map(account => ({...account, id: nextId++}));
        replacementNeeded = false;
        page = 1;
        element('account-search').value = '';
        if (element('account-editor').open) element('account-editor').close();
        render();
        status('已加载 ' + rows.length + ' 个账号；表格不会显示真实令牌、Cookie 或密码。');
    }

    function collectGrouped() {
        const grouped = new Map();
        rows.forEach(row => {
            const key = JSON.stringify([row.url, row.cfClearance, row.cfClearanceEnv]);
            if (!grouped.has(key)) grouped.set(key, {
                url: row.url, cfClearance: row.cfClearance, cfClearanceEnv: row.cfClearanceEnv, accounts: []
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
        const query = element('account-search').value.trim().toLocaleLowerCase();
        const filtered = rows.filter(row => [row.url, row.name, row.userId, row.accessTokenEnv]
            .some(value => value.toLocaleLowerCase().includes(query)));
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
            appendCell(row, account.userId);
            appendCell(row, account.accessTokenEnv, 'account-variable-cell');
            appendCell(row, account.accessToken ? '已填写，待同步' : '未填写新令牌');
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
            cell.colSpan = 7;
            body.appendChild(row);
        }
        element('account-count').textContent = `${rows.length} 个账号 · ${new Set(rows.map(row => row.url)).size} 个站点`;
        element('account-page-info').textContent = `第 ${page} / ${pages} 页 · 匹配 ${filtered.length} 个账号`;
        element('account-page-previous').disabled = page <= 1;
        element('account-page-next').disabled = page >= pages;
    }

    function openEditor(identifier = null) {
        const row = identifier === null ? normalize({}) : rows.find(account => account.id === identifier);
        if (!row) {
            status('该账号已不存在，请重新加载列表', true);
            return;
        }
        editingId = identifier;
        element('account-editor-form').reset();
        fieldNames.forEach(field => { element('account-field-' + field).value = row[field]; });
        element('account-editor-title').textContent = identifier === null ? '添加账号' : '编辑账号';
        element('account-editor-error').textContent = '';
        element('account-editor-advanced').open = false;
        element('account-editor').showModal();
        element('account-field-url').focus();
    }

    function saveEditor(event) {
        event.preventDefault();
        const values = Object.fromEntries(fieldNames.map(field => [field, element('account-field-' + field).value]));
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
            : '当前草稿已清空；GitHub 同步至少需要保留一个账号。');
        return true;
    }

    function init() {
        if (initialized) return;
        initialized = true;
        element('account-add').addEventListener('click', () => openEditor());
        element('account-editor-form').addEventListener('submit', saveEditor);
        element('account-editor-cancel').addEventListener('click', () => element('account-editor').close());
        element('account-editor-close').addEventListener('click', () => element('account-editor').close());
        element('account-editor').addEventListener('close', () => {
            element('account-editor-form').reset();
            editingId = null;
        });
        element('account-search').addEventListener('input', () => { page = 1; render(); });
        element('account-page-size').addEventListener('change', () => { page = 1; render(); });
        element('account-page-previous').addEventListener('click', () => { page -= 1; render(); });
        element('account-page-next').addEventListener('click', () => { page += 1; render(); });
        render();
    }

    return {init, openEditor, saveAccount, removeAccount, loadGrouped, collectGrouped,
        count: () => rows.length, requiresReplacement: () => replacementNeeded};
})();
