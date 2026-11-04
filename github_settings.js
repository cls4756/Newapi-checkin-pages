/* Browser-only preferences and password-encrypted PAT. Never sends network requests. */
globalThis.GitHubSettings = (() => {
    const storageKey = 'newapi_checkin_github_target';
    const iterations = 600000;
    const additionalData = new TextEncoder().encode('newapi-checkin/github-pat/v1');

    function preferences(value = {}) {
        return {
            version: 1,
            repository: typeof value.repository === 'string' ? value.repository.slice(0, 300) : '',
            branch: typeof value.branch === 'string' ? value.branch.slice(0, 255) : '',
            mode: value.mode === 'replace' ? 'replace' : 'merge',
            syncSecrets: value.syncSecrets !== false,
            includeEnv: value.includeEnv === true,
            syncLocal: value.syncLocal === true,
        };
    }

    function read(storage = localStorage) {
        try {
            const value = JSON.parse(storage.getItem(storageKey) || '{}');
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
            return {...preferences(value), vault: value.vault || null};
        } catch {
            throw new Error('无法读取浏览器设置；请检查浏览器存储权限，或清除损坏的设置后重新保存');
        }
    }

    function write(value, vault = null, storage = localStorage) {
        if (vault !== null) vault = validateVault(vault);
        try {
            storage.setItem(storageKey, JSON.stringify({...preferences(value), vault}));
        } catch {
            throw new Error('设置未保存：浏览器存储不可用或空间不足');
        }
    }

    function clear(storage = localStorage) {
        try { storage.removeItem(storageKey); }
        catch { throw new Error('无法清除浏览器设置，请检查存储权限'); }
    }

    function available() {
        return Boolean(globalThis.crypto?.subtle && globalThis.crypto?.getRandomValues);
    }

    function encode(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
    function decode(value) {
        if (typeof value !== 'string' || value.length > 8192 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error();
        return Uint8Array.from(atob(value), character => character.charCodeAt(0));
    }

    function validateVault(vault) {
        try {
            if (!vault || vault.version !== 1 || vault.iterations !== iterations
                    || vault.algorithm !== 'AES-GCM' || vault.kdf !== 'PBKDF2-SHA256'
                    || decode(vault.salt).length !== 16 || decode(vault.iv).length !== 12) throw new Error();
            const length = decode(vault.ciphertext).length;
            if (length < 17 || length > 4112) throw new Error();
        } catch { throw new Error('已保存的 PAT 密文格式无效，请删除后重新保存'); }
        return Object.fromEntries(['version', 'algorithm', 'kdf', 'iterations', 'salt', 'iv', 'ciphertext']
            .map(key => [key, vault[key]]));
    }

    function validateToken(token) {
        if (typeof token !== 'string' || !token.trim() || token.length > 4096 || /[^\x21-\x7e]/.test(token.trim())) {
            throw new Error('请填写有效的 GitHub PAT');
        }
        return token.trim();
    }

    async function keyFor(password, salt) {
        if (!available()) throw new Error('当前浏览器不支持安全加密，请使用 HTTPS 或本地服务打开页面');
        if (typeof password !== 'string' || !password || password.length > 1024) throw new Error('请输入解锁密码');
        const bytes = new TextEncoder().encode(password);
        try {
            const key = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
            return await crypto.subtle.deriveKey({name: 'PBKDF2', hash: 'SHA-256', salt, iterations},
                key, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
        } finally { bytes.fill(0); }
    }

    async function encrypt(token, password) {
        token = validateToken(token);
        if (typeof password !== 'string' || password.length < 5) throw new Error('保存 PAT 时请设置至少 5 个字符的解锁密码');
        if (!available()) throw new Error('当前浏览器不支持安全加密，请使用 HTTPS 或本地服务打开页面');
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await keyFor(password, salt);
        const bytes = new TextEncoder().encode(token);
        try {
            const encrypted = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData}, key, bytes);
            return {version: 1, algorithm: 'AES-GCM', kdf: 'PBKDF2-SHA256', iterations,
                salt: encode(salt), iv: encode(iv), ciphertext: encode(encrypted)};
        } finally { bytes.fill(0); }
    }

    async function decrypt(vault, password) {
        validateVault(vault);
        const key = await keyFor(password, decode(vault.salt));
        let bytes;
        try {
            bytes = new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv: decode(vault.iv), additionalData},
                key, decode(vault.ciphertext)));
            return validateToken(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
        } catch { throw new Error('解锁失败：密码不正确或已保存的密文损坏'); }
        finally { bytes?.fill(0); }
    }

    return Object.freeze({storageKey, preferences, read, write, clear, available, encrypt, decrypt, validateToken});
})();
