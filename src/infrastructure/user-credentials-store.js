/**
 * 按终端 ID（机器码）隔离存储第三方站点账密（如 Clarivate / WoS）
 * 同一台检索引擎终端共用一份 WoS 账密，不同终端互不影响
 */
const fs = require('fs');
const path = require('path');
const { getSafeProjectPath, ensureDir } = require('../utils/common-utils');

const STORE_RELATIVE = 'credentials/wos-author-by-terminal.json';
const LEGACY_USER_STORE_RELATIVE = 'credentials/wos-author-by-user.json';

function sanitizeTerminalKey(terminalId) {
    return String(terminalId || '')
        .trim()
        .replace(/[^\w.@+-]/g, '_');
}

function getStorePath() {
    return getSafeProjectPath(STORE_RELATIVE);
}

function loadAll() {
    const storePath = getStorePath();
    try {
        if (!fs.existsSync(storePath)) return {};
        const raw = fs.readFileSync(storePath, 'utf8');
        const data = JSON.parse(raw);
        return data && typeof data === 'object' ? data : {};
    } catch (e) {
        console.warn(`读取终端凭证库失败: ${e.message}`);
        return {};
    }
}

function saveAll(data) {
    const storePath = getStorePath();
    ensureDir(path.dirname(storePath));
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * 兼容旧版「按 App 用户」存储：取最近一条有账密的记录用于迁移到当前终端
 * @returns {{email: string, password: string}|null}
 */
function loadLegacyUserCredentials() {
    try {
        const legacyPath = getSafeProjectPath(LEGACY_USER_STORE_RELATIVE);
        if (!fs.existsSync(legacyPath)) return null;
        const data = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
        if (!data || typeof data !== 'object') return null;
        let best = null;
        for (const entry of Object.values(data)) {
            if (!entry || typeof entry !== 'object') continue;
            const email = String(entry.email || '').trim();
            const password = String(entry.password || '');
            if (!email || !password) continue;
            if (!best || String(entry.updatedAt || '') > String(best.updatedAt || '')) {
                best = { email, password, updatedAt: entry.updatedAt || '' };
            }
        }
        return best ? { email: best.email, password: best.password } : null;
    } catch (e) {
        return null;
    }
}

/**
 * @param {string} terminalId
 * @returns {{email: string, password: string}|null}
 */
function getWosAuthorCredentials(terminalId) {
    const key = sanitizeTerminalKey(terminalId);
    if (!key) return null;
    const entry = loadAll()[key];
    if (!entry || typeof entry !== 'object') return null;
    const email = String(entry.email || '').trim();
    const password = String(entry.password || '');
    if (!email || !password) return null;
    return { email, password };
}

/**
 * @param {string} terminalId
 * @param {{email: string, password: string}} credentials
 */
function saveWosAuthorCredentials(terminalId, credentials = {}) {
    const key = sanitizeTerminalKey(terminalId);
    if (!key) {
        throw new Error('缺少终端 ID，无法按终端保存 WoS 账密');
    }
    const email = String(credentials.email || '').trim();
    const password = String(credentials.password || '');
    if (!email || !password) {
        throw new Error('邮箱或密码为空，跳过保存');
    }
    const all = loadAll();
    all[key] = {
        email,
        password,
        updatedAt: new Date().toISOString()
    };
    saveAll(all);
    return all[key];
}

module.exports = {
    sanitizeTerminalKey,
    getWosAuthorCredentials,
    saveWosAuthorCredentials,
    loadLegacyUserCredentials
};
