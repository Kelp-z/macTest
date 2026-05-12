// src/infrastructure/browser-manager.js
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const os = require('os');

chromium.use(StealthPlugin());

class BrowserManager {
    constructor() {
        this.browsersPath = this._findBrowsersPath();
    }

    /**
     * 查找浏览器路径
     */
    _findBrowsersPath() {
        const isPkg = !!process.pkg;
        const isElectron = !!process.versions.electron;


        if (isElectron) {
            const { app } = require('electron');
            // Electron 打包后，browsers 目录通常在资源目录或 userData 目录
            return path.join(app.getAppPath(), '..', 'browsers');
        } else if (isPkg) {
            // pkg 打包后的可执行文件目录
            return path.join(path.dirname(process.execPath), 'browsers');
        } else {
            // 开发环境
            return path.join(process.cwd(), 'browsers');
        }
    }

    /**
     * 递归查找本地浏览器可执行文件
     */
    findLocalBrowser(startDir) {
        console.log('\n=== 开始查找本地浏览器 ===');

        //构建搜索目录列表
        const keyDirs = [];

        // 优先使用传入的起始目录或默认路径
        if (startDir) {
            keyDirs.push(startDir);
        } else {
            keyDirs.push(this.browsersPath);
        }

        // Electron 环境的额外路径
        if (process.versions.electron) {
            try {
                const { app } = require('electron');
                const appRootPath = path.dirname(app.getAppPath());
                keyDirs.unshift(path.join(appRootPath, 'browsers'));
                keyDirs.unshift(path.join(app.getPath('userData'), 'browsers'));
                console.log(`Electron 环境，添加搜索路径:`);
                console.log(`  - ${path.join(appRootPath, 'browsers')}`);
                console.log(`  - ${path.join(app.getPath('userData'), 'browsers')}`);
            } catch (e) {
                console.warn(`获取 Electron 路径失败: ${e.message}`);
            }
        }

        // pkg 打包环境的额外路径
        if (process.pkg) {
            const pkgBrowsersPath = path.join(path.dirname(process.execPath), 'browsers');
            if (!keyDirs.includes(pkgBrowsersPath)) {
                keyDirs.push(pkgBrowsersPath);
                console.log(`pkg 打包环境，添加搜索路径: ${pkgBrowsersPath}`);
            }
        }

        // 通用备选路径
        const fallbackDirs = [
            path.join(process.cwd(), 'browsers'),
            process.cwd(),
            path.dirname(process.execPath)
        ];

        for (const dir of fallbackDirs) {
            if (!keyDirs.includes(dir)) {
                keyDirs.push(dir);
            }
        }

        console.log(`搜索目录列表 (${keyDirs.length} 个):`);
        keyDirs.forEach((dir, index) => {
            console.log(`  ${index + 1}. ${dir} ${fs.existsSync(dir) ? '✓' : '✗'}`);
        });

        // 依次搜索每个目录
        for (const keyDir of keyDirs) {
            if (fs.existsSync(keyDir)) {
                console.log(`\n正在搜索: ${keyDir}`);
                const found = this._searchRecursive(keyDir, 0);
                if (found) {
                    console.log(`✓ 找到浏览器: ${found}`);
                    return found;
                }
            }
        }

        console.log('\n✗ 未找到本地浏览器文件');
        return null;
    }

    _searchRecursive(dir, depth) {
        if (depth > 10) return null;

        try {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(dir, item.name);

                //macOS .app 包
                if (item.isDirectory() && item.name.toLowerCase().endsWith('.app')) {
                    console.log(`  检测到 .app 包: ${fullPath}`);
                    const executable = this._getMacOSAppExecutable(fullPath);
                    if (executable) {
                        console.log(`  ✓ 从 .app 包提取到可执行文件: ${executable}`);
                        return executable;
                    } else {
                        console.log(`  ✗ .app 包无效，跳过`);
                    }
                    continue; // 不递归进入 .app 内部
                }

                //Windows chrome.exe
                if (item.isFile() && item.name.toLowerCase() === 'chrome.exe') {
                    console.log(`  ✓ 找到 Windows Chrome: ${fullPath}`);
                    return fullPath;
                }

                // 其他浏览器名称
                if (item.isFile() &&
                    (item.name.toLowerCase() === 'chromium' ||
                        item.name.toLowerCase() === 'google-chrome' ||
                        item.name.toLowerCase() === 'chrome')) {
                    // 检查是否是可执行文件
                    try {
                        const stats = fs.statSync(fullPath);
                        if (stats.isFile() && (stats.mode & fs.constants.S_IXUSR)) {
                            console.log(`  ✓ 找到 Linux/Mac 浏览器: ${fullPath}`);
                            return fullPath;
                        }
                    } catch (e) {
                        // 忽略
                    }
                }

                // 递归子目录
                if (item.isDirectory()) {
                    const found = this._searchRecursive(fullPath, depth + 1);
                    if (found) return found;
                }
            }
        } catch (error) {
            console.error(`查找浏览器时出错: ${error.message}`);
        }
        return null;
    }

    // _getMacOSAppExecutable(appPath) {
    //     const possiblePaths = [
    //         path.join(appPath, 'Contents', 'MacOS', 'Chromium'),
    //         path.join(appPath, 'Contents', 'MacOS', 'Google Chrome'),
    //         path.join(appPath, 'Contents', 'MacOS', 'Chrome')
    //     ];
    //
    //     for (const exePath of possiblePaths) {
    //         if (fs.existsSync(exePath)) return exePath;
    //     }
    //     return null;
    // }

    /**
     * 确保浏览器可用（查找或下载）
     */
    async ensureBrowser() {
        const localBrowser = this.findLocalBrowser();
        if (localBrowser) {
            console.log('✓ 找到本地浏览器:', localBrowser);
            return localBrowser;
        }

        console.log('未找到本地浏览器，尝试自动下载...');
        return await this._downloadBrowser();
    }
    /**
     * 判断一个路径是否是 macOS 的 .app 应用包
     */
    _isMacOSApp(filePath) {
        try {
            if (!filePath.toLowerCase().endsWith('.app')) {
                return false;
            }
            const stats = fs.statSync(filePath);
            if (!stats.isDirectory()) {
                return false;
            }
            const contentsPath = path.join(filePath, 'Contents');
            return fs.existsSync(contentsPath);
        } catch (error) {
            console.error(`检查 .app 文件失败: ${error.message}`);
            return false;
        }
    }

    /**
     * 获取 .app 包中的可执行文件路径
     */
    _getMacOSAppExecutable(appPath) {
        if (!this._isMacOSApp(appPath)) {
            return null;
        }

        try {
            const macosDir = path.join(appPath, 'Contents', 'MacOS');
            if (!fs.existsSync(macosDir)) {
                return null;
            }

            const files = fs.readdirSync(macosDir);
            const appName = path.basename(appPath, '.app');

            // 优先查找与 .app 包名匹配的可执行文件
            for (const file of files) {
                const fullPath = path.join(macosDir, file);
                const stats = fs.statSync(fullPath);
                if (stats.isFile() && file === appName) {
                    return fullPath;
                }
            }

            // 如果没有找到完全匹配的，返回第一个可执行文件
            for (const file of files) {
                const fullPath = path.join(macosDir, file);
                const stats = fs.statSync(fullPath);
                if (stats.isFile()) {
                    return fullPath;
                }
            }

            return null;
        } catch (error) {
            console.error(`获取 .app 可执行文件失败: ${error.message}`);
            return null;
        }
    }
    /**
     * 下载浏览器
     */
    async _downloadBrowser() {
        try {
            const downloadDir = this.browsersPath;
            if (!fs.existsSync(downloadDir)) {
                fs.mkdirSync(downloadDir, { recursive: true });
            }

            process.env.PLAYWRIGHT_BROWSERS_PATH = downloadDir;

            const { execSync } = require('child_process');
            console.log('正在下载 Chromium 浏览器，请稍候...');

            execSync('npx playwright install chromium', {
                stdio: 'inherit',
                cwd: process.cwd(),
                env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: downloadDir }
            });

            console.log('✓ 浏览器下载完成！');
            return this.findLocalBrowser();
        } catch (error) {
            console.error(`浏览器下载失败: ${error.message}`);
            throw new Error(`无法获取浏览器: ${error.message}`);
        }
    }

    /**
     * 启动浏览器
     * @param {Object} options - 浏览器启动选项
     * @returns {Promise<Object>} browser 实例
     */
    async launch(options = {}) {
        const {
            headless = false,
            executablePath = null,
            args = [],
            userDataDir = null
        } = options;

        let browserPath = executablePath;
        if (!browserPath) {
            browserPath = await this.ensureBrowser();
        }

        const launchArgs = [
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            ...args
        ];

        const launchOptions = {
            executablePath: browserPath,
            headless,
            args: launchArgs
        };

        if (userDataDir) {
            launchOptions.userDataDir = userDataDir;
        }

        const browser = await chromium.launch(launchOptions);

        // 设置浏览器关闭标记
        browser._isClosedByUser = false;

        return browser;
    }

    /**
     * 创建新页面
     * @param {Object} browser - browser 实例
     * @param {Object} contextOptions - 上下文选项
     * @returns {Promise<Object>} page 实例
     */
    async createPage(browser, contextOptions = {}) {
        const {
            userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            acceptDownloads = true,
            downloadsPath = null,
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
            viewport = { width: 1280, height: 800 }
        } = contextOptions;

        const context = await browser.newContext({
            userAgent,
            acceptDownloads,
            viewport,
            ...(downloadsPath && { downloadsPath })
        });

        const page = await context.newPage();
        return { page, context };
    }
    /**
     * 设置浏览器关闭监听器
     * @param {Object} browser - browser 实例
     * @param {Function} onCloseCallback - 关闭时的回调函数
     */
    setupBrowserCloseListener(browser, onCloseCallback) {
        if (!browser) {
            console.warn('浏览器实例为空，无法设置监听器');
            return;
        }

        // 移除旧的监听器（防止重复绑定）
        this.removeBrowserCloseListener(browser);

        // 监听断开连接事件
        const disconnectedHandler = () => {
            console.log('[BrowserManager] 检测到浏览器断开连接');

            // 检查是否是用户手动关闭
            if (!browser._isClosedByUser) {
                console.warn('[BrowserManager] 浏览器被意外关闭（用户手动关闭或崩溃）');

                // 调用回调通知上层
                if (typeof onCloseCallback === 'function') {
                    onCloseCallback({
                        type: 'unexpected_close',
                        message: '浏览器已意外关闭',
                        timestamp: new Date().toISOString()
                    });
                }
            } else {
                console.log('[BrowserManager] 浏览器正常关闭');
            }
        };

        browser.on('disconnected', disconnectedHandler);

        // 保存监听器引用，方便后续移除
        browser._disconnectedHandler = disconnectedHandler;
    }

    /**
     * 移除浏览器关闭监听器
     * @param {Object} browser - browser 实例
     */
    removeBrowserCloseListener(browser) {
        if (!browser) return;

        if (browser._disconnectedHandler) {
            browser.removeListener('disconnected', browser._disconnectedHandler);
            browser._disconnectedHandler = null;
        }
    }

    /**
     * 关闭浏览器
     * @param {Object} browser - browser 实例
     */
    async close(browser) {
        if (browser) {
            try {
                // 标记为正常关闭
                browser._isClosedByUser = true;

                // 先移除监听器，避免触发意外关闭回调
                this.removeBrowserCloseListener(browser);
                await browser.close();
            } catch (error) {
                console.error(`关闭浏览器失败: ${error.message}`);

                // 强制终止进程（Windows）
                if (process.platform === 'win32') {
                    try {
                        require('child_process').execSync('taskkill /F /IM chrome.exe /T 2>nul');
                        require('child_process').execSync('taskkill /F /IM chromium.exe /T 2>nul');
                    } catch (e) {
                        // 忽略错误
                    }
                }
            }
        }
    }

    /**
     * 截图
     * @param {Object} page - page 实例
     * @param {string} type - 截图类型 ('error', 'captcha', etc.)
     * @param {string} outputDir - 输出目录
     * @returns {Promise<string|null>} 截图路径
     */
    async takeScreenshot(page, type = 'error', outputDir) {
        if (!page || page.isClosed()) return null;

        try {
            const screenshotsDir = outputDir || path.join(process.cwd(), 'output', 'screenshots');
            if (!fs.existsSync(screenshotsDir)) {
                fs.mkdirSync(screenshotsDir, { recursive: true });
            }

            const timestamp = Date.now();
            const filename = `${type}_${timestamp}.png`;
            const filepath = path.join(screenshotsDir, filename);

            await page.screenshot({ path: filepath, fullPage: true });
            console.log(`截图已保存: ${filepath}`);
            return filepath;
        } catch (error) {
            console.error(`截图失败: ${error.message}`);
            return null;
        }
    }

    /**
     * 清理临时用户数据目录
     * @param {string} userDataDir - 用户数据目录路径
     */
    cleanupUserDataDir(userDataDir) {
        if (userDataDir && fs.existsSync(userDataDir)) {
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
                console.log(`已清理临时目录: ${userDataDir}`);
            } catch (error) {
                console.error(`清理临时目录失败: ${error.message}`);
            }
        }
    }

    /**
     * 创建临时用户数据目录
     * @returns {string} 临时目录路径
     */
    createTempUserDataDir() {
        const random = Math.random().toString(36).substring(2, 8);
        const tempDir = path.join(os.tmpdir(), `crawler_clean_${Date.now()}_${random}`);
        fs.mkdirSync(tempDir, { recursive: true });
        return tempDir;
    }
    /**
     * 清理 Chromium 数据
     */
    cleanupAllChromiumData() {
        console.log('=== 开始清理 Chromium 数据 ===\n');
        const { execSync } = require('child_process');

        try {
            if (process.platform === 'win32') {
                execSync('taskkill /F /IM chrome.exe /T 2>nul', { stdio: 'ignore' });
                execSync('taskkill /F /IM chromium.exe /T 2>nul', { stdio: 'ignore' });
                console.log('✓ 已终止残留进程');
            }
        } catch (e) {
            // 忽略错误
        }

        const tmpDir = os.tmpdir();
        try {
            const files = fs.readdirSync(tmpDir);
            for (const file of files) {
                if (file.startsWith('scholar_') || file.startsWith('playwright_')) {
                    const fullPath = path.join(tmpDir, file);
                    try {
                        fs.rmSync(fullPath, { recursive: true, force: true });
                        console.log(`✓ 删除: ${file}`);
                    } catch (e) {
                        // 忽略错误
                    }
                }
            }
        } catch (e) {
            // 忽略错误
        }

        console.log('=== 清理完成 ===\n');
    }
}

module.exports = BrowserManager;
