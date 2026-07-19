// src/infrastructure/config-manager.js
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class ConfigManager {
    constructor() {
        this.config = null;
        this.configPath = this._getConfigPath();
        this._loadConfig();
    }
    /**
     * 获取配置文件路径（区分开发/生产环境）
     * @returns {string}
     */
    _getConfigPath() {
        const isPackaged = app.isPackaged;
        if (isPackaged) {
            // 生产环境：config.json 放在 exe 同级目录（由 extraFiles 释放）
            const exeDir = path.dirname(app.getPath('exe'));
            return path.join(exeDir, 'config.json');
        } else {
            // 开发环境：保持原逻辑，从项目根目录读取
            return path.join(process.cwd(), 'config.json');
        }
    }
    /**
     * 加载配置文件
     */
    _loadConfig() {
        try {
            if (fs.existsSync(this.configPath)) {
                const raw = fs.readFileSync(this.configPath, 'utf8');
                this.config = JSON.parse(raw);
                console.log('已加载配置文件:', this.configPath);
            } else {
                console.warn('配置文件不存在，使用默认配置');
                this.config = {};
            }
        } catch (error) {
            console.error(`读取配置文件失败: ${error.message}`);
            this.config = {};
        }
    }

    /**
     * 获取完整配置
     * @returns {Object} 配置对象
     */
    getConfig() {
        return {...this.config};
    }
    /**
     * 获取更新配置
     * @returns {Object} 更新配置
     */
    getUpdateConfig() {
        return this.config.update || {
            UPDATE_URL: 'http://124.70.184.0:8100/',
            AUTO_CHECK: true,
            CHECK_INTERVAL: 3600000
        };
    }
    /**
     * 获取特定爬虫的配置
     * @param {string} crawlerType - 爬虫类型 ('google', 'scopus', 'wos', etc.)
     * @returns {Object} 爬虫配置
     */
    getCrawlerConfig(crawlerType) {
        // 映射爬虫类型到配置键名
        const configKeyMap = {
            'google': 'googleScholar',
            'google-author': 'googleScholarAuthor',
            'scopus': 'scopus',
            'scopus-author': 'scopusAuthor',
            'wos': 'wos',
            'wos-author': 'wosAuthor'
        };

        const key = configKeyMap[crawlerType] || crawlerType;
        return this.config[key] || {};
    }

    /**
     * 获取后端服务配置
     * @returns {Object} 后端服务配置，包含端口和URL等信息
     */
    getBackendConfig() {
        return this.config.backend || {
            LOCAL_PORT: 3000,
            SPRING_PORT: 8080,
            LOCAL_HOST: 'localhost',
            LOCAL_BASE_URL: 'http://localhost:3000',
            SPRING_BASE_URL: 'http://localhost:8080'
        };
    }

    /**
     * 获取本地服务端口
     * @returns {number} 本地服务端口号
     */
    getLocalPort() {
        return this.getBackendConfig().LOCAL_PORT;
    }

    /**
     * 获取Spring后端端口
     * @returns {number} Spring后端端口号
     */
    getSpringPort() {
        return this.getBackendConfig().SPRING_PORT;
    }

    /**
     * 获取本地服务基础URL
     * @returns {string} 本地服务基础URL
     */
    getLocalBaseUrl() {
        return this.getBackendConfig().LOCAL_BASE_URL;
    }

    /**
     * 获取Spring后端基础URL
     * @returns {string} Spring后端基础URL
     */
    getSpringBaseUrl() {
        return this.getBackendConfig().SPRING_BASE_URL;
    }

    /**
     * 获取浏览器启动选项
     * 默认：有头但最小化后台运行，仅在人机验证/登录干预时恢复窗口
     * @returns {Object}
     */
    getBrowserOptions() {
        const browser = this.config.browser || {};
        return {
            headless: browser.headless === true,
            // 默认后台最小化，避免检索时弹出窗口打断用户
            startMinimized: browser.startMinimized !== false,
            // minimized: 任务栏最小化（默认）；offscreen: 屏外窗口
            hideMode: browser.hideMode === 'offscreen' ? 'offscreen' : 'minimized',
            // 仅在人机验证 / 登录 / 注册时再弹出浏览器
            showOnIntervention: browser.showOnIntervention !== false,
            // 任务结束后保持浏览器最小化不关闭，下一任务直接复用（避免反复开关闪烁）
            keepAlive: browser.keepAlive !== false,
            // 全进程共用一个 Chromium，按任务类型分标签（切换任务不弹窗）
            shared: browser.shared !== false,
            // 以下两项会显著增加 Google 风控，默认关闭
            disableSecurityArgs: browser.disableSecurityArgs === true,
            deterministicRendering: browser.deterministicRendering === true,
            ...(Array.isArray(browser.args) ? { args: browser.args } : {}),
            ...(browser.executablePath ? { executablePath: browser.executablePath } : {}),
            ...(browser.userDataDir ? { userDataDir: browser.userDataDir } : {}),
            ...(typeof browser.remoteDebuggingPort === 'number'
                ? { remoteDebuggingPort: browser.remoteDebuggingPort }
                : {})
        };
    }

    /**
     * @deprecated 请使用 getBrowserOptions()
     */
    get browserOptions() {
        return this.getBrowserOptions();
    }

    /**
     * 获取配置值（支持点号路径）
     * @param {string} path - 配置路径，如 'googleScholar.PRECISE_SEARCH_ENABLED'
     * @param {*} defaultValue - 默认值
     * @returns {*} 配置值
     */
    get(path, defaultValue = undefined) {
        const keys = path.split('.');
        let value = this.config;

        for (const key of keys) {
            if (value === null || value === undefined || typeof value !== 'object') {
                return defaultValue;
            }
            value = value[key];
        }

        return value !== undefined ? value : defaultValue;
    }

    /**
     * 重新加载配置
     */
    reload() {
        this._loadConfig();
    }

    /**
     * 深度合并并写回某个爬虫的配置片段（如保存 WoS 作者账密）
     * @param {string} crawlerType
     * @param {Object} partial
     */
    updateCrawlerConfig(crawlerType, partial = {}) {
        const configKeyMap = {
            'google': 'googleScholar',
            'google-author': 'googleScholarAuthor',
            'scopus': 'scopus',
            'scopus-author': 'scopusAuthor',
            'wos': 'wos',
            'wos-author': 'wosAuthor'
        };
        const key = configKeyMap[crawlerType] || crawlerType;
        if (!this.config || typeof this.config !== 'object') {
            this.config = {};
        }
        const prev = this.config[key] && typeof this.config[key] === 'object' ? this.config[key] : {};
        const next = { ...prev, ...partial };
        // credentials 做浅合并，避免整段被空对象覆盖丢字段
        if (partial.credentials && typeof partial.credentials === 'object') {
            next.credentials = {
                ...(prev.credentials || {}),
                ...partial.credentials
            };
        }
        this.config[key] = next;
        this.save(this.config);
        return next;
    }

    /**
     * 保存配置
     * @param {Object} newConfig - 新配置
     */
    save(newConfig) {
        try {
            fs.writeFileSync(this.configPath, JSON.stringify(newConfig, null, 2), 'utf8');
            this.config = newConfig;
            console.log('配置已保存:', this.configPath);
        } catch (error) {
            console.error(`保存配置失败: ${error.message}`);
            throw error;
        }
    }
}

// 单例模式
const instance = new ConfigManager();
module.exports = instance;
