/**
 * 终端引擎级共享浏览器：始终只开一个 Chromium，按站点复用/新建标签页。
 * 关闭时机：仅 shutdown()（关引擎时）。
 *
 * 用户数据目录沿用原来的 google-scholar profile（Cookie/信任），
 * 降低连续谷歌学术任务触发人机验证的概率；WoS/Scopus 标签也挂在同一 profile 下。
 */
const path = require('path');
const fs = require('fs');
const BrowserManager = require('./browser-manager');

const DEFAULT_HOME = {
    scholar: 'https://scholar.google.com',
    wos: 'https://access.clarivate.com/login?app=wos',
    'wos-portal': 'https://www.2447.net/',
    scopus: 'https://www.scopus.com/',
    'scopus-portal': 'https://www.2447.net/'
};

/** crawlerType → 站点标签 key（同站复用；入口不同则拆标签） */
const SITE_KEY_BY_CRAWLER = {
    google: 'scholar',
    'google-author': 'scholar',
    wos: 'wos-portal',
    'wos-author': 'wos',
    scopus: 'scopus-portal',
    'scopus-author': 'scopus'
};

class SharedBrowserPool {
    constructor() {
        this._bm = new BrowserManager();
        this.browser = null;
        this.context = null;
        /** @type {Map<string, import('playwright').Page>} */
        this.tabs = new Map();
        this._blankPage = null;
        this._launching = null;
        this._closeHooked = false;
    }

    resolveSiteKey(crawlerType) {
        return SITE_KEY_BY_CRAWLER[crawlerType] || crawlerType || 'default';
    }

    isAlive() {
        try {
            if (!this.browser || !this.context) return false;
            if (typeof this.browser.isConnected === 'function' && !this.browser.isConnected()) {
                return false;
            }
            const pages = typeof this.context.pages === 'function' ? this.context.pages() : [];
            return pages.some((p) => p && !p.isClosed());
        } catch (e) {
            return false;
        }
    }

    _pruneTabs() {
        for (const [key, page] of this.tabs.entries()) {
            if (!page || page.isClosed()) {
                this.tabs.delete(key);
            }
        }
        if (this._blankPage && this._blankPage.isClosed()) {
            this._blankPage = null;
        }
    }

    /** 受保护的站点标签（切站时不要关） */
    getProtectedPages() {
        this._pruneTabs();
        return new Set([...this.tabs.values()].filter((p) => p && !p.isClosed()));
    }

    async ensureBrowser(browserOptions = {}) {
        if (this.isAlive()) {
            return { browser: this.browser, context: this.context };
        }
        if (this._launching) {
            return this._launching;
        }
        this._launching = this._doLaunch(browserOptions);
        try {
            return await this._launching;
        } finally {
            this._launching = null;
        }
    }

    async _doLaunch(browserOptions = {}) {
        this.tabs.clear();
        this._blankPage = null;
        this._closeHooked = false;

        // 与改共享池之前一致：复用 browser-profiles/google-scholar
        const profileDir = this._bm.getPersistentUserDataDir('google-scholar');
        const downloadsPath = path.join(profileDir, 'downloads');
        if (!fs.existsSync(downloadsPath)) {
            fs.mkdirSync(downloadsPath, { recursive: true });
        }

        const options = {
            ...browserOptions,
            keepAlive: true,
            downloadsPath
        };

        console.log('[SharedBrowserPool] 启动唯一常驻浏览器 (profile=google-scholar):', profileDir);
        const { browser, context, page } = await this._bm.launchPersistent(profileDir, options);
        this.browser = browser;
        this.context = context;
        this._blankPage = page;
        this._hookBrowserClose();

        await this._bm.applyInitialVisibility(page, browser).catch(() => {});
        return { browser, context };
    }

    _hookBrowserClose() {
        if (!this.browser || this._closeHooked) return;
        this._closeHooked = true;
        this._bm.removeBrowserCloseListener(this.browser);
        this._bm.setupBrowserCloseListener(this.browser, () => {
            console.warn('[SharedBrowserPool] 浏览器已断开，清空共享池状态');
            this.tabs.clear();
            this._blankPage = null;
            this.browser = null;
            this.context = null;
            this._closeHooked = false;
        });
    }

    _pageMatchesHome(page, homeUrl) {
        if (!homeUrl) return true;
        try {
            const cur = page.url() || '';
            if (!cur || cur === 'about:blank') return false;
            if (homeUrl.includes('scholar.google')) {
                return cur.includes('scholar.google');
            }
            const host = new URL(homeUrl).hostname.replace(/^www\./, '');
            return cur.includes(host);
        } catch (e) {
            return false;
        }
    }

    /**
     * 获取或创建站点标签（不存在则 newPage）
     * @param {string} siteKey
     * @param {string|null} homeUrl
     * @param {object} [browserOptions]
     */
    async getOrCreateTab(siteKey, homeUrl = null, browserOptions = {}) {
        await this.ensureBrowser(browserOptions);
        this._pruneTabs();

        const targetHome = homeUrl || DEFAULT_HOME[siteKey] || null;
        let page = this.tabs.get(siteKey);

        if (page && !page.isClosed()) {
            try {
                await page.bringToFront();
            } catch (e) { /* ignore */ }
            // 复用标签时若已离开该站域名，再导航回首页（不新建标签）
            if (targetHome && !this._pageMatchesHome(page, targetHome)) {
                await page.goto(targetHome, {
                    timeout: 30000,
                    waitUntil: 'domcontentloaded'
                }).catch((e) => {
                    console.warn(`[SharedBrowserPool] 复用标签导航失败 (${siteKey}): ${e.message}`);
                });
            }
            console.log(`[SharedBrowserPool] 复用标签: ${siteKey}`);
            return {
                browser: this.browser,
                context: this.context,
                page,
                reused: true
            };
        }

        if (this._blankPage && !this._blankPage.isClosed()) {
            page = this._blankPage;
            this._blankPage = null;
            console.log(`[SharedBrowserPool] 使用初始空白页作为标签: ${siteKey}`);
        } else {
            page = await this.context.newPage();
            console.log(`[SharedBrowserPool] 新建标签: ${siteKey}`);
        }

        if (targetHome && !this._pageMatchesHome(page, targetHome)) {
            await page.goto(targetHome, {
                timeout: 30000,
                waitUntil: 'domcontentloaded'
            }).catch((e) => {
                console.warn(`[SharedBrowserPool] 打开 ${siteKey} 首页失败: ${e.message}`);
            });
        }

        this.tabs.set(siteKey, page);
        return {
            browser: this.browser,
            context: this.context,
            page,
            reused: false
        };
    }

    /** 关闭某一站点标签（浏览器进程保留；其它站点标签保留） */
    async releaseTab(siteKey) {
        this._pruneTabs();
        const page = this.tabs.get(siteKey);
        if (page && !page.isClosed()) {
            await page.close().catch(() => {});
        }
        this.tabs.delete(siteKey);
        console.log(`[SharedBrowserPool] 已释放标签: ${siteKey}`);
    }

    async hide() {
        this._pruneTabs();
        let page = null;
        for (const p of this.tabs.values()) {
            if (p && !p.isClosed()) {
                page = p;
                break;
            }
        }
        if (!page && this._blankPage && !this._blankPage.isClosed()) {
            page = this._blankPage;
        }
        if (!page && this.context) {
            const pages = this.context.pages();
            page = pages.find((p) => p && !p.isClosed()) || null;
        }
        if (page && this.browser) {
            await this._bm.hideWindow(page, this.browser).catch(() => {});
        }
    }

    /** 引擎退出时真正关闭浏览器 */
    async shutdown() {
        console.log('[SharedBrowserPool] 关闭常驻浏览器（引擎退出）');
        const browser = this.browser;
        this.tabs.clear();
        this._blankPage = null;
        this.context = null;
        this.browser = null;
        this._closeHooked = false;
        if (!browser) return;
        try {
            this._bm.removeBrowserCloseListener(browser);
        } catch (e) { /* ignore */ }
        try {
            await this._bm.close(browser);
        } catch (e) {
            console.warn(`[SharedBrowserPool] 关闭失败: ${e.message}`);
        }
    }
}

let _pool = null;

function getSharedBrowserPool() {
    if (!_pool) {
        _pool = new SharedBrowserPool();
    }
    return _pool;
}

module.exports = {
    getSharedBrowserPool,
    SharedBrowserPool,
    SITE_KEY_BY_CRAWLER,
    DEFAULT_HOME
};
