// src/infrastructure/logger.js
const fs = require('fs');
const path = require('path');

const log = require('electron-log');

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



        // 配置统一文件路径（所有 Logger 实例 + console 都写这里）
        let logBaseDir = options.logBaseDir ||
            (global.globalConfig && global.globalConfig.LOG_BASE_DIR);

        if (!logBaseDir) {
            console.warn(`[Logger] global.globalConfig.LOG_BASE_DIR 未设置，使用临时目录兜底`);
            logBaseDir = path.join(os.tmpdir(), 'spmcrawler-logs');
        }
        try {
            if (!fs.existsSync(logBaseDir)) {
                fs.mkdirSync(logBaseDir, { recursive: true });
            }
            // 测试是否真的可写
            const testFile = path.join(logBaseDir, '.write-test');
            fs.writeFileSync(testFile, 'test');
            fs.unlinkSync(testFile);
        } catch (err) {
            console.error(`[Logger] 目录无写入权限 ${logBaseDir}，回退到临时目录: ${err.message}`);
            logBaseDir = path.join(os.tmpdir(), 'spmcrawler-logs');
            fs.mkdirSync(logBaseDir, { recursive: true });
        }
        // 统一文件名：app_日期.log
        const date = new Date().toISOString().slice(0, 10);
        const logFile = path.join(logBaseDir, `app_${date}.log`);
        this.logFilePath = logFile;


        // 可选：禁用 console 输出（避免重复）
        // this.logger.transports.console.level = false;
        this.logFilePath = logFile;
        // 创建独立的 electron-log 实例，但共享文件
        this.logger = log.create({ logId: crawlerType });
        // electron-log v5 用 resolvePathFn，v4 用 resolvePath，兼容处理
        if (typeof this.logger.transports.file.resolvePathFn === 'function') {
            this.logger.transports.file.resolvePathFn = () => logFile;
        } else if (typeof this.logger.transports.file.resolvePath === 'function') {
            this.logger.transports.file.resolvePath = () => logFile;
        }

        // 验证写入
        this.logger.info(`[${crawlerType}] 日志初始化，文件: ${logFile}`);
        console.log(`[Logger] 日志目录确保存在: ${logBaseDir}`);
        console.log(`[Logger] 日志目标文件: ${this.logFilePath}`);
        // // 创建日志文件
        // const timestamp = new Date().toISOString().replace(/[-:\.T]/g, '').slice(0, 15);
        // const logFilename = `${timestamp}_${crawlerType.replace(/-/g, '_')}_crawler.log`;
        // const logFilePath = path.join(logBaseDir, logFilename);
        // this.logger.transports.file.resolvePath = () => logFilePath;
        // this.logFilePath = logFilePath;
        // this.logStream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });

        // console.log(`日志文件已创建: ${this.logFilePath}`);
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
        // const formatted = this._formatLog(level, message);
        // if (level === 'error') {
        //     console.error(formatted);
        // } else if (level === 'warn') {
        //     console.warn(formatted);
        // } else {
        //     console.log(formatted);
        // }

        // 统一用 electron-log，带爬虫类型前缀
        const prefix = `[${this.crawlerType}]`;
        const fullMessage = `${prefix} ${message}`;

        switch (level) {
            case 'error': this.logger.error(fullMessage); break;
            case 'warn': this.logger.warn(fullMessage); break;
            case 'success': this.logger.info(fullMessage); break;
            default: this.logger.info(fullMessage);
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
        this.logs = [];
    }

    /**
     * 获取日志文件路径
     */
    getLogFilePath() {
        return this.logFilePath;
    }
}

module.exports = Logger;
