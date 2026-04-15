// crawler-utils.js
const path = require('path');
const fs = require('fs');
const os = require('os');
// 全局io设置
let globalIo = null;

function setIo(io) {
    globalIo = io;
}
function getIo() { return globalIo; }
const pendingInterventions = new Map();
async function requestUserIntervention(intervention) {
    return new Promise((resolve, reject) => {
        const id = `${intervention.type}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        const timeout = setTimeout(() => {
            pendingInterventions.delete(id);
            reject(new Error(`用户干预超时：${intervention.type}`));
        }, 300000);
        pendingInterventions.set(id, { resolve, reject, timeout });
        if (globalIo) {
            globalIo.emit('user-intervention-required', { id, ...intervention });
        } else {
            reject(new Error('全局 io 未设置'));
        }
    });
}

/**
 * 模拟人类点击：移动鼠标、停顿、点击
 * @param {Page} page Playwright页面对象
 * @param {Locator} locator 要点击的元素定位器
 * @returns {Promise<boolean>}
 */
async function humanClick(page, locator) {
    try {
        const box = await locator.boundingBox();
        if (box) {
            await page.mouse.move(box.x + 10, box.y + 10, {steps: 8});
            await page.waitForTimeout(200);
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {steps: 8});
            await page.waitForTimeout(150);
        }
        await locator.click({delay: 150});
        return true;
    } catch (e) {
        console.log(`人类点击模拟失败: ${e.message}`);
        return false;
    }
}

/**
 * 模拟人类输入：逐个字符输入，带随机延迟
 * @param {Page} page Playwright页面对象
 * @param {Locator} locator 输入框定位器
 * @param {string} text 要输入的文本
 */
async function humanType(page, locator, text) {
    await locator.fill('');
    for (const char of text) {
        await locator.type(char, {delay: 50 + Math.random() * 80});
        await page.waitForTimeout(10);
    }
}

/**
 * 随机延迟，模拟人类操作间隔
 * @param {Page} page Playwright页面对象
 * @param {number} min 最小毫秒
 * @param {number} max 最大毫秒
 */
async function randomDelay(page, min = 500, max = 1500) {
    const delay = min + Math.random() * (max - min);
    await page.waitForTimeout(delay);
}

/**
 * 格式化日期为 yyyy-MM-dd HH:mm:ss
 * @param {Date} date
 * @returns {string}
 */
function formatDateTime(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * 计算两个字符串的相似度（基于三元组匹配）
 * @param {string} str1
 * @param {string} str2
 * @returns {number} 0~1
 */
function calculateStringSimilarity(str1, str2) {
    if (!str1 || !str2) return 0.0;
    const shorter = str1.length <= str2.length ? str1.toLowerCase() : str2.toLowerCase();
    const longer = str1.length > str2.length ? str1.toLowerCase() : str2.toLowerCase();

    let matches = 0;
    for (let i = 0; i < shorter.length - 2; i++) {
        const substr = shorter.substring(i, i + 3);
        if (longer.includes(substr)) matches++;
    }
    return Math.min(1.0, matches / Math.max(1, shorter.length / 3));
}

/**
 * 计算论文匹配相似度（标题权重0.7，作者权重0.3）
 * @param {Object} originalPaper 原论文信息（含title, authors）
 * @param {string} foundTitle 检索到的标题
 * @param {string} foundAuthors 检索到的作者
 * @returns {number}
 */
function calculateMatchSimilarity(originalPaper, foundTitle, foundAuthors) {
    if (!originalPaper || !foundTitle || !foundAuthors) return 0.0;
    const titleSimilarity = calculateStringSimilarity(originalPaper.title, foundTitle);
    const authorSimilarity = calculateStringSimilarity(originalPaper.authors, foundAuthors);
    return titleSimilarity * 0.7 + authorSimilarity * 0.3;
}

/**
 * 确保目录存在
 * @param {string} dirPath
 */
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, {recursive: true});
    }
}

/**
 * 查找本地浏览器（新增）
 * @param {Function} log 日志函数，接受一个字符串参数
 * @returns {string|null} 浏览器路径或 null
 */
function findLocalBrowser(log = console.log) {
    log('\n=== 开始查找本地浏览器 ===');

    function findBrowserRecursive(dir, depth = 0) {
        try {
            const items = fs.readdirSync(dir, {withFileTypes: true});
            for (const item of items) {
                const fullPath = path.join(dir, item.name);

                // 如果是 .app 文件（macOS），获取其中的可执行文件
                if (item.isDirectory() && item.name.toLowerCase().endsWith('.app')) {
                    if (isMacOSApp(fullPath)) {
                        const executable = getMacOSAppExecutable(fullPath);
                        if (executable) {
                            log(`✓ 找到 macOS 应用包并提取可执行文件: ${fullPath}`);
                            log(`  可执行文件路径: ${executable}`);
                            return executable;
                        }
                    }
                    // ⚠️ 重要：不要递归进入 .app 内部，避免找到 Helper 进程
                    // 如果上面的 getMacOSAppExecutable 失败，说明这个 .app 无效，跳过它
                    continue;
                } else if (item.isDirectory()) {
                    // 普通目录，递归查找（但限制深度，避免过深）
                    if (depth < 10) {
                        const found = findBrowserRecursive(fullPath, depth + 1);
                        if (found) return found;
                    }
                } else if (item.name.toLowerCase() === 'chrome.exe') {
                    // Windows 浏览器
                    log(`✓ 找到浏览器（递归查找）: ${fullPath}`);
                    return fullPath;
                }
            }
        } catch (error) {
            log(`查找浏览器时出错: ${error.message}`);
        }
        return null;
    }

    const keyDirs = [
        path.join(process.cwd(), 'browsers'),
        path.join(path.dirname(process.execPath), 'browsers'),
        process.cwd(),
        path.dirname(process.execPath)
    ];

    for (const keyDir of keyDirs) {
        if (fs.existsSync(keyDir)) {
            const found = findBrowserRecursive(keyDir);
            if (found) return found;
        }
    }

    log('✗ 未找到本地浏览器文件');
    return null;
}

/**
 * 清理 Chromium 数据
 * @param {Function} log 日志函数，接受一个字符串参数
 */
function cleanupAllChromiumData(log = console.log) {
    log('=== 开始清理 Chromium 数据 ===\n');
    const {execSync} = require('child_process');

    try {
        if (process.platform === 'win32') {
            execSync('taskkill /F /IM chrome.exe /T 2>nul', {stdio: 'ignore'});
            execSync('taskkill /F /IM chromium.exe /T 2>nul', {stdio: 'ignore'});
            log('✓ 已终止残留进程');
        }
    } catch (e) {
    }

    const tmpDir = os.tmpdir();
    try {
        const files = fs.readdirSync(tmpDir);
        for (const file of files) {
            if (file.startsWith('scholar_') || file.startsWith('playwright_')) {
                const fullPath = path.join(tmpDir, file);
                try {
                    fs.rmSync(fullPath, {recursive: true, force: true});
                    log(`✓ 删除: ${file}`);
                } catch (e) {
                }
            }
        }
    } catch (e) {
    }

    log('=== 清理完成 ===\n');
}

/**
 * 确保浏览器可用（新增）
 * @param {Function} log 日志函数，接受一个字符串参数
 * @returns {Promise<string|null>} 浏览器路径或 null
 */
async function ensureBrowser(log = console.log) {
    log('\n=== 检查浏览器环境 ===');
    const localBrowser = findLocalBrowser(log);
    if (localBrowser) {
        log('使用本地浏览器文件');
        return localBrowser;
    }

    log('\n未找到本地浏览器，尝试自动下载...');
    log('注意：下载需要网络连接，文件约150MB');

    try {
        const downloadDir = path.join(process.cwd(), 'browsers');
        log(`浏览器将下载到: ${downloadDir}`);
        ensureDir(downloadDir);

        process.env.PLAYWRIGHT_BROWSERS_PATH = downloadDir;

        log('正在下载Chromium浏览器，请稍候...');
        log('这可能需要几分钟，取决于网络速度...');

        const {execSync} = require('child_process');
        execSync(`npx playwright install chromium`, {
            stdio: 'inherit',
            cwd: process.cwd(),
            env: {...process.env, PLAYWRIGHT_BROWSERS_PATH: downloadDir}
        });

        log('✓ 浏览器下载完成！');
        return findLocalBrowser(log);
    } catch (downloadError) {
        log(`浏览器下载失败: ${downloadError.message}`);
        return null;
    }
}

/**
 * 保存错误截图
 * @param {Page} page - Playwright 的 page 对象
 * @param {string} context - 错误上下文标识（如 'scopus_author', 'google_scholar'）
 * @returns {Promise<string|null>} 截图文件的绝对路径，失败返回 null
 */
async function takeErrorScreenshot(page, context = 'unknown') {
    if (!page || page.isClosed()) {
        console.warn('[截图] 页面对象无效或已关闭，无法截图');
        return null;
    }
    try {
        const screenshotDir = path.join(process.cwd(), 'output', 'screenshots');
        ensureDir(screenshotDir);
        const timestamp = Date.now();
        // 清理上下文中的非法字符，用于文件名
        const safeContext = context.replace(/[^a-z0-9]/gi, '_').slice(0, 50);
        const filename = `error_${timestamp}_${safeContext}.png`;
        const filePath = path.join(screenshotDir, filename);
        await page.screenshot({path: filePath, fullPage: true});
        console.log(`[截图] 错误截图已保存: ${filePath}`);
        return filePath;
    } catch (err) {
        console.error(`[截图] 保存截图失败: ${err.message}`);
        return null;
    }
}

/**
 * 判断一个路径是否是 macOS 的 .app 应用包
 * @param {string} filePath - 文件路径
 * @returns {boolean}
 */
function isMacOSApp(filePath) {
    try {
        // 1. 检查是否以 .app 结尾
        if (!filePath.toLowerCase().endsWith('.app')) {
            return false;
        }

        // 2. 检查是否是目录（.app 实际上是目录）
        const stats = fs.statSync(filePath);
        if (!stats.isDirectory()) {
            return false;
        }

        // 3. 检查是否包含 Contents 目录（macOS .app 包的标志）
        const contentsPath = path.join(filePath, 'Contents');
        return fs.existsSync(contentsPath);

    } catch (error) {
        console.error(`检查 .app 文件失败: ${error.message}`);
        return false;
    }
}

/**
 * 严格验证 macOS .app 应用包
 * @param {string} appPath - .app 路径
 * @returns {object} 验证结果 { isValid: boolean, reasons: string[] }
 */
function validateMacOSApp(appPath) {
    const result = {
        isValid: false,
        reasons: []
    };

    try {
        // 检查扩展名
        if (!appPath.toLowerCase().endsWith('.app')) {
            result.reasons.push('文件扩展名不是 .app');
            return result;
        }

        // 检查是否为目录
        const stats = fs.statSync(appPath);
        if (!stats.isDirectory()) {
            result.reasons.push('.app 必须是目录类型');
            return result;
        }

        // 检查必需的结构
        const requiredPaths = [
            'Contents',
            'Contents/Info.plist',
            'Contents/MacOS'
        ];

        for (const relativePath of requiredPaths) {
            const fullPath = path.join(appPath, relativePath);
            if (!fs.existsSync(fullPath)) {
                result.reasons.push(`缺少必需的路径: ${relativePath}`);
                return result;
            }
        }

        result.isValid = true;

    } catch (error) {
        result.reasons.push(`检查失败: ${error.message}`);
    }

    return result;
}

/**
 * 获取 .app 包中的可执行文件路径
 * @param {string} appPath - .app 路径
 * @returns {string|null} 可执行文件路径或 null
 */
function getMacOSAppExecutable(appPath) {
    if (!isMacOSApp(appPath)) {
        return null;
    }

    try {
        const macosDir = path.join(appPath, 'Contents', 'MacOS');
        if (!fs.existsSync(macosDir)) {
            return null;
        }

        const files = fs.readdirSync(macosDir);

        // 获取 .app 包的名称（不含 .app 后缀）
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
 * 递归检查目录是否为空
 * @param {string} dirPath
 * @returns {boolean}
 */
function isDirectoryEmpty(dirPath){
    if (!fs.existsSync(dirPath)) return true;
    const items = fs.readdirSync(dirPath);
    for (const item of items){
        const fullPath = path.join(dirPath,item);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()){
            if (!isDirectoryEmpty(fullPath)) return false;
        }else {
            // 非空
            return false;
        }
    }
    return true;
}
/**
 * 清理空目录（递归删除所有空子目录后删除自身）
 * @param {string} dirPath
 */
function cleanEmptyDirectory(dirPath){
    if (!fs.existsSync(dirPath)) return;
    if (isDirectoryEmpty(dirPath)){
        try{
            fs.rmSync(dirPath,{recursive:true,force:true});
            console.log(`已删除空目录:${dirPath}`);
        }catch (err){
            console.warn(`删除空目录失败${err.message}`)
        }
    } else{
        console.log(`目录非空，保留${dirPath}`);
    }
}
module.exports = {
    pendingInterventions,
    setIo,
    getIo,
    humanClick,
    humanType,
    randomDelay,
    formatDateTime,
    calculateStringSimilarity,
    calculateMatchSimilarity,
    ensureDir,
    findLocalBrowser,
    ensureBrowser,
    cleanupAllChromiumData,
    takeErrorScreenshot,
    requestUserIntervention,
    isMacOSApp,
    validateMacOSApp,
    getMacOSAppExecutable,
    cleanEmptyDirectory
};










