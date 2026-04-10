// error-utils.js

const ErrorType = {
    // 网络相关
    NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
    PROXY_ERROR: 'PROXY_ERROR',
    PROXY_CONNECT_ERROR: 'PROXY_CONNECT_ERROR',
    // 验证码相关
    CAPTCHA_REQUIRED: 'CAPTCHA_REQUIRED',
    VERIFICATION_ERROR: 'VERIFICATION_ERROR',
    // 浏览器相关
    BROWSER_NOT_FOUND: 'BROWSER_NOT_FOUND',
    BROWSER_DOWNLOAD_FAILED: 'BROWSER_DOWNLOAD_FAILED',
    BROWSER_CLOSED: 'BROWSER_CLOSED',
    // 登录相关
    LOGIN_FAILED: 'LOGIN_FAILED',
    // 页面相关
    PAGE_STRUCTURE_CHANGED: 'PAGE_STRUCTURE_CHANGED',
    NO_RESULTS: 'NO_RESULTS',
    // 用户停止
    USER_STOPPED: 'USER_STOPPED',
    // 未知
    UNKNOWN: 'UNKNOWN'
};

function getErrorType(err) {
    const msg = err.message || '';

    // 优先判断浏览器已关闭
    if (msg.includes('closed') || msg.includes('Target page, context or browser has been closed')) {
        return ErrorType.BROWSER_CLOSED;
    }

    // 用户停止
    if (msg.includes('用户停止')) {
        return ErrorType.USER_STOPPED;
    }

    // 网络超时或连接错误（包括代理未开）
    if (msg.includes('ERR_CONNECTION_TIMED_OUT') ||
        msg.includes('ERR_CONNECTION_REFUSED') ||
        msg.includes('ERR_PROXY_CONNECTION_FAILED') ||
        msg.includes('ERR_TUNNEL_CONNECTION_FAILED') ||
        msg.includes('net::ERR_CONNECTION') ||
        msg.includes('timed out') ||
        msg.includes('timeout')) {
        // 进一步细分：如果是代理相关的错误，可以返回 PROXY_ERROR
        if (msg.includes('ERR_PROXY_CONNECTION_FAILED') || msg.includes('代理连接失败')) {
            return ErrorType.PROXY_CONNECT_ERROR;
        }
        // 默认网络超时/连接错误
        return ErrorType.NETWORK_TIMEOUT;
    }

    // 人机验证
    if (msg.includes('人机验证') || msg.includes('captcha') || msg.includes('unusual activity') ||
        msg.includes('验证码') || msg.includes('verification')) {
        return ErrorType.CAPTCHA_REQUIRED;
    }

    // 浏览器相关
    if (msg.includes('未找到/下载浏览器')) {
        return ErrorType.BROWSER_NOT_FOUND;
    }
    if (msg.includes('浏览器下载失败')) {
        return ErrorType.BROWSER_DOWNLOAD_FAILED;
    }

    // 登录失败
    if (msg.includes('登录失败') || msg.includes('sign in') || msg.includes('login')) {
        return ErrorType.LOGIN_FAILED;
    }

    // 页面结构变化
    if (msg.includes('页面结构') || msg.includes('未找到元素')) {
        return ErrorType.PAGE_STRUCTURE_CHANGED;
    }

    // 无结果
    if (msg.includes('无结果') || msg.includes('no results')) {
        return ErrorType.NO_RESULTS;
    }

    return ErrorType.UNKNOWN;
}

function getUserFriendlyMessage(err, context = '') {
    const type = getErrorType(err);
    switch (type) {
        case ErrorType.NETWORK_TIMEOUT:
            return '连接超时，请检查网络连接或稍后重试。';
        case ErrorType.PROXY_CONNECT_ERROR:
            return '代理连接失败！请检查代理工具是否正常运行，或代理地址/端口是否正确。';
        case ErrorType.CAPTCHA_REQUIRED:
            return '检测到人机验证，请在浏览器中手动完成验证后继续。';
        case ErrorType.BROWSER_NOT_FOUND:
            return '浏览器未找到，请确保 Playwright 已正确安装或提供浏览器文件。';
        case ErrorType.BROWSER_DOWNLOAD_FAILED:
            return '浏览器下载失败，请检查网络连接或手动下载浏览器。';
        case ErrorType.BROWSER_CLOSED:
            return '浏览器意外关闭，可能是用户手动停止或程序异常。';
        case ErrorType.LOGIN_FAILED:
            return '登录失败，请检查用户名/密码是否正确。';
        case ErrorType.PAGE_STRUCTURE_CHANGED:
            return '目标网站页面结构发生变化，请联系管理员更新爬虫。';
        case ErrorType.NO_RESULTS:
            return '未检索到任何结果。';
        case ErrorType.USER_STOPPED:
            return '用户已手动停止任务。';
        default:
            return `检索失败：${err.message || '未知错误'}`;
    }
}

function formatError(err, context = '') {
    return {
        userMessage: getUserFriendlyMessage(err, context),
        type: getErrorType(err),
        detail: err.stack || err.message,
        originalMessage: err.message,
        screenshotPath: err.screenshotPath || null   // 从错误对象中读取截图路径
    };
}

module.exports = {
    ErrorType,
    getErrorType,
    getUserFriendlyMessage,
    formatError
};
