// src/infrastructure/browser-manager.js
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
chromium.use(StealthPlugin());

/**
 * 基础反检测参数 - 禁用自动化标记和后台限制
 * 注意：不过度注入“确定性渲染 / 关闭同源策略”等异常参数，否则更容易触发 Google 人机验证
 */
const CHROME_ARGS = [
    '--disable-blink-features=AutomationControlled',      // 禁用自动化控制标记
    '--disable-infobars',                                // 禁用"Chrome正受到自动测试软件控制"
    '--disable-background-timer-throttling',             // 后台标签不禁用定时器
    '--disable-backgrounding-occluded-windows',            // 遮挡/屏外窗口不暂停渲染
    '--disable-renderer-backgrounding',                  // 渲染进程不被降级
    '--no-first-run',
    '--no-default-browser-check',
];
/**
 * Docker/容器环境专用参数
 */
const CHROME_DOCKER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
];

/**
 * Headless模式伪装参数（配合 --headless=new 使用）
 */
const CHROME_HEADLESS_ARGS = [
    '--hide-scrollbars',
    '--mute-audio',
    '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
];

/**
 * 禁用安全限制参数（谨慎使用，仅在受控环境启用；对 Google 易增加风控）
 */
const CHROME_DISABLE_SECURITY_ARGS = [
    '--disable-web-security',
    '--disable-features=BlockInsecurePrivateNetworkRequests',
];

/**
 * 确定性渲染参数 - 指纹异常，默认关闭
 */
const CHROME_DETERMINISTIC_RENDERING_ARGS = [
    '--deterministic-mode',
    '--disable-skia-runtime-opts',
    '--run-all-compositor-stages-before-draw',
    '--disable-new-content-rendering-timeout',
    '--disable-threaded-animation',
    '--disable-threaded-scrolling',
    '--disable-checker-imaging',
];

/** 屏外隐藏时的窗口坐标（保持 normal 状态，比最小化更不易触发风控） */
const OFFSCREEN_WINDOW_POSITION = { left: -32000, top: 0 };

/** 判定窗口仍在屏外的阈值 */
const OFFSCREEN_LEFT_THRESHOLD = -500;

class BrowserManager {
    constructor() {
        this.browsersPath = this._findBrowsersPath();
        this._offscreenGuardProc = null;
        this._offscreenGuardEnabled = false;
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
     * 获取屏幕分辨率
     * @returns {{width: number, height: number}}
     */
    _getScreenResolution() {
        // Electron 环境：使用 screen API
        if (process.versions.electron) {
            try {
                const { screen } = require('electron');
                const { width, height } = screen.getPrimaryDisplay().workAreaSize;
                return { width, height };
            } catch (e) {
                console.warn('[BrowserManager] 获取 Electron 屏幕分辨率失败:', e.message);
            }
        }

        // 尝试通过系统命令获取
        try {
            const { execSync } = require('child_process');

            if (process.platform === 'win32') {
                const output = execSync(
                    'wmic path Win32_VideoController get CurrentHorizontalResolution,CurrentVerticalResolution /value',
                    { encoding: 'utf8', timeout: 5000 }
                );
                const widthMatch = output.match(/CurrentHorizontalResolution=(\d+)/);
                const heightMatch = output.match(/CurrentVerticalResolution=(\d+)/);
                if (widthMatch && heightMatch) {
                    return {
                        width: parseInt(widthMatch[1], 10),
                        height: parseInt(heightMatch[1], 10)
                    };
                }
            } else if (process.platform === 'darwin') {
                const output = execSync(
                    'system_profiler SPDisplaysDataType | grep Resolution',
                    { encoding: 'utf8', timeout: 5000 }
                );
                const match = output.match(/(\d+)\s*x\s*(\d+)/);
                if (match) {
                    return {
                        width: parseInt(match[1], 10),
                        height: parseInt(match[2], 10)
                    };
                }
            } else if (process.platform === 'linux') {
                try {
                    const output = execSync('xrandr | grep "\\*" | head -1', {
                        encoding: 'utf8',
                        timeout: 5000
                    });
                    const match = output.match(/(\d+)x(\d+)/);
                    if (match) {
                        return {
                            width: parseInt(match[1], 10),
                            height: parseInt(match[2], 10)
                        };
                    }
                } catch (e) {
                    // xrandr 可能不可用（无显示服务器）
                }
            }
        } catch (e) {
            console.warn('[BrowserManager] 通过系统命令获取屏幕分辨率失败:', e.message);
        }

        // 默认返回标准桌面分辨率
        return { width: 1920, height: 1080 };
    }

    /**
     * 获取窗口偏移量（模拟真实窗口边框和任务栏）
     * 确保 window.outerWidth !== window.innerWidth，绕过 headless 检测
     * @returns {{offsetX: number, offsetY: number}}
     */
    _getWindowAdjustments() {
        // 模拟真实窗口的边框和标题栏偏移
        if (process.platform === 'win32') {
            return { offsetX: 8, offsetY: 31 };   // 左边框8px，标题栏约23px + 任务栏偏移
        } else if (process.platform === 'darwin') {
            return { offsetX: 0, offsetY: 25 };   // macOS 标题栏约25px
        } else {
            return { offsetX: 1, offsetY: 28 };   // Linux 假设值
        }
    }

    /**
     * 检查端口是否被占用（第三层反检测：端口冲突智能处理）
     * @param {number} port
     * @returns {Promise<boolean>}
     */
    _isPortInUse(port) {
        return new Promise((resolve) => {
            const tester = net.createServer()
                .once('error', (err) => {
                    resolve(err.code === 'EADDRINUSE');
                })
                .once('listening', () => {
                    tester.close(() => resolve(false));
                })
                .listen(port, '127.0.0.1');
        });
    }

    /**
     * 构建完整的 Chrome 反检测启动参数
     * 整合三层反检测策略：
     *   第一层：启动参数注入（CHROME_ARGS 系列常量）
     *   第二层：窗口尺寸与位置仿真
     *   第三层：远程调试端口冲突检测
     * @param {Object} options
     * @returns {Promise<string[]>}
     */
    async _buildAntiDetectArgs(options = {}) {
        const {
            headless = false,
            startMinimized = true,
            hideMode = 'minimized',
            remoteDebuggingPort = null,
            extraBrowserArgs = [],
            customArgs = [],
            disableSecurityArgs = false,
            deterministicRendering = false
        } = options;

        const chromeArgs = new Set();

        // 第一层：基础反检测参数注入
        CHROME_ARGS.forEach(arg => chromeArgs.add(arg));
        CHROME_DOCKER_ARGS.forEach(arg => chromeArgs.add(arg));

        // 高风险参数默认关闭，避免 Google 风控
        if (disableSecurityArgs) {
            CHROME_DISABLE_SECURITY_ARGS.forEach(arg => chromeArgs.add(arg));
        }
        if (deterministicRendering) {
            CHROME_DETERMINISTIC_RENDERING_ARGS.forEach(arg => chromeArgs.add(arg));
        }

        // Headless 模式伪装参数
        if (headless) {
            CHROME_HEADLESS_ARGS.forEach(arg => chromeArgs.add(arg));
        }

        // 第二层：窗口尺寸与位置仿真
        let screenSize, offsetX, offsetY;
        if (headless) {
            screenSize = { width: 1920, height: 1080 };
            offsetX = 0;
            offsetY = 0;
        } else if (startMinimized && hideMode === 'offscreen') {
            // 屏外启动：窗口仍是 normal，比 --start-minimized 更接近真实用户
            screenSize = this._getScreenResolution();
            offsetX = OFFSCREEN_WINDOW_POSITION.left;
            offsetY = OFFSCREEN_WINDOW_POSITION.top;
        } else if (startMinimized) {
            // 默认：任务栏最小化，仅人机验证/登录时再恢复
            chromeArgs.add('--start-minimized');
            screenSize = this._getScreenResolution();
            const adjustments = this._getWindowAdjustments();
            offsetX = adjustments.offsetX;
            offsetY = adjustments.offsetY;
        } else {
            screenSize = this._getScreenResolution();
            const adjustments = this._getWindowAdjustments();
            offsetX = adjustments.offsetX;
            offsetY = adjustments.offsetY;
        }

        chromeArgs.add(`--window-position=${offsetX},${offsetY}`);
        chromeArgs.add(`--window-size=${screenSize.width},${screenSize.height}`);

        // 第三层：远程调试端口（默认不注入，该端口是常见自动化指纹）
        if (typeof remoteDebuggingPort === 'number' && remoteDebuggingPort > 0) {
            const portInUse = await this._isPortInUse(remoteDebuggingPort);
            if (!portInUse) {
                chromeArgs.add(`--remote-debugging-port=${remoteDebuggingPort}`);
            } else {
                console.warn(`[BrowserManager] 远程调试端口 ${remoteDebuggingPort} 已被占用，跳过注入以避免启动失败`);
            }
        }

        // 合并用户自定义参数（去重）
        extraBrowserArgs.forEach(arg => chromeArgs.add(arg));
        customArgs.forEach(arg => chromeArgs.add(arg));

        return Array.from(chromeArgs);
    }

    /**
     * 启动浏览器
     * @param {Object} options - 浏览器启动选项
     * @param {boolean} options.headless - 是否无头模式（默认 false）
     * @param {boolean} options.startMinimized - 有头模式下是否最小化启动（默认 true）
     * @param {boolean} options.showOnIntervention - 需要人机验证/登录时是否恢复窗口（默认 true）
     * @param {string} options.executablePath - 浏览器可执行文件路径
     * @param {string[]} options.args - 额外的 Chrome 启动参数
     * @param {string} options.userDataDir - 用户数据目录
     * @param {number} options.remoteDebuggingPort - 远程调试端口（默认 9222）
     * @param {string[]} options.extraBrowserArgs - 额外的反检测参数
     * @returns {Promise<Object>} browser 实例
     */
    async launch(options = {}) {
        const {
            headless = false,
            startMinimized = true,
            showOnIntervention = true,
            hideMode = 'minimized',
            keepAlive = true,
            executablePath = null,
            args = [],
            userDataDir = null,
            remoteDebuggingPort = null,
            extraBrowserArgs = [],
            disableSecurityArgs = false,
            deterministicRendering = false
        } = options;

        // keepAlive 时不杀残留进程，避免误杀其它常驻浏览器；非常驻时仍清理
        if (!keepAlive) {
            await this._killPlaywrightBrowsersOnly();
        }

        let browserPath = executablePath;
        if (!browserPath) {
            browserPath = await this.ensureBrowser();
        }
        // 构建完整的反检测启动参数
        const antiDetectArgs = await this._buildAntiDetectArgs({
            headless,
            startMinimized,
            hideMode,
            remoteDebuggingPort,
            extraBrowserArgs,
            customArgs: args,
            disableSecurityArgs,
            deterministicRendering
        });
        console.log('BrowserManager 启动参数:', antiDetectArgs);
        const launchOptions = {
            executablePath: browserPath,
            headless,
            args: antiDetectArgs
        };

        if (userDataDir) {
            launchOptions.userDataDir = userDataDir;
        }

        const browser = await chromium.launch(launchOptions);

        // 设置浏览器关闭标记与窗口可见性策略
        browser._isClosedByUser = false;
        browser._visibilityOptions = {
            headless: !!headless,
            startMinimized: !headless && startMinimized !== false,
            showOnIntervention: showOnIntervention !== false,
            hideMode: hideMode === 'offscreen' ? 'offscreen' : 'minimized',
            keepAlive: keepAlive !== false
        };
        browser._windowVisible = !browser._visibilityOptions.startMinimized;
        browser._screenSize = this._getScreenResolution();

        return browser;
    }

    /**
     * 使用持久化用户目录启动（复用 Cookie / 本地存储，降低 Google 人机验证）
     * @param {string} userDataDir
     * @param {Object} options
     * @returns {Promise<{browser: Object, context: Object, page: Object}>}
     */
    async launchPersistent(userDataDir, options = {}) {
        const {
            headless = false,
            startMinimized = true,
            showOnIntervention = true,
            hideMode = 'minimized',
            keepAlive = true,
            executablePath = null,
            args = [],
            remoteDebuggingPort = null,
            extraBrowserArgs = [],
            disableSecurityArgs = false,
            deterministicRendering = false,
            downloadsPath = null,
            userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            locale = 'zh-CN',
            timezoneId = 'Asia/Shanghai'
        } = options;

        if (!keepAlive) {
            await this._killPlaywrightBrowsersOnly();
        }

        let browserPath = executablePath;
        if (!browserPath) {
            browserPath = await this.ensureBrowser();
        }

        if (!fs.existsSync(userDataDir)) {
            fs.mkdirSync(userDataDir, { recursive: true });
        }

        const antiDetectArgs = await this._buildAntiDetectArgs({
            headless,
            startMinimized,
            hideMode,
            remoteDebuggingPort,
            extraBrowserArgs,
            customArgs: args,
            disableSecurityArgs,
            deterministicRendering
        });

        console.log('BrowserManager 持久化启动参数:', antiDetectArgs);

        const context = await chromium.launchPersistentContext(userDataDir, {
            executablePath: browserPath,
            headless,
            args: antiDetectArgs,
            viewport: null,
            locale,
            timezoneId,
            userAgent,
            acceptDownloads: true,
            ...(downloadsPath ? { downloadsPath } : {})
        });

        // launchPersistentContext 在部分版本中 context.browser() 可能为 null，做兼容包装
        let browser = context.browser();
        if (!browser) {
            browser = {
                _isPersistentWrapper: true,
                _persistentContext: context,
                isConnected: () => {
                    try {
                        return context.pages().some(p => !p.isClosed());
                    } catch (e) {
                        return false;
                    }
                },
                close: async () => context.close(),
                on: () => {},
                removeListener: () => {},
                newContext: async () => {
                    throw new Error('持久化模式下请复用已有 context，勿再 newContext');
                }
            };
        } else {
            browser._persistentContext = context;
        }

        browser._isClosedByUser = false;
        browser._visibilityOptions = {
            headless: !!headless,
            startMinimized: !headless && startMinimized !== false,
            showOnIntervention: showOnIntervention !== false,
            hideMode: hideMode === 'offscreen' ? 'offscreen' : 'minimized',
            keepAlive: keepAlive !== false
        };
        browser._windowVisible = !browser._visibilityOptions.startMinimized;
        browser._screenSize = this._getScreenResolution();

        const page = context.pages()[0] || await context.newPage();
        // waitForTimeout polyfill (rebrowser-playwright may omit it)
        if (page && typeof page.waitForTimeout !== 'function') {
            page.waitForTimeout = (ms) =>
                new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));
        }
        return { browser, context, page };
    }

    /**
     * 通过 CDP 设置浏览器窗口边界/状态
     * @param {Object} page
     * @param {Object} bounds - CDP Browser.Bounds
     * @returns {Promise<boolean>}
     */
    async _setWindowBounds(page, bounds) {
        if (!page || page.isClosed()) return false;

        let session = null;
        try {
            session = await page.context().newCDPSession(page);
            const { windowId } = await session.send('Browser.getWindowForTarget');
            await session.send('Browser.setWindowBounds', { windowId, bounds });
            return true;
        } catch (error) {
            console.warn(`[BrowserManager] 设置窗口边界失败: ${error.message}`);
            return false;
        } finally {
            if (session) {
                await session.detach().catch(() => {});
            }
        }
    }

    /**
     * 通过 CDP 设置浏览器窗口状态
     * @param {Object} page - Playwright page
     * @param {'normal'|'minimized'|'maximized'|'fullscreen'} windowState
     * @returns {Promise<boolean>}
     */
    async _setWindowState(page, windowState) {
        return this._setWindowBounds(page, { windowState });
    }

    /**
     * 将浏览器窗口藏到后台（默认屏外，避免最小化触发风控）
     * @param {Object} page - Playwright page
     * @param {Object} [browser] - browser 实例（可选，用于读取策略）
     */
    async hideWindow(page, browser = null) {
        const browserRef = browser || (typeof page?.context?.()?.browser === 'function' ? page.context().browser() : null);
        const options = browserRef?._visibilityOptions || {};
        if (options.headless || options.startMinimized === false) {
            return;
        }

        this._stopOffscreenFocusGuard();

        let ok = false;
        if (options.hideMode === 'offscreen') {
            const screenSize = browserRef?._screenSize || this._getScreenResolution();
            ok = await this._setWindowBounds(page, {
                left: OFFSCREEN_WINDOW_POSITION.left,
                top: OFFSCREEN_WINDOW_POSITION.top,
                width: screenSize.width,
                height: screenSize.height,
                windowState: 'normal'
            });
            // 仅 offscreen 模式启用焦点守卫；minimized 模式不自动弹窗
            this._startOffscreenFocusGuard();
        } else {
            // 默认：任务栏最小化
            ok = await this._setWindowState(page, 'minimized');
            await this._minimizeChromiumWin32();
        }
        if (browserRef) {
            browserRef._windowVisible = false;
        }
        return ok;
    }

    /**
     * 在需要人机验证 / 登录时恢复并前置浏览器窗口
     * @param {Object} page - Playwright page
     * @param {Object} [browser] - browser 实例（可选）
     */
    async showWindow(page, browser = null) {
        const browserRef = browser || (typeof page?.context?.()?.browser === 'function' ? page.context().browser() : null);
        const options = browserRef?._visibilityOptions || {};
        if (options.headless) {
            return;
        }
        if (options.showOnIntervention === false) {
            return;
        }

        this._stopOffscreenFocusGuard();

        const screenSize = browserRef?._screenSize || this._getScreenResolution();
        const adjustments = this._getWindowAdjustments();
        const targetBounds = {
            left: Math.max(adjustments.offsetX, 80),
            top: Math.max(adjustments.offsetY, 80),
            width: Math.min(Math.max(screenSize.width - 160, 1024), 1440),
            height: Math.min(Math.max(screenSize.height - 160, 720), 900),
            windowState: 'normal'
        };

        // 先恢复 normal，再设到可见区域（避免仍停在屏外）
        if (page && !page.isClosed()) {
            await this._setWindowBounds(page, { windowState: 'normal' });
            const ok = await this._setWindowBounds(page, targetBounds);
            try {
                await page.bringToFront();
            } catch (e) {
                // 忽略
            }
            if (ok) {
                console.log('[BrowserManager] 已恢复浏览器窗口供用户干预');
            } else {
                console.warn('[BrowserManager] CDP 恢复窗口可能失败，已尝试系统前置');
            }
        }

        // Windows 下再强制把 Chromium 窗口拉到前台（任务栏点了也看不见时的兜底）
        await this._bringChromiumToForegroundWin32();

        if (browserRef) {
            browserRef._windowVisible = true;
        }
    }

    /**
     * 仅通过系统 API 把检索用 Chromium 拉回可见区域（无需 page 引用）
     * 仅应在人机验证 / 登录干预时由前端或爬虫调用
     */
    async forceShowChromiumWindows() {
        this._stopOffscreenFocusGuard();
        await this._bringChromiumToForegroundWin32();
        console.log('[BrowserManager] 已强制将 Chromium 窗口移回屏幕内');
    }

    /**
     * Windows：将检索用 Chromium 最小化到任务栏（仅主窗口，避免误伤子窗口）
     */
    async _minimizeChromiumWin32() {
        if (process.platform !== 'win32') return;
        try {
            const { execFileSync } = require('child_process');
            const psPath = path.join(os.tmpdir(), `spm_min_chrome_${Date.now()}.ps1`);
            const ps = this._buildWin32ChromeMainWindowScript('minimize');
            fs.writeFileSync(psPath, ps, 'utf8');
            execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath], {
                timeout: 8000,
                stdio: 'ignore'
            });
            try { fs.unlinkSync(psPath); } catch (e) {}
        } catch (e) {
            console.warn('[BrowserManager] Win32 最小化失败:', e.message);
        }
    }

    /**
     * 生成仅操作「一个主浏览器窗口」的 PowerShell（Chrome 每个进程有大量 HWND，全部 ShowWindow 会一次弹出很多窗）
     * @param {'show'|'minimize'} action
     */
    _buildWin32ChromeMainWindowScript(action = 'show') {
        const doShow = action === 'show';
        return `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class ChromeMainWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  // 只收集「无 owner、足够大」的顶层主窗口，排除 Chrome 大量工具/幽灵 HWND
  public static IntPtr FindLargestMainWindow(HashSet<int> pids) {
    IntPtr best = IntPtr.Zero;
    long bestArea = 0;
    EnumWindows((hWnd, lParam) => {
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (!pids.Contains((int)pid)) return true;
      if (!IsWindow(hWnd)) return true;
      if (GetWindow(hWnd, 4) != IntPtr.Zero) return true; // GW_OWNER=4，有 owner 的不是主窗
      if (!IsWindowVisible(hWnd) && !IsIconic(hWnd)) return true;
      RECT r;
      if (!GetWindowRect(hWnd, out r)) return true;
      int w = r.Right - r.Left;
      int h = r.Bottom - r.Top;
      if (w < 400 || h < 300) return true; // 过滤小弹层/托盘类窗口
      long area = (long)w * h;
      if (area > bestArea) { bestArea = area; best = hWnd; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@
$pids = New-Object 'System.Collections.Generic.HashSet[int]'
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    ($_.Name -match 'chrome|chromium') -and
    ($_.CommandLine -match 'playwright|user-data-dir=.*browser-profiles|crawler_clean')
  } |
  ForEach-Object { [void]$pids.Add([int]$_.ProcessId) }

# 绝不再回退到本机全部 chrome.exe，否则会把用户自己的浏览器也全部拉起来

if ($pids.Count -eq 0) { exit 0 }
$h = [ChromeMainWin]::FindLargestMainWindow($pids)
if ($h -eq [IntPtr]::Zero) { exit 0 }
${doShow ? `
[void][ChromeMainWin]::ShowWindow($h, 9)
[void][ChromeMainWin]::SetWindowPos($h, [IntPtr]::Zero, 80, 80, 1280, 800, 0x0040)
Start-Sleep -Milliseconds 80
[void][ChromeMainWin]::SetForegroundWindow($h)
` : `
[void][ChromeMainWin]::ShowWindow($h, 6)
`}
`;
    }

    /**
     * 屏外隐藏期间守护：用户点击任务栏谷歌图标激活窗口时，自动移回屏幕
     * （仅 hideMode=offscreen 时启用；默认 minimized 不会启动）
     */
    _startOffscreenFocusGuard() {
        if (process.platform !== 'win32') return;
        if (this._offscreenGuardEnabled && this._offscreenGuardProc && !this._offscreenGuardProc.killed) {
            return;
        }
        this._stopOffscreenFocusGuard();
        this._offscreenGuardEnabled = true;

        try {
            const { spawn } = require('child_process');
            const psPath = path.join(os.tmpdir(), `spm_offscreen_guard_${process.pid}.ps1`);
            const threshold = OFFSCREEN_LEFT_THRESHOLD;
            const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class OffscreenGuard {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static IntPtr FindLargestMainWindow(HashSet<int> pids) {
    IntPtr best = IntPtr.Zero;
    long bestArea = 0;
    EnumWindows((hWnd, lParam) => {
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (!pids.Contains((int)pid)) return true;
      if (!IsWindow(hWnd)) return true;
      if (GetWindow(hWnd, 4) != IntPtr.Zero) return true;
      if (!IsWindowVisible(hWnd) && !IsIconic(hWnd)) return true;
      RECT r;
      if (!GetWindowRect(hWnd, out r)) return true;
      int w = r.Right - r.Left; int h = r.Bottom - r.Top;
      if (w < 400 || h < 300) return true;
      long area = (long)w * h;
      if (area > bestArea) { bestArea = area; best = hWnd; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
  public static bool IsOffscreen(IntPtr hWnd, int threshold) {
    RECT r;
    if (!GetWindowRect(hWnd, out r)) return false;
    return r.Left < threshold || r.Top < threshold;
  }
}
"@
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $pids = New-Object 'System.Collections.Generic.HashSet[int]'
  Get-CimInstance Win32_Process |
    Where-Object {
      ($_.Name -match 'chrome|chromium') -and
      ($_.CommandLine -match 'playwright|user-data-dir=.*browser-profiles|crawler_clean')
    } |
    ForEach-Object { [void]$pids.Add([int]$_.ProcessId) }

  if ($pids.Count -gt 0) {
    $h = [OffscreenGuard]::FindLargestMainWindow($pids)
    if ($h -ne [IntPtr]::Zero) {
      $fg = [OffscreenGuard]::GetForegroundWindow()
      $isFg = ($h -eq $fg)
      $off = [OffscreenGuard]::IsOffscreen($h, ${threshold})
      if ($isFg -and $off) {
        [void][OffscreenGuard]::ShowWindow($h, 9)
        [void][OffscreenGuard]::SetWindowPos($h, [IntPtr]::Zero, 80, 80, 1280, 800, 0x0040)
        Start-Sleep -Milliseconds 50
        [void][OffscreenGuard]::SetForegroundWindow($h)
      }
    }
  }
  Start-Sleep -Milliseconds 600
}
`;
            fs.writeFileSync(psPath, ps, 'utf8');
            this._offscreenGuardProc = spawn('powershell.exe', [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath
            ], {
                windowsHide: true,
                stdio: 'ignore'
            });
            this._offscreenGuardProc.on('exit', () => {
                this._offscreenGuardProc = null;
                try { fs.unlinkSync(psPath); } catch (e) {}
            });
            console.log('[BrowserManager] 已启动屏外焦点守卫（点击任务栏谷歌图标会自动移回屏幕）');
        } catch (e) {
            console.warn('[BrowserManager] 启动屏外焦点守卫失败:', e.message);
            this._offscreenGuardEnabled = false;
        }
    }

    _stopOffscreenFocusGuard() {
        this._offscreenGuardEnabled = false;
        if (this._offscreenGuardProc && !this._offscreenGuardProc.killed) {
            try {
                this._offscreenGuardProc.kill();
            } catch (e) {}
        }
        this._offscreenGuardProc = null;
        try {
            const psPath = path.join(os.tmpdir(), `spm_offscreen_guard_${process.pid}.ps1`);
            if (fs.existsSync(psPath)) fs.unlinkSync(psPath);
        } catch (e) {}
    }

    /**
     * Windows：将 Playwright/Chromium 主窗口还原并前置（只动 1 个主窗，避免一次弹出大量 HWND）
     */
    async _bringChromiumToForegroundWin32() {
        if (process.platform !== 'win32') return;
        const now = Date.now();
        // 短时间去重：前端弹窗 + 爬虫 showWindow 可能连续触发
        if (this._lastBringAt && (now - this._lastBringAt) < 1500) {
            return;
        }
        this._lastBringAt = now;
        try {
            const { execFileSync } = require('child_process');
            const psPath = path.join(os.tmpdir(), `spm_bring_chrome_${Date.now()}.ps1`);
            const ps = this._buildWin32ChromeMainWindowScript('show');
            fs.writeFileSync(psPath, ps, 'utf8');
            execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath], {
                timeout: 10000,
                stdio: 'ignore'
            });
            try { fs.unlinkSync(psPath); } catch (e) {}
        } catch (e) {
            console.warn('[BrowserManager] Win32 前置窗口失败:', e.message);
        }
    }

    /**
     * 页面创建后应用初始可见性（默认屏外后台）
     * @param {Object} page
     * @param {Object} browser
     */
    async applyInitialVisibility(page, browser) {
        const options = browser?._visibilityOptions || {};
        if (options.headless || !options.startMinimized) {
            return;
        }
        await new Promise(r => setTimeout(r, 5000));
        await this.hideWindow(page, browser);
        console.log(`[BrowserManager] 浏览器已在后台运行（模式: ${options.hideMode || 'offscreen'}）`);
    }

    /**
     * 获取/创建持久化用户数据目录（复用 Cookie，降低 Google 人机验证频率）
     * @param {string} profileName
     * @returns {string}
     */
    getPersistentUserDataDir(profileName = 'default') {
        const baseDir = path.join(process.cwd(), 'browser-profiles', profileName);
        if (!fs.existsSync(baseDir)) {
            fs.mkdirSync(baseDir, { recursive: true });
        }
        return baseDir;
    }

    /**
     * 干预期间临时显示窗口，结束后再隐藏回后台
     * @param {Object} page
     * @param {Function} asyncFn
     * @param {Object} [browser]
     * @returns {Promise<*>}
     */
    async withVisibleWindow(page, asyncFn, browser = null) {
        const browserRef = browser || (typeof page?.context?.()?.browser === 'function' ? page.context().browser() : null);
        const wasVisible = browserRef?._windowVisible === true;
        await this.showWindow(page, browserRef);
        try {
            return await asyncFn();
        } finally {
            if (!wasVisible) {
                await this.hideWindow(page, browserRef);
            }
        }
    }
    /**
     * 强制终止所有 Playwright 相关的浏览器进程（仅 Windows）
     * 该函数用于清理残留的浏览器进程，避免端口占用和资源泄漏。
     * 执行成功后会等待 2 秒以确保端口完全释放。
     */
    async _killPlaywrightBrowsersOnly() {
        if (process.platform !== 'win32') return;

        const { execSync } = require('child_process');

        try {
            const psScript = `
            Get-CimInstance Win32_Process | Where-Object { 
                ($_.Name -match 'chrome|chromium') -and 
                ($_.CommandLine -match 'remote-debugging-port=\\d+|playwright_chromiumdev_profile|playwright-artifacts')
            } | ForEach-Object { 
                try { 
                    Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop;
                    $_.ProcessId 
                } catch { 
                    $null 
                }
            } | Where-Object { $_ -ne $null }
        `;

            const result = execSync(
                `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/\n/g, ' ').trim()}"`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 15000 }
            );

            const pids = result.trim().split('\n').filter(Boolean);
            if (pids.length > 0) {
                console.log(`[BrowserManager] 已终止 ${pids.length} 个 Playwright 浏览器进程`);
                await new Promise(r => setTimeout(r, 2000)); // 等待端口完全释放
            } else {
                console.log('[BrowserManager] 未发现残留 Playwright 浏览器进程');
            }
        } catch (e) {
            // PowerShell 执行失败，静默忽略
        }
    }
    /**
     * 创建新页面（修复 locale/timezoneId 透传）
     * @param {Object} browser - browser 实例
     * @param {Object} contextOptions - 上下文选项
     * @returns {Promise<Object>} { page, context }
     */
    async createPage(browser, contextOptions = {}) {
        const {
            userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            acceptDownloads = true,
            downloadsPath = null,
            locale = 'zh-CN',
            timezoneId,
            timezone_id,
            viewport =  null
        } = contextOptions;

        const context = await browser.newContext({
            userAgent,
            acceptDownloads,
            viewport,
            locale,
            timezoneId: timezoneId || timezone_id || 'Asia/Shanghai',
            ...(downloadsPath && { downloadsPath })
        });

        const page = await context.newPage();
        // waitForTimeout polyfill (rebrowser-playwright may omit it)
        if (typeof page.waitForTimeout !== 'function') {
            page.waitForTimeout = (ms) =>
                new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));
        }
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
                console.log('BrowserManager 浏览器正常关闭');
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

                if (browser._persistentContext) {
                    await browser._persistentContext.close();
                } else {
                    await browser.close();
                }
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
                console.log('BrowserManager 已终止残留进程');
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
                        console.log(` 删除: ${file}`);
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
