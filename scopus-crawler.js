// scopus-crawler.js
const { chromium } = require('playwright');
const ExcelJS = require('exceljs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const excel = require('excel4node');
let logStream = null; // 用于写入日志文件
const {takeErrorScreenshot} = require("./crawler-utils");
const {
    humanClick,
    humanType,
    randomDelay,
    formatDateTime,
    ensureDir,
    ensureBrowser,
    cleanupAllChromiumData
} = require('./crawler-utils');
const {
    academicCatLogin,
    academicCatNavigateToTarget
} = require('./academic-cat-utils');
const {formatError} = require("./error-utils");

const isStopRequested = () => shouldStop;

//  配置读取
const DEFAULT_CONFIG = {
    USER_NAME: '28199134',
    PASSWORD: '460256',
    BASE_URL: 'https://www.2447.net/',
    OUTPUT_DIR_NAME: 'output/scopus',
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
const scopusConfig = userConfig.scopus || {};
const merged = { ...DEFAULT_CONFIG, ...scopusConfig };

const baseDir = process.cwd();
const CONFIG = {
    USER_NAME: merged.USER_NAME,
    PASSWORD: merged.PASSWORD,
    BASE_URL: merged.BASE_URL,
    OUTPUT_DIR: path.join(baseDir, merged.OUTPUT_DIR_NAME),
    CAPTCHA_DIR: path.join(baseDir, merged.CAPTCHA_DIR_NAME),
    // SCREENSHOT_DIR: path.join(baseDir, merged.SCREENSHOT_DIR_NAME)
};

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

//  Scopus

/**
 * 等待 Scopus 页面就绪（检测输入框或搜索按钮）
 */
async function waitForScopusReady(page, timeout = 30000) {
    const startTime = Date.now();
    const checkInterval = 1000;

    const inputSelectors = [
        'label:has(span:text("Search documents")) input.styleguide-input_input__b0U41',
        'label:has-text("Search documents") input[class*="styleguide-input_input"]',
        'input[id^="autosuggest-"][id$="-input"][class*="styleguide-input_input"]',
        'input[placeholder*="Search"]',
        'input[aria-label*="Search"]'
    ];
    const buttonSelectors = [
        'button[type="submit"]:has-text("Search")',
        'button:has-text("Search")',
        'button.Button_button__9XFW1'
    ];

    while (Date.now() - startTime < timeout) {
        if (shouldStop) {
            addLog('⏹️ 检测到停止信号，退出页面等待');
            return false;
        }
        for (const selector of inputSelectors) {
            try {
                const locator = page.locator(selector).first();
                if (await locator.isVisible({ timeout: 500 }).catch(() => false)) {
                    addLog('检测到 Scopus 搜索输入框');
                    return true;
                }
            } catch (e) {}
        }
        for (const selector of buttonSelectors) {
            try {
                const locator = page.locator(selector).first();
                if (await locator.isVisible({ timeout: 500 }).catch(() => false)) {
                    addLog('检测到 Scopus 搜索按钮');
                    return true;
                }
            } catch (e) {}
        }
        await page.waitForTimeout(checkInterval);
    }
    addLog('等待 Scopus 页面超时，未检测到关键元素');
    return false;
}

/**
 * 检索单篇论文
 */
async function searchSinglePaper(latestPage, searchKeyWords) {
    let paperData = null;
    let isRecruit = false;

    try {
        await latestPage.waitForLoadState('domcontentloaded', { timeout: 120000 });
        addLog(`【${searchKeyWords}】页面DOM加载完成，开始查找输入框`);

        // 定位输入框
        const inputLocators = [
            latestPage.locator('label:has(span:text("Search documents")) input.styleguide-input_input__b0U41'),
            latestPage.locator('label:has-text("Search documents") input[class*="styleguide-input_input"]'),
            latestPage.locator('input[id^="autosuggest-"][id$="-input"][class*="styleguide-input_input"]')
        ];
        let inputElement = null;
        for (const locator of inputLocators) {
            try {
                await locator.waitFor({ state: 'visible', timeout: 8000 });
                inputElement = locator;
                addLog(`【${searchKeyWords}】找到Search documents输入框`);
                break;
            } catch (e) { /* 继续尝试下一个 */ }
        }
        if (!inputElement) throw new Error('未找到Search documents输入框');

        await humanType(latestPage, inputElement, searchKeyWords);
        addLog(`【${searchKeyWords}】输入框已填充检索内容`);

        // 定位搜索按钮
        const buttonLocators = [
            latestPage.locator('button[type="submit"].Button_button__9XFW1:has-text("Search")'),
            latestPage.locator('button[type="submit"]:has(span:text("Search"))'),
            latestPage.locator('button:visible:has-text("Search")')
        ];
        let submitButton = null;
        for (const locator of buttonLocators) {
            try {
                await locator.waitFor({ state: 'visible', timeout: 8000 });
                submitButton = locator;
                addLog(`【${searchKeyWords}】找到Search按钮`);
                break;
            } catch (e) { /* 继续尝试 */ }
        }
        if (!submitButton) throw new Error('未找到Search按钮');

        if (shouldStop) {
            addLog('⏹️ 收到停止信号，跳过当前论文');
            return null;
        }

        // 点击按钮
        let clickSuccess = false;
        for (let i = 0; i < 3; i++) {
            try {
                await humanClick(latestPage, submitButton);
                clickSuccess = true;
                addLog(`【${searchKeyWords}】Search按钮点击成功（第${i+1}次尝试）`);
                break;
            } catch (e) {
                addLog(`【${searchKeyWords}】第${i+1}次点击按钮失败：${e.message}`);
                await latestPage.waitForTimeout(500);
            }
        }
        if (!clickSuccess) throw new Error('多次点击Search按钮失败');

        await latestPage.waitForLoadState('domcontentloaded', { timeout: 10000 });
        await latestPage.waitForTimeout(3000);

        // 判断是否有检索结果
        const titleKeyword = searchKeyWords.substring(0, 50);
        const allElements = latestPage.locator(`span:has-text("${titleKeyword}")`);
        let hasResults = false;
        try {
            await allElements.first().waitFor({ state: 'visible', timeout: 8000 });
            hasResults = true;
        } catch (e) { /* 无结果 */ }

        if (!hasResults) {
            addLog(`【${searchKeyWords}】未搜索到结果\n`);
            paperData = {
                eid: '无',
                isRecruit: 'false',
                title: searchKeyWords,
                searchTime: formatDateTime(new Date()),
                doi: '',
                pubDate: ''
            };
            await latestPage.goBack();
            await latestPage.waitForLoadState('domcontentloaded');
        } else {
            const count = await allElements.count();
            addLog(`【${searchKeyWords}】找到 ${count} 个匹配结果`);

            if (count > 0) {
                await humanClick(latestPage, allElements.first());
                isRecruit = true;

                const showAll = latestPage.locator('text=Show all information');
                await showAll.waitFor({ state: 'visible', timeout: 100000 });
                await humanClick(latestPage, showAll);

                const EID = latestPage.locator('dd[data-testid="document-info-eid"]');
                await EID.waitFor({ state: 'visible', timeout: 100000 });
                const eid = await EID.textContent();


                let doi = '';
                try {
                    const doiElement = latestPage.locator('dd[data-testid="document-info-doi"]');
                    if (await doiElement.count() > 0) {
                        doi = await doiElement.first().textContent();
                        doi = doi.trim();
                    }
                } catch (e) {
                    addLog(`【${searchKeyWords}】获取 DOI 失败: ${e.message}`);
                }

                // 获取 Publication date
                let pubDate = '';
                try {
                    const dateElement = latestPage.locator('dd[data-testid="document-info-publication-date"]');
                    if (await dateElement.count() > 0) {
                        pubDate = await dateElement.first().textContent();
                        pubDate = pubDate.trim();
                    }
                } catch (e) {
                    addLog(`【${searchKeyWords}】获取 Publication date 失败: ${e.message}`);
                }

                addLog(`【${searchKeyWords}】EID: ${eid.trim()}, DOI: ${doi}, Publication date: ${pubDate}\n`);

                paperData = {
                    eid: eid.trim(),
                    isRecruit: String(isRecruit),
                    title: searchKeyWords,
                    searchTime: formatDateTime(new Date()),
                    doi: doi,
                    pubDate: pubDate
                };

                await latestPage.evaluate(() => window.history.go(-2));
                await latestPage.waitForLoadState('domcontentloaded');
            } else {
                addLog(`【${searchKeyWords}】未搜索到结果`);
                paperData = {
                    eid: '无',
                    isRecruit: String(isRecruit),
                    title: searchKeyWords,
                    searchTime: formatDateTime(new Date()),
                    doi: '',
                    pubDate: ''
                };
                await latestPage.goBack();
                await latestPage.waitForLoadState('domcontentloaded');
            }
        }
    } catch (e) {
        addLog(`【${searchKeyWords}】搜索错误: ${e.message}`);
        // 无结果时
        paperData = {
            eid: '无',
            isRecruit: 'false',
            title: searchKeyWords,
            searchTime: formatDateTime(new Date()),
            doi: '',
            pubDate: ''
        };
    }
    return paperData;
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
        addLog(`\n开始检索第 ${i+1}/${keywords.length} 篇：${keyword.substring(0,50)}...`);
        const paperData = await searchSinglePaper(page, keyword);
        if (paperData) results.push(paperData);
        crawlerState.progress = Math.round(((i+1) / keywords.length) * 100);
        if (i < keywords.length - 1) {
            const waitTime = 5000 + Math.random() * 3000;
            addLog(`等待 ${Math.round(waitTime/1000)} 秒...`);
            await page.waitForTimeout(waitTime);
        }
    }
    return results;
}

/**
 * 写入 Excel 文件
 */
async function writeToExcel(newDataList, outputDir) {
    const dataDir = path.join(outputDir, 'data');
    ensureDir(dataDir);

    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}-${String(now.getSeconds()).padStart(2,'0')}`;
    const fileName = `SCOPUS-${timestamp}.xlsx`;
    const filePath = path.join(dataDir, fileName);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('scopus');
    worksheet.columns = [
        { key: 'eid', header: 'EID', width: 30 },
        { key: 'isRecruit', header: '是否收录', width: 10 },
        { key: 'title', header: '论文标题', width: 80 },
        { key: 'searchTime', header: '检索时间', width: 20 },
        { key: 'doi', header: 'DOI', width: 40 },
        { key: 'pubDate', header: '出版日期', width: 15 }
    ];

    newDataList.forEach(item => {
        worksheet.addRow({
            eid: item.eid,
            isRecruit: item.isRecruit,
            title: item.title,
            searchTime: item.searchTime,
            doi: item.doi || '',
            pubDate: item.pubDate || ''
        });
    });

    await workbook.xlsx.writeFile(filePath);
    addLog(`数据写入成功，文件：${filePath}，共 ${newDataList.length} 条记录`);
    return filePath;
}

//  主函数
/**
 * 启动 Scopus 爬虫
 */
async function crawlScopus(keywords, callbacks = {}) {
    const { onCaptchaRequired, onManualModeRequired, generateExcel = true, captchaDir, outputDir } = callbacks;
    resetCrawlerState();
    crawlerState.isRunning = true;
    shouldStop = false;

    // 创建独立日志文件
    const logBaseDir = userConfig.LOG_BASE_DIR || path.join(process.cwd(), 'logs');
    ensureDir(logBaseDir);
    const timestamp = new Date().toISOString().replace(/[-:\.T]/g, '').slice(0, 15);
    const logFilePath = path.join(logBaseDir, `scopus_${timestamp}.log`);
    logStream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });

    // 处理自定义输出目录
    let baseOutputDir;
    if (outputDir && outputDir.trim() !== '') {
        baseOutputDir = outputDir;
        addLog(`使用自定义输出目录: ${baseOutputDir}`);
    } else {
        baseOutputDir = CONFIG.OUTPUT_DIR;
        addLog(`使用默认输出目录: ${baseOutputDir}`);
    }
    ensureDir(baseOutputDir);



    const currentOutputDir = path.join(baseOutputDir, timestamp);
    ensureDir(currentOutputDir);

    // 处理输入参数，如果是论文对象数组则转换为关键词数组
    if (Array.isArray(keywords) && keywords.length > 0) {
        // 判断是否为对象数组
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

    // 清理残留进程并确保浏览器可用
    // cleanupAllChromiumData((msg) => addLog(msg));
    const browserPath = await ensureBrowser((msg) => addLog(msg));
    if (!browserPath) {
        throw new Error('未找到/下载浏览器，无法继续');
    }

    let context = null;
    let page = null;
    let scopusPage = null;
    let results = [];
    let filePath = null;

    try {
        context = await chromium.launchPersistentContext('', {
            executablePath: browserPath,  // 指定浏览器路径
            headless: false,
            viewport: { width: 1800, height: 960 },
            args: [
                '--disable-popup-blocking',
                '--ignore-certificate-errors', // 忽略证书错误
                '--ignore-ssl-errors',         // 忽略SSL错误
                '--allow-insecure-localhost',  // 允许不安全的本地主机
                '--disable-web-security'       // 禁用网页安全策略
            ],
            ignoreHTTPSErrors: true, // 忽略HTTPS证书错误
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            locale: 'en-US',
            timezoneId: 'America/New_York'
        });
        page = context.pages()[0];

        await page.addInitScript(function() {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
        });
        await page.goto(CONFIG.BASE_URL, { waitUntil: 'domcontentloaded' });
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

                    const taskId = imagePath.split(path.sep).slice(-2, -1)[0]; // 提取任务目录名
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
            text: 'SCOPUS文摘',
            filterPattern: 'scopus', // 用于过滤镜像链接的关键字
            checkReady: waitForScopusReady
        };
        scopusPage  = await academicCatNavigateToTarget(
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

        results = await batchSearchPapers(scopusPage, keywords);
        if (!shouldStop && results.length > 0) {
            if (generateExcel) {
                filePath = await writeToExcel(results,currentOutputDir);
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
        const formattedError = formatError(error, 'scopus');
        crawlerState.error = formattedError;
        // 将原始详细信息写入日志
        addLog('error', formattedError.detail);
        addLog('info', `用户提示：${formattedError.userMessage}`);
        // 抛出自定义错误
        throw formattedError;
    } finally {
        if (logStream) {
            logStream.end();
            logStream = null;
        }
        if (context) await context.close();
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
    crawlScopus,
    getCrawlerState,
    resetCrawlerState,
    stopCrawler,
    CONFIG
};
