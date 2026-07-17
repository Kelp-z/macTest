/**
 * 按 SPM 登录用户隔离存储第三方站点账密（如 Clarivate / WoS）
 * 避免多 App 用户共用同一份 config.json 凭证导致串号
 */
const fs = require('fs');
const path = require('path');
const { getSafeProjectPath, ensureDir } = require('../utils/common-utils');

const STORE_RELATIVE = 'credentials/wos-author-by-user.json';

function sanitizeUserKey(username) {
    return String(username || '')
        .trim()
        .toLowerCase()
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
        console.warn(`读取用户凭证库失败: ${e.message}`);
        return {};
    }
}

function saveAll(data) {
    const storePath = getStorePath();
    ensureDir(path.dirname(storePath));
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * @param {string} spmUsername
 * @returns {{email: string, password: string}|null}
 */
function getWosAuthorCredentials(spmUsername) {
    const key = sanitizeUserKey(spmUsername);
    if (!key) return null;
    const entry = loadAll()[key];
    if (!entry || typeof entry !== 'object') return null;
    const email = String(entry.email || '').trim();
    const password = String(entry.password || '');
    if (!email || !password) return null;
    return { email, password };
}

/**
 * @param {string} spmUsername
 * @param {{email: string, password: string}} credentials
 */
function saveWosAuthorCredentials(spmUsername, credentials = {}) {
    const key = sanitizeUserKey(spmUsername);
    if (!key) {
        throw new Error('缺少 SPM 用户名，无法按用户保存 WoS 账密');
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
    sanitizeUserKey,
    getWosAuthorCredentials,
    saveWosAuthorCredentials
};
