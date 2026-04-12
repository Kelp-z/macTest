// google-scholar-author-crawler.js
const {chromium} = require('playwright');
const excel = require('excel4node');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const {
    humanClick,
    humanType,
    randomDelay,
    formatDateTime,
    ensureDir
} = require('./crawler-utils');
const {formatError} = require("./error-utils");
const {takeErrorScreenshot} = require("./crawler-utils");
//  配置读取
const DEFAULT_CONFIG = {
    OUTPUT_BASE_DIR_NAME: 'output/google_authors'
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
const googleAuthorConfig = userConfig.googleScholarAuthor || {};
const merged = {...DEFAULT_CONFIG, ...googleAuthorConfig};
const OUTPUT_BASE_DIR = path.join(process.cwd(), merged.OUTPUT_BASE_DIR_NAME);

//  全局状态
let crawlerState = {
    isRunning: false,
    progress: 0,
    logs: [],
    result: [],               // 存储 AuthorInfo 对象数组
    filePaths: {resultExcel: ''},
    error: null,
    currentDir: '',
    logIndex: 0
};

// 内部全局变量
let authorResultList = [];
let browserInstance = null;
let currentUserDataDir = null;
let currentOutputDir = null;
let logStream = null;
let shouldStop = false;

//  内部日志函数
function addLog(type, content) {
    const log = {
        time: new Date().toLocaleTimeString(),
        type,
        content
    };
    crawlerState.logs.push(log);
    if (crawlerState.logs.length > 1000) crawlerState.logs = crawlerState.logs.slice(-500);
    const logLine = `[${log.time}] [${log.type}] ${log.content}`;
    console.log(logLine);
    if (logStream && logStream.writable) {
        logStream.write(logLine + '\n');
    }
}

//  状态管理导出函数
function resetCrawlerState() {
    crawlerState = {
        isRunning: false,
        progress: 0,
        logs: [],
        result: [],
        filePaths: {resultExcel: ''},
        error: null,
        currentDir: '',
        logIndex: 0
    };
    authorResultList = [];
    currentUserDataDir = null;
    currentOutputDir = null;
    shouldStop = false;
}

function getCrawlerState() {
    return {...crawlerState};
}

async function stopCrawler() {
    addLog('info', '开始停止谷歌学术作者检索任务...');
    shouldStop = true;
    crawlerState.isRunning = false;
    if (browserInstance) {
        try {
            await browserInstance.close();
            addLog('info', '浏览器实例已关闭');
        } catch (e) {
            addLog('info', `关闭浏览器失败：${e.message}`);
            if (process.platform === 'win32') {
                try {
                    require('child_process').execSync('taskkill /F /IM chrome.exe /T 2>nul');
                    require('child_process').execSync('taskkill /F /IM chromium.exe /T 2>nul');
                } catch (err) {
                }
            }
        } finally {
            browserInstance = null;
        }
    }
    if (currentUserDataDir) {
        try {
            fs.rmSync(currentUserDataDir, {recursive: true, force: true});
            addLog('info', `已清理临时目录：${currentUserDataDir}`);
        } catch (e) {
            addLog('info', `清理临时目录失败：${e.message}`);
        }
    }
    addLog('info', '谷歌学术作者检索任务已停止');
}

//  内部辅助函数
async function checkForCaptcha(page) {
    const captchaSelectors = [
        '#captcha-form',
        'form[action*="captcha"]',
        '.g-recaptcha',
        'iframe[src*="recaptcha"]',
        '.rc-anchor',
        'div[class*="captcha"]',
        'div:has-text("请进行人机身份验证")',
        'div:has-text("检测到异常流量")',
        'div:has-text("unusual traffic")'
    ];
    for (const selector of captchaSelectors) {
        try {
            const element = await page.$(selector);
            if (element && await element.isVisible()) return true;
        } catch (error) {
        }
    }
    const url = page.url();
    const captchaKeywords = ['sorry', 'captcha', 'recaptcha'];
    if (captchaKeywords.some(keyword => url.toLowerCase().includes(keyword))) return true;
    const pageContent = await page.content();
    const contentKeywords = ['请进行人机身份验证', '检测到异常流量', 'unusual traffic', 'automated requests'];
    return contentKeywords.some(keyword => pageContent.toLowerCase().includes(keyword.toLowerCase()));
}

//统一验证码检查和处理函数
async function checkAndHandleCaptcha(page, context = '') {
    if (await checkForCaptcha(page)) {
        addLog('info', `${context} 检测到人机验证，正在等待手动处理...`);
        await handleCaptchaManually(page);
        addLog('info', `${context} 人机验证已处理完成`);
        return true;
    }
    return false;
}
async function handleCaptchaManually(page) {
    addLog('warn', '================');
    addLog('warn', '⚠️  检测到人机身份验证！');
    addLog('warn', '📌 请在弹出的浏览器窗口中手动完成验证');
    addLog('warn', '📌 完成后脚本会自动继续运行');
    addLog('warn', '================\n');
    await page.bringToFront();
    // 保存截图（开发阶段）
    // ensureDir(path.join(currentOutputDir, 'screenshots'));
    // await page.screenshot({path: path.join(currentOutputDir, 'screenshots', `captcha_detected_${Date.now()}.png`)});

    let captchaResolved = false;
    let waitTime = 0;
    const maxWaitTime = 600000;
    const checkInterval = 5000;

    while (!captchaResolved && waitTime < maxWaitTime) {
        await page.waitForTimeout(checkInterval);
        waitTime += checkInterval;
        const minutes = Math.floor(waitTime / 60000);
        const seconds = Math.floor((waitTime % 60000) / 1000);
        addLog('info', `⏳ 已等待 ${minutes}分${seconds}秒...`);

        const stillHasCaptcha = await checkForCaptcha(page);
        if (!stillHasCaptcha) {
            try {
                // 简单检查页面是否恢复正常（存在搜索框或结果）
                const searchInput = await page.$('input[name="q"]');
                if (searchInput) {
                    captchaResolved = true;
                    addLog('info', '\n✅ 验证已完成，继续爬取数据...\n');
                    break;
                }
            } catch (error) {
                captchaResolved = true;
                addLog('info', '\n✅ 页面已恢复正常，继续爬取数据...\n');
                break;
            }
        }
        if (waitTime % 30000 === 0) {
            addLog('info', '\n💡 提示: 请确保在浏览器窗口中完成人机验证');
            addLog('info', '   如果已完成验证但脚本仍在等待，请刷新页面或重新完成验证\n');
            await page.bringToFront();
        }
    }
    if (!captchaResolved) {
        addLog('info', '\n❌ 等待验证超时（10分钟），请重新运行脚本并及时完成验证');
        throw new Error('人机验证处理超时');
    }
    await page.waitForTimeout(3000);
}

//  作者信息类
class AuthorInfo {
    constructor(searchKeyword, authorName, totalHIndex, recentHIndex, profileUrl,institution,emailVerified) {
        this.searchKeyword = searchKeyword;   // 搜索时使用的关键词
        this.authorName = authorName;         // 作者姓名（从档案页获取）
        this.totalHIndex = totalHIndex;       // 总计h指数
        this.recentHIndex = recentHIndex;     // 近期h指数
        this.profileUrl = profileUrl;         // 个人档案完整URL
        this.institution = institution;           // 机构名称
        this.emailVerified = emailVerified;       // 电子邮件验证信息（如 "在 ohsu.edu 的电子邮件经过验证"）
        this.searchTime = formatDateTime(new Date());
    }
}

//  生成作者搜索关键词（格式：author:"作者姓名"）
function generateAuthorSearchKeyword(authorName) {
    // 清理作者姓名中的多余引号，并用双引号包裹
    let cleanAuthor = authorName.replace(/["']/g, '').trim();
    console.log("搜索关键词："+`author:"${cleanAuthor}"`)
    return `author:"${cleanAuthor}"`;
}




// 在搜索结果页查找所有作者档案链接（精确限定在作者列表表格内）
async function findAllAuthorProfileLinks(page) {
    try {
        await page.waitForSelector('body', { timeout: 10000 });
        await randomDelay(page);

        // 定位包含作者列表的表格（位于带有“用户个人学术档案”标题的div内）
        const authorTable = await page.$('div.gs_r table');
        if (!authorTable) {
            addLog('warn', '未找到作者列表表格');
            return [];
        }

        // 在该表格内查找所有指向作者档案的链接
        const linkElements = await authorTable.$$('a[href*="/citations?user="]');
        const links = [];
        for (const link of linkElements) {
            const href = await link.getAttribute('href');
            if (href) {
                const fullUrl = href.startsWith('http') ? href : `https://scholar.google.com${href}`;
                links.push({ url: fullUrl }); // 只存储 url，不再存储 link 句柄
            }
        }
        if (links.length > 0) {
            addLog('info', `找到 ${links.length} 个作者档案链接`);
            return links;
        }
        addLog('warn', '在表格内未找到包含 user= 的链接');
        return [];
    } catch (e) {
        addLog('error', `查找作者档案链接时出错: ${e.message}`);
        return [];
    }
}


// 处理单个作者档案页（传入 URL，处理完毕后返回搜索结果页）
async function processSingleAuthor(page, authorUrl, searchKeyword) {
    addLog('info', `处理作者档案: ${authorUrl}`);

    // 从 URL 中提取 user ID
    const urlObj = new URL(authorUrl);
    const userIdMatch = urlObj.search.match(/[?&]user=([^&]+)/);
    if (!userIdMatch) {
        throw new Error(`无法从 URL 中提取 user ID: ${authorUrl}`);
    }
    const userId = userIdMatch[1];

    // 在搜索结果页上根据 user ID 定位链接元素
    const link = await page.$(`a[href*="/citations?user=${userId}"]`);
    if (!link) {
        throw new Error(`无法在页面上找到 user ID 为 ${userId} 的链接`);
    }

    // 获取 target 属性
    const targetAttr = await link.getAttribute('target');

    let targetPage = page;
    if (targetAttr === '_blank') {
        const [newPage] = await Promise.all([
            page.context().waitForEvent('page', { timeout: 10000 }),
            link.click()
        ]);
        targetPage = newPage;
        await targetPage.waitForLoadState('networkidle');
        await checkAndHandleCaptcha(targetPage, '作者档案页');
    } else {
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }),
            link.click()
        ]);
        targetPage = page;
        await checkAndHandleCaptcha(targetPage, '作者档案页');
    }

    // 提取作者信息
    const authorInfo = await extractAuthorInfoFromProfile(targetPage, authorUrl);

    // 如果是新打开的页面则关闭，并切换回原页面
    if (targetAttr === '_blank') {
        await targetPage.close();
        await page.bringToFront();
    } else {
        // 当前页面导航后，需要返回搜索结果页（点击浏览器后退）
        await page.goBack({ waitUntil: 'networkidle' });
        await checkAndHandleCaptcha(page, '返回搜索结果页');
    }

    // 创建 AuthorInfo 对象
    return new AuthorInfo(
        searchKeyword,
        authorInfo.authorName,
        authorInfo.totalHIndex,
        authorInfo.recentHIndex,
        authorUrl,
        authorInfo.institution,
        authorInfo.emailVerified
    );
}


// 处理单个作者关键词（搜索并处理所有匹配的作者）
async function processAuthorSearch(page, authorName) {
    let searchKeyword = generateAuthorSearchKeyword(authorName);
    // 清洗换行符
    const cleanKeyword = searchKeyword.replace(/[\r\n]+/g, '');
    searchKeyword = cleanKeyword;
    addLog('info', `开始检索作者: ${authorName}，关键词: ${searchKeyword}`);

    // 访问谷歌学术首页
    await page.goto('https://scholar.google.com', { timeout: 30000 });
    await randomDelay(page);


    await checkAndHandleCaptcha(page, '谷歌学术首页');

    // 输入搜索词
    // const searchInput = page.locator('input[name="q"]');
    // ID定位
    const searchInput = page.locator('#gs_hdr_tsi');
    await searchInput.waitFor({ state: 'visible', timeout: 10000 });
    await humanType(page, searchInput, searchKeyword);
    await randomDelay(page, 800, 2000);
    await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle');
    await randomDelay(page);

    await checkAndHandleCaptcha(page, '搜索后');

    // 获取所有作者链接
    const allLinks = await findAllAuthorProfileLinks(page);
    if (allLinks.length === 0) {
        addLog('warn', `未找到作者 ${authorName} 的个人学术档案链接`);
        authorResultList.push(new AuthorInfo(searchKeyword, authorName, '未找到', '未找到', '', '', ''));
        return;
    }

    // 遍历每个链接，处理作者档案
    for (let i = 0; i < allLinks.length; i++) {
        const linkInfo = allLinks[i];
        addLog('info', `处理第 ${i + 1}/${allLinks.length} 个作者档案`);
        // 只传递 url，不再传递 link 句柄
        const authorResult = await processSingleAuthor(page, linkInfo.url, searchKeyword);
        authorResultList.push(authorResult);
        addLog('info', `作者档案处理完成: ${authorResult.authorName}`);

        // 避免请求过快，每个作者之间稍作等待
        if (i < allLinks.length - 1) {
            const waitTime = 3000 + Math.random() * 3000;
            addLog('info', `等待 ${Math.round(waitTime / 1000)} 秒后继续下一个...`);
            await page.waitForTimeout(waitTime);
        }
        await checkAndHandleCaptcha(page, '等待中');
    }

    addLog('info', `关键词 ${authorName} 处理完成，共处理 ${allLinks.length} 个作者`);
}



// 从作者个人档案页面提取信息（姓名、总计h指数、近期h指数）
async function extractAuthorInfoFromProfile(page, profileUrl) {
    addLog('info', '开始从作者档案页提取信息...');
    let authorName = '';
    let totalHIndex = 'N/A';
    let recentHIndex = 'N/A';
    let institution = '';
    let emailVerified = '';
    try {
        // 等待表格出现（确保页面已加载）
        await page.waitForSelector('#gsc_rsb_st', {timeout: 10000});

        // 提取作者姓名
        const nameElement = await page.$('#gsc_prf_in');
        if (nameElement) {
            authorName = await nameElement.textContent();
            authorName = authorName ? authorName.trim() : '';
        }
        if (!authorName) {
            // 从图片 alt 获取
            const imgElement = await page.$('#gsc_prf_pup-img');
            if (imgElement) {
                authorName = await imgElement.getAttribute('alt');
                if (authorName) authorName = authorName.trim();
            }
        }
        addLog('info', `作者姓名: ${authorName || '未找到'}`);

        //  提取 h 指数（总计和近期）
        // 获取表格中的所有数据行（tbody > tr）
        const rows = await page.$$('#gsc_rsb_st tbody tr');
        if (rows.length < 2) {
            addLog('info', '表格行数不足，无法提取 h 指数');
        } else {
            // 尝试通过文本定位包含 "h指数" 或 "h-index" 的行
            let hIndexRow = null;
            for (const row of rows) {
                const labelCell = await row.$('td.gsc_rsb_sc1');
                if (!labelCell) continue;
                const labelText = await labelCell.textContent();
                if (!labelText) continue;
                // 兼容中文“h指数”和英文“h-index”（不区分大小写）
                if (labelText.includes('h 指数') || labelText.toLowerCase().includes('h-index')) {
                    hIndexRow = row;
                    break;
                }
            }

            // 如果未找到文本匹配的行，则默认取第二行
            if (!hIndexRow && rows.length >= 2) {
                addLog('info', '未通过文本匹配到 h 指数行，默认使用第二行');
                hIndexRow = rows[1]; // 索引从0开始，第二行是索引1
            }

            // 提取数值
            if (hIndexRow) {
                const valueCells = await hIndexRow.$$('td.gsc_rsb_std');
                if (valueCells.length >= 2) {
                    totalHIndex = await valueCells[0].textContent();
                    recentHIndex = await valueCells[1].textContent();
                    // 清理可能的空白字符
                    totalHIndex = totalHIndex ? totalHIndex.trim() : 'N/A';
                    recentHIndex = recentHIndex ? recentHIndex.trim() : 'N/A';
                } else {
                    addLog('info', 'h 指数行缺少数值单元格');
                }
            } else {
                addLog('info', '未能定位到 h 指数行');
            }
        }

        addLog('info', `总计 h 指数: ${totalHIndex}`);
        addLog('info', `近期 h 指数: ${recentHIndex}`);
// 提取机构名称

        const institutionElement = await page.$('div.gsc_prf_il a.gsc_prf_ila');
        if (institutionElement) {
            institution = await institutionElement.textContent();
            institution = institution ? institution.trim() : '';
        }
        addLog('info', `机构名称: ${institution || '未找到'}`);

// 提取电子邮件验证信息

        const emailElement = await page.$('#gsc_prf_ivh');
        if (emailElement) {
            emailVerified = await emailElement.textContent();
            emailVerified = emailVerified ? emailVerified.trim() : '';
        }
        addLog('info', `电子邮件验证: ${emailVerified || '未找到'}`);
    } catch (error) {
        addLog('info', `提取作者信息时出错: ${error.message}`);
    }

    return {
        authorName: authorName || '未知作者',
        totalHIndex,
        recentHIndex,
        institution: institution || '',
        emailVerified: emailVerified || ''
    };
}



async function processAuthors(page, authorNames) {
    for (let i = 0; i < authorNames.length; i++) {
        if (shouldStop || !crawlerState.isRunning) {
            addLog('info', '检测到停止信号，终止爬取');
            break;
        }

        const author = authorNames[i];
        addLog('info', `\n===== 处理第 ${i + 1}/${authorNames.length} 个关键词: ${author} =====`);
        crawlerState.progress = Math.round((i / authorNames.length) * 100);


        await processAuthorSearch(page, author);

        if (i < authorNames.length - 1) {
            const waitTime = 5000 + Math.random() * 5000;
            addLog('info', `等待 ${Math.round(waitTime / 1000)} 秒后继续下一个关键词...`);
            await page.waitForTimeout(waitTime);
        }
    }
}

//  写入 Excel 文件
function writeToExcel(dataList, filePath) {
    if (!dataList || dataList.length === 0) {
        addLog('info', '无数据可写入 Excel');
        return;
    }

    const workbook = new excel.Workbook();
    const worksheet = workbook.addWorksheet('作者信息');

    const headers = [
        '搜索关键词',
        '作者姓名',
        '总计h指数',
        '近期h指数',
        '作者档案链接',
        '检索时间',
        '机构名称',
        '电子邮件验证'
    ];
    headers.forEach((header, index) => {
        worksheet.cell(1, index + 1).string(header).style({font: {bold: true}});
    });

    dataList.forEach((item, rowIndex) => {
        const row = rowIndex + 2;
        worksheet.cell(row, 1).string(item.searchKeyword || '');
        worksheet.cell(row, 2).string(item.authorName || '');
        worksheet.cell(row, 3).string(String(item.totalHIndex));
        worksheet.cell(row, 4).string(String(item.recentHIndex));
        worksheet.cell(row, 5).string(item.profileUrl || '');
        worksheet.cell(row, 6).string(item.searchTime || '');
        worksheet.cell(row, 7).string(item.institution || '');
        worksheet.cell(row, 8).string(item.emailVerified || '');
    });

    workbook.write(filePath);
    addLog('info', `结果已导出到: ${filePath}`);
}

//  设置输出目录和日志
async function setupOutputAndLogs(currentOutputDir, timestamp, authorNames) {
    ensureDir(currentOutputDir);
    // 保存截图（开发阶段）
    // const subDirs = ['screenshots', 'logs', 'data'];
    const subDirs = [ 'data'];
    for (const dir of subDirs) {
        ensureDir(path.join(currentOutputDir, dir));
    }

    crawlerState.filePaths.resultExcel = path.join(currentOutputDir, 'data', `authors_${timestamp}.xlsx`);

    const logBaseDir = userConfig.LOG_BASE_DIR || path.join(process.cwd(), 'logs');
    ensureDir(logBaseDir);
    const logFilePath = path.join(logBaseDir, `${timestamp}_google_author_crawler.log`);
    logStream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });

    // addLog('info', `日志文件已创建: ${logFilePath}`);
    addLog('info', `谷歌学术作者检索启动，作者列表：${authorNames.join(', ')}，输出目录：${currentOutputDir}`);
}

// 查找本地浏览器文件（同谷歌论文检索）
function findLocalBrowser() {
    addLog('info', '\n=== 开始查找本地浏览器 ===');

    function findBrowserRecursive(dir) {
        try {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(dir, item.name);
                if (item.isDirectory()) {
                    const found = findBrowserRecursive(fullPath);
                    if (found) return found;
                } else if (item.name.toLowerCase() === 'chrome.exe') {
                    addLog('info', `✓ 找到浏览器（递归查找）: ${fullPath}`);
                    return fullPath;
                }
            }
        } catch (error) {}
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

    addLog('warn', '\n✗ 未找到本地浏览器文件');
    return null;
}

async function ensureBrowser() {
    addLog('info', '\n=== 检查浏览器环境 ===');
    const localBrowser = findLocalBrowser();
    if (localBrowser) {
        addLog('info', '使用本地浏览器文件');
        return localBrowser;
    }

    addLog('info', '\n未找到本地浏览器，尝试自动下载...');
    addLog('info', '注意：下载需要网络连接，文件约150MB');

    try {
        const downloadDir = path.join(process.cwd(), 'browsers');
        addLog('info', `浏览器将下载到: ${downloadDir}`);
        ensureDir(downloadDir);

        process.env.PLAYWRIGHT_BROWSERS_PATH = downloadDir;

        addLog('info', '正在下载Chromium浏览器，请稍候...');
        addLog('info', '这可能需要几分钟，取决于网络速度...');

        execSync(`npx playwright install chromium`, {
            stdio: 'inherit',
            cwd: process.cwd(),
            env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: downloadDir }
        });

        addLog('success', '✓ 浏览器下载完成！');
        return findLocalBrowser();
    } catch (downloadError) {
        addLog('info', `浏览器下载失败: ${downloadError.message}`);
        return null;
    }
}
//  浏览器环境设置
async function setupBrowserEnvironment() {
    const browserPath = await ensureBrowser();  // 使用查找逻辑获取路径
    if (!browserPath) {
        throw new Error('未找到/下载浏览器，无法继续');
    }

    const browser = await chromium.launch({
        executablePath: browserPath,  // 指定路径
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage'
        ]
    });
    browserInstance = browser;

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        acceptDownloads: true,
        viewport: { width: 1280, height: 800 }
    });
    const page = await context.newPage();

    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        delete navigator.__proto__.webdriver;
        window.chrome = { runtime: {} };
    });

    return { browser, context, page };
}

//  从输入数据提取作者姓名列表
function extractAuthorNamesFromInput(input) {
    if (!Array.isArray(input) || input.length === 0) {
        // 如果没有输入，返回测试数据
        return ['Stommel J', 'Brook A'];
    }

    // 判断第一个元素类型
    const first = input[0];
    if (typeof first === 'string') {
        // 已经是字符串列表，直接作为作者姓名
        return input;
    } else if (typeof first === 'object' && first !== null) {
        // 如果是对象数组，尝试提取 authorName 字段
        const authors = input
            .map(item => item.authorName || item.authorName || '')
            .filter(name => name.trim() !== '');
        if (authors.length > 0) {
            return authors;
        }
    }
    // 默认返回测试数据
    return ['Stommel J', 'Brook A'];
}

//  主爬虫函数
async function crawlGoogleScholarAuthors(input = [], options = {}) {
    // 从 options 中获取任务类型（可选）
    console.log('启动谷歌学术作者信息检索');
    const authorNames = extractAuthorNamesFromInput(input);
    const generateExcel = options.generateExcel !== undefined ? options.generateExcel : true;
    const customOutputDir = options.outputDir;
    addLog('info', `待检索作者列表: ${authorNames.join(', ')}`);

    // 确定基础输出目录
    let baseOutputDir;
    if (customOutputDir && customOutputDir.trim() !== '') {
        baseOutputDir = customOutputDir;
        addLog('info', `使用自定义输出目录: ${baseOutputDir}`);
    } else {
        // 默认桌面
        baseOutputDir = path.join(os.homedir(), 'Desktop');
        addLog('info', `使用默认输出目录（桌面）: ${baseOutputDir}`);
    }
    ensureDir(baseOutputDir);
    // 重置状态
    resetCrawlerState();
    crawlerState.isRunning = true;
    shouldStop = false;

    const timestamp = new Date().toISOString().replace(/[-:\.T]/g, '').slice(0, 15);
    currentOutputDir = path.join(baseOutputDir, timestamp);  // 在基础目录下创建时间戳子目录
    crawlerState.currentDir = currentOutputDir;

    await setupOutputAndLogs(currentOutputDir, timestamp, authorNames);

    let page = null;
    let context = null;
    let browser = null;

    try {
        // 启动浏览器
        ({browser, context, page} = await setupBrowserEnvironment());

        addLog('info', `\n=== 开始检索作者信息 ===`);
        addLog('info', `作者数量: ${authorNames.length}`);

        // 处理每个作者
        await processAuthors(page, authorNames);

        // 最终处理
        crawlerState.progress = 100;
        crawlerState.result = authorResultList;
        crawlerState.isRunning = false;

        // 写入 Excel
        if (generateExcel && authorResultList.length > 0) {
            writeToExcel(authorResultList, crawlerState.filePaths.resultExcel);
        }

        addLog('success', `检索完成，共处理 ${authorResultList.length} 个作者`);
        return crawlerState.result;

    } catch (error) {
        // 截图
        let screenshotPath = null;
        if (page && !page.isClosed()) {
            screenshotPath = await takeErrorScreenshot(page, 'google-author');
        }
        // 将截图路径附加到错误对象
        error.screenshotPath = screenshotPath;
        crawlerState.isRunning = false;
        // 格式化错误
        const formattedError = formatError(error, 'google-author');
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
        if (browser) {
            try {
                await browser.close();
            } catch (e) {
                addLog('info', `关闭浏览器失败: ${e.message}`);
            }
        }
        if (currentUserDataDir) {
            try {
                fs.rmSync(currentUserDataDir, {recursive: true, force: true});
                addLog('info', `已清理临时目录: ${currentUserDataDir}`);
            } catch (e) {
                addLog('info', `清理临时目录失败: ${e.message}`);
            }
        }
        crawlerState.isRunning = false;
        addLog('info', '\n=== 爬虫执行结束 ===');
    }
}

// 模块导出
module.exports = {
    crawlGoogleScholarAuthors,
    getCrawlerState,
    resetCrawlerState,
    stopCrawler
};


if (require.main === module) {
    // 测试数据
    // const testAuthors = ['Stommel J', 'Brook A'];
    const testAuthors = [ 'Brook A'];
    crawlGoogleScholarAuthors(testAuthors)
        .then(() => process.exit(0))
        .catch(err => {
            console.error('爬虫执行失败:', err);
            process.exit(1);
        });
}
