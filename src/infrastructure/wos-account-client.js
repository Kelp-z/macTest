/**
 * 向 Spring 后端领取 / 释放 WoS 账号池凭证
 */
const axios = require('axios');
const configManager = require('./config-manager');

function getSpringBaseUrl() {
    return (configManager.getSpringBaseUrl() || 'http://localhost:8080').replace(/\/$/, '');
}

/**
 * @param {Object} params
 * @param {string} params.terminalId
 * @param {string} [params.taskId]
 * @param {string} params.authToken - JWT（Bearer）
 * @returns {Promise<{accountId:number, email:string, password:string}>}
 */
async function leaseWosAccount({ terminalId, taskId, authToken }) {
    if (!authToken) {
        throw new Error('缺少登录 Token，无法向后端领取 WoS 账号');
    }
    if (!terminalId) {
        throw new Error('缺少 terminalId，无法领取 WoS 账号');
    }
    const url = `${getSpringBaseUrl()}/cite/wos-account/lease`;
    const res = await axios.post(
        url,
        { terminalId, taskId: taskId || '' },
        {
            headers: {
                Authorization: `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000,
            validateStatus: () => true
        }
    );
    const body = res.data || {};
    if (body.code !== 200) {
        throw new Error(body.msg || `领取 WoS 账号失败 (HTTP ${res.status})`);
    }
    const data = body.data || {};
    if (!data.accountId || !data.email || !data.password) {
        throw new Error('后端返回的 WoS 账号不完整');
    }
    return {
        accountId: data.accountId,
        email: data.email,
        password: data.password
    };
}

/**
 * @param {Object} params
 * @param {number|string} params.accountId
 * @param {string} [params.terminalId]
 * @param {string} [params.taskId]
 * @param {string} params.authToken
 */
async function releaseWosAccount({ accountId, terminalId, taskId, authToken }) {
    if (!accountId) return;
    if (!authToken) {
        console.warn('[wos-account] 缺少 Token，跳过释放账号');
        return;
    }
    const url = `${getSpringBaseUrl()}/cite/wos-account/release`;
    const res = await axios.post(
        url,
        {
            accountId,
            terminalId: terminalId || '',
            taskId: taskId || ''
        },
        {
            headers: {
                Authorization: `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000,
            validateStatus: () => true
        }
    );
    const body = res.data || {};
    if (body.code !== 200) {
        throw new Error(body.msg || `释放 WoS 账号失败 (HTTP ${res.status})`);
    }
}

module.exports = {
    leaseWosAccount,
    releaseWosAccount
};
