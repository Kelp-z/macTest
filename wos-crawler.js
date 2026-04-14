// wos-crawler.js
const { chromium } = require('playwright');
const ExcelJS = require('exceljs');
const fs = require('fs');
const os = require('os');
const path = require('path');
let logStream = null;

const {
    humanClick,
    humanType,
    randomDelay,
    formatDateTime,
    ensureDir,
    findLocalBrowser,
    cleanupAllChromiumData,
    ensureBrowser
} = require('./crawler-utils');
const {
    academicCatLogin,
    academicCatNavigateToTarget
} = require('./academic-cat-utils');
const {formatError} = require("./error-utils");
const {takeErrorScreenshot} = require("./crawler-utils");
const isStopRequested = () => shouldStop;

// 配置读取
const DEFAULT_CONFIG = {
    USER_NAME: '28199134',
    PASSWORD: '460256',
    BASE_URL: 'https://www.2447.net/',
    OUTPUT_DIR_NAME: 'output/wos',
    CAPTCHA_DIR_NAME: 'captcha_temp',
    // 保存截图（开发阶段）
    // SCREENSHOT_DIR_NAME: 'screenshots'
};

let userConfig = {};
const configPath = path.join(process.cwd(), 'config.json');
if (fs.existsSync(configPath)) {
    try {
        const raw = fs.readFileSync(configPath, 'utf8');
        userConfig = JSON.parse(raw);
        console.log('已加载外部配置文件:', configPath);
    } catch (err) {
        console.warn('读取配置文件失败，使用默认配置', err.message);
    }
}
const wosConfig = userConfig.wos || {};
const merged = { ...DEFAULT_CONFIG, ...wosConfig };

// 基于 process.cwd() 构建绝对路径
const baseDir = process.cwd();
const CONFIG = {
    USER_NAME: merged.USER_NAME,
    PASSWORD: merged.PASSWORD,
    BASE_URL: merged.BASE_URL,
    OUTPUT_DIR: path.join(baseDir, merged.OUTPUT_DIR_NAME),
    CAPTCHA_DIR: path.join(baseDir, merged.CAPTCHA_DIR_NAME),
    // SCREENSHOT_DIR: path.join(baseDir, merged.SCREENSHOT_DIR_NAME)
};

// 确保目录存在（可写）
ensureDir(CONFIG.OUTPUT_DIR);
ensureDir(CONFIG.CAPTCHA_DIR);
// ensureDir(CONFIG.SCREENSHOT_DIR);


//  状态管理
let crawlerState = {
    isRunning: false,
    progress: 0,
    logs: [],
    result: null,
    filePaths: [],
    error: null,
    logIndex: 0,
    waitingForCaptcha: false,
    captchaId: null,
    captchaImagePath: null,
    manualModeActive: false,
    stopRequested: false
};
let shouldStop = false;

function addLog(message) {
    const logEntry = { time: new Date().toISOString(), message };
    crawlerState.logs.push(logEntry);
    crawlerState.logIndex++;
    if (crawlerState.logs.length > 1000) crawlerState.logs.shift();
    console.log(message);
    if (logStream && logStream.writable) {
        logStream.write(`[${new Date().toISOString()}] ${message}\n`);
    }
}

function resetCrawlerState() {
    crawlerState = {
        isRunning: false,
        progress: 0,
        logs: [],
        result: null,
        filePaths: [],
        error: null,
        logIndex: 0,
        waitingForCaptcha: false,
        captchaId: null,
        captchaImagePath: null,
        manualModeActive: false,
        stopRequested: false
    };
    shouldStop = false;
}

function getCrawlerState() {
    return { ...crawlerState };
}

function stopCrawler() {
    shouldStop = true;
    crawlerState.stopRequested = true;
    addLog('⏹️ 收到停止请求，正在停止...');
}

//  WoS

/**
 * 判断是否为有效的 WoS 页面
 */
async function isWosPage(page) {
    try {
        await page.locator('#composeQuerySmartSearch').waitFor({ timeout: 10000 });
        return true;
    } catch (e) {
        try {
            await getSearchButton(page);
            return true;
        } catch (e2) {
            return false;
        }
    }
}

/**
 * 获取搜索按钮（多种选择器）
 */
async function getSearchButton(page) {
    const selectors = [
        "button[data-pendo='smart-search-query']",
        "button[data-ta='run-search']",
        "button[type='submit']",
        ".fully-rounded-large-input-submit-button"
    ];
    for (const selector of selectors) {
        try {
            const button = page.locator(selector);
            if (await button.isVisible({ timeout: 1000 })) {
                return button;
            }
        } catch (e) {}
    }
    throw new Error('找不到搜索按钮');
}

/**
 * 处理 Cookie/遮罩层
 */
async function handleCookieConsent(page) {
    try {
        await page.waitForTimeout(1500);
        const removed = await page.evaluate(() => {
            try {
                let found = false;
                document.querySelectorAll('.onetrust-pc-dark-filter, .cookie-overlay, .modal-backdrop').forEach(el => {
                    el.remove();
                    found = true;
                });
                document.querySelectorAll('#onetrust-consent-sdk, .onetrust-pc-dark-filter, .cookie-consent, .modal-dialog').forEach(el => {
                    el.remove();
                    found = true;
                });
                document.body.style.overflow = 'auto';
                document.documentElement.style.overflow = 'auto';
                document.body.style.pointerEvents = 'auto';
                return found;
            } catch {
                return false;
            }
        });
        if (removed) addLog('成功处理Cookie弹窗');
        else addLog('未检测到Cookie弹窗');
    } catch (e) {
        addLog('处理Cookie弹窗时出错:' + e.message);
    }
}

/**
 * 等待搜索结果
 */
async function waitForSearchResults(page) {
    try {
        await page.waitForSelector("[data-ta='summary-record-title-link']", { timeout: 10000 });
        addLog('搜索结果加载完成');
    } catch (e) {
        addLog('等待搜索结果超时');
    }
}

/**
 * 从HTML中提取所有高亮词
 * @param {string} html 结果项的HTML内容
 * @returns {string[]} 高亮词数组
 */
function extractHighlightedWords(html) {
    const highlightRegex = /<span class="highlight">(.*?)<\/span>/g;
    let matches = [];
    let match;
    while ((match = highlightRegex.exec(html)) !== null) {
        matches.push(match[1]);
    }
    return matches;
}

/**
 * 判断高亮词是否有意义（长度>2且不是停用词）
 * @param {string} highlighted 高亮词
 * @returns {boolean}
 */
function checkMeaningfulHighlight(highlighted) {
    const stopWords = ['the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'were', 'has', 'have', 'been', 'from', 'they', 'their', 'will', 'would', 'could', 'should'];
    if (!highlighted || highlighted.length < 2) return false;
    const lower = highlighted.toLowerCase();
    if (stopWords.includes(lower)) return false;
    return true;
}

/**
 * 检查高亮词是否与搜索词或标题相关
 * @param {string} search 搜索关键词
 * @param {string} title 论文标题
 * @param {string} highlighted 高亮词
 * @returns {boolean}
 */
function checkCorePhrase(search, title, highlighted) {
    if (!search || !highlighted) return false;
    const searchLower = search.toLowerCase();
    const titleLower = (title || '').toLowerCase();
    const highlightedLower = highlighted.toLowerCase();
    return searchLower.includes(highlightedLower) || titleLower.includes(highlightedLower);
}

/**
 * 判断单个结果是否为完整匹配
 * @param {Locator} resultLocator 结果项的Playwright定位器
 * @param {string} searchKeyword 搜索关键词
 * @returns {Promise<boolean>}
 */
async function isCompleteMatch(resultLocator, searchKeyword) {
    try {
        // 获取结果项的HTML
        const html = await resultLocator.innerHTML();
        const highlighted = extractHighlightedWords(html);
        if (highlighted.length === 0) return false;

        // 获取标题文本
        const titleElement = resultLocator.locator('a[data-ta="summary-record-title-link"]').first();
        const title = await titleElement.textContent() || '';

        // 检查高亮词的有效性和相关性
        let meaningfulCount = 0;
        for (const word of highlighted) {
            if (checkMeaningfulHighlight(word) && checkCorePhrase(searchKeyword, title, word)) {
                meaningfulCount++;
            }
        }
        return meaningfulCount > 0;
    } catch (e) {
        console.log(`判断完整匹配时出错: ${e.message}`);
        return false;
    }
}

/**
 * 检查搜索结果中是否存在完整匹配
 * @param {Page} page Playwright页面对象
 * @param {string} searchKeyword 搜索关键词
 * @returns {Promise<boolean>}
 */
async function hasCompleteMatchResults(page, searchKeyword) {
    try {
        // 等待结果列表出现
        await page.waitForSelector("[data-ta='summary-record-title-link']", { timeout: 10000 });
    } catch (e) {
        return false;
    }

    const results = page.locator("[data-ta='summary-record']");
    const count = await results.count();
    // 只检查前5个结果以提高效率
    for (let i = 0; i < Math.min(count, 5); i++) {
        const result = results.nth(i);
        if (await isCompleteMatch(result, searchKeyword)) {
            return true;
        }
    }
    return false;
}
/**
 * 处理单个关键词
 */
async function processKeyword(page, keyword) {
    let isRecruit = false;
    let accessionNo = '';
    let indexedDate = '';

    try {
        addLog(`\n开始处理: ${keyword}`);
        await handleCookieConsent(page);

        const loadInput = page.locator('#composeQuerySmartSearch');
        await loadInput.fill(keyword);
        addLog('已填写搜索内容');

        await handleCookieConsent(page);

        const searchButton = await getSearchButton(page);
        if (!(await searchButton.isEnabled())) {
            addLog('搜索按钮不可用，跳过');
            return { isRecruit: 'false', accessionNo, title: keyword, searchTime: formatDateTime(new Date()) };
        }
        await searchButton.click();
        addLog('搜索按钮点击成功');

        await handleCookieConsent(page);
        await page.waitForLoadState('networkidle');
        addLog('搜索完成');

        await page.waitForTimeout(4000);
        await handleCookieConsent(page);

        // 直接查找结果链接
        const resultLinks = page.locator("[data-ta='summary-record-title-link']");
        const linkCount = await resultLinks.count();
        if (linkCount > 0) {
            addLog(`找到 ${linkCount} 个结果，点击第一个`);
            await resultLinks.first().click();
            await page.waitForLoadState('networkidle');

            // 点击展开详细信息按钮（如果存在）
            const spreadOut = page.locator("[data-ta='HiddenSecTa-showMoreDataButton']");
            if (await spreadOut.isVisible()) {
                await spreadOut.click();
                await page.waitForTimeout(1000); // 等待内容展开
            }

            // 尝试获取入藏号
            const accessionNoElement = page.locator("[data-ta='HiddenSecTa-accessionNo']");
            if (await accessionNoElement.count() > 0) {
                accessionNo = await accessionNoElement.first().textContent();
                accessionNo = accessionNo.trim();
                isRecruit = true;
                addLog(`是否收录: true, 入藏号: ${accessionNo}`);
            } else {
                addLog('是否收录: false, 未找到入藏号');
                accessionNo = '无';
            }

            // 提取 Indexed 日期
            try {
                // 等待 Indexed 日期元素出现（最多等待 10 秒）
                await page.waitForSelector('span[name="indexedDate"]', { timeout: 10000 });
                const indexedElement = page.locator('span[name="indexedDate"]').first();
                indexedDate = await indexedElement.textContent();
                indexedDate = indexedDate.trim();
                addLog(`Indexed 日期: ${indexedDate}`);
            } catch (err) {
                addLog(`使用 name 选择器提取 Indexed 日期失败: ${err.message}`);
                // 尝试备用选择器
                try {
                    await page.waitForSelector('[data-ta="FullRTa-indexedDate"]', { timeout: 5000 });
                    const altElement = page.locator('[data-ta="FullRTa-indexedDate"]').first();
                    indexedDate = await altElement.textContent();
                    indexedDate = indexedDate.trim();
                    addLog(`使用备用选择器找到 Indexed 日期: ${indexedDate}`);
                } catch (e) {
                    addLog(`备用选择器也未找到 Indexed 日期: ${e.message}`);
                }
            }

            // 返回搜索结果页
            await page.goBack();
            await page.waitForLoadState('networkidle');
        } else {
            addLog('未找到任何结果链接');
            accessionNo = '无';
        }
    } catch (e) {
        addLog(`处理关键词出错: ${e.message}`);
    }

    return {
        isRecruit: String(isRecruit),
        accessionNo,
        title: keyword,
        searchTime: formatDateTime(new Date()),
        indexedDate: indexedDate || ''
    };
}

/**
 * 批量检索
 */
async function batchSearchPapers(page, keywords) {
    const results = [];
    for (let i = 0; i < keywords.length; i++) {
        if (shouldStop) {
            addLog('⏹️ 收到停止信号，停止批量检索');
            break;
        }
        const keyword = keywords[i];
        addLog(`\n开始检索第 ${i + 1}/${keywords.length} 篇`);
        const result = await processKeyword(page, keyword);
        results.push(result);
        crawlerState.progress = Math.round(((i + 1) / keywords.length) * 100);
        if (i < keywords.length - 1) {
            const waitTime = 5000 + Math.random() * 3000;
            addLog(`等待 ${Math.round(waitTime / 1000)} 秒...`);
            await page.waitForTimeout(waitTime);
        }
    }
    return results;
}

/**
 * 写入 Excel 文件
 */
async function writeToExcel(newDataList, outputDir) {
    let filePath;
    try {
        // 在输出目录下创建 data 子目录
        const dataDir = path.join(outputDir, 'data');
        ensureDir(dataDir);
        const now = new Date();
        const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
        const fileName = `WOS-${timestamp}.xlsx`;
        filePath = path.join(CONFIG.OUTPUT_DIR, fileName);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('web of science');
        const columnConfig = [
            { key: 'isRecruit', header: '是否收录', width: 10 },
            { key: 'accessionNo', header: '入藏号', width: 20 },
            { key: 'title', header: '论文标题', width: 80 },
            { key: 'searchTime', header: '检索时间', width: 20 },
            { key: 'indexedDate', header: 'Indexed日期', width: 15 }
        ];
        worksheet.columns = columnConfig.map(item => ({ header: item.header, key: item.key, width: item.width }));

        newDataList.forEach(item => worksheet.addRow(item));
        await workbook.xlsx.writeFile(filePath);
        addLog(`数据写入成功，文件：${filePath}，共 ${newDataList.length} 条记录`);
    } catch (e) {
        addLog('写入失败:' + e.message);
    }
    return filePath;
}

/**
 * 启动浏览器
 */
async function launchBrowser() {
    // cleanupAllChromiumData((msg) => addLog(msg));

    const browserPath = await ensureBrowser((msg) => addLog(msg));
    if (!browserPath) {
        throw new Error('未找到/下载浏览器，无法继续');
    }
    const browser = await chromium.launch({
        executablePath: browserPath,  // 指定浏览器路径
        headless: false,
        args: ['--disable-popup-blocking']
    });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        timezoneId: 'America/New_York'
    });
    const page = await context.newPage();

    await page.addInitScript(function() {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        delete navigator.__proto__.webdriver;
        window.chrome = { runtime: {} };
    });
    return { browser, context, page };
}

//  主函数
/**
 * 启动 WoS 爬虫
 * @param {string[]} keywords
 * @param {Object} callbacks
 * @param {Function} callbacks.onCaptchaRequired
 * @param {Function} callbacks.onManualModeRequired
 */
async function crawlWos(keywords, callbacks = {}) {
    const { onCaptchaRequired, onManualModeRequired, generateExcel = true, captchaDir, outputDir } = callbacks;
    resetCrawlerState();
    crawlerState.isRunning = true;
    shouldStop = false;

    // 创建独立日志文件
    const logBaseDir = userConfig.LOG_BASE_DIR || path.join(process.cwd(), 'logs');
    ensureDir(logBaseDir);
    const timestamp = new Date().toISOString().replace(/[-:\.T]/g, '').slice(0, 15);
    const logFilePath = path.join(logBaseDir, `wos_${timestamp}.log`);
    logStream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });

    // 自定义输出目录的处理
    let baseOutputDir;
    if (outputDir && outputDir.trim() !== '') {
        baseOutputDir = outputDir;
        addLog(`使用自定义输出目录: ${baseOutputDir}`);
    } else {
        baseOutputDir = CONFIG.OUTPUT_DIR;
        addLog(`使用默认输出目录: ${baseOutputDir}`);
    }
    ensureDir(baseOutputDir);   // 确保目录存在


    const currentOutputDir = path.join(baseOutputDir, timestamp);   // 带时间戳的子目录
    ensureDir(currentOutputDir);

    // 处理输入参数，如果是论文对象数组则转换为关键词数组
    if (Array.isArray(keywords) && keywords.length > 0) {
        // 判断是否为对象数组（包含 title 字段）
        if (typeof keywords[0] === 'object' && keywords[0] !== null && ('title' in keywords[0] || 'authors' in keywords[0])) {
            const converted = keywords.map(paper => {
                const author = paper.authors || '';
                const title = paper.title || '';
                if (title) {
                    return title;
                } else {
                    return '';
                }
            }).filter(kw => kw);
            addLog(`检测到论文对象数组，转换为关键词数组，共 ${converted.length} 个`);
            keywords = converted; // 重新赋值
        } else if (typeof keywords[0] === 'string') {
            // 已经是字符串数组，无需处理
            addLog(`直接使用字符串关键词数组，共 ${keywords.length} 个`);
        } else {
            throw new Error('无效的输入格式');
        }
    } else {
        throw new Error('关键词列表不能为空');
    }

    let browser = null;
    let context = null;
    let page = null;
    let wosPage = null;
    let results = [];
    let filePath = null;

    try {
        ({ browser, context, page } = await launchBrowser());

        await page.goto(CONFIG.BASE_URL, { waitUntil: 'domcontentloaded' });
        addLog('页面标签: ' + await page.title());

        if (shouldStop) throw new Error('用户停止');

        // 使用公共登录函数
        await academicCatLogin(
            page,
            CONFIG,
            onCaptchaRequired,
            addLog,
            (action, captchaId, imagePath) => {
                if (action === 'start') {
                    crawlerState.waitingForCaptcha = true;
                    crawlerState.captchaId = captchaId;
                    // crawlerState.captchaImagePath = imagePath;
                    const taskId = path.basename(captchaDir);
                    const fileName = path.basename(imagePath);
                    crawlerState.captchaImagePath = `http://localhost:3000/captcha/${taskId}/${fileName}`;
                } else {
                    crawlerState.waitingForCaptcha = false;
                    crawlerState.captchaId = null;
                    crawlerState.captchaImagePath = null;
                }
            },
            isStopRequested,
            captchaDir
        );

        if (shouldStop) throw new Error('用户停止');

        // 定义目标信息
        const target = {
            text: '(SCI)Web of Science',
            filterPattern: 'sci',   // 用于过滤镜像链接的关键字
            checkReady: isWosPage
        };
        wosPage = await academicCatNavigateToTarget(
            page,
            context,
            CONFIG,
            target,
            onManualModeRequired,
            addLog,
            isStopRequested,
            (active) => {
                crawlerState.manualModeActive = active;
            }
        );

        if (shouldStop) throw new Error('用户停止');

        results = await batchSearchPapers(wosPage, keywords);


        if (!shouldStop && results.length > 0) {
            if (generateExcel) {
                filePath = await writeToExcel(results, currentOutputDir);
                addLog(`✅ 爬取完成，结果文件：${filePath}`);
            } else {
                addLog('✅ 爬取完成，未生成Excel文件');
            }
            crawlerState.result = results;
            crawlerState.filePaths = generateExcel ? [filePath] : [];
        } else {
            addLog('⏹️ 爬虫已停止或未产生结果，未生成文件');
        }
        return { results, filePath };
    } catch (error) {
        // 截图
        let screenshotPath = null;
        if (page && !page.isClosed()) {
            screenshotPath = await takeErrorScreenshot(page, 'google');
        }
        // 将截图路径附加到错误对象
        error.screenshotPath = screenshotPath;
        // 错误处理
        crawlerState.isRunning = false;
        // 使用工具类格式化错误
        const formattedError = formatError(error, 'wos');
        crawlerState.error = formattedError;
        // 将原始详细信息写入日志
        addLog('info', formattedError.detail);
        addLog('error', `用户提示：${formattedError.userMessage}`);
        // 抛出自定义错误
        throw formattedError;
    } finally {
        if (logStream) {
            logStream.end();
            logStream = null;
        }
        if (browser) await browser.close();
        crawlerState.isRunning = false;
        crawlerState.waitingForCaptcha = false;
        crawlerState.manualModeActive = false;
        // 清理任务自己的验证码目录
        if (captchaDir && fs.existsSync(captchaDir)) {
            try {
                fs.rmSync(captchaDir, { recursive: true, force: true });
                addLog(`已清理任务验证码目录: ${captchaDir}`);
            } catch (err) {
                addLog(`清理验证码目录失败: ${err.message}`);
            }
        }
    }
}

//  导出
module.exports = {
    crawlWos,
    getCrawlerState,
    resetCrawlerState,
    stopCrawler,
    CONFIG
};
