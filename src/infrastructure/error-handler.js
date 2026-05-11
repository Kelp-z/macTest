// src/infrastructure/error-handler.js
const path = require('path');

class ErrorHandler {
    constructor() {
        this.errorCodes = {
            NETWORK_ERROR: 'NETWORK_ERROR',
            TIMEOUT_ERROR: 'TIMEOUT_ERROR',
            AUTH_ERROR: 'AUTH_ERROR',
            CAPTCHA_ERROR: 'CAPTCHA_ERROR',
            BROWSER_ERROR: 'BROWSER_ERROR',
            DATA_ERROR: 'DATA_ERROR',
            UNKNOWN_ERROR: 'UNKNOWN_ERROR',
            BROWSER_CLOSED_ERROR: 'BROWSER_CLOSED_ERROR',
            CAPTCHA_MANUAL_TIMEOUT:'CAPTCHA_MANUAL_TIMEOUT'
        };
    }

    /**
     * 格式化错误对象
     * @param {Error} error - 原始错误对象
     * @param {string} crawlerType - 爬虫类型
     * @returns {Object} 格式化后的错误对象
     */
    format(error, crawlerType) {
        const errorCode = this._classifyError(error);

        const formattedError = {
            code: errorCode,
            message: this._getUserMessage(errorCode, error),
            detail: this._getErrorDetail(error),
            crawlerType,
            timestamp: new Date().toISOString(),
            screenshotPath: error.screenshotPath || null
        };

        return formattedError;
    }

    /**
     * 分类错误类型
     */
    _classifyError(error) {
        const message = (error.message || '').toLowerCase();
        const name = (error.name || '').toLowerCase();


        if (message.includes('has been closed') ||
            message.includes('target page') ||
            message.includes('context has been closed') ||
            message.includes('browser has been closed') ||
            message.includes('navigation failed because browser has disconnected')) {
            return this.errorCodes.BROWSER_CLOSED_ERROR;
        }
        // 网络错误
        if (message.includes('network') ||
            message.includes('socket') ||
            message.includes('connect') ||
            message.includes('dns')) {
            return this.errorCodes.NETWORK_ERROR;
        }
        if (message.includes('人机验证处理超时') ||
            message.includes('captcha manual timeout')) {
            return this.errorCodes.CAPTCHA_MANUAL_TIMEOUT;
        }
        // 超时错误
        if (message.includes('timeout') ||
            message.includes('timed out')) {
            return this.errorCodes.TIMEOUT_ERROR;
        }

        // 认证错误
        if (message.includes('auth') ||
            message.includes('login') ||
            message.includes('password') ||
            message.includes('credential')) {
            return this.errorCodes.AUTH_ERROR;
        }

        // 验证码错误
        if (message.includes('captcha') ||
            message.includes('verification')) {
            return this.errorCodes.CAPTCHA_ERROR;
        }

        // 浏览器错误
        if (message.includes('browser') ||
            message.includes('page closed') ||
            message.includes('target closed') ||
            name.includes('browser')) {
            return this.errorCodes.BROWSER_ERROR;
        }

        // 数据错误
        if (message.includes('parse') ||
            message.includes('extract') ||
            message.includes('data')) {
            return this.errorCodes.DATA_ERROR;
        }

        return this.errorCodes.UNKNOWN_ERROR;
    }

    /**
     * 获取用户友好的错误消息
     */
    _getUserMessage(errorCode, error) {
        const messages = {
            [this.errorCodes.NETWORK_ERROR]: '网络连接失败，请检查网络设置或稍后重试',
            [this.errorCodes.TIMEOUT_ERROR]: '操作超时，可能是网络较慢或服务器响应慢',
            [this.errorCodes.AUTH_ERROR]: '登录失败，请检查账号密码是否正确',
            [this.errorCodes.CAPTCHA_ERROR]: '验证码处理失败，请手动完成验证',
            [this.errorCodes.BROWSER_ERROR]: '浏览器异常，请重启应用后重试',
            [this.errorCodes.DATA_ERROR]: '数据解析失败，页面结构可能已变化',
            [this.errorCodes.BROWSER_CLOSED_ERROR]: '浏览器已关闭，任务已终止',
            [this.errorCodes.UNKNOWN_ERROR]: `未知错误: ${error.message}`
        };

        return messages[errorCode] || error.message;
    }

    /**
     * 获取详细错误信息（用于日志）
     */
    _getErrorDetail(error) {
        let detail = `错误类型: ${error.name || 'Error'}\n`;
        detail += `错误消息: ${error.message}\n`;

        if (error.stack) {
            detail += `\n堆栈跟踪:\n${error.stack}`;
        }

        if (error.screenshotPath) {
            detail += `\n截图路径: ${error.screenshotPath}`;
        }

        return detail;
    }

    /**
     * 创建带截图的错误
     * @param {Error} error - 原始错误
     * @param {string} screenshotPath - 截图路径
     * @returns {Error} 增强的错误对象
     */
    withScreenshot(error, screenshotPath) {
        error.screenshotPath = screenshotPath;
        return error;
    }

    /**
     * 判断是否为可重试错误
     */
    isRetryable(error) {
        const retryableCodes = [
            this.errorCodes.NETWORK_ERROR,
            this.errorCodes.TIMEOUT_ERROR
        ];

        const errorCode = this._classifyError(error);
        return retryableCodes.includes(errorCode);
    }

    /**
     * 获取错误代码映射
     */
    getErrorCodes() {
        return {...this.errorCodes};
    }

    /**
     * 判断是否为浏览器关闭错误
     */
    isBrowserClosedError(error) {
        const errorCode = this._classifyError(error);
        return errorCode === this.errorCodes.BROWSER_CLOSED_ERROR;

    }
    /**
     * 处理爬虫执行过程中的错误（包括通知前端）
     * @param {string} source - 爬虫来源标识
     * @param {Error} error - 错误对象
     */
    handleCrawlerError(source, error) {
        console.error(`${source}爬虫异常:`, error);

        const errorCode = this._classifyError(error);

        // 特殊处理人机验证超时
        if (errorCode === this.errorCodes.CAPTCHA_MANUAL_TIMEOUT) {
            console.warn(`${source}人机验证超时，任务标记为失败`);

            const io = getIo();
            if (io) {
                io.emit('task-failed', {
                    source,
                    reason: '人机验证处理超时',
                    errorCode,
                    timestamp: Date.now()
                });
            }
        }

        // 添加其他特殊错误类型的处理

    }
}
module.exports = ErrorHandler;
