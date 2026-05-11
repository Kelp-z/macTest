// src/infrastructure/config-manager.js
const fs = require('fs');
const path = require('path');

class ConfigManager {
    constructor() {
        this.config = null;
        this.configPath = path.join(process.cwd(), 'config.json');
        this._loadConfig();
    }

    /**
     * 加载配置文件
     */
    _loadConfig() {
        try {
            if (fs.existsSync(this.configPath)) {
                const raw = fs.readFileSync(this.configPath, 'utf8');
                this.config = JSON.parse(raw);
                console.log('✓ 已加载配置文件:', this.configPath);
            } else {
                console.warn('⚠ 配置文件不存在，使用默认配置');
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
     * 保存配置（谨慎使用）
     * @param {Object} newConfig - 新配置
     */
    save(newConfig) {
        try {
            fs.writeFileSync(this.configPath, JSON.stringify(newConfig, null, 2), 'utf8');
            this.config = newConfig;
            console.log('✓ 配置已保存');
        } catch (error) {
            console.error(`保存配置失败: ${error.message}`);
            throw error;
        }
    }
}

// 单例模式
const instance = new ConfigManager();
module.exports = instance;
