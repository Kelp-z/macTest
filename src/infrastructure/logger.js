// src/infrastructure/logger.js
const fs = require('fs');
const path = require('path');

class Logger {
    /**
     * @param {string} crawlerType - 爬虫类型标识
     * @param {Object} options - 日志选项
     */
    constructor(crawlerType, options = {}) {
        this.crawlerType = crawlerType;
        this.logs = [];
        this.maxLogs = options.maxLogs || 1000; // 内存中保留的最大日志数
        this.logStream = null;
        
        // 日志目录配置
        const logBaseDir = options.logBaseDir || 
            (global.globalConfig && global.globalConfig.LOG_BASE_DIR) || 
            path.join(process.cwd(), 'output', 'log');
        
        if (!fs.existsSync(logBaseDir)) {
            fs.mkdirSync(logBaseDir, { recursive: true });
        }

        // 创建日志文件
        const timestamp = new Date().toISOString().replace(/[-:\.T]/g, '').slice(0, 15);
        const logFilename = `${timestamp}_${crawlerType.replace(/-/g, '_')}_crawler.log`;
        const logFilePath = path.join(logBaseDir, logFilename);
        
        this.logFilePath = logFilePath;
        this.logStream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });
        
        console.log(`日志文件已创建: ${logFilePath}`);
    }

    /**
     * 格式化日志条目
     */
    _formatLog(level, message) {
        const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    }

    /**
     * 添加日志
     */
    _addLog(level, message) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            level,
            message
        };

        this.logs.push(logEntry);
        
        // 限制内存中的日志数量
        if (this.logs.length > this.maxLogs) {
            this.logs = this.logs.slice(-this.maxLogs / 2);
        }

        // 输出到控制台
        const formatted = this._formatLog(level, message);
        if (level === 'error') {
            console.error(formatted);
        } else if (level === 'warn') {
            console.warn(formatted);
        } else {
            console.log(formatted);
        }

        // 写入文件
        if (this.logStream && this.logStream.writable) {
            this.logStream.write(formatted + '\n');
        }
    }

    /**
     * 信息日志
     */
    info(message) {
        this._addLog('info', message);
    }

    /**
     * 警告日志
     */
    warn(message) {
        this._addLog('warn', message);
    }

    /**
     * 错误日志
     */
    error(message) {
        this._addLog('error', message);
    }

    /**
     * 成功日志
     */
    success(message) {
        this._addLog('success', message);
    }

    /**
     * 调试日志
     */
    debug(message) {
        if (process.env.DEBUG) {
            this._addLog('debug', message);
        }
    }

    /**
     * 获取所有日志
     */
    getLogs() {
        return [...this.logs];
    }

    /**
     * 获取最近的 N 条日志
     */
    getRecentLogs(count = 100) {
        return this.logs.slice(-count);
    }

    /**
     * 关闭日志流
     */
    close() {
        if (this.logStream) {
            try {
                this.logStream.end();
                this.logStream = null;
            } catch (error) {
                console.error(`关闭日志流失败: ${error.message}`);
            }
        }
    }

    /**
     * 获取日志文件路径
     */
    getLogFilePath() {
        return this.logFilePath;
    }
}

module.exports = Logger;
