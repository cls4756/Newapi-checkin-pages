const GITHUB_TARGET_STORAGE_KEY = 'newapi_checkin_github_target';
let unlockedGithubToken = '';
let githubBusy = false;
let githubSettingsBusy = false;
let githubDisabledControls = [];
let githubLockRevision = 0;
let githubSettingsSnapshot = null;
let githubLoadPending = null;
let githubLoadAfterDialog = false;
let githubAccountsLoaded = false;
let githubAccountsDirty = false;
const githubSettingFields = ['github-repository', 'github-branch', 'github-save-mode',
    'github-sync-secrets', 'github-include-env', 'github-sync-local', 'github-remember-token'];

function toggleGithubSync() {
    const section = document.getElementById('github-section');
    section.style.display = section.style.display === 'none' ? 'block' : 'none';
    if (section.style.display === 'block') section.scrollIntoView({behavior: 'smooth', block: 'start'});
}

function restoreGithubTarget() {
    const local = usesLocalGithubGateway();
    const localCheckbox = document.getElementById('github-sync-local');
    localCheckbox.disabled = !local;
    if (!local) localCheckbox.checked = false;
    const localRow = document.getElementById('github-local-option');
    if (localRow) localRow.hidden = !local;
    const importRow = document.getElementById('github-env-import-row');
    if (importRow) importRow.hidden = local;
    updatePushplusControls();
    try {
        const target = GitHubSettings.read();
        document.getElementById('github-repository').value = target.repository;
        document.getElementById('github-branch').value = target.branch;
        document.getElementById('github-save-mode').value = target.mode;
        document.getElementById('github-sync-secrets').checked = target.syncSecrets;
        document.getElementById('github-include-env').checked = target.includeEnv;
        localCheckbox.checked = local && target.syncLocal;
        document.getElementById('github-remember-token').checked = Boolean(target.vault);
        updateGithubSettingsSummary();
    } catch (error) {
        showGithubStatus('error', error.message);
    }
}

function usesLocalGithubGateway() {
    return location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(location.hostname);
}

function rememberGithubTarget(repository, branch) {
    try {
        const saved = GitHubSettings.read();
        GitHubSettings.write({...saved, repository, branch}, saved.vault);
        updateGithubSettingsSummary();
    } catch (error) {
        return error.message;
    }
    return '';
}

function openGithubSettings() {
    const dialog = document.getElementById('github-settings-dialog');
    if (githubBusy || dialog.open) return;
    githubSettingsSnapshot = captureGithubSettings();
    dialog.returnValue = '';
    document.getElementById('github-settings-status').style.display = 'none';
    dialog.showModal();
    const locked = document.getElementById('github-remember-token').checked && !unlockedGithubToken;
    document.getElementById(locked ? 'github-vault-password' : 'github-repository').focus();
}

function captureGithubSettings() {
    return githubSettingFields.map(id => {
        const element = document.getElementById(id);
        const property = element.type === 'checkbox' ? 'checked' : 'value';
        return {id, property, value: element[property]};
    });
}

function closeGithubSettings(result = 'cancel') {
    if (!githubBusy) document.getElementById('github-settings-dialog').close(result);
}

function finishGithubSettings() {
    const dialog = document.getElementById('github-settings-dialog');
    if (dialog.open) return;
    githubSettingsSnapshot?.forEach(({id, property, value}) => {
        document.getElementById(id)[property] = value;
    });
    githubSettingsSnapshot = null;
    for (const id of ['github-token', 'github-vault-password', 'github-vault-confirm']) {
        document.getElementById(id).value = '';
    }
    const reload = githubLoadAfterDialog && ['saved', 'unlocked'].includes(dialog.returnValue);
    githubLoadAfterDialog = false;
    if (reload) loadFromGithub(githubLoadPending || {automatic: true});
    else {
        if (dialog.returnValue === 'cancel' || !dialog.returnValue) githubLoadPending = null;
        initAccountImport();
    }
}

function githubPreferences() {
    const repository = document.getElementById('github-repository').value.trim();
    const branch = document.getElementById('github-branch').value.trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
            || repository.split('/').some(part => ['.', '..'].includes(part))) {
        throw new Error('请填写 owner/repo 格式的 GitHub 仓库');
    }
    if (branch.length > 255 || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) || branch.includes('..')
            || branch.includes('@{') || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.')) {
        throw new Error('目标分支格式不正确；留空使用仓库默认分支');
    }
    return {repository, branch, mode: document.getElementById('github-save-mode').value,
        syncSecrets: document.getElementById('github-sync-secrets').checked,
        includeEnv: document.getElementById('github-include-env').checked,
        syncLocal: usesLocalGithubGateway() && document.getElementById('github-sync-local').checked};
}

function updateGithubSettingsSummary() {
    const saved = GitHubSettings.read();
    const tokenState = unlockedGithubToken ? 'PAT 已解锁，仅在本页内存中使用'
        : saved.vault ? 'PAT 已加密保存，使用前请解锁' : 'PAT 未保存';
    document.getElementById('github-settings-summary').textContent =
        `${saved.repository || '尚未保存仓库设置'} · ${saved.branch || '默认分支'} · ${tokenState}`;
    document.getElementById('github-vault-status').textContent = tokenState;
}

async function saveGithubSettings() {
    if (githubBusy || githubSettingsBusy) return;
    githubSettingsBusy = true;
    const revision = githubLockRevision;
    let savedSuccessfully = false;
    setGithubBusy(true);
    const password = document.getElementById('github-vault-password');
    const confirmation = document.getElementById('github-vault-confirm');
    try {
        const preferences = githubPreferences();
        const saved = GitHubSettings.read();
        const reload = Boolean(githubLoadPending) || !githubAccountsLoaded
            || preferences.repository !== saved.repository || preferences.branch !== saved.branch;
        const token = document.getElementById('github-token').value.trim() || unlockedGithubToken;
        if (token) GitHubSettings.validateToken(token);
        let vault = saved.vault;
        if (document.getElementById('github-remember-token').checked) {
            if (password.value || !vault || (token && token !== unlockedGithubToken)) {
                if (password.value !== confirmation.value) throw new Error('两次输入的解锁密码不一致');
                vault = await GitHubSettings.encrypt(token, password.value);
            }
        } else {
            vault = null;
        }
        GitHubSettings.write(preferences, vault);
        if (token && revision === githubLockRevision) unlockedGithubToken = GitHubSettings.validateToken(token);
        document.getElementById('github-token').value = '';
        updateGithubSettingsSummary();
        showGithubStatus('success', '设置已保存到当前浏览器，刷新后恢复。没有向 GitHub 提交文件或上传凭证。');
        savedSuccessfully = true;
        githubLoadAfterDialog = reload;
    } catch (error) {
        showGithubStatus('error', error.message);
    } finally {
        password.value = '';
        confirmation.value = '';
        githubSettingsBusy = false;
        setGithubBusy(false);
        if (savedSuccessfully) {
            githubSettingsSnapshot = null;
            closeGithubSettings('saved');
        }
    }
}

async function unlockGithubToken() {
    if (githubBusy || githubSettingsBusy) return;
    githubSettingsBusy = true;
    const revision = githubLockRevision;
    let unlockedSuccessfully = false;
    setGithubBusy(true);
    const password = document.getElementById('github-vault-password');
    try {
        const saved = GitHubSettings.read();
        if (!saved.vault) throw new Error('尚未加密保存 PAT，请先填写 PAT 和自设密码保存设置');
        const token = await GitHubSettings.decrypt(saved.vault, password.value);
        if (revision !== githubLockRevision) return;
        unlockedGithubToken = token;
        document.getElementById('github-token').value = '';
        updateGithubSettingsSummary();
        showGithubStatus('success', 'PAT 已解锁，本页面的 GitHub 操作可直接使用；刷新、离开页面或立即锁定后需重新解锁。');
        unlockedSuccessfully = true;
        githubLoadAfterDialog = Boolean(githubLoadPending) || !githubAccountsLoaded;
    } catch (error) {
        unlockedGithubToken = '';
        try { updateGithubSettingsSummary(); } catch {}
        showGithubStatus('error', error.message);
    } finally {
        password.value = '';
        document.getElementById('github-vault-confirm').value = '';
        githubSettingsBusy = false;
        setGithubBusy(false);
        if (unlockedSuccessfully) closeGithubSettings('unlocked');
    }
}

function lockGithubToken() {
    githubLockRevision += 1;
    unlockedGithubToken = '';
    for (const id of ['github-token', 'github-vault-password', 'github-vault-confirm']) {
        document.getElementById(id).value = '';
    }
    try { updateGithubSettingsSummary(); } catch { /* Storage may have been disabled. */ }
}

function forgetGithubToken() {
    if (githubBusy || githubSettingsBusy || !confirm('删除当前浏览器保存的 PAT 密文？GitHub 上的 PAT 不会被撤销。')) return;
    try {
        const saved = GitHubSettings.read();
        GitHubSettings.write(saved, null);
        document.getElementById('github-remember-token').checked = false;
        lockGithubToken();
        const remembered = githubSettingsSnapshot?.find(field => field.id === 'github-remember-token');
        if (remembered) remembered.value = false;
        showGithubStatus('success', '已删除浏览器保存的 PAT，仓库及选项仍保留。');
    } catch (error) { showGithubStatus('error', error.message); }
}

function clearGithubSettings() {
    if (githubBusy || githubSettingsBusy || !confirm('清除当前浏览器的 GitHub 仓库、选项和 PAT 密文？账号草稿和远端仓库不会改变。')) return;
    try {
        GitHubSettings.clear();
        githubLoadPending = null;
        githubAccountsLoaded = false;
        lockGithubToken();
        restoreGithubTarget();
        githubSettingsSnapshot = captureGithubSettings();
        showGithubStatus('success', '已清除本浏览器的 GitHub 设置。');
    } catch (error) { showGithubStatus('error', error.message); }
}

function githubTarget() {
    if (location.protocol !== 'https:' && !usesLocalGithubGateway()) {
        throw new Error('请从 HTTPS 页面（如 GitHub Pages）使用 GitHub 保存；也可通过本地 serve.py 打开');
    }
    let preferences;
    try { preferences = githubPreferences(); }
    catch (error) { openGithubSettings(); throw error; }
    const {repository, branch} = preferences;
    const token = document.getElementById('github-token').value.trim() || unlockedGithubToken;
    if (!token) {
        openGithubSettings();
        throw new Error('请先解锁已保存的 PAT，或在设置中填写 GitHub Personal Access Token');
    }
    GitHubSettings.validateToken(token);
    return {repository, branch, token};
}

function showGithubStatus(type, message) {
    const ids = ['github-status', 'github-table-status'];
    if (document.getElementById('github-settings-dialog').open) ids.push('github-settings-status');
    for (const id of ids) {
        const status = document.getElementById(id);
        status.className = 'cloud-status ' + type;
        status.textContent = message;
        status.style.display = 'block';
    }
}

function setGithubBusy(busy) {
    githubBusy = busy;
    if (busy) {
        githubDisabledControls = Array.from(document.querySelectorAll('.content input, .content select, .content textarea, .content button'))
            .map(element => [element, element.disabled]);
        githubDisabledControls.forEach(([element]) => { element.disabled = true; });
    } else {
        githubDisabledControls.forEach(([element, disabled]) => { element.disabled = disabled; });
        githubDisabledControls = [];
        globalThis.AccountTable?.refresh();
        updatePushplusControls();
    }
}

function updatePushplusControls() {
    const mode = document.getElementById('github-pushplus-mode');
    if (!mode) return;
    const local = usesLocalGithubGateway();
    mode.disabled = local;
    const enabled = !local && mode.value === 'enable';
    document.getElementById('github-pushplus-fields').hidden = !enabled;
    document.getElementById('github-pushplus-token').disabled = !enabled;
    document.getElementById('github-pushplus-only-failure').disabled = !enabled;
    document.getElementById('github-pushplus-local-note').hidden = !local;
}

function clearPushplusDraft() {
    document.getElementById('github-pushplus-mode').value = 'preserve';
    document.getElementById('github-pushplus-token').value = '';
    document.getElementById('github-pushplus-only-failure').checked = false;
}

async function githubRequest(payload) {
    if (!usesLocalGithubGateway()) {
        if (location.protocol !== 'https:' || !globalThis.GitHubBrowserConfig) {
            throw new Error('请通过 HTTPS 访问，并确认浏览器 GitHub 模块已正确部署');
        }
        return globalThis.GitHubBrowserConfig.handle(payload, {
            readEnvTemplate: async () => {
                const file = document.getElementById('github-env-import')?.files?.[0];
                if (!file) return '';
                if (file.size > 1024 * 1024) throw new Error('首次导入的 .env 不能超过 1 MB');
                return file.text();
            }
        });
    }
    const response = await fetch('/github-config', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer'
    });
    let result;
    try {
        result = await response.json();
    } catch {
        throw new Error('本地服务未返回有效 JSON，请确认使用最新的 python3 serve.py 启动服务');
    }
    if (!response.ok) throw new Error(result.error || 'GitHub 操作失败，请检查权限和网络');
    return result;
}

function collectGithubSavePayload() {
    const target = githubTarget();
    if (globalThis.AccountTable?.requiresReplacement()
            && document.getElementById('github-save-mode').value !== 'replace') {
        throw new Error('表格已删除账号、修改站点 / 用户 ID 或清除 CF 变量。合并模式无法删除远端旧配置；请确认表格包含完整远端账号后，选择「替换账号列表」再保存。');
    }
    const sites = collectFormData();
    if (sites.some(site => site.accounts.some(account => account.session || account.loginUser || account.loginPass))) {
        throw new Error('GitHub 账号配置仅支持系统令牌和 CF 变量；请使用旧版 JSON / WebDAV 保存 Session 或登录信息，或先清除这些旧版字段。');
    }
    const {publicAccounts: accounts, secrets} = AccountExports.build(sites);
    const includeEnv = document.getElementById('github-include-env').checked;
    const syncSecrets = document.getElementById('github-sync-secrets').checked;
    const syncLocal = document.getElementById('github-sync-local').checked;
    if (syncLocal && !usesLocalGithubGateway()) {
        throw new Error('GitHub Pages 无法回写设备本地文件，请取消本地回写，保存后从仓库拉取即可');
    }
    const pushplusMode = document.getElementById('github-pushplus-mode').value;
    if (pushplusMode !== 'preserve' && usesLocalGithubGateway()) {
        throw new Error('本地后端尚不支持此 PushPlus 工作流配置，请改用 HTTPS Pages 页面保存');
    }
    if (pushplusMode === 'enable') {
        if (!syncSecrets) throw new Error('启用 PushPlus 请勾选自动创建 / 更新 Actions Secrets；Token 不提交到文件');
        const pushplusToken = document.getElementById('github-pushplus-token').value.trim();
        if (pushplusToken) secrets.PUSHPLUS_TOKEN = pushplusToken;
    }
    if (Object.keys(secrets).length && !includeEnv && !syncSecrets && !syncLocal) {
        throw new Error('已填写令牌，请至少选择同步 Secrets、本地 .env 或私有仓库 .env 中的一项');
    }
    return {...target, action: 'save', accounts, secrets,
        ...(pushplusMode === 'preserve' ? {} : {notifications: {pushplus: {mode: pushplusMode,
            only_failure: document.getElementById('github-pushplus-only-failure').checked}}}),
        mode: document.getElementById('github-save-mode').value,
        include_env: includeEnv, confirm_plaintext_env: includeEnv,
        sync_secrets: syncSecrets, sync_local: syncLocal};
}

function refreshGithubAccounts() {
    return loadFromGithub({automatic: true});
}

function loadGithubAccountsOnOpen() {
    try {
        if (GitHubSettings.read().repository) {
            refreshGithubAccounts();
            return;
        }
    } catch (error) { showGithubStatus('error', error.message); }
    initAccountImport();
}

async function loadFromGithub({automatic = false} = {}) {
    if (githubBusy || githubSettingsBusy) return;
    let target;
    try {
        target = githubTarget();
    } catch (error) {
        githubLoadPending = {automatic};
        showGithubStatus('error', error.message);
        if (!document.getElementById('github-settings-dialog').open) initAccountImport();
        return;
    }
    githubLoadPending = null;
    const hasDraft = githubAccountsDirty
        || document.getElementById('github-pushplus-mode').value !== 'preserve'
        || document.getElementById('github-pushplus-token').value;
    if ((!automatic || hasDraft) && !confirm('从 GitHub 加载将覆盖当前账号表单，并清空本页尚未保存的 PushPlus 配置。只读取公开账号配置，不读取 .env 或 Secrets 的值。是否继续？')) {
        showGithubStatus('info', '已取消从 GitHub 加载，当前账号表格和未保存的修改保持不变。');
        initAccountImport();
        return;
    }
    setGithubBusy(true);
    document.getElementById('github-commit-link').hidden = true;
    showGithubStatus('info', '正在加载 GitHub 公开账号配置…');
    try {
        const result = await githubRequest({...target, action: 'load'});
        loadFlatData(result.accounts);
        githubAccountsDirty = false;
        githubAccountsLoaded = true;
        clearPushplusDraft();
        document.getElementById('github-branch').value = result.branch;
        const storageWarning = rememberGithubTarget(target.repository, result.branch);
        showGithubStatus(storageWarning ? 'info' : 'success', `已加载 ${result.accounts.length} 个账号，分支：${result.branch}（${result.private ? '私有' : '公开'}仓库）。已有凭证不会读回，新增或更新令牌时再填写。` + (storageWarning ? '\n' + storageWarning : ''));
    } catch (error) {
        showGithubStatus('error', error instanceof TypeError ? githubConnectionError() : error.message);
    } finally {
        setGithubBusy(false);
        // Open any pending bookmark import after startup loading, so loading cannot close its editor.
        initAccountImport();
    }
}

async function saveToGithub() {
    if (githubBusy || githubSettingsBusy) return;
    let payload;
    try {
        payload = collectGithubSavePayload();
        if (!payload) return;
    } catch (error) {
        showGithubStatus('error', error.message);
        return;
    }
    let confirmation = `将向 ${payload.repository} 的 ${payload.branch || '默认'} 分支提交 ${payload.accounts.length} 个表单账号，并更新两个工作流。`;
    confirmation += payload.mode === 'replace' ? '\n替换模式：远端不在表单中的账号将被删除。' : '\n合并模式：保留远端其他账号。';
    if (payload.include_env) confirmation += usesLocalGithubGateway()
        ? '\n⚠️ 明文 .env 将进入 Git 历史；首次可能包含本地 .env 的全部凭证，仅私有仓库允许此操作。'
        : '\n⚠️ 明文 .env 将进入私有仓库的 Git 历史；首次以你选择的 .env 文件或本次填写的账号令牌创建，不会发布到 Pages。';
    if (payload.sync_local) confirmation += '\n⚠️ 同时覆盖本地公开配置和工作流，并更新本地 .env。';
    if (payload.sync_secrets) confirmation += `\n加密上传 ${Object.keys(payload.secrets).length} 个填写的凭证；留空保留已有 Secrets。`;
    if (payload.notifications?.pushplus.mode === 'enable') confirmation += '\n启用 PushPlus：向两个工作流添加任务结果推送步骤，发送签到步骤状态和 Actions 日志链接，不发送账号凭证；Token 仅加密保存到 PUSHPLUS_TOKEN Secret。'
        + (payload.notifications.pushplus.only_failure ? '\n仅在签到步骤失败时推送。' : '\n签到步骤成功或失败均推送。');
    if (payload.notifications?.pushplus.mode === 'disable') confirmation += '\n关闭由本页面添加的 PushPlus 工作流步骤，保留已有 PUSHPLUS_TOKEN Secret 和其他通知设置。';
    if (payload.sync_secrets) confirmation += '\n⚠️ 文件和 Secrets 不能作为一个原子事务；部分失败会标为未全部完成，已写入部分不会自动回滚。';
    if (!confirm(confirmation + '\n\n确认保存？')) return;
    setGithubBusy(true);
    document.getElementById('github-commit-link').hidden = true;
    showGithubStatus('info', '正在检查配置、提交 GitHub 文件并同步 Secrets，请勿关闭页面…');
    try {
        const result = await githubRequest(payload);
        const complete = result.complete !== false && !result.failed_secrets?.length
            && (result.complete === true || result.warnings.length === 0);
        if (complete) {
            loadFlatData(result.accounts);
            githubAccountsDirty = false;
            githubAccountsLoaded = true;
            clearPushplusDraft();
        }
        document.getElementById('github-branch').value = result.branch;
        const storageWarning = rememberGithubTarget(payload.repository, result.branch);
        const summary = [
            complete ? `已保存 ${result.account_count} 个账号，分支：${result.branch}。`
                : `保存未全部完成，分支：${result.branch}。已写入部分不会自动回滚；当前账号草稿和填写的令牌保留在页面内，可核对后使用已解锁的 PAT 重试。`,
            result.changed_files.length ? '已提交文件：' + result.changed_files.join('、') : '远端文件没有变化，无需新提交。',
            '已更新 Secrets：' + (result.saved_secrets.join('、')
                || (complete ? '无（留空的已有 Secret 保持不变）' : '无已确认成功的更新'))
        ];
        if (result.failed_secrets?.length) summary.push('未完成或需核对的 Secrets：' + result.failed_secrets.join('、'));
        if (result.local_updated) summary.push('本地项目和 .env 已更新；没有自动执行 git add / commit / pull。');
        else summary.push('设备本地文件未更新；如需本地调试，请从 GitHub 拉取配置。');
        summary.push(...result.warnings);
        if (payload.notifications?.pushplus.mode === 'enable') summary.push('PushPlus 工作流步骤已配置；在后续签到任务运行时发送任务结果和日志链接，不是本次保存时发送。');
        if (payload.notifications?.pushplus.mode === 'disable') summary.push('由本页面添加的 PushPlus 步骤已关闭；未删除 Secret 或其他通知渠道。');
        if (storageWarning) summary.push(storageWarning);
        showGithubStatus(!complete ? 'error' : result.warnings.length || storageWarning ? 'info' : 'success', summary.join('\n'));
        const link = document.getElementById('github-commit-link');
        link.href = result.commit_url;
        link.hidden = result.changed_files.length === 0;
    } catch (error) {
        showGithubStatus('error', error instanceof TypeError ? githubConnectionError() : error.message);
    } finally {
        document.getElementById('github-token').value = '';
        const envImport = document.getElementById('github-env-import');
        if (envImport) envImport.value = '';
        setGithubBusy(false);
    }
}

function githubConnectionError() {
    return usesLocalGithubGateway() ? '连接本地服务失败，请确认 serve.py 正在运行'
        : '连接 GitHub API 失败，请检查网络或浏览器限制；无需启动本地服务';
}

document.addEventListener('DOMContentLoaded', restoreGithubTarget);
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('github-pushplus-mode').addEventListener('change', updatePushplusControls);
    const dialog = document.getElementById('github-settings-dialog');
    dialog.addEventListener('cancel', event => { if (githubBusy) event.preventDefault(); });
    dialog.addEventListener('close', finishGithubSettings);
    document.getElementById('github-settings-form').addEventListener('submit', event => {
        event.preventDefault();
        saveGithubSettings();
    });
});
window.addEventListener('pagehide', lockGithubToken);
window.addEventListener('load', loadGithubAccountsOnOpen);
document.addEventListener('account-draft-changed', () => { githubAccountsDirty = true; });
document.addEventListener('account-draft-saved', () => { githubAccountsDirty = true; });
