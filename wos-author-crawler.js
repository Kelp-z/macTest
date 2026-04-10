// wos-author-crawler.js
const {chromium} = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {execSync} = require('child_process');
const excel = require('excel4node');
const {formatError} = require("./error-utils");
const {requestUserIntervention} = require("./crawler-utils");
const {takeErrorScreenshot} = require("./crawler-utils");
//  配置读取
const DEFAULT_CONFIG = {
    OUTPUT_BASE_DIR_NAME: 'output/wos_authors'
};

//  登录凭证配置（请修改为您的账号密码）
const WOS_CREDENTIALS = {
    email: '',
    password: ''
};

let userConfig = {};
const configPath = path.join(process.cwd(), 'config.json');
if (fs.existsSync(configPath)) {
    try {
        const raw = fs.readFileSync(configPath, 'utf8');
        userConfig = JSON.parse(raw);
        console.log('已加载外部配置文件:', configPath);
        if (userConfig.wosAuthor && userConfig.wosAuthor.credentials) {
            WOS_CREDENTIALS.email = userConfig.wosAuthor.credentials.email || WOS_CREDENTIALS.email;
            WOS_CREDENTIALS.password = userConfig.wosAuthor.credentials.password || WOS_CREDENTIALS.password;
        }
    } catch (err) {
        console.warn('读取配置文件失败，使用默认配置', err.message);
    }
}
const wosAuthorConfig = userConfig.wosAuthor || {};
const merged = {...DEFAULT_CONFIG, ...wosAuthorConfig};
const OUTPUT_BASE_DIR = path.join(process.cwd(), merged.OUTPUT_BASE_DIR_NAME);

//  全局状态
let crawlerState = {
    isRunning: false,
    progress: 0,
    logs: [],
    result: [],
    filePaths: {resultExcel: ''},
    error: null,
    currentDir: '',
    logIndex: 0
};

let browserInstance = null;
let logStream = null;
let shouldStop = false;

//  日志函数
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

//  状态管理
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
    shouldStop = false;
}

function getCrawlerState() {
    return {...crawlerState};
}

async function stopCrawler() {
    addLog('warn', '开始停止 WoS 作者检索任务...');
    shouldStop = true;
    crawlerState.isRunning = false;
    if (browserInstance) {
        try {
            await browserInstance.close();
            addLog('success', '浏览器实例已关闭');
        } catch (e) {
            addLog('error', `关闭浏览器失败：${e.message}`);
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
    addLog('success', 'WoS 作者检索任务已停止');
}

//  辅助函数
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, {recursive: true});
        addLog('info', `创建目录: ${dirPath}`);
    }
}

function findLocalBrowser() {
    addLog('info', '\n=== 开始查找本地浏览器 ===');

    function findBrowserRecursive(dir) {
        try {
            const items = fs.readdirSync(dir, {withFileTypes: true});
            for (const item of items) {
                const fullPath = path.join(dir, item.name);
                if (item.isDirectory()) {
                    const found = findBrowserRecursive(fullPath);
                    if (found) return found;
                } else if (item.name.toLowerCase() === 'chrome.exe') {
                    addLog('success', `✓ 找到浏览器（递归查找）: ${fullPath}`);
                    return fullPath;
                }
            }
        } catch (error) {
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
    try {
        const downloadDir = path.join(process.cwd(), 'browsers');
        ensureDir(downloadDir);
        process.env.PLAYWRIGHT_BROWSERS_PATH = downloadDir;
        addLog('info', '正在下载Chromium浏览器，请稍候...');
        execSync(`npx playwright install chromium`, {
            stdio: 'inherit',
            cwd: process.cwd(),
            env: {...process.env, PLAYWRIGHT_BROWSERS_PATH: downloadDir}
        });
        addLog('success', '✓ 浏览器下载完成！');
        return findLocalBrowser();
    } catch (downloadError) {
        addLog('error', `浏览器下载失败: ${downloadError.message}`);
        return null;
    }
}

async function setupBrowserEnvironment() {
    const browserPath = await ensureBrowser();
    if (!browserPath) throw new Error('未找到/下载浏览器，无法继续');

    const browser = await chromium.launch({
        executablePath: browserPath,
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
        viewport: {width: 1280, height: 800}
    });

    const page = await context.newPage();
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
        delete navigator.__proto__.webdriver;
        window.chrome = {runtime: {}};
    });

    return {browser, page};
}


async function waitForCaptchaClear(page, timeoutMs = 600000) {

    const captchaText = "There is unusual activity coming from your account or institution. Please verify you are human to proceed.";
    const startTime = Date.now();
    let notified = false;
    while (Date.now() - startTime < timeoutMs) {
        const content = await page.content();
        // 循环打印日志提醒
        // if (content.includes(captchaText)) {
        //     addLog('warn', '检测到人机验证页面，请手动完成验证...');
        //     await closeCookiePopup(page);
        //     await page.waitForTimeout(10000);
        // } else {
        //     return;
        // }

        if (content.includes(captchaText)){
            if (!notified){
                notified = true;
                await  requestUserIntervention({
                    type:'captcha-manual',
                    data:{message:'检测到人机验证，请在浏览器中手动完成验证'}
                });
                // 等待页面稳定再继续检测
                await page.waitForTimeout(2000)
            }
        }else {
            // 验证通过，退出
            return;
        }
    }

    throw new Error('等待人机验证超时（10分钟）');
}

async function waitForCrossBorderManual(page, timeoutMs = 600000) {
    const targetText = "Cross Border Personal Data Transfer Acknowledgement.";
    const startTime = Date.now();
    let autoAttempts = 0;
    const maxAutoAttempts = 5;


    while (Date.now() - startTime < timeoutMs) {
        const content = await page.content();
        if (!content.includes(targetText)) {
            addLog('info', '跨境数据传输确认页面已处理，继续执行');
            return;
        }

        if (autoAttempts < maxAutoAttempts) {
            addLog('info', `尝试自动处理跨境数据传输确认页面 (第 ${autoAttempts+1}/${maxAutoAttempts} 次)`);
            try {
                // 勾选复选框（使用 JavaScript 直接操作）
                await page.evaluate(() => {
                    const checkboxes = document.querySelectorAll('mat-checkbox input[type="checkbox"]');
                    for (let cb of checkboxes) {
                        if (!cb.checked) {
                            cb.checked = true;
                            cb.dispatchEvent(new Event('change', { bubbles: true }));
                            cb.dispatchEvent(new Event('click', { bubbles: true }));
                        }
                    }
                });
                addLog('info', '已通过 JavaScript 勾选复选框');

                // 多次尝试点击确认按钮，直到弹窗消失或达到最大尝试次数
                let retry = 0;
                const maxRetry = 3;
                let clickSuccess = false;
                while (retry < maxRetry) {
                    // 点击确认按钮
                    await page.evaluate(() => {
                        const btn = document.querySelector('#cbdt_confirm');
                        if (btn && !btn.disabled) {
                            btn.click();
                        }
                    });
                    addLog('info', `已通过 JavaScript 点击 Confirm and continue 按钮 (第 ${retry+1} 次)`);

                    // 等待一小段时间让页面处理
                    await page.waitForTimeout(2000);

                    // 检查弹窗是否消失
                    const newContent = await page.content();
                    if (!newContent.includes(targetText)) {
                        addLog('success', '跨境数据传输确认页面已自动处理完成');
                        clickSuccess = true;
                        break;
                    }
                    retry++;
                }

                if (clickSuccess) {
                    return;
                } else {
                    addLog('warn', '多次点击确认按钮后弹窗仍未消失，可能仍需手动处理');
                }
            } catch (err) {
                addLog('error', `自动处理跨境确认页面时出错: ${err.message}`);
            }
            autoAttempts++;
            await page.waitForTimeout(5000);
        } else {
            // 超过最大尝试次数，转手动
            addLog('warn', `已尝试自动处理 ${maxAutoAttempts} 次仍未成功，请手动完成跨境数据传输确认`);
            while (Date.now() - startTime < timeoutMs) {
                const newContent = await page.content();
                if (!newContent.includes(targetText)) {
                    addLog('info', '用户已手动完成跨境数据传输确认，继续执行');
                    return;
                }
                await page.waitForTimeout(5000);
            }
            throw new Error('等待跨境数据传输确认超时（10分钟），请检查网络或手动处理');
        }
    }
    throw new Error('等待跨境数据传输确认超时（10分钟）');
}

// 登录后统一处理弹窗/验证（按顺序）
async function handlePostLoginInterventions(page) {
    addLog('info', '开始处理登录后的弹窗与验证...');
    // 关闭 Cookie 弹窗（自动）
    await closeCookiePopup(page);
    // 等待人机验证（自动）
    await waitForCaptchaClear(page);
    // 等待跨境传输确认（手动）
    await waitForCrossBorderManual(page);
    addLog('success', '所有弹窗/验证已处理完成');
}

// 关闭 Cookie 弹窗的函数
async function closeCookiePopup(page) {
    try {
        const closeButton = await page.$('#onetrust-close-btn-container button.onetrust-close-btn-handler');
        if (closeButton && await closeButton.isVisible()) {
            addLog('info', '检测到 Cookie 同意弹窗，正在关闭...');
            await closeButton.click();
            addLog('success', '已关闭 Cookie 弹窗');
            await page.waitForTimeout(1000); // 等待弹窗消失动画
        } else {
            addLog('info', '未检测到 Cookie 弹窗');
        }
    } catch (error) {
        addLog('warn', '关闭 Cookie 弹窗时出错: ' + error.message);
    }
}

// 写入 Excel 文件
function writeToExcel(results, filePath) {
    if (!results || results.length === 0) {
        addLog('info', '无数据可写入 Excel');
        return;
    }

    const workbook = new excel.Workbook();
    const worksheet = workbook.addWorksheet('作者检索结果');

    const headers = [
        '序号',
        '检索姓氏 (LastName)',
        '检索名字 (FirstName)',
        '检索结果总数',
        '作者序号',
        '作者姓名',
        '作者链接',
        '机构',
        '国家/地区',
        'ResearcherID',
        'ORCID',
        'H-Index',
    ];
    headers.forEach((header, index) => {
        worksheet.cell(1, index + 1).string(header).style({font: {bold: true}});
    });

    let rowIdx = 2;
    let globalSeq = 1;
    for (const search of results) {
        const authorsList = search.authors || [];
        if (authorsList.length === 0) {
            worksheet.cell(rowIdx, 1).number(globalSeq);
            worksheet.cell(rowIdx, 2).string(search.familyName || '');
            worksheet.cell(rowIdx, 3).string(search.givenName || '');
            worksheet.cell(rowIdx, 4).number(search.totalResults || 0);
            worksheet.cell(rowIdx, 5).string('-');
            worksheet.cell(rowIdx, 6).string('-');
            worksheet.cell(rowIdx, 7).string('-');
            worksheet.cell(rowIdx, 8).string('-');
            worksheet.cell(rowIdx, 9).string('-');
            worksheet.cell(rowIdx, 10).string('-');
            worksheet.cell(rowIdx, 11).string('-');
            worksheet.cell(rowIdx, 12).string('-');
            rowIdx++;
            globalSeq++;
        } else {
            for (let j = 0; j < authorsList.length; j++) {
                const author = authorsList[j];
                worksheet.cell(rowIdx, 1).number(globalSeq);
                worksheet.cell(rowIdx, 2).string(search.familyName || '');
                worksheet.cell(rowIdx, 3).string(search.givenName || '');
                worksheet.cell(rowIdx, 4).number(search.totalResults || 0);
                worksheet.cell(rowIdx, 5).number(j + 1);
                worksheet.cell(rowIdx, 6).string(author.authorName || '');
                worksheet.cell(rowIdx, 7).string(author.authorUrl || '');
                worksheet.cell(rowIdx, 8).string(author.institution || '');
                worksheet.cell(rowIdx, 9).string(author.location || '');
                worksheet.cell(rowIdx, 10).string(author.researcherId || '');
                worksheet.cell(rowIdx, 11).string(author.orcid || '');
                worksheet.cell(rowIdx, 12).string(author.hIndex || '');
                rowIdx++;
            }
            globalSeq++;
        }
    }

    workbook.write(filePath);
    addLog('info', `结果已导出到: ${filePath}`);
}

function namesMatch(nameFromList, nameFromPage) {
    if (!nameFromList || !nameFromPage) return false;
    // 标准化：转小写，移除标点符号（保留字母数字和空格）
    const normalize = (s) => s.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const listNorm = normalize(nameFromList);
    const pageNorm = normalize(nameFromPage);
    if (listNorm === pageNorm) return true;
    const listWords = listNorm.split(/\s+/);
    const pageWords = pageNorm.split(/\s+/);
    // 计算共同单词数量
    const common = listWords.filter(w => pageWords.includes(w));
    // 如果共同单词数量大于等于最小单词数的一半，认为匹配
    const minLen = Math.min(listWords.length, pageWords.length);
    return common.length >= minLen * 0.5;
}
async function extractAuthorDetailFromPage(page) {
    const authorName = await page.$eval('h1[data-test="author-name"]', el => el.textContent.trim()).catch(() => '');

    // ResearcherID
    let researcherId = '';
    const ridSection = await page.$('div[data-test="rid"]');
    if (ridSection) {
        // 找到包含 "Web of Science ResearcherID" 的 span 后的兄弟 span
        const ridSpan = await ridSection.$('span:has-text("Web of Science ResearcherID") + span');
        if (ridSpan) {
            researcherId = await ridSpan.textContent();
            researcherId = researcherId.trim();
        }
    }


    // ORCID
    let orcid = '';
    const orcidLink = await page.$('a.wat-other-identifiers-orcid-link');
    if (orcidLink) {
        const href = await orcidLink.getAttribute('href');
        const match = href.match(/orcid\.org\/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/);
        if (match) orcid = match[1];
    }


    // H-Index
    let hIndex = '';
    const hIndexDiv = await page.$('.wat-author-metric-inline-block .wat-author-metric');
    if (hIndexDiv) {
        hIndex = await hIndexDiv.textContent();
        hIndex = hIndex.trim();
    }

    // 机构（从 Organizations 区域）
    let institution = '';
    const orgSection = await page.$('app-display-data:has(span:has-text("Organizations")) .author-detail-section-content');
    if (orgSection) {
        const orgSpans = await orgSection.$$('span');
        const orgNames = await Promise.all(orgSpans.map(span => span.textContent()));
        institution = orgNames.join(', ');
    }

    // 位置信息在详情页可能没有，置空
    const location = '';

    return {
        authorName,
        authorUrl: page.url(),
        institution,
        location,
        researcherId,
        orcid,
        hIndex
    };
}

// 批量搜索函数
async function crawlWosAuthors(authors, options = {}) {
    const { onManualLoginRequired } = options;
    if (crawlerState.isRunning) {
        throw new Error('爬虫已在运行中，请勿重复启动');
    }
    resetCrawlerState();
    crawlerState.isRunning = true;
    shouldStop = false;



    // 准备输出目录
    const timestamp = new Date().toISOString().replace(/[-:\.T]/g, '').slice(0, 15);
    let baseOutputDir;
    if (options.outputDir && options.outputDir.trim() !== '') {
        baseOutputDir = options.outputDir;
        addLog('info', `使用自定义输出目录: ${baseOutputDir}`);
    } else {
        baseOutputDir = OUTPUT_BASE_DIR;
        addLog('info', `使用默认输出目录: ${baseOutputDir}`);
    }
    ensureDir(baseOutputDir);

    const currentOutputDir = path.join(baseOutputDir, timestamp);
    const dataDir = path.join(currentOutputDir, 'data');



    ensureDir(currentOutputDir);
    ensureDir(dataDir);

    const logBaseDir = userConfig.LOG_BASE_DIR || path.join(process.cwd(), 'logs');
    ensureDir(logBaseDir);
    const logFilePath = path.join(logBaseDir, `${timestamp}_wos_author_crawler.log`);
    addLog('info', `日志文件已创建: ${logFilePath}`);
    addLog('info', `输出目录: ${currentOutputDir}`);

    const outputDirs = {data: dataDir};

    const loginUrl = 'https://access.clarivate.com/login?app=wos';
    const targetUrl = 'https://webofscience.clarivate.cn/wos/author/author-search';

    // 检查凭证
    const credentials = options.credentials || WOS_CREDENTIALS;
    const hasValidCredentials = !!(credentials.email && credentials.password);



    let browser, page;
    const searchResults = [];

    try {
        const env = await setupBrowserEnvironment();
        browser = env.browser;
        page = env.page;

        //  登录流程
        addLog('info', `正在访问登录页: ${loginUrl}`);
        await page.goto(loginUrl, {waitUntil: 'domcontentloaded', timeout: 60000});

        await page.waitForSelector('input[formcontrolname="email"]', {timeout: 15000});
        await page.waitForSelector('input[formcontrolname="password"]', {timeout: 15000});

        if (!hasValidCredentials && onManualLoginRequired) {
            addLog('warn', '请用户登录以使用wos of science');
            // 通知前端需要用户手动登录
            onManualLoginRequired();
        }
        if (hasValidCredentials) {
            // 自动登录模式
            const emailInput = await page.$('input[formcontrolname="email"]');
            const passwordInput = await page.$('input[formcontrolname="password"]');
            const loginButton = await page.$('#signIn-btn');
            if (!emailInput || !passwordInput || !loginButton) {
                throw new Error('未找到登录表单元素');
            }
            await emailInput.fill(credentials.email);
            await passwordInput.fill(credentials.password);
            addLog('info', '已自动填写邮箱和密码');
            await Promise.all([
                page.waitForNavigation({waitUntil: 'domcontentloaded', timeout: 30000}),
                loginButton.click()
            ]);
            addLog('success', '自动登录成功');
        } else {
            // 手动登录模式：等待用户手动填写并点击登录
            addLog('warn', '请在弹出的页面中手动输入账号密码并点击登录');
            addLog('warn', '登录完成后，爬虫将自动继续执行');
            // 等待用户登录成功：检测页面 URL 变化或出现特定元素
            const startTime = Date.now();
            const timeout = 10 * 60 * 1000; // 10分钟超时
            let loggedIn = false;
            while (Date.now() - startTime < timeout && !shouldStop) {
                const currentUrl = page.url();
                // 如果 URL 不再包含 login 且包含 wos 或 author-search，则认为登录成功
                if (!currentUrl.includes('login') && (currentUrl.includes('wos') || currentUrl.includes('author'))) {
                    loggedIn = true;
                    break;
                }

                await page.waitForTimeout(2000);
            }
            if (!loggedIn) {
                throw new Error('用户手动登录超时（10分钟），请重新启动任务');
            }
            addLog('success', '用户已手动登录，继续执行');

        }
        // 额外等待页面稳定
        await page.waitForTimeout(6000);
        await closeCookiePopup(page);    // 关闭 Cookie 弹窗

        // 按顺序处理登录后的弹窗/验证
        await handlePostLoginInterventions(page);

        // 确保进入作者搜索页
        if (!page.url().includes('author/author-search')) {
            addLog('info', `导航到作者搜索页: ${targetUrl}`);
            await page.goto(targetUrl, {waitUntil: 'domcontentloaded', timeout: 60000});
        } else {
            addLog('info', '已在作者搜索页面');
        }

        await closeCookiePopup(page); // 再次关闭可能出现的弹窗
        await waitForCaptchaClear(page);

        // 等待表单加载
        await page.waitForSelector('#snSearchType', {timeout: 15000});
        addLog('info', '已找到作者搜索表单 #snSearchType');

        // 检查并切换到 Name Search
        const dropdownButton = await page.$('#snSearchType wos-select button');
        if (!dropdownButton) throw new Error('未找到检索方式选择按钮');

        const selectedTextSpan = await dropdownButton.$('span.dropdown-text');
        let selectedText = '';
        if (selectedTextSpan) {
            selectedText = await selectedTextSpan.textContent();
            selectedText = selectedText ? selectedText.trim() : '';
        } else {
            selectedText = await dropdownButton.textContent();
            selectedText = selectedText ? selectedText.trim() : '';
        }
        addLog('info', `当前选择的检索方式: "${selectedText}"`);

        if (selectedText !== 'Name Search') {
            addLog('info', '当前不是 Name Search，尝试切换...');
            await dropdownButton.click();
            const nameSearchOption = await page.$('wos-select .dropdown-item:has-text("Name Search")');
            if (nameSearchOption) {
                await nameSearchOption.click();
                addLog('success', '已切换到 Name Search');
                await page.waitForTimeout(2000);
            } else {
                addLog('warn', '未找到 Name Search 选项，继续尝试获取输入框');
            }
        }

        await waitForCaptchaClear(page);
        await closeCookiePopup(page);

        // 获取姓氏和名字输入框（仅一次，但注意刷新后需重新获取）
        let lastNameInput = await page.$('input[aria-label="Last Name"]');
        let firstNameInput = await page.$('input[aria-label="First Name"]');
        let searchButton = await page.$('button[data-ta="run-search"]');
        if (!lastNameInput || !firstNameInput || !searchButton) {
            throw new Error('未找到姓氏、名字输入框或搜索按钮');
        }

        //  批量搜索
        for (let i = 0; i < authors.length; i++) {
            if (shouldStop) {
                addLog('warn', '检测到停止信号，终止批量搜索');
                break;
            }
            const author = authors[i];
            const familyName = author.familyName || '';
            const givenName = author.givenName || '';
            addLog('info', `处理第 ${i + 1}/${authors.length} 位作者: ${familyName} ${givenName}`);

            // 搜索前检测验证和弹窗
            await waitForCaptchaClear(page);
            await closeCookiePopup(page);

            // 清空输入框
            await lastNameInput.fill('');
            await firstNameInput.fill('');
            await page.waitForTimeout(300);

            // 填充
            await lastNameInput.fill(familyName);
            await firstNameInput.fill(givenName);
            addLog('info', `已填入姓氏: ${familyName}, 名字: ${givenName}`);

            // 点击搜索按钮并等待导航
            await searchButton.click();


            // 额外等待确保内容稳定
            await page.waitForTimeout(5000);

            // 等待三种结果中的任意一个出现
            await Promise.race([
                page.waitForSelector('h1.search-info-title:has-text("results from Web of Science Researchers for:")', { timeout: 30000 }).catch(() => null),
                page.waitForSelector('text="Your search found no results"', { timeout: 30000 }).catch(() => null),
                page.waitForSelector('h1[data-test="author-name"]', { timeout: 30000 }).catch(() => null)
            ]);

            // 额外等待确保内容稳定
            await page.waitForTimeout(2000);

            // 判断结果类型
            const hasResultsList = await page.$('h1.search-info-title:has-text("results from Web of Science Researchers for:")') !== null;
            const hasNoResult = await page.$('text="Your search found no results"') !== null;
            const isDetailPage = await page.$('h1[data-test="author-name"]') !== null;

            let totalResults = 0;
            let authorItems = [];

            if (hasNoResult) {
                addLog('warn', `作者 ${familyName} ${givenName} 检索无结果，跳过解析。`);
            } else if (isDetailPage) {
                addLog('info', `检索到单个作者，直接进入详情页：${familyName} ${givenName}`);
                // 直接从详情页提取信息
                const detail = await extractAuthorDetailFromPage(page);
                authorItems = [detail];
                totalResults = 1;
                addLog('info', `成功解析作者详情：${detail.authorName}`);
            } else if (hasResultsList) {
                // 提取结果数量
                const resultCountSpan = await page.$('h1.search-info-title span.brand-blue');
                if (resultCountSpan) {
                    const countText = await resultCountSpan.textContent();
                    totalResults = parseInt(countText, 10) || 0;
                    addLog('info', `检索到 ${totalResults} 个作者结果`);
                } else {
                    addLog('warn', '未找到结果数量元素');
                }

                if (totalResults > 0) {
                    // 提取结果数量
                    const resultCountSpan = await page.$('h1.search-info-title span.brand-blue');
                    if (resultCountSpan) {
                        const countText = await resultCountSpan.textContent();
                        totalResults = parseInt(countText, 10) || 0;
                        addLog('info', `检索到 ${totalResults} 个作者结果`);
                    } else {
                        addLog('warn', '未找到结果数量元素');
                    }

                    if (totalResults > 0) {
                        // 提取作者列表
                        authorItems = await page.$$eval('app-author-summary-record', records => {
                            return records.map(record => {
                                const nameLink = record.querySelector('h3.author-name a');
                                const authorName = nameLink ? nameLink.textContent.trim() : '';
                                let authorUrl = nameLink ? nameLink.getAttribute('href') : '';
                                if (authorUrl && !authorUrl.startsWith('http')) {
                                    authorUrl = 'https://webofscience.clarivate.cn' + authorUrl;
                                }

                                const paragraphs = Array.from(record.querySelectorAll('p.font-size-14'));
                                let institution = '';
                                let location = '';
                                let researcherId = '';
                                for (const p of paragraphs) {
                                    const text = p.textContent.trim();
                                    if (text.includes('Web of Science ResearcherID')) {
                                        const idSpan = p.querySelector('span:last-child');
                                        researcherId = idSpan ? idSpan.textContent.trim() : '';
                                    } else {
                                        if (!institution) institution = text;
                                        else if (!location) location = text;
                                    }
                                }
                                return {
                                    authorName,
                                    authorUrl,
                                    institution,
                                    location,
                                    researcherId,
                                    orcid: '',
                                    hIndex: ''
                                };
                            });
                        });
                        addLog('info', `成功解析 ${authorItems.length} 个作者条目`);

                        // 对列表中的每个作者，访问详情页获取 ORCID 和 H-Index
                        for (let j = 0; j < authorItems.length; j++) {
                            const auth = authorItems[j];
                            if (!auth.authorUrl) {
                                auth.orcid = '无';
                                auth.hIndex = '无';
                                continue;
                            }
                            addLog('info', `正在访问作者详情页: ${auth.authorName} (${auth.authorUrl})`);
                            let detailPage = null;
                            try {
                                detailPage = await page.context().newPage();
                                await detailPage.goto(auth.authorUrl, {waitUntil: 'domcontentloaded', timeout: 30000});
                                await detailPage.waitForSelector('h1[data-test="author-name"]', {timeout: 15000});
                                await waitForCaptchaClear(detailPage);
                                await closeCookiePopup(detailPage);

                                // 提取详情页信息
                                const detail = await extractAuthorDetailFromPage(detailPage);
                                auth.orcid = detail.orcid;
                                auth.hIndex = detail.hIndex;
                                // 可选：覆盖机构信息（如果详情页更完整）
                                if (detail.institution) auth.institution = detail.institution;
                                addLog('info', `作者 ${auth.authorName} - ORCID: ${detail.orcid}, H-Index: ${detail.hIndex}`);
                            } catch (err) {
                                addLog('error', `访问详情页失败 ${auth.authorName}: ${err.message}`);
                                auth.orcid = '无';
                                auth.hIndex = '无';
                            } finally {
                                if (detailPage) await detailPage.close();
                            }
                            await page.waitForTimeout(1000);
                        }
                    }
                }
            }
            searchResults.push({
                index: i+1,
                familyName,
                givenName,
                hasResults: !hasNoResult,
                totalResults,
                authors: authorItems,
                resultPageUrl: page.url()
            });

            await page.goto(targetUrl, {waitUntil: 'domcontentloaded', timeout: 30000});
            addLog('info', '已返回作者搜索页面');
            await page.waitForTimeout(10000);
            await closeCookiePopup(page);
            await waitForCaptchaClear(page);
            lastNameInput = await page.$('input[aria-label="Last Name"]');
            firstNameInput = await page.$('input[aria-label="First Name"]');
            searchButton = await page.$('button[data-ta="run-search"]');
            if (!lastNameInput || !firstNameInput || !searchButton) {
                throw new Error('返回后未找到姓氏、名字输入框或搜索按钮');
            }
        }

        addLog('success', `批量搜索完成，共处理 ${searchResults.length} 位作者`);

        // 根据 generateExcel 参数决定是否生成 Excel
        if (options.generateExcel !== false) {
            const excelFileName = `wos_authors_${timestamp}.xlsx`;
            const excelFilePath = path.join(dataDir, excelFileName);
            writeToExcel(searchResults, excelFilePath);
            crawlerState.filePaths.resultExcel = excelFilePath;
        }

        crawlerState.result = searchResults;
        crawlerState.progress = 100;
        return searchResults;

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
        const formattedError = formatError(error, 'wos-author');
        crawlerState.error = formattedError;
        // 将原始详细信息写入日志
        addLog('error', formattedError.detail);
        addLog('info', `用户提示：${formattedError.userMessage}`);
        // 抛出自定义错误
        throw formattedError;
    } finally {
        crawlerState.isRunning = false;
        if (page) await page.waitForTimeout(3000);
        if (browser) await browser.close();
        if (logStream) logStream.end();
        browserInstance = null;
        addLog('info', '爬虫执行结束');
    }
}

//  导出
module.exports = {
    crawlWosAuthors,      // 批量搜索函数
    getCrawlerState,
    resetCrawlerState,
    stopCrawler
};

//  测试代码
if (require.main === module) {
    // 示例作者数据
    const authors = [

        {
            "authorName": "Brook, A",
            "familyName": "Brook",
            "givenName": "A",
            "orcid": ""
        }, {
            "authorName": "Feldman, G",
            "familyName": "Feldman",
            "givenName": "G",
            "orcid": ""
        }
    ];

    crawlWosAuthors(authors, {saveDebug: true})
        .then(results => {
            console.log('批量搜索完成，结果如下：');
            results.forEach(r => {
                console.log(`${r.index}. ${r.familyName} ${r.givenName} -> ${r.resultPageUrl}`);
            });
            process.exit(0);
        })
        .catch(err => {
            console.error('爬取失败:', err);
            process.exit(1);
        });
}
