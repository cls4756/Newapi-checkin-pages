/* All export destinations use this one validation and credential mapping. */
globalThis.AccountExports = (() => {
    function build(sites, {allowEmpty = false} = {}) {
        if (!Array.isArray(sites)) throw new Error('账号草稿格式错误');
        const rows = sites.flatMap(site => {
            if (!site || !Array.isArray(site.accounts)) throw new Error('站点配置缺少账号列表');
            return site.accounts.map(account => ({...account, type: account.type || site.type || 'newapi', url: site.url,
                cfClearance: site.cfClearance, cfClearanceEnv: site.cfClearanceEnv}));
        });
        if (!rows.length && !allowEmpty) throw new Error('请先添加账号或从 GitHub 加载账号配置');
        const used = new Set(rows.flatMap(row => [row.accessTokenEnv, row.cfClearanceEnv].filter(Boolean)));
        const metadata = rows.map(row => {
            let tokenEnv = row.accessTokenEnv;
            if (!tokenEnv) {
                let number = 1;
                const prefix = row.type === 'vyceai' ? 'VYCEAI_SESSION_TOKEN_ACCOUNT' : 'NEWAPI_TOKEN_ACCOUNT';
                while (used.has(prefix + number)) number += 1;
                tokenEnv = prefix + number;
                used.add(tokenEnv);
            }
            const url = String(row.url || '').trim();
            const account = {url: url.includes('://') ? url : 'https://' + url, name: row.name,
                enabled: row.enabled === undefined ? true : row.enabled,
                ...(row.type === 'vyceai' ? {type: 'vyceai', account_id: row.accountId, session_token_env: tokenEnv}
                    : {user_id: row.userId, access_token_env: tokenEnv})};
            const clearanceEnv = row.cfClearanceEnv || (row.cfClearance ? 'CF_CLEARANCE_' + tokenEnv : '');
            if (clearanceEnv && row.type !== 'vyceai') account.cf_clearance_env = clearanceEnv;
            return account;
        });
        const publicAccounts = GitHubBrowserConfig.validateAccounts(metadata);
        const secrets = Object.create(null);
        function addSecret(name, value) {
            if (!value) return;
            if (typeof value !== 'string' || new TextEncoder().encode(value).length > 48 * 1024
                    || /[\x00-\x1f\x7f]/.test(value)) throw new Error('账号凭证不能包含控制字符或超过 48 KB');
            if (Object.prototype.hasOwnProperty.call(secrets, name) && secrets[name] !== value) {
                throw new Error('同一个 Secret 变量填写了不同的凭证，请检查共享的 CF 变量');
            }
            secrets[name] = value;
        }
        const legacyAccounts = publicAccounts.map((account, index) => {
            const row = rows[index];
            if (account.type === 'vyceai') {
                addSecret(account.session_token_env, row.accessToken);
                return {...account};
            }
            const legacy = {url: account.url, user_id: account.user_id, name: account.name,
                enabled: account.enabled, session: row.session || ''};
            if (row.accessToken) legacy.access_token = row.accessToken;
            else if (!row.session) legacy.access_token_env = account.access_token_env;
            if (row.cfClearance) legacy.cf_clearance = row.cfClearance;
            else if (account.cf_clearance_env) legacy.cf_clearance_env = account.cf_clearance_env;
            if (row.loginUser) legacy.login_username = row.loginUser;
            if (row.loginPass) legacy.login_password = row.loginPass;
            addSecret(account.access_token_env, row.accessToken);
            if (account.cf_clearance_env) addSecret(account.cf_clearance_env, row.cfClearance);
            return legacy;
        });
        return {publicAccounts, legacyAccounts, secrets};
    }

    function simple(accounts) {
        if (accounts.some(account => account.enabled === false || account.type === 'vyceai' || !account.session || account.access_token || account.access_token_env
                || account.cf_clearance || account.cf_clearance_env || account.login_username || account.login_password
                || /[,#]/.test(account.session) || /[,#]/.test(account.url))) {
            return '简单格式仅适用于旧版 Session；系统令牌、启停状态、变量引用及高级选项请使用 JSON，避免丢失用户 ID 或配置。';
        }
        return accounts.map(account => `${account.url}#${account.session}`).join(',');
    }
    return Object.freeze({build, simple});
})();
