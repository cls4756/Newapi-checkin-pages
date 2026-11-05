"""Isolated Chrome UI tests. All URLs and credentials are fictional; network is blocked."""
import importlib.util
import json
import mimetypes
import re
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('pages_build', ROOT / 'scripts' / 'build_pages.py')
pages_build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pages_build)


class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='newapi-ui-test-')
        cls.output = Path(cls.temporary.name) / 'site'
        pages_build.build_pages(ROOT, cls.output)
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(channel='chrome', headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.temporary.cleanup()

    def setUp(self):
        self.context = self.browser.new_context()
        self.addCleanup(self.context.close)
        self.network = []
        self.errors = []
        self.context.route('**/*', self.route)
        self.context.add_init_script('''document.addEventListener('DOMContentLoaded', () => {
            if (!globalThis.GitHubBrowserConfig) return;
            window.githubLoadCalls = [];
            window.GitHubBrowserConfig = {...GitHubBrowserConfig, handle: async payload => {
                if (payload.action !== 'load') throw new Error('Unexpected unmocked save');
                githubLoadCalls.push(payload);
                return {accounts: JSON.parse(sessionStorage.getItem('fictional-remote-accounts') || '[]'),
                    branch: payload.branch || 'main', private: true};
            }};
        });''')
        self.page = self.context.new_page()
        self.page.set_default_timeout(7000)
        self.dialogs = []
        self.dialog_handler = lambda dialog: (self.dialogs.append(dialog.message), dialog.accept())
        self.page.on('dialog', self.dialog_handler)
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.goto('https://ui.invalid/config_generator.html')
        self.page.wait_for_load_state('load')
        self.assertTrue(self.page.evaluate('async () => { await sodium.ready; return typeof sodium.crypto_box_seal === "function"; }'))

    def tearDown(self):
        self.assertEqual(self.errors, [])
        self.assertEqual(self.network, [])

    def route(self, route):
        parsed = urlsplit(route.request.url)
        relative = parsed.path.lstrip('/')
        if parsed.hostname == 'ui.invalid' and relative in pages_build.PUBLIC_FILES:
            route.fulfill(body=(self.output / relative).read_bytes(),
                          content_type=mimetypes.guess_type(relative)[0] or 'application/octet-stream')
        else:
            if parsed.hostname == 'api.github.com':
                self.network.append(route.request.method + ' ' + parsed.path)
            route.abort()

    def open_settings(self):
        if not self.page.locator('#github-settings-dialog').is_visible():
            self.page.get_by_role('button', name='⚙️ 设置', exact=True).click()
        expect(self.page.locator('#github-settings-dialog')).to_be_visible()

    def test_pause_resume_and_vyceai_editor_preserve_public_configuration(self):
        self.add_account()
        toggle = self.page.get_by_role('switch', name='启用签到：Fictional account', exact=True)
        expect(toggle).to_have_attribute('aria-checked', 'true')
        toggle.click()
        public = self.page.evaluate('generateConfig(false)')
        self.assertIs(public[0]['enabled'], False)
        self.assertNotIn('fictional-account-token', json.dumps(public))
        self.page.evaluate('loadFlatData', public)
        expect(toggle).to_have_attribute('aria-checked', 'false')
        toggle.click()
        self.assertIs(self.page.evaluate('generateConfig(false)')[0]['enabled'], True)
        self.page.locator('#account-add').click()
        self.page.locator('#account-field-type').select_option('vyceai')
        expect(self.page.locator('#account-field-userId')).to_be_hidden()
        self.page.locator('#account-field-name').fill('VyceAI synthetic')
        self.page.locator('#account-field-accessToken').fill('synthetic-session-token')
        self.page.locator('#account-field-enabled').uncheck()
        self.page.get_by_role('button', name='保存到表格', exact=True).click()
        vyce = self.page.evaluate('generateConfig(false)')[1]
        self.assertEqual(vyce['type'], 'vyceai')
        self.assertIs(vyce['enabled'], False)
        self.assertNotIn('user_id', vyce)
        self.page.get_by_role('button', name='编辑账号：VyceAI synthetic', exact=True).click()
        self.page.locator('#account-field-accessTokenEnv').fill('VYCEAI_ROTATED')
        self.page.get_by_role('button', name='保存到表格', exact=True).click()
        updated = self.page.evaluate('generateConfig(false)')[1]
        self.assertEqual(updated['account_id'], vyce['account_id'])
        self.assertEqual(updated['session_token_env'], 'VYCEAI_ROTATED')
        self.assertIs(updated['enabled'], False)
        exported = self.page.evaluate('AccountExports.build(collectFormData())')
        self.assertEqual(exported['secrets']['VYCEAI_ROTATED'], 'synthetic-session-token')
        self.assertNotIn('synthetic-session-token', json.dumps(exported['publicAccounts']))
        self.page.evaluate('loadFlatData', exported['publicAccounts'])
        self.assertEqual(self.page.evaluate('generateConfig(false)'), exported['publicAccounts'])

    def test_wide_table_and_mobile_editor_layout(self):
        self.page.set_viewport_size({'width': 1600, 'height': 1000})
        self.page.evaluate('''() => loadFlatData(Array.from({length: 10}, (_, i) => ({
            url: 'https://synthetic.example', user_id: String(i + 1), name: 'Synthetic account ' + (i + 1),
            access_token_env: 'SYNTHETIC_TOKEN_' + i, enabled: i % 2 === 0})))''')
        box = self.page.locator('.container').bounding_box()
        self.assertGreaterEqual(box['width'], 1400)
        self.assertLessEqual(box['x'], 100)
        first_row = self.page.locator('#account-table-body tr').first.bounding_box()
        self.assertLessEqual(first_row['height'], 70)
        self.page.set_viewport_size({'width': 390, 'height': 844})
        self.page.locator('#account-add').click()
        editor = self.page.locator('#account-editor').bounding_box()
        self.assertGreaterEqual(editor['x'], 0)
        self.assertLessEqual(editor['width'], 390)
        self.assertEqual(self.page.locator('.account-editor-grid').first.evaluate(
            '(node) => getComputedStyle(node).gridTemplateColumns.split(" ").length'), 1)

    def open_sync(self):
        if not self.page.locator('#github-section').is_visible():
            self.page.get_by_role('button', name='🐙 GitHub 同步', exact=True).click()

    def submit_settings(self):
        self.page.get_by_role('button', name='💾 保存设置', exact=True).click()
        expect(self.page.locator('#github-settings-dialog')).to_be_hidden()
        self.page.wait_for_function('!githubBusy')

    def unlock_settings(self):
        self.open_settings()
        self.page.locator('#github-vault-password').fill('fictional-password')
        self.page.get_by_role('button', name='🔓 解锁 PAT', exact=True).click()
        expect(self.page.locator('#github-settings-dialog')).to_be_hidden()
        expect(self.page.locator('#github-settings-summary')).to_contain_text('PAT 已解锁')
        self.page.wait_for_function('!githubBusy')

    def save_settings(self):
        self.open_settings()
        self.page.locator('#github-repository').fill('fictional-owner/config')
        self.page.locator('#github-branch').fill('main')
        self.page.locator('#github-token').fill('fictional-pat')
        self.page.locator('#github-remember-token').check()
        self.page.locator('#github-vault-password').fill('fictional-password')
        self.page.locator('#github-vault-confirm').fill('fictional-password')
        self.submit_settings()
        expect(self.page.locator('#github-table-status')).to_contain_text('已加载')
        self.open_sync()

    def dismiss_dialogs(self):
        self.page.remove_listener('dialog', self.dialog_handler)
        self.dialog_handler = lambda dialog: (self.dialogs.append(dialog.message), dialog.dismiss())
        self.page.on('dialog', self.dialog_handler)

    def remote_account(self, name):
        self.page.evaluate('''name => sessionStorage.setItem('fictional-remote-accounts', JSON.stringify([
            {url:'https://fictional-remote.example',user_id:'456',name,access_token_env:'REMOTE_TOKEN'}]))''', name)

    def add_account(self):
        self.page.locator('#account-add').click()
        self.page.locator('#account-field-url').fill('https://fictional.example')
        self.page.locator('#account-field-userId').fill('123')
        self.page.locator('#account-field-name').fill('Fictional account')
        self.page.locator('#account-field-accessTokenEnv').fill('FICTIONAL_TOKEN')
        self.page.locator('#account-field-accessToken').fill('fictional-account-token')
        self.page.get_by_role('button', name='保存到表格', exact=True).click()
        expect(self.page.locator('#account-count')).to_contain_text('1 个账号')

    def mock_github(self, partial=False):
        self.page.evaluate('''partial => {
            window.githubCalls = [];
            window.GitHubBrowserConfig = {...GitHubBrowserConfig, handle: async payload => {
                githubCalls.push(payload);
                if (payload.action === 'load') return {accounts: [], branch: 'main', private: true};
                return {accounts: payload.accounts, account_count: payload.accounts.length, branch: 'main',
                    changed_files: ['accounts.config.json'], saved_secrets: partial ? [] : ['FICTIONAL_TOKEN'],
                    failed_secrets: partial ? ['FICTIONAL_TOKEN'] : [], complete: !partial,
                    commit_url: 'https://github.com/fictional-owner/config/commit/fictional',
                    local_updated: false, warnings: partial ? ['Fictional Secret failure'] : []};
            }};
        }''', partial)

    def test_settings_persist_encrypted_and_unlock_after_reload(self):
        self.save_settings()
        stored = self.page.evaluate('JSON.stringify(localStorage)')
        self.assertNotIn('fictional-pat', stored)
        self.assertNotIn('fictional-password', stored)
        self.assertEqual(self.context.cookies(), [])
        self.page.reload()
        expect(self.page.locator('#github-settings-dialog')).to_be_visible()
        expect(self.page.locator('#github-repository')).to_have_value('fictional-owner/config')
        expect(self.page.locator('#github-vault-status')).to_contain_text('请解锁')
        self.page.locator('#github-vault-password').fill('wrong-password')
        self.page.get_by_role('button', name='🔓 解锁 PAT', exact=True).click()
        expect(self.page.locator('#github-settings-status')).to_contain_text('解锁失败')
        self.assertEqual(self.page.evaluate('githubLoadCalls.length'), 0)
        self.unlock_settings()
        expect(self.page.locator('#github-table-status')).to_contain_text('已加载 0 个账号')
        self.assertEqual(self.page.evaluate('githubLoadCalls.length'), 1)
        expect(self.page.locator('#github-vault-password')).to_have_value('')
        self.add_account()
        self.mock_github()
        self.open_sync()
        self.page.get_by_role('button', name='🐙 确认并保存到 GitHub', exact=True).click()
        expect(self.page.locator('#github-status')).to_contain_text('已保存 1 个账号')
        self.assertEqual(self.page.evaluate('githubCalls.length'), 1)
        self.assertEqual(self.page.evaluate('githubCalls[0].token'), 'fictional-pat')
        self.open_settings()
        self.page.get_by_role('button', name='🔒 立即锁定', exact=True).click()
        expect(self.page.locator('#github-vault-status')).to_contain_text('请解锁')
        self.page.get_by_role('button', name='删除已保存的 PAT', exact=True).click()
        expect(self.page.locator('#github-vault-status')).to_contain_text('PAT 未保存')

    def test_settings_modal_cancel_restores_options_and_clears_sensitive_inputs(self):
        self.save_settings()
        saved = self.page.evaluate('JSON.stringify(localStorage)')
        for action in ('cancel', 'escape', 'close'):
            self.open_settings()
            self.assertTrue(self.page.locator('#github-settings-dialog').evaluate('dialog => dialog.matches(":modal")'))
            self.page.locator('#github-repository').fill('fictional-owner/unsaved')
            self.page.locator('#github-save-mode').select_option('replace')
            self.page.locator('#github-token').fill('unsaved-fictional-token')
            self.page.locator('#github-vault-password').fill('unsaved-fictional-password')
            if action == 'escape':
                self.page.keyboard.press('Escape')
            elif action == 'close':
                self.page.get_by_role('button', name='关闭 GitHub 设置', exact=True).click()
            else:
                self.page.locator('#github-settings-dialog').get_by_role('button', name='取消', exact=True).click()
            expect(self.page.locator('#github-settings-dialog')).to_be_hidden()
            expect(self.page.locator('#github-repository')).to_have_value('fictional-owner/config')
            expect(self.page.locator('#github-save-mode')).to_have_value('merge')
            expect(self.page.locator('#github-token')).to_have_value('')
            expect(self.page.locator('#github-vault-password')).to_have_value('')
            self.assertEqual(self.page.evaluate('JSON.stringify(localStorage)'), saved)
            self.assertEqual(self.page.evaluate('githubLoadCalls.length'), 1)
        self.page.set_viewport_size({'width': 375, 'height': 667})
        self.open_settings()
        for selector in ('#github-settings-dialog', '.github-settings-footer'):
            box = self.page.locator(selector).bounding_box()
            self.assertGreaterEqual(box['x'], 0)
            self.assertGreaterEqual(box['y'], 0)
            self.assertLessEqual(box['x'] + box['width'], 375)
            self.assertLessEqual(box['y'] + box['height'], 667)
        self.page.locator('#github-branch').fill('fictional-branch')
        self.submit_settings()
        expect(self.page.locator('#github-table-status')).to_contain_text('分支：fictional-branch')

    def test_reload_unlocks_then_reads_latest_github_instead_of_browser_draft(self):
        self.save_settings()
        self.add_account()
        self.page.get_by_role('button', name='💾 保存浏览器草稿', exact=True).click()
        self.remote_account('Latest remote account')
        self.dialogs.clear()
        self.page.reload()
        expect(self.page.locator('#github-settings-dialog')).to_be_visible()
        expect(self.page.locator('#github-vault-password')).to_be_focused()
        self.assertEqual(self.page.evaluate('githubLoadCalls.length'), 0)
        expect(self.page.locator('#account-count')).to_contain_text('0 个账号')
        self.unlock_settings()
        expect(self.page.get_by_role('button', name='编辑账号：Latest remote account', exact=True)).to_be_visible()
        self.assertEqual(self.page.evaluate('githubLoadCalls.length'), 1)
        self.assertEqual(self.page.evaluate('githubLoadCalls[0].action'), 'load')
        self.assertEqual(self.dialogs, [])
        self.assertEqual(self.page.evaluate('AccountTable.collectGrouped()[0].accounts[0].accessToken'), '')

    def test_refresh_reads_latest_and_failed_refresh_preserves_current_rows(self):
        self.remote_account('Original remote account')
        self.save_settings()
        expect(self.page.get_by_role('button', name='编辑账号：Original remote account', exact=True)).to_be_visible()
        self.remote_account('Updated remote account')
        self.page.get_by_role('button', name='🔄 刷新账号', exact=True).click()
        expect(self.page.get_by_role('button', name='编辑账号：Updated remote account', exact=True)).to_be_visible()
        self.assertEqual(self.page.evaluate('githubLoadCalls.length'), 2)
        self.assertEqual(self.dialogs, [])
        self.page.evaluate('() => { GitHubBrowserConfig.handle = async () => { throw new TypeError("Fictional offline"); }; }')
        self.page.get_by_role('button', name='🐙 GitHub 同步', exact=True).click()
        self.page.get_by_role('button', name='🔄 刷新账号', exact=True).click()
        expect(self.page.locator('#github-table-status')).to_contain_text('连接 GitHub API 失败')
        expect(self.page.get_by_role('button', name='编辑账号：Updated remote account', exact=True)).to_be_visible()
        expect(self.page.locator('#account-add')).to_be_enabled()

    def test_refresh_cancel_preserves_edits_and_deletion_of_last_account(self):
        self.save_settings()
        self.add_account()
        self.dismiss_dialogs()
        self.page.get_by_role('button', name='🔄 刷新账号', exact=True).click()
        self.assertEqual(self.page.evaluate('githubLoadCalls.length'), 1)
        expect(self.page.locator('#account-count')).to_contain_text('1 个账号')
        self.assertIn('覆盖当前账号', self.dialogs[-1])
        self.page.evaluate('''() => {
            const original = window.confirm;
            window.confirm = () => true;
            document.querySelector('[aria-label="删除账号：Fictional account"]').click();
            window.confirm = original;
        }''')
        expect(self.page.locator('#account-count')).to_contain_text('0 个账号')
        self.page.get_by_role('button', name='🔄 刷新账号', exact=True).click()
        self.assertEqual(self.page.evaluate('githubLoadCalls.length'), 1)
        self.assertTrue(self.page.evaluate('AccountTable.requiresReplacement()'))
        self.assertEqual(len(self.dialogs), 2)

    def test_refresh_cancel_preserves_unsaved_pushplus_even_with_empty_table(self):
        self.save_settings()
        self.page.locator('#github-pushplus-mode').select_option('enable')
        self.page.locator('#github-pushplus-token').fill('fictional-pushplus-token')
        self.dismiss_dialogs()
        self.page.get_by_role('button', name='🔄 刷新账号', exact=True).click()
        expect(self.page.locator('#github-pushplus-token')).to_have_value('fictional-pushplus-token')
        self.assertEqual(self.page.evaluate('githubLoadCalls.length'), 1)
        self.assertIn('PushPlus', self.dialogs[-1])

    def test_manual_load_continues_after_unlock_without_saving_preference_edits(self):
        self.save_settings()
        self.open_settings()
        self.page.get_by_role('button', name='🔒 立即锁定', exact=True).click()
        self.page.get_by_role('button', name='关闭 GitHub 设置', exact=True).click()
        self.remote_account('Loaded after unlock')
        self.page.get_by_role('button', name='📥 从 GitHub 加载', exact=True).click()
        expect(self.page.locator('#github-settings-dialog')).to_be_visible()
        self.page.locator('#github-repository').fill('fictional-owner/unsaved')
        self.unlock_settings()
        expect(self.page.get_by_role('button', name='编辑账号：Loaded after unlock', exact=True)).to_be_visible()
        self.assertEqual(self.page.evaluate('githubLoadCalls[1].repository'), 'fictional-owner/config')
        self.assertIn('覆盖当前账号', self.dialogs[-1])

    def test_bookmark_editor_opens_after_initial_github_load_or_cancelled_unlock(self):
        self.save_settings()
        self.remote_account('Remote before import')
        self.page.goto('https://ui.invalid/config_generator.html?fictional=load#add-account')
        expect(self.page.locator('#github-settings-dialog')).to_be_visible()
        expect(self.page.locator('#account-editor')).to_be_hidden()
        self.unlock_settings()
        expect(self.page.locator('#account-editor')).to_be_visible()
        expect(self.page.locator('#account-editor-import-status')).to_contain_text('抓取结果只在剪贴板')
        expect(self.page.locator('#account-count')).to_contain_text('1 个账号')
        self.page.goto('https://ui.invalid/config_generator.html?fictional=cancel#add-account')
        expect(self.page.locator('#github-settings-dialog')).to_be_visible()
        self.page.get_by_role('button', name='关闭 GitHub 设置', exact=True).click()
        expect(self.page.locator('#account-editor')).to_be_visible()
        self.assertEqual(self.page.evaluate('githubLoadCalls.length'), 0)

    def test_exports_include_all_pages_and_are_invalidated_after_edit(self):
        self.add_account()
        self.page.evaluate('''() => { for (let n=2; n<=12; n++) AccountTable.saveAccount({
            url:'https://fictional.example', userId:String(n), name:'Fictional '+n}); }''')
        self.page.locator('#account-search').fill('Fictional account')
        self.page.get_by_role('button', name='✨ 生成配置', exact=True).click()
        accounts = json.loads(self.page.locator('#repository-output').text_content())
        self.assertEqual(len(accounts), 12)
        self.assertNotIn('fictional-account-token', json.dumps(accounts))
        self.assertIn('简单格式仅适用于', self.page.locator('#simple-output').text_content())
        self.page.get_by_role('button', name='编辑账号：Fictional account', exact=True).click()
        self.page.locator('#account-field-name').fill('Renamed')
        self.page.get_by_role('button', name='保存到表格', exact=True).click()
        expect(self.page.locator('#result')).to_be_hidden()
        expect(self.page.locator('#json-output')).to_have_text('')

    def test_deleted_account_draft_keeps_replacement_requirement(self):
        self.save_settings()
        self.add_account()
        self.page.evaluate("AccountTable.saveAccount({url:'https://fictional.example', userId:'456', name:'Remove me'})")
        self.page.get_by_role('button', name='删除账号：Remove me', exact=True).click()
        self.page.get_by_role('button', name='💾 保存浏览器草稿', exact=True).click()
        self.page.reload()
        self.unlock_settings()
        self.page.get_by_role('button', name='📂 加载浏览器草稿', exact=True).click()
        self.assertTrue(self.page.evaluate('AccountTable.requiresReplacement()'))
        self.mock_github()
        self.open_sync()
        self.page.get_by_role('button', name='🐙 确认并保存到 GitHub', exact=True).click()
        expect(self.page.locator('#github-status')).to_contain_text('合并模式无法删除')
        self.assertEqual(self.page.evaluate('githubCalls.length'), 0)
        self.open_settings()
        self.page.locator('#github-save-mode').select_option('replace')
        self.submit_settings()
        self.assertEqual(self.page.evaluate('githubCalls.length'), 0)
        self.page.get_by_role('button', name='🐙 确认并保存到 GitHub', exact=True).click()
        expect(self.page.locator('#github-status')).to_contain_text('已保存 1 个账号')

    def test_partial_secret_failure_preserves_draft_and_reuses_unlocked_pat(self):
        self.save_settings()
        self.add_account()
        self.mock_github(partial=True)
        self.page.get_by_role('button', name='🐙 确认并保存到 GitHub', exact=True).click()
        expect(self.page.locator('#github-status')).to_contain_text('保存未全部完成')
        self.assertEqual(self.page.evaluate('AccountTable.collectGrouped()[0].accounts[0].accessToken'),
                         'fictional-account-token')
        self.page.get_by_role('button', name='🐙 确认并保存到 GitHub', exact=True).click()
        expect(self.page.locator('#github-status')).to_contain_text('保存未全部完成')
        self.assertEqual(self.page.evaluate('githubCalls.length'), 2)
        self.assertNotIn('fictional-account-token', self.page.evaluate('JSON.stringify(localStorage)'))

    def test_pushplus_controls_survive_settings_save_and_partial_retry(self):
        self.save_settings()
        self.add_account()
        self.page.locator('#github-pushplus-mode').select_option('enable')
        self.page.locator('#github-pushplus-token').fill('fictional-pushplus-token')
        self.page.locator('#github-pushplus-only-failure').check()
        self.open_settings()
        self.submit_settings()
        expect(self.page.locator('#github-pushplus-token')).to_be_enabled()
        self.mock_github(partial=True)
        self.page.get_by_role('button', name='🐙 确认并保存到 GitHub', exact=True).click()
        expect(self.page.locator('#github-status')).to_contain_text('保存未全部完成')
        self.assertEqual(self.page.evaluate('githubCalls[0].secrets.PUSHPLUS_TOKEN'), 'fictional-pushplus-token')
        self.assertTrue(self.page.evaluate('githubCalls[0].notifications.pushplus.only_failure'))
        expect(self.page.locator('#github-pushplus-token')).to_have_value('fictional-pushplus-token')
        self.assertNotIn('fictional-pushplus-token', self.page.evaluate('JSON.stringify(localStorage)'))
        self.mock_github()
        self.page.get_by_role('button', name='🐙 确认并保存到 GitHub', exact=True).click()
        expect(self.page.locator('#github-status')).to_contain_text('已保存 1 个账号')
        expect(self.page.locator('#github-pushplus-mode')).to_have_value('preserve')
        expect(self.page.locator('#github-pushplus-token')).to_have_value('')
        expect(self.page.locator('#github-pushplus-token')).to_be_disabled()

    def test_webdav_url_does_not_rewrite_directory_or_store_password_on_typing(self):
        self.page.get_by_role('button', name='☁️ WebDAV 同步（旧流程）', exact=True).click()
        self.page.locator('#cloud-url').fill('https://dav.invalid/dav/folder/')
        self.page.locator('#cloud-username').fill('fictional-user')
        self.page.locator('#cloud-password').fill('fictional-webdav-password')
        self.assertEqual(self.page.evaluate('buildCloudUrl()'), 'https://dav.invalid/dav/folder/newapi-config.json')
        self.assertNotIn('fictional-webdav-password', self.page.evaluate('JSON.stringify(localStorage)'))

    def test_options_restore_and_pages_never_enables_local_file_writes(self):
        self.save_settings()
        self.open_settings()
        self.page.locator('#github-save-mode').select_option('replace')
        self.page.locator('#github-sync-secrets').uncheck()
        self.page.locator('#github-include-env').check()
        self.submit_settings()
        expect(self.page.locator('#github-status')).to_contain_text('设置已保存')
        self.page.reload()
        self.open_settings()
        expect(self.page.locator('#github-save-mode')).to_have_value('replace')
        expect(self.page.locator('#github-sync-secrets')).not_to_be_checked()
        expect(self.page.locator('#github-include-env')).to_be_checked()
        expect(self.page.locator('#github-sync-local')).to_be_disabled()
        expect(self.page.locator('#github-sync-local')).not_to_be_checked()
        expect(self.page.locator('#github-vault-status')).to_contain_text('请解锁')

    def test_busy_load_blocks_duplicates_and_recomputes_pagination(self):
        self.save_settings()
        self.page.evaluate('''() => {
            window.githubCalls = [];
            window.GitHubBrowserConfig = {...GitHubBrowserConfig, handle: payload => {
                githubCalls.push(payload);
                return new Promise(resolve => { window.finishLoad = () => resolve({branch:'main', private:true,
                    accounts: Array.from({length:12}, (_, n) => ({url:'https://fictional.example',
                        user_id:String(n+1), name:'Fictional '+n, access_token_env:'TOKEN_'+n}))}); });
            }};
        }''')
        self.page.get_by_role('button', name='📥 从 GitHub 加载', exact=True).click()
        expect(self.page.locator('#account-add')).to_be_disabled()
        self.page.evaluate('loadFromGithub()')
        self.assertEqual(self.page.evaluate('githubCalls.length'), 1)
        self.page.evaluate('finishLoad()')
        expect(self.page.locator('#account-count')).to_contain_text('12 个账号')
        expect(self.page.locator('#account-page-next')).to_be_enabled()
        self.page.locator('#account-page-next').click()
        expect(self.page.locator('#account-page-info')).to_contain_text('第 2 / 2 页')
        expect(self.page.locator('#account-page-previous')).to_be_enabled()

    def test_cancelled_draft_and_github_saves_make_no_mutations(self):
        self.save_settings()
        self.add_account()
        self.mock_github()
        self.dismiss_dialogs()
        self.page.get_by_role('button', name='💾 保存浏览器草稿', exact=True).click()
        self.assertIsNone(self.page.evaluate("localStorage.getItem('newapi_checkin_accounts')"))
        self.page.get_by_role('button', name='🐙 确认并保存到 GitHub', exact=True).click()
        self.page.get_by_role('button', name='📥 从 GitHub 加载', exact=True).click()
        self.assertEqual(self.page.evaluate('githubCalls.length'), 0)
        expect(self.page.locator('#account-count')).to_contain_text('1 个账号')

    def test_disabled_storage_reports_failure_and_keeps_form(self):
        self.page.add_init_script('''Storage.prototype.getItem = function() { throw new Error('blocked'); };
            Storage.prototype.setItem = function() { throw new Error('blocked'); };''')
        self.page.reload()
        self.add_account()
        self.page.get_by_role('button', name='⚙️ 设置', exact=True).click()
        self.page.locator('#github-repository').fill('fictional-owner/config')
        self.page.locator('#github-token').fill('fictional-pat')
        self.page.get_by_role('button', name='💾 保存设置', exact=True).click()
        expect(self.page.locator('#github-settings-status')).to_contain_text('无法读取浏览器设置')
        expect(self.page.locator('#github-token')).to_have_value('fictional-pat')
        self.page.get_by_role('button', name='关闭 GitHub 设置', exact=True).click()
        expect(self.page.locator('#github-settings-dialog')).to_be_hidden()
        expect(self.page.locator('#account-add')).to_be_enabled()
        expect(self.page.locator('#account-count')).to_contain_text('1 个账号')

    def test_invalid_import_is_atomic_and_deleted_variable_names_survive_reload(self):
        self.add_account()
        self.page.evaluate("AccountTable.saveAccount({url:'https://fictional.example',userId:'2',name:'Deleted'})")
        self.page.get_by_role('button', name='删除账号：Deleted', exact=True).click()
        self.page.get_by_role('button', name='💾 保存浏览器草稿', exact=True).click()
        self.page.reload()
        self.page.get_by_role('button', name='📂 加载浏览器草稿', exact=True).click()
        self.page.evaluate("AccountTable.saveAccount({url:'https://fictional.example',userId:'3',name:'New'})")
        self.assertEqual(self.page.evaluate('AccountTable.collectGrouped()[0].accounts[1].accessTokenEnv'),
                         'NEWAPI_TOKEN_ACCOUNT2')
        self.page.get_by_role('button', name='📋 批量导入 JSON', exact=True).click()
        self.page.locator('#import-json').fill(json.dumps([
            {'url': 'https://fictional.example', 'user_id': '4'},
            {'url': 'https://fictional.example', 'user_id': '5', 'access_token_env': 'GITHUB_TOKEN'}]))
        self.page.evaluate('importJSON()')
        expect(self.page.locator('#account-count')).to_contain_text('2 个账号')

    def test_legacy_fields_are_not_silently_lost_on_github_save(self):
        self.save_settings()
        self.page.evaluate("AccountTable.saveAccount({url:'https://fictional.example',userId:'1',session:'fictional-session'})")
        self.mock_github()
        self.page.get_by_role('button', name='🐙 确认并保存到 GitHub', exact=True).click()
        expect(self.page.locator('#github-status')).to_contain_text('旧版 JSON / WebDAV')
        self.assertEqual(self.page.evaluate('githubCalls.length'), 0)

    def test_webdav_save_preserves_explicit_settings_and_copy_uses_direct_url(self):
        self.add_account()
        self.page.get_by_role('button', name='☁️ WebDAV 同步（旧流程）', exact=True).click()
        self.page.locator('#cloud-url').fill('https://dav.invalid/folder/')
        self.page.locator('#cloud-username').fill('<img src=x onerror="window.leaked=true">')
        self.page.locator('#cloud-password').fill('fictional-password')
        self.page.get_by_role('button', name='💾 记住 WebDAV 连接信息', exact=True).click()
        stored = self.page.evaluate("localStorage.getItem('newapi_checkin_cloud_config')")
        self.page.locator('#cloud-url').fill('https://dav.invalid/new-folder/')
        self.page.get_by_role('button', name='☁️ WebDAV 同步（旧流程）', exact=True).click()
        self.page.get_by_role('button', name='☁️ WebDAV 同步（旧流程）', exact=True).click()
        expect(self.page.locator('#cloud-url')).to_have_value('https://dav.invalid/new-folder/')
        self.page.evaluate('''() => {
            window.davCalls = []; window.copied = [];
            window.fetch = async (url, options) => { davCalls.push({url, options}); return {ok:true, status:204}; };
            Object.defineProperty(navigator, 'clipboard', {value: {writeText: async text => copied.push(text)}, configurable:true});
        }''')
        self.page.evaluate('saveToCloud()')
        expect(self.page.locator('#cloud-status')).to_contain_text('配置已保存到云端')
        self.assertEqual(self.page.evaluate("localStorage.getItem('newapi_checkin_cloud_config')"), stored)
        self.assertEqual(self.page.evaluate('window.leaked'), None)
        self.assertEqual(self.page.locator('.cloud-usage-tip img').count(), 0)
        self.page.locator("button[onclick=\"copySecretValue('config_url', this)\"]").click()
        self.assertEqual(self.page.evaluate('copied[0]'), 'https://dav.invalid/new-folder/newapi-config.json')
        self.assertEqual(self.page.evaluate('davCalls[0].options.method'), 'PUT')

    def test_webdav_proxy_is_applied_once_and_cancelled_requests_do_not_send(self):
        self.page.get_by_role('button', name='☁️ WebDAV 同步（旧流程）', exact=True).click()
        self.page.locator('#cloud-url').fill('https://dav.invalid/folder/')
        self.page.locator('#cloud-username').fill('fictional-user')
        self.page.locator('#cloud-password').fill('fictional-password')
        self.page.locator('#cors-proxy-enabled').check()
        self.page.locator('.cors-proxy-custom').click()
        self.page.locator('#cors-proxy-url').fill('https://proxy.invalid/?url=')
        self.page.evaluate('''() => { window.davCalls=[]; window.fetch=async (url, options) => {
            davCalls.push({url, options}); return {ok:true, status:207}; }; }''')
        self.page.evaluate('testCloudConnection()')
        self.assertEqual(self.page.evaluate('davCalls[0].url'),
                         'https://proxy.invalid/?url=https%3A%2F%2Fdav.invalid%2Ffolder%2F')
        self.assertEqual(self.page.evaluate('davCalls[0].options.method'), 'PROPFIND')
        self.dismiss_dialogs()
        self.page.evaluate('testCloudConnection()')
        self.assertEqual(self.page.evaluate('davCalls.length'), 1)
        expect(self.page.locator('#cloud-status')).to_contain_text('已取消第三方代理请求')

    def test_dashboard_on_pages_explains_missing_local_proxy(self):
        self.page.goto('https://ui.invalid/dashboard.html')
        expect(self.page.locator('#cards')).to_contain_text('公开 Pages 没有本地查询代理')

    def test_every_inline_button_handler_is_available(self):
        for filename in ('config_generator.html', 'index.html', 'dashboard.html'):
            self.page.goto('https://ui.invalid/' + filename)
            handlers = self.page.locator('[onclick], [onchange], [oninput]').evaluate_all('''elements =>
                elements.flatMap(element => ['onclick','onchange','oninput'].map(name => element.getAttribute(name) || ''))''')
            for handler in handlers:
                for function in re.findall(r'(?<![\w.])([A-Za-z_$][\w$]*)\s*\(', handler):
                    self.assertEqual(self.page.evaluate('name => typeof globalThis[name]', function), 'function',
                                     filename + ': missing handler ' + function)

    def test_dashboard_local_requests_use_auth_and_support_current_draft_format(self):
        self.context.route('http://127.0.0.1:8765/dashboard.html', lambda route: route.fulfill(
            body=(self.output / 'dashboard.html').read_bytes(), content_type='text/html'))
        self.context.add_init_script('''if (location.hostname === '127.0.0.1') {
            localStorage.setItem('newapi_checkin_accounts', JSON.stringify({version:1, sites:[{
                url:'https://fictional.example',accounts:[{userId:'1', name:'Fictional', accessToken:'Bearer fictional-token'},
                    {userId:'2', name:'Session',session:'fictional-session'}]}]})); }''')
        calls = []

        def proxy(route):
            payload = route.request.post_data_json
            calls.append(payload)
            data = {'success': True, 'data': {'username': 'fictional', 'quota': 500000}}
            if '/checkin?' in payload['url']:
                data = {'success': True, 'data': {'stats': {'checked_in_today': True, 'checkin_count': 1},
                        'records': [{'checkin_date': '2026-11-01', 'quota_awarded': 500000}]}}
            route.fulfill(json={'status': 200, 'text': json.dumps(data)})

        self.context.route('http://127.0.0.1:8765/cloud-proxy', proxy)
        self.page.goto('http://127.0.0.1:8765/dashboard.html')
        expect(self.page.locator('.card')).to_have_count(2)
        self.assertEqual(len(calls), 4)
        self.assertEqual(calls[0]['headers']['Authorization'], 'Bearer fictional-token')
        self.assertEqual(calls[2]['headers']['Cookie'], 'session=fictional-session')
        self.assertEqual(calls[2]['headers']['New-Api-User'], '2')
        expect(self.page.locator('.rec-row')).to_have_count(2)


if __name__ == '__main__':
    unittest.main()
