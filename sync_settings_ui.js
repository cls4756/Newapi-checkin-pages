let activeSettingsTab = 'github';
let webdavSettingsSnapshot = null;
let pendingWebdavAction = null;
let pendingEnvImport = null;
const webdavSettingFields = ['cloud-url', 'cloud-auth-type', 'cloud-username', 'cloud-password',
    'cloud-token', 'cloud-filename', 'cors-proxy-enabled', 'cors-proxy-url', 'cloud-remember-credentials'];

function switchSettingsTab(tab) {
    if (!['github', 'services', 'webdav', 'tools'].includes(tab)) tab = 'github';
    activeSettingsTab = tab;
    for (const button of document.querySelectorAll('.settings-tabs [role="tab"]')) {
        const selected = button.id === 'settings-tab-' + tab;
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
        document.getElementById(button.getAttribute('aria-controls')).hidden = !selected;
    }
    document.getElementById('settings-save').hidden = tab === 'tools';
    document.querySelector('.github-settings-body').scrollTop = 0;
}

function captureWebdavSettings() {
    loadCloudConfigFromLocal();
    webdavSettingsSnapshot = {
        fields: webdavSettingFields.map(id => {
            const element = document.getElementById(id);
            const property = element.type === 'checkbox' ? 'checked' : 'value';
            return {id, property, value: element[property]};
        }),
        preset: document.querySelector('.cloud-preset-btn.active')?.id,
        proxyLabel: document.getElementById('cors-proxy-picker-btn').firstElementChild.textContent,
        proxyInfo: document.getElementById('cors-proxy-friendly-name').textContent,
        proxyDisplay: document.getElementById('cors-proxy-url').style.display
    };
}

function finishWebdavSettings(result) {
    closeCorsProxyPicker();
    if (result !== 'webdav-saved' && webdavSettingsSnapshot) {
        const snapshot = webdavSettingsSnapshot;
        snapshot.fields.forEach(({id, property, value}) => { document.getElementById(id)[property] = value; });
        document.querySelectorAll('.cloud-preset-btn').forEach(button => button.classList.toggle('active', button.id === snapshot.preset));
        document.getElementById('cors-proxy-picker-btn').firstElementChild.textContent = snapshot.proxyLabel;
        document.getElementById('cors-proxy-friendly-name').textContent = snapshot.proxyInfo;
        document.getElementById('cors-proxy-url').style.display = snapshot.proxyDisplay;
        document.getElementById('cloud-auth-type').dispatchEvent(new Event('change'));
        const proxyEnabled = document.getElementById('cors-proxy-enabled').checked;
        document.getElementById('cors-proxy-field').style.display = proxyEnabled ? 'block' : 'none';
        document.getElementById('cors-proxy-warning').style.display = proxyEnabled ? 'block' : 'none';
        updateCorsProxyPreview();
    }
    webdavSettingsSnapshot = null;
    const action = result === 'webdav-saved' ? pendingWebdavAction : null;
    pendingWebdavAction = null;
    return action;
}

function saveSyncSettings() {
    if (githubBusy || githubSettingsBusy) return;
    if (activeSettingsTab === 'tools') return;
    if (activeSettingsTab !== 'webdav') return saveGithubSettings();
    if (!buildCloudUrl() || !buildCloudHeaders()) return;
    if (!saveCloudConfigToLocal(document.getElementById('cloud-remember-credentials').checked)) return;
    closeGithubSettings('webdav-saved');
}

function syncWebdav() {
    if (githubBusy || githubSettingsBusy) return;
    loadCloudConfigFromLocal();
    if (!buildCloudUrl() || !buildCloudHeaders()) {
        pendingWebdavAction = saveToCloud;
        openGithubSettings('webdav');
        return;
    }
    return saveToCloud();
}

function requestGithubEnvTemplate() {
    if (pendingEnvImport) return Promise.reject(new Error('已有导入操作正在进行'));
    const dialog = document.getElementById('github-env-dialog');
    document.getElementById('github-env-import').value = '';
    document.getElementById('github-env-status').style.display = 'none';
    dialog.returnValue = '';
    return new Promise((resolve, reject) => {
        pendingEnvImport = {resolve, reject, reading: false};
        dialog.showModal();
    });
}

async function finishGithubEnvImport(useFile) {
    const pending = pendingEnvImport;
    if (!pending || pending.reading) return;
    const dialog = document.getElementById('github-env-dialog');
    const input = document.getElementById('github-env-import');
    try {
        let text = '';
        if (useFile) {
            const file = input.files?.[0];
            if (!file) throw new Error('请先选择 .env 文件');
            if (file.size > 1024 * 1024) throw new Error('.env 文件过大，最大支持 1 MB');
            pending.reading = true;
            try { text = await file.text(); }
            catch { throw new Error('无法读取所选文件，请重新选择'); }
        }
        if (pendingEnvImport !== pending) return;
        pendingEnvImport = null;
        input.value = '';
        dialog.close('imported');
        pending.resolve(text);
    } catch (error) {
        if (pendingEnvImport !== pending) return;
        const status = document.getElementById('github-env-status');
        status.className = 'cloud-status error';
        status.textContent = error.message;
        status.style.display = 'block';
    } finally { pending.reading = false; }
}

document.addEventListener('DOMContentLoaded', () => {
    // Keep the proxy picker in the modal's top layer, outside the settings form.
    document.getElementById('github-settings-dialog').append(document.getElementById('cors-modal-overlay'));
    document.getElementById('cors-modal-overlay').addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        closeCorsProxyPicker();
        document.getElementById('cors-proxy-picker-btn').focus();
    });
    document.querySelector('.settings-tabs').addEventListener('keydown', event => {
        const tabs = Array.from(document.querySelectorAll('.settings-tabs [role="tab"]'));
        let index = tabs.indexOf(document.activeElement);
        if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        switchSettingsTab(tabs[index].id.replace('settings-tab-', ''));
        tabs[index].focus();
    });
    document.getElementById('github-env-dialog').addEventListener('close', () => {
        if (document.getElementById('github-env-dialog').open) return;
        document.getElementById('github-env-import').value = '';
        const pending = pendingEnvImport;
        pendingEnvImport = null;
        pending?.reject(new DOMException('已取消同步，未写入 GitHub', 'AbortError'));
    });
});
