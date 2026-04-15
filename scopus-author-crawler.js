// scopus-author-batch-search.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const excel = require('excel4node');
const {formatError} = require("./error-utils");
const {takeErrorScreenshot, cleanEmptyDirectory} = require("./crawler-utils");

//  配置读取
const DEFAULT_CONFIG = {
    OUTPUT_BASE_DIR_NAME: 'output/scopus_authors'
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
const scopusAuthorConfig = userConfig.scopusAuthor || {};
const merged = { ...DEFAULT_CONFIG, ...scopusAuthorConfig };
const OUTPUT_BASE_DIR = path.join(process.cwd(), merged.OUTPUT_BASE_DIR_NAME);

//  全局状态
let crawlerState = {
    isRunning: false,
    progress: 0,
    logs: [],
    result: [],
    filePaths: { resultExcel: '' },
    error: null,
    currentDir: '',
    logIndex: 0
};

let browserInstance = null;
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
        filePaths: { resultExcel: '' },
        error: null,
        currentDir: '',
        logIndex: 0
    };
    shouldStop = false;
}

function getCrawlerState() {
    return { ...crawlerState };
}

async function stopCrawler() {
    addLog('warn', '开始停止 Scopus 作者检索任务...');
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
                } catch (err) {}
            }
        } finally {
            browserInstance = null;
        }
    }
    addLog('success', 'Scopus 作者检索任务已停止');
}

//  辅助函数
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

// 查找本地浏览器文件（复用谷歌爬虫逻辑）
function findLocalBrowser() {
    // 导入工具函数
    const { isMacOSApp, getMacOSAppExecutable } = require('./crawler-utils');

    function findBrowserRecursive(dir, depth = 0) {
        try {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(dir, item.name);

                // 如果是 .app 文件（macOS），获取其中的可执行文件
                if (item.isDirectory() && item.name.toLowerCase().endsWith('.app')) {
                    if (isMacOSApp(fullPath)) {
                        const executable = getMacOSAppExecutable(fullPath);
                        if (executable) {
                            return executable;
                        }
                    }
                    // ⚠️ 重要：不要递归进入 .app 内部，避免找到 Helper 进程
                    continue;
                } else if (item.isDirectory()) {
                    // 普通目录，递归查找（限制深度）
                    if (depth < 10) {
                        const found = findBrowserRecursive(fullPath, depth + 1);
                        if (found) return found;
                    }
                } else if (item.name.toLowerCase() === 'chrome.exe') {
                    // Windows 浏览器
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
    return null;
}

async function ensureBrowser() {
    const localBrowser = findLocalBrowser();
    if (localBrowser) return localBrowser;
    try {
        const downloadDir = path.join(process.cwd(), 'browsers');
        ensureDir(downloadDir);
        process.env.PLAYWRIGHT_BROWSERS_PATH = downloadDir;
        execSync(`npx playwright install chromium`, {
            stdio: 'inherit',
            cwd: process.cwd(),
            env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: downloadDir }
        });
        return findLocalBrowser();
    } catch (downloadError) {
        throw new Error(`浏览器下载失败: ${downloadError.message}`);
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
        viewport: { width: 1280, height: 800 }
    });

    const page = await context.newPage();
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        delete navigator.__proto__.webdriver;
        window.chrome = { runtime: {} };
    });

    return { browser, page };
}

// 作者信息类（内部使用）
class AuthorInfo {
    constructor(lastName, firstName, orcid = '') {
        this.lastName = lastName;
        this.firstName = firstName;
        this.orcid = orcid;
    }
}

// 提取作者详情页信息
async function extractAuthorDetails(page, authorUrl, expectedAuthorName) {
    addLog('info', `正在访问作者详情页: ${authorUrl}`);
    const newPage = await page.context().newPage();
    try {
        await newPage.goto(authorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await newPage.waitForSelector('h1[data-testid="author-profile-name"]', { timeout: 15000 });
        await newPage.waitForSelector('[data-testid="authorInstitution"]', { timeout: 10000 }).catch(() => {
            addLog('warn', '未找到机构元素 [data-testid="authorInstitution"]，尝试备用选择器');
        });
        await newPage.waitForTimeout(2000);

        const h1 = await newPage.$('h1[data-testid="author-profile-name"]');
        if (!h1) {
            addLog('warn', `未找到作者姓名 h1 元素，可能页面加载失败: ${authorUrl}`);
            return null;
        }
        const authorName = await h1.textContent();
        if (!authorName.trim() || (expectedAuthorName && !authorName.includes(expectedAuthorName))) {
            addLog('warn', `作者姓名不匹配: 期望 "${expectedAuthorName}", 实际 "${authorName}"`);
        }

        // 机构和国家
        let institutionCountry = '';
        const institutionSpan = await newPage.$('[data-testid="authorInstitution"]');
        if (institutionSpan) {
            const rawText = await institutionSpan.textContent();
            institutionCountry = rawText.replace(/此链接已禁用。?/g, '').trim();
        } else {
            const institutionLi = await newPage.$('ul.AuthorHeader-module__FFjTx > li:first-child');
            if (institutionLi) {
                const rawText = await institutionLi.textContent();
                institutionCountry = rawText.replace(/此链接已禁用。?/g, '').trim();
            }
        }

        // Scopus ID
        let scopusId = '';
        const scopusIdLi = await newPage.$('ul.AuthorHeader-module__FFjTx > li:nth-child(2)');
        if (scopusIdLi) {
            const text = await scopusIdLi.textContent();
            const match = text.match(/Scopus ID:\s*(\S+)/);
            if (match) scopusId = match[1];
        }

        // ORCID
        let orcid = '';
        const orcidLi = await newPage.$('ul.AuthorHeader-module__FFjTx > li:nth-child(3)');
        if (orcidLi) {
            const link = await orcidLi.$('a');
            if (link) {
                const href = await link.getAttribute('href');
                const orcidMatch = href.match(/orcid\.org\/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/);
                if (orcidMatch) orcid = orcidMatch[1];
                else {
                    const text = await orcidLi.textContent();
                    const match = text.match(/\d{4}-\d{4}-\d{4}-\d{3}[\dX]/);
                    if (match) orcid = match[0];
                }
            } else {
                const text = await orcidLi.textContent();
                const match = text.match(/\d{4}-\d{4}-\d{4}-\d{3}[\dX]/);
                if (match) orcid = match[0];
            }
        }

        // h-index
        let hIndex = '';
        const hIndexDiv = await newPage.$('[data-testid="metrics-section-h-index"]');
        if (hIndexDiv) {
            const span = await hIndexDiv.$('span[data-testid="unclickable-count"]');
            if (span) {
                hIndex = await span.textContent();
                hIndex = hIndex ? hIndex.trim() : '';
            }
        }

        return {
            authorName: authorName.trim(),
            institutionCountry,
            scopusId,
            orcid,
            hIndex
        };
    } catch (error) {
        addLog('error', `提取作者详情页失败: ${error.message}`);
        return null;
    } finally {
        await newPage.close();
    }
}

// 批量搜索函数
async function searchAuthors(page, authors, outputDirs) {
    const results = [];
    const searchPageUrl = page.url();

    for (let i = 0; i < authors.length; i++) {
        if (shouldStop) {
            addLog('warn', '检测到停止信号，终止爬取');
            break;
        }
        const author = authors[i];
        addLog('info', `\n--- 处理第 ${i + 1}/${authors.length} 位作者: ${author.firstName} ${author.lastName} ---`);
        crawlerState.progress = Math.round((i / authors.length) * 100);

        const currentUrl = page.url();
        if (!currentUrl.includes('author.uri')) {
            addLog('info', '不在作者搜索页，重新导航...');
            await page.goto(searchPageUrl, { waitUntil: 'domcontentloaded' });
        }

        let searchResult;
        if (author.orcid && author.orcid.trim()!==''){
            searchResult = await searchByOrcid(page,author);
        }else {
            searchResult = await searchByName(page,author);
        }
        results.push(searchResult);
        await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {
            addLog('warn', '返回搜索页失败，尝试重新导航');
            return page.goto(searchPageUrl, { waitUntil: 'domcontentloaded' });
        });
        await page.waitForSelector('input[name="searchterm1"]', { timeout: 10000 });
        addLog('info', '已返回作者搜索页面');
    }

    return results;
}

async function searchByOrcid(page, author) {
    const orcid = author.orcid.trim();
    addLog('info', `使用 ORCID 检索: ${orcid}`);

    // 定位 ORCID 输入框和按钮
    const orcidInput = await page.$('#orcidId');
    const orcidSubmitBtn = await page.$('#orcidSubmitBtn');

    if (!orcidInput) {
        addLog('error', '未找到 ORCID 输入框 #orcidId，回退到姓名检索');
        return await searchByName(page, author);
    }
    if (!orcidSubmitBtn) {
        addLog('error', '未找到 ORCID 搜索按钮 #orcidSubmitBtn，回退到姓名检索');
        return await searchByName(page, author);
    }

    // 填写 ORCID
    await orcidInput.fill('');
    await orcidInput.fill(orcid);

    // 点击搜索，监听导航
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
        orcidSubmitBtn.click()
    ]);

    const resultUrl = page.url();
    addLog('info', `ORCID 搜索结果页 URL: ${resultUrl}`);
    await page.waitForTimeout(3000);

    // 检查是否无结果
    const bodyText = await page.locator('body').innerText();
    if (bodyText.includes('No authors were found')) {
        addLog('warn', `ORCID ${orcid} 未检索到任何作者`);
        return {
            searchAuthor: {
                lastName: author.lastName,
                firstName: author.firstName,
                orcid: author.orcid
            },
            resultPageUrl: resultUrl,
            totalResults: 0,
            authors: []
        };
    }

    // 检查是否直接跳转到作者详情页（ORCID 唯一时可能直接进入详情页）
    const isDetailPage = await page.$('h1[data-testid="author-profile-name"]');
    if (isDetailPage) {
        addLog('info', 'ORCID 检索直接进入作者详情页，提取信息');
        const details = await extractAuthorDetails(page, page.url(), `${author.firstName} ${author.lastName}`);
        if (details) {
            const authorItem = {
                authorName: details.authorName,
                authorUrl: page.url(),
                affiliation: '',
                city: '',
                country: '',
                details: details
            };
            return {
                searchAuthor: {
                    lastName: author.lastName,
                    firstName: author.firstName,
                    orcid: author.orcid
                },
                resultPageUrl: resultUrl,
                totalResults: 1,
                authors: [authorItem]
            };
        }
    }

    // 否则按列表页解析
    return await parseSearchResultsPage(page, author);
}
async function searchByName(page, author) {
    addLog('info', `使用姓名检索: ${author.lastName}, ${author.firstName}`);

    // 清空并填写姓名输入框
    const lastNameInput = await page.$('input[name="searchterm1"]');
    const firstNameInput = await page.$('input[name="searchterm2"]');
    if (!lastNameInput || !firstNameInput) {
        throw new Error('无法获取姓名输入框');
    }
    await lastNameInput.fill('');
    await firstNameInput.fill('');
    await lastNameInput.fill(author.lastName);
    await firstNameInput.fill(author.firstName);

    const submitBtn = await page.$('#authorSubmitBtn');
    if (!submitBtn) throw new Error('找不到姓名搜索按钮');

    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
        submitBtn.click()
    ]);

    const resultUrl = page.url();
    addLog('info', `姓名搜索结果页 URL: ${resultUrl}`);
    await page.waitForTimeout(3000);

    // 解析结果
    return await parseSearchResultsPage(page, author);
}
async function parseSearchResultsPage(page, author) {
    // 获取结果总数
    let totalResults = 0;
    const resultsCountSpan = await page.$('span.resultsCount');
    if (resultsCountSpan) {
        const countText = await resultsCountSpan.textContent();
        totalResults = parseInt(countText.trim(), 10) || 0;
        addLog('info', `检索到 ${totalResults} 条作者结果`);
    } else {
        addLog('warn', '未找到结果计数元素，可能无结果');
    }

    // 提取表格数据
    const authorItems = [];
    const tableExists = await page.$('#srchResultsList');
    if (tableExists) {
        const rows = await page.$$('#srchResultsList tbody tr.searchArea');
        addLog('info', `找到 ${rows.length} 个作者条目`);

        for (let idx = 0; idx < rows.length; idx++) {
            const row = rows[idx];
            const authorLink = await row.$('td.authorResultsNamesCol a');
            let authorName = '', authorUrl = '';
            if (authorLink) {
                authorName = await authorLink.textContent();
                authorUrl = await authorLink.getAttribute('href');
                authorName = authorName ? authorName.trim() : '';
            } else {
                const nameCell = await row.$('td.authorResultsNamesCol');
                if (nameCell) {
                    authorName = await nameCell.textContent();
                    authorName = authorName ? authorName.trim() : '';
                }
            }

            const affiliationCell = await row.$('td.dataCol5');
            let affiliation = affiliationCell ? (await affiliationCell.textContent()).trim() : '';
            const cityCell = await row.$('td.dataCol6');
            let city = cityCell ? (await cityCell.textContent()).trim() : '';
            const countryCell = await row.$('td.dataCol7');
            let country = countryCell ? (await countryCell.textContent()).trim() : '';

            authorItems.push({
                authorName,
                authorUrl,
                affiliation,
                city,
                country,
                details: null
            });
        }
    } else {
        addLog('warn', '未找到结果表格 #srchResultsList');
    }

    // 提取前5个作者的详情
    const maxDetails = 5;
    for (let idx = 0; idx < Math.min(authorItems.length, maxDetails); idx++) {
        if (shouldStop) break;
        const item = authorItems[idx];
        if (item.authorUrl) {
            addLog('info', `正在提取第 ${idx+1} 个作者的详情: ${item.authorName}`);
            const details = await extractAuthorDetails(page, item.authorUrl, item.authorName);
            item.details = details;
        }
    }

    return {
        searchAuthor: {
            lastName: author.lastName,
            firstName: author.firstName,
            orcid: author.orcid || ''
        },
        resultPageUrl: page.url(),
        totalResults: totalResults,
        authors: authorItems
    };
}
function writeToExcel(results, filePath) {
    if (!results || results.length === 0) {
        addLog('info', '无数据可写入 Excel');
        return;
    }

    const workbook = new excel.Workbook();
    const worksheet = workbook.addWorksheet('Scopus作者检索结果');

    const headers = [
        '序号',
        '检索姓氏 (LastName)',
        '检索名字 (FirstName)',
        '检索结果总数',
        '结果序号',
        '作者姓名',
        'Scopus ID',
        'ORCID',
        'H-Index',
        '机构/国家',
        '作者链接'
    ];
    headers.forEach((header, index) => {
        worksheet.cell(1, index + 1).string(header).style({ font: { bold: true } });
    });

    let globalSeq = 1;
    let rowIdx = 2;
    for (const search of results) {
        const searchAuthor = search.searchAuthor;
        const totalResults = search.totalResults;
        const authors = search.authors || [];
        if (authors.length === 0) {
            worksheet.cell(rowIdx, 1).number(globalSeq);
            worksheet.cell(rowIdx, 2).string(searchAuthor.lastName || '');
            worksheet.cell(rowIdx, 3).string(searchAuthor.firstName || '');
            worksheet.cell(rowIdx, 4).number(totalResults);
            worksheet.cell(rowIdx, 5).string('-');
            worksheet.cell(rowIdx, 6).string('-');
            worksheet.cell(rowIdx, 7).string('-');
            worksheet.cell(rowIdx, 8).string('-');
            worksheet.cell(rowIdx, 9).string('-');
            worksheet.cell(rowIdx, 10).string('-');
            worksheet.cell(rowIdx, 11).string('-');
            rowIdx++;
            globalSeq++;
        } else {
            for (let j = 0; j < authors.length; j++) {
                const author = authors[j];
                const details = author.details || {};
                worksheet.cell(rowIdx, 1).number(globalSeq);
                worksheet.cell(rowIdx, 2).string(searchAuthor.lastName || '');
                worksheet.cell(rowIdx, 3).string(searchAuthor.firstName || '');
                worksheet.cell(rowIdx, 4).number(totalResults);
                worksheet.cell(rowIdx, 5).number(j + 1);
                worksheet.cell(rowIdx, 6).string(author.authorName || '');
                worksheet.cell(rowIdx, 7).string(details.scopusId || '');
                worksheet.cell(rowIdx, 8).string(details.orcid || '');
                worksheet.cell(rowIdx, 9).string(details.hIndex || '');
                worksheet.cell(rowIdx, 10).string(details.institutionCountry || `${author.affiliation} ${author.city} ${author.country}`.trim());
                worksheet.cell(rowIdx, 11).string(author.authorUrl || '');
                rowIdx++;
            }
            globalSeq++;
        }
    }

    workbook.write(filePath);
    addLog('info', `结果已导出到: ${filePath}`);
}

//  主爬虫函数
async function crawlScopusAuthors(authorInput, options = {}) {
    if (crawlerState.isRunning) {
        throw new Error('爬虫已在运行中，请勿重复启动');
    }
    resetCrawlerState();
    crawlerState.isRunning = true;
    shouldStop = false;
    let browser, page;
    let authors = [];
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



    try {
        // 解析作者列表
        if (Array.isArray(authorInput)) {
            if (authorInput.length === 0) {
                throw new Error('作者列表不能为空');
            }
            const first = authorInput[0];
            if (typeof first === 'string') {
                authors = authorInput.map(name => {
                    const parts = name.trim().split(/\s+/);
                    if (parts.length === 1) {
                        return new AuthorInfo(parts[0], '');
                    } else if (parts.length === 2) {
                        return new AuthorInfo(parts[0], parts[1]);
                    } else {
                        const lastName = parts[0];
                        const firstName = parts.slice(1).join(' ');
                        return new AuthorInfo(lastName, firstName);
                    }
                });
            } else if (typeof first === 'object' && first !== null) {
                authors = authorInput.map(item => {
                    // 检查是否有 familyName 和 givenName
                    const familyName = item.familyName || '';
                    const givenName = item.givenName  || '';
                    // 如果 familyName 和 givenName 都有值，则直接使用
                    if (familyName && givenName) {
                        return new AuthorInfo(familyName, givenName, item.orcid || '');
                    } else if (item.authorName) {
                        // 否则，如果提供了 authorName，则拆分
                        const nameParts = item.authorName.trim().split(/\s+/);
                        const lastName = nameParts[0];
                        const firstName = nameParts.slice(1).join(' ');
                        return new AuthorInfo(lastName, firstName, item.orcid || '');
                    }
                });
            }else {
                throw new Error('authorInput 必须是字符串数组或对象数组');
            }
        } else {
            throw new Error('authorInput 必须是数组');
        }

        authors = authors.filter(a => a.lastName.trim() !== '');
        if (authors.length === 0) {
            throw new Error('没有有效的作者信息');
        }



        const logBaseDir = userConfig.LOG_BASE_DIR || path.join(process.cwd(), 'logs');
        ensureDir(logBaseDir);
        const logFilePath = path.join(logBaseDir, `${timestamp}_scopus_author_crawler.log`);
        logStream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });
        addLog('info', `输出目录: ${currentOutputDir}`);

        const outputDirs = { data: dataDir };
        // 启动浏览器
        const env = await setupBrowserEnvironment();
        browser = env.browser;
        page = env.page;

        // 访问首页
        addLog('info', '正在访问 Scopus 首页...');
        await page.goto('https://www.scopus.com/pages/home', { waitUntil: 'domcontentloaded', timeout: 60000 });

        // 查找并点击 "Author Search"
        addLog('info', '正在查找 "Author Search" 链接...');
        let authorSearchLink = null;
        const selectors = [
            'a:has-text("Author Search")',
            'a:has-text("Author search")',
            'a:has-text("作者检索")',
            'a:has-text("作者搜索")',
            'a:has-text("Authors")',
            'a:has-text("Find an author")',
            'a[href*="author.uri"]',
            'a[href*="/author/search"]'
        ];

        for (const selector of selectors) {
            const link = await page.$(selector);
            if (link) {
                authorSearchLink = link;
                addLog('info', `使用选择器 "${selector}" 找到链接`);
                break;
            }
        }

        if (!authorSearchLink) {
            const allLinks = await page.$$eval('a', links => links.map(l => l.textContent.trim()).filter(t => t));
            addLog('warn', '未找到 "Author Search" 链接，页面中所有链接文本:');
            console.log(allLinks.slice(0, 30));
            throw new Error('未找到 "Author Search" 链接');
        }

        addLog('info', '点击 "Author Search" 链接...');
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
            authorSearchLink.click()
        ]);

        addLog('info', `当前页面 URL: ${page.url()}`);
        addLog('info', `页面标题: ${await page.title()}`);


        await page.waitForTimeout(3000);
        await page.waitForSelector('input[name="searchterm1"]', { timeout: 15000 });

        // 批量搜索
        const results = await searchAuthors(page, authors, outputDirs);

        // 保存结果
        const resultFilePath = path.join(dataDir, 'search_results.json');
        fs.writeFileSync(resultFilePath, JSON.stringify(results, null, 2), 'utf8');
        addLog('info', `搜索结果已保存到: ${resultFilePath}`);

        // 根据 generateExcel 参数决定是否生成 Excel
        if (options.generateExcel !== false) {
            const excelFileName = `scopus_authors_${timestamp}.xlsx`;
            const excelFilePath = path.join(dataDir, excelFileName);
            writeToExcel(results, excelFilePath);
            crawlerState.filePaths.resultExcel = excelFilePath;
        }else {
            crawlerState.filePaths.resultExcel = '';
        }
        crawlerState.result = results;
        crawlerState.progress = 100;
        addLog('success', `批量搜索完成，共处理 ${results.length} 位作者`);
        return results;
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
        const formattedError = formatError(error, 'scopus-author');
        crawlerState.error = formattedError;
        // 将原始详细信息写入日志
        addLog('info', formattedError.detail);
        addLog('error', `用户提示：${formattedError.userMessage}`);
        // 抛出自定义错误
        throw formattedError;
    } finally {
        crawlerState.isRunning = false;
        if (page) await page.waitForTimeout(3000);
        if (browser) await browser.close();
        if (logStream) logStream.end();
        browserInstance = null;
        // 清理空输出目录
        cleanEmptyDirectory(currentOutputDir);
        addLog('info', '爬虫执行结束');
    }
}

//  导出
module.exports = {
    crawlScopusAuthors,
    getCrawlerState,
    resetCrawlerState,
    stopCrawler
};

// 直接运行时的测试
if (require.main === module) {
    const testAuthors = [
        { lastName: 'Brook', firstName: 'A H' },
        { lastName: 'Stommel', firstName: 'J' },
        { lastName: 'Gorichanaz', firstName: 'T' }
    ];
    crawlScopusAuthors(testAuthors, { saveDebug: true })
        .then(results => {
            console.log('爬取完成，结果数量:', results.length);
            process.exit(0);
        })
        .catch(err => {
            console.error('爬取失败:', err);
            process.exit(1);
        });
}
