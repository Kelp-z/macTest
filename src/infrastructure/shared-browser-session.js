/**
 * 全进程共享一个 Chromium：不同任务类型复用不同标签页。
 * 切换任务时默认保持最小化，仅人机验证/登录干预时再拉窗。
 */
const path = require('path');
const BrowserManager = require('./browser-manager');
const ConfigManager = require('./config-manager');

class SharedBrowserSession {
    constructor() {
        this.browserManager = new BrowserManager();
        this.browser = null;
        this.context = null;
        this.pages = new Map(); // source -> page
        this.activeSource = null;
        this._bootstrapPage = null;
        this._bootstrapAssigned = false;
        this._launchPromise = null;
        this._closeListeners = new Set();
    }

    isEnabled() {
        try {
            const opts = ConfigManager.getBrowserOptions();
            // shared 默认开启；显式 false 时回退到各爬虫独立浏览器
            return opts.shared !== false;
        } catch (e) {
            return true;
        }
    }

    _isBrowserAlive() {
        try {
            if (!this.browser || !this.context) return false;
            if (typeof this.browser.isConnected === 'function' && !this.browser.isConnected()) {
                return false;
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    _polyfillPage(page) {
        if (!page) return page;
        if (typeof page.waitForTimeout !== 'function') {
            page.waitForTimeout = (ms) =>
                new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));
        }
        return page;
    }

    _profileDir() {
        const opts = ConfigManager.getBrowserOptions();
        if (opts.userDataDir) {
            return opts.userDataDir;
        }
        return this.browserManager.getPersistentUserDataDir('shared');
    }

    async _ensureLaunched() {
        if (this._isBrowserAlive()) {
            return;
        }
        if (this._launchPromise) {
            await this._launchPromise;
            return;
        }

        this._launchPromise = (async () => {
            const browserOptions = ConfigManager.getBrowserOptions();
            const profileDir = this._profileDir();
            const stickyDownloadDir = path.join(profileDir, 'downloads');

            console.log(`[SharedBrowser] 启动唯一 Chromium（profile: ${profileDir}）`);

            const { browser, context, page } = await this.browserManager.launchPersistent(profileDir, {
                ...browserOptions,
                downloadsPath: stickyDownloadDir
            });

            this.browser = browser;
            this.context = context;
            this.pages.clear();
            this._bootstrapPage = page || null;
            this._bootstrapAssigned = false;
            this.activeSource = null;

            // 首次启动即最小化，避免闪窗
            if (this._bootstrapPage) {
                this._polyfillPage(this._bootstrapPage);
                await this.browserManager.applyInitialVisibility(this._bootstrapPage, this.browser);
            }

            this.browserManager.setupBrowserCloseListener(this.browser, (closeInfo) => {
                console.warn(`[SharedBrowser] 浏览器异常关闭: ${closeInfo.message}`);
                this._resetState();
                for (const cb of this._closeListeners) {
                    try {
                        cb(closeInfo);
                    } catch (e) {
                        // ignore
                    }
                }
            });
        })();

        try {
            await this._launchPromise;
        } finally {
            this._launchPromise = null;
        }
    }

    _resetState() {
        this.browser = null;
        this.context = null;
        this.pages.clear();
        this._bootstrapPage = null;
        this._bootstrapAssigned = false;
        this.activeSource = null;
    }

    /**
     * 领取某任务类型的长期标签页（始终保持窗口在后台）
     * @param {string} source - google / wos / scopus / ...
     */
    async acquire(source) {
        const key = String(source || 'default');
        await this._ensureLaunched();

        let page = this.pages.get(key);
        if (page && typeof page.isClosed === 'function' && page.isClosed()) {
            this.pages.delete(key);
            page = null;
        }

        if (!page) {
            if (this._bootstrapPage && !this._bootstrapAssigned && !this._bootstrapPage.isClosed()) {
                page = this._bootstrapPage;
                this._bootstrapAssigned = true;
            } else {
                page = await this.context.newPage();
            }
            this._polyfillPage(page);
            this.pages.set(key, page);
            console.log(`[SharedBrowser] 为「${key}」创建标签页（当前共 ${this.pages.size} 个）`);
        } else {
            this._polyfillPage(page);
            console.log(`[SharedBrowser] 复用「${key}」标签页`);
        }

        this.activeSource = key;

        // 切换任务类型：强制保持最小化，不弹窗
        try {
            await this.browserManager.hideWindow(page, this.browser);
        } catch (e) {
            // ignore
        }

        return {
            browser: this.browser,
            context: this.context,
            page
        };
    }

    /**
     * 任务结束：默认只缩回后台；force 时关闭该 source 的标签页
     */
    async release(source, options = {}) {
        const force = options.force === true;
        const closeBrowser = options.closeBrowser === true;
        const key = String(source || 'default');
        const page = this.pages.get(key);

        if (page) {
            try {
                if (!page.isClosed()) {
                    await this.browserManager.hideWindow(page, this.browser);
                }
            } catch (e) {
                // ignore
            }

            if (force) {
                try {
                    if (!page.isClosed()) {
                        await page.close();
                    }
                } catch (e) {
                    // ignore
                }
                this.pages.delete(key);
                if (page === this._bootstrapPage) {
                    this._bootstrapPage = null;
                    this._bootstrapAssigned = false;
                }
                console.log(`[SharedBrowser] 已关闭「${key}」标签页`);
            }
        }

        if (closeBrowser || (force && this.pages.size === 0 && options.closeWhenEmpty !== false)) {
            // force 且无剩余标签时，默认不关整个浏览器（便于下一任务秒开）
            // 仅 closeBrowser=true 时强制退出 Chromium
            if (closeBrowser) {
                await this.closeAll();
            }
        }
    }

    /**
     * 重建某 source 的标签（如 WoS 作者换终端防串号），并尽量清掉 Clarivate Cookie
     */
    async recreatePage(source, options = {}) {
        const key = String(source || 'default');
        await this.release(key, { force: true, closeWhenEmpty: false });

        if (options.clearClarivateCookies !== false && this.context) {
            try {
                const cookies = await this.context.cookies();
                const keep = cookies.filter(
                    (c) => !/clarivate|webofknowledge|webofscience|isiknowledge/i.test(String(c.domain || ''))
                );
                await this.context.clearCookies();
                if (keep.length > 0) {
                    await this.context.addCookies(keep);
                }
                console.log(`[SharedBrowser] 已清理 Clarivate 相关 Cookie（保留 ${keep.length} 条其它站点 Cookie）`);
            } catch (e) {
                console.warn(`[SharedBrowser] 清理 Clarivate Cookie 失败: ${e.message}`);
            }
        }

        return this.acquire(key);
    }

    async forceShow() {
        await this._ensureLaunched().catch(() => {});
        const page =
            (this.activeSource && this.pages.get(this.activeSource)) ||
            [...this.pages.values()].find((p) => p && !p.isClosed()) ||
            this._bootstrapPage;

        if (page && !page.isClosed()) {
            await this.browserManager.showWindow(page, this.browser);
            return;
        }
        await this.browserManager.forceShowChromiumWindows();
    }

    async hide() {
        const page =
            (this.activeSource && this.pages.get(this.activeSource)) ||
            [...this.pages.values()].find((p) => p && !p.isClosed()) ||
            this._bootstrapPage;
        if (page && !page.isClosed() && this.browser) {
            await this.browserManager.hideWindow(page, this.browser);
        }
    }

    onBrowserClosed(callback) {
        if (typeof callback === 'function') {
            this._closeListeners.add(callback);
        }
        return () => this._closeListeners.delete(callback);
    }

    async closeAll() {
        console.log('[SharedBrowser] 关闭共享 Chromium');
        const browser = this.browser;
        this._resetState();
        if (!browser) return;
        try {
            this.browserManager.removeBrowserCloseListener(browser);
        } catch (e) {
            // ignore
        }
        try {
            await this.browserManager.close(browser);
        } catch (e) {
            console.warn(`[SharedBrowser] 关闭失败: ${e.message}`);
        }
    }
}

module.exports = new SharedBrowserSession();
