const GITHUB_TARGET_STORAGE_KEY = 'newapi_checkin_github_target';

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
        const target = JSON.parse(localStorage.getItem(GITHUB_TARGET_STORAGE_KEY) || '{}');
        document.getElementById('github-repository').value = target.repository || '';
        document.getElementById('github-branch').value = target.branch || '';
    } catch {
        return;
    }
}

function usesLocalGithubGateway() {
    return location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(location.hostname);
}

function rememberGithubTarget(repository, branch) {
    try {
        localStorage.setItem(GITHUB_TARGET_STORAGE_KEY, JSON.stringify({repository, branch}));
    } catch {
        return;
    }
}

function githubTarget() {
    if (location.protocol !== 'https:' && !usesLocalGithubGateway()) {
        throw new Error('请从 HTTPS 页面（如 GitHub Pages）使用 GitHub 保存；也可通过本地 serve.py 打开');
    }
    const repository = document.getElementById('github-repository').value.trim();
    const branch = document.getElementById('github-branch').value.trim();
    const token = document.getElementById('github-token').value.trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
        throw new Error('请填写 owner/repo 格式的 GitHub 仓库');
    }
    if (!token) throw new Error('请填写 GitHub Personal Access Token');
    return {repository, branch, token};
}

function showGithubStatus(type, message) {
    const status = document.getElementById('github-status');
    status.className = 'cloud-status ' + type;
    status.textContent = message;
    status.style.display = 'block';
}

function setGithubBusy(busy) {
    document.querySelectorAll('.github-operation').forEach(button => { button.disabled = busy; });
    document.querySelectorAll('.github-pushplus-control').forEach(control => { control.disabled = busy; });
    if (!busy) updatePushplusControls();
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
    const accounts = generateConfig(false);
    if (!accounts) return null;
    const secrets = {};
    let accountIndex = 0;
    const sites = collectFormData();
    sites.forEach(site => {
        let clearanceEnv = site.cfClearanceEnv || '';
        if (site.cfClearance && !clearanceEnv) {
            clearanceEnv = 'CF_CLEARANCE_' + accounts[accountIndex].access_token_env;
        }
        site.accounts.forEach(account => {
            const publicAccount = accounts[accountIndex];
            if (account.accessToken) secrets[publicAccount.access_token_env] = account.accessToken;
            if (clearanceEnv) {
                publicAccount.cf_clearance_env = clearanceEnv;
                if (site.cfClearance) secrets[clearanceEnv] = site.cfClearance;
            }
            accountIndex += 1;
        });
    });
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

async function loadFromGithub() {
    let target;
    try {
        target = githubTarget();
    } catch (error) {
        showGithubStatus('error', error.message);
        return;
    }
    if (!confirm('从 GitHub 加载将覆盖当前账号表单，并清空本页尚未保存的 PushPlus 配置。只读取公开账号配置，不读取 .env 或 Secrets 的值。是否继续？')) return;
    setGithubBusy(true);
    document.getElementById('github-commit-link').hidden = true;
    showGithubStatus('info', '正在加载 GitHub 公开账号配置…');
    try {
        const result = await githubRequest({...target, action: 'load'});
        loadFlatData(result.accounts);
        clearPushplusDraft();
        if (!result.accounts.length) addSite();
        document.getElementById('github-branch').value = result.branch;
        rememberGithubTarget(target.repository, result.branch);
        showGithubStatus('success', `已加载 ${result.accounts.length} 个账号，分支：${result.branch}（${result.private ? '私有' : '公开'}仓库）。已有凭证不会读回，新增或更新令牌时再填写。`);
    } catch (error) {
        showGithubStatus('error', error instanceof TypeError ? githubConnectionError() : error.message);
    } finally {
        setGithubBusy(false);
    }
}

async function saveToGithub() {
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
            clearPushplusDraft();
        }
        document.getElementById('github-branch').value = result.branch;
        rememberGithubTarget(payload.repository, result.branch);
        const summary = [
            complete ? `已保存 ${result.account_count} 个账号，分支：${result.branch}。`
                : `保存未全部完成，分支：${result.branch}。已写入部分不会自动回滚；当前账号草稿和填写的令牌保留在页面内，可核对后重新输入 PAT 重试。`,
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
        showGithubStatus(!complete ? 'error' : result.warnings.length ? 'info' : 'success', summary.join('\n'));
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
});
