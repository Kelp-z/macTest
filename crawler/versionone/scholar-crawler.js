// 检查是否在打包环境中
const isPkg = typeof process.pkg !== 'undefined';
// 添加全局锁或检查
let browserInstance = null;
let currentUserDataDir = null; // 新增：记录当前临时目录
let currentOutputDir = null;   // 新增：记录当前输出目录
// 文件流变量
let logStream = null;
// 全局状态/日志管理
let crawlerState = {
    isRunning: false,       // 爬虫是否运行中
    progress: 0,            // 爬取进度（0-100）
    logs: [],               // 实时日志
    result: {               // 爬取结果
        successCount: 0,
        failedCount: 0,
        successList: [],
        failedList: []
    },
    filePaths: {            // 生成的文件路径
        successExcel: '',
        failedExcel: '',
        endnoteExcel: '',
        endnoteDir: ''
    },
    error: null,            // 错误信息
    currentDir: '',          // 新增：记录当前检索的目录
    logIndex: 0 // 新增：记录前端已读取的日志索引
};

// 重置爬虫状态（每次启动前调用）
function resetCrawlerState() {
    crawlerState = {
        isRunning: false,
        progress: 0,
        logs: [],
        result: {successCount: 0, failedCount: 0, successList: [], failedList: []},
        filePaths: {successExcel: '', failedExcel: '', endnoteExcel: '', endnoteDir: ''},
        error: null,
        currentDir: '',
        logIndex: 0 // 重置日志索引
    };
    // 重置全局变量
    successPaperList = [];
    failedPaperList = [];
    fileIndex = 1;
    currentUserDataDir = null;
    currentOutputDir = null;
}

// 随机延迟函数（毫秒）
async function randomDelay(page, min = 500, max = 1500) {
    const delay = min + Math.random() * (max - min);
    await page.waitForTimeout(delay);
}

// 停止爬虫函数
async function stopCrawler() {
    addLog('warn', '开始停止当前检索任务...');

    // 1. 标记爬虫为停止状态
    crawlerState.isRunning = false;
    crawlerState.progress = 0;

    // 2. 强制关闭浏览器实例
    if (browserInstance) {
        try {
            await browserInstance.close();
            addLog('success', '浏览器实例已关闭');
        } catch (e) {
            addLog('error', `关闭浏览器失败：${e.message}`);
            // 兜底：强制杀死Chromium进程
            if (process.platform === 'win32') {
                try {
                    require('child_process').execSync('taskkill /F /IM chrome.exe /T 2>nul');
                    require('child_process').execSync('taskkill /F /IM chromium.exe /T 2>nul');
                    addLog('success', '已强制杀死残留浏览器进程');
                } catch (err) {
                }
            }
        } finally {
            browserInstance = null;
        }
    }

    // 3. 清理临时目录
    if (currentUserDataDir) {
        try {
            require('fs').rmSync(currentUserDataDir, {recursive: true, force: true});
            addLog('success', `已清理临时目录：${currentUserDataDir}`);
        } catch (e) {
            addLog('error', `清理临时目录失败：${e.message}`);
        }
    }

    addLog('success', '检索任务已停止');
}

// 新增：删除检索目录函数
function deleteCrawlerDir(dirPath) {
    addLog('warn', `开始删除检索目录：${dirPath}`);
    const fs = require('fs');
    const path = require('path');

    // 支持删除多个目录/文件
    const pathsToDelete = [
        dirPath,
        crawlerState.filePaths.successExcel,
        crawlerState.filePaths.failedExcel,
        crawlerState.filePaths.endnoteExcel,
        crawlerState.filePaths.endnoteDir
    ];

    for (const p of pathsToDelete) {
        if (p && fs.existsSync(p)) {
            try {
                if (fs.statSync(p).isDirectory()) {
                    fs.rmSync(p, {recursive: true, force: true});
                    addLog('success', `已删除目录：${p}`);
                } else {
                    fs.unlinkSync(p);
                    addLog('success', `已删除文件：${p}`);
                }
            } catch (e) {
                addLog('error', `删除 ${p} 失败：${e.message}`);
            }
        }
    }
}

// 新增：重启检索函数
async function restartCrawler(customKeywords = []) {
    // 1. 停止当前爬虫
    await stopCrawler();

    // 2. 删除上一次检索的目录
    if (crawlerState.currentDir) {
        deleteCrawlerDir(crawlerState.currentDir);
    }

    // 3. 重置状态
    resetCrawlerState();

    // 4. 重新启动检索
    addLog('info', '开始重新执行检索任务');
    return await crawlGoogleScholar(customKeywords);
}

// 添加日志（带时间戳）
function addLog(type, content) {
    const log = {
        time: new Date().toLocaleTimeString(),
        type: type, // info/success/warn/error
        content: content
    };
    crawlerState.logs.push(log);
    // 限制日志长度（避免内存溢出）
    if (crawlerState.logs.length > 1000) {
        crawlerState.logs = crawlerState.logs.slice(-500);
    }
    // 后端终端打印
    const logLine = `[${log.time}] [${log.type}] ${log.content}`;
    console.log(logLine);

    if (logStream && logStream.writable) {
        logStream.write(logLine + '\n');
    }
}

// 清理函数（同步版本）
function cleanupAllChromiumData() {
    addLog('info', '=== 开始清理 Chromium 数据 ===\n');

    const {execSync} = require('child_process');
    const os = require('os');
    const fs = require('fs');
    const path = require('path');

    // 杀死残留进程（同步）
    try {
        if (process.platform === 'win32') {
            execSync('taskkill /F /IM chrome.exe /T 2>nul', {stdio: 'ignore'});
            execSync('taskkill /F /IM chromium.exe /T 2>nul', {stdio: 'ignore'});
            addLog('success', '✓ 已终止残留进程');
        }
    } catch (e) {
    }

    // 删除临时目录（同步）
    const tmpDir = os.tmpdir();
    try {
        const files = fs.readdirSync(tmpDir);
        for (const file of files) {
            if (file.startsWith('scholar_') || file.startsWith('playwright_')) {
                const fullPath = path.join(tmpDir, file);
                try {
                    fs.rmSync(fullPath, {recursive: true, force: true});
                    addLog('success', `✓ 删除: ${file}`);
                } catch (e) {
                }
            }
        }
    } catch (e) {
    }

    addLog('info', '=== 清理完成 ===\n');
}

// 全局错误捕获
process.on('uncaughtException', (error) => {
    console.error('致命错误:', error.message);
    console.error('堆栈:', error.stack);

    // 将错误写入文件以便调试
    const fs = require('fs');
    const path = require('path');
    const crashLog = path.join(process.cwd(), 'crash.log');
    const errorInfo = `
崩溃时间: ${new Date().toISOString()}
错误信息: ${error.message}
堆栈追踪: ${error.stack}

系统信息:
- 平台: ${process.platform}
- 架构: ${process.arch}
- Node版本: ${process.version}
- 打包环境: ${isPkg}
- 执行路径: ${process.execPath}
- 当前目录: ${process.cwd()}
- 内存: ${JSON.stringify(process.memoryUsage(), null, 2)}
    `;

    fs.writeFileSync(crashLog, errorInfo);
    addLog('error', '错误日志已保存到: crash.log');

    // 延迟退出以便用户能看到错误信息
    setTimeout(() => process.exit(1), 3000);
});

process.on('unhandledRejection', (reason, promise) => {
    addLog('error', `未处理的Promise拒绝: ${reason}`);
});

// 浏览器路径查找函数
function findLocalBrowser() {
    const fs = require('fs');
    const path = require('path');

    addLog('info', '\n=== 开始查找本地浏览器 ===');
    addLog('info', `当前目录: ${process.cwd()}`);

    // 完整的搜索路径（考虑目录层级）
    const searchPaths = [
        // 打包环境：完整路径
        path.join(path.dirname(process.execPath), 'browsers', 'chromium-*', 'chrome-win64', 'chrome.exe'),
        path.join(path.dirname(process.execPath), 'browsers', 'chrome-win64', 'chrome.exe'),

        // 开发环境：完整路径
        path.join(process.cwd(), 'browsers', 'chromium-*', 'chrome-win64', 'chrome.exe'),
        path.join(process.cwd(), 'browsers', 'chrome-win64', 'chrome.exe'),

        // 尝试查找 chromium 子目录
        path.join(process.cwd(), 'browsers', '**', 'chrome-win64', 'chrome.exe'),
        path.join(process.cwd(), 'browsers', '**', 'chrome.exe'),

        // 备用简单路径
        path.join(process.cwd(), 'browsers', 'chrome.exe'),
        path.join(process.cwd(), 'chrome.exe')
    ];

    addLog('info', '搜索路径:');
    for (const searchPath of searchPaths) {
        addLog('info', `  - ${searchPath}`);
    }

    // 不使用 glob，但使用递归查找
    addLog('info', '\n尝试递归查找...');

    function findBrowserRecursive(dir) {
        try {
            const items = fs.readdirSync(dir, {withFileTypes: true});

            for (const item of items) {
                const fullPath = path.join(dir, item.name);

                if (item.isDirectory()) {
                    // 如果是目录，递归查找
                    const found = findBrowserRecursive(fullPath);
                    if (found) return found;
                } else if (item.name.toLowerCase() === 'chrome.exe') {
                    // 找到 chrome.exe
                    addLog('success', `✓ 找到浏览器（递归查找）: ${fullPath}`);
                    return fullPath;
                }
            }
        } catch (error) {
            // 忽略无法访问的目录
        }
        return null;
    }

    // 在几个关键目录中递归查找
    const keyDirs = [
        path.join(process.cwd(), 'browsers'),
        path.join(path.dirname(process.execPath), 'browsers'),
        process.cwd(),
        path.dirname(process.execPath)
    ];

    for (const keyDir of keyDirs) {
        if (fs.existsSync(keyDir)) {
            const found = findBrowserRecursive(keyDir);
            if (found) {
                const stats = fs.statSync(found);
                addLog('info', `  文件大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
                return found;
            }
        }
    }

    addLog('warn', '\n✗ 未找到本地浏览器文件');
    return null;
}

// 检查并下载浏览器的函数
async function ensureBrowser() {
    const fs = require('fs');
    const path = require('path');

    addLog('info', '\n=== 检查浏览器环境 ===');

    // 1. 先查找本地已有的浏览器
    const localBrowser = findLocalBrowser();

    if (localBrowser) {
        addLog('info', '使用本地浏览器文件');
        return localBrowser;
    }

    // 2. 如果没有找到，尝试自动下载
    addLog('info', '\n未找到本地浏览器，尝试自动下载...');
    addLog('info', '注意：下载需要网络连接，文件约150MB');

    try {
        // 设置下载目录为当前目录下的 browsers 文件夹
        const downloadDir = path.join(process.cwd(), 'browsers');
        addLog('info', `浏览器将下载到: ${downloadDir}`);

        // 创建目录
        if (!fs.existsSync(downloadDir)) {
            fs.mkdirSync(downloadDir, {recursive: true});
        }

        // 设置环境变量，让Playwright下载到指定目录
        process.env.PLAYWRIGHT_BROWSERS_PATH = downloadDir;

        addLog('info', '正在下载Chromium浏览器，请稍候...');
        addLog('info', '这可能需要几分钟，取决于网络速度...');

        // 使用子进程下载浏览器（更可靠）
        const {execSync} = require('child_process');
        execSync(`npx playwright install chromium`, {
            stdio: 'inherit',
            cwd: process.cwd(),
            env: {...process.env, PLAYWRIGHT_BROWSERS_PATH: downloadDir}
        });

        addLog('success', '✓ 浏览器下载完成！');

        // 重新查找
        return findLocalBrowser();

    } catch (downloadError) {
        addLog('error', `浏览器下载失败: ${downloadError.message}`);
        addLog('info', '\n===== 手动下载指南 =====');
        addLog('info', '1. 请确保网络连接正常');
        addLog('info', '2. 或手动下载浏览器文件：');
        addLog('info', '   - 从 http://commondatastorage.googleapis.com/chromium-browser-snapshots/index.html 下载');
        addLog('info', '   - 解压到程序目录下的 "browsers/chrome-win/" 文件夹');
        addLog('info', '   - 确保 chrome.exe 文件存在');

        return null;
    }
}

const {chromium} = require('playwright');
const excel = require('excel4node');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {copyFileSync, existsSync, mkdirSync, readFileSync} = require('fs');
// 导入配置管理器
const ConfigManager = require('./config-manager');
const configManager = new ConfigManager();

const TIMESTAMP = new Date().toISOString().replace(/[-:\.T]/g, '').slice(0, 15);

// 从配置管理器获取
const PRECISE_SEARCH_ENABLED = configManager.get('search.preciseSearchEnabled', true);
const TITLE_SIMILARITY_THRESHOLD = configManager.get('search.titleSimilarityThreshold', 0.8);

let successPaperList = [];
let failedPaperList = [];
let fileIndex = 1;

class PaperInfo {
    constructor(title, authors, abstractText, citations, year, publication, remark, searchTime, resultCountFormatted, endNoteLink) {
        this.title = title;
        this.authors = authors;
        this.abstract = abstractText;
        this.citations = citations;
        this.year = year;
        this.publication = publication;
        this.remark = remark;
        this.searchTime = searchTime;
        this.resultCountFormatted = resultCountFormatted;
        this.endNoteLink = endNoteLink;
        this.downloadedFilePath = '';
    }
}

class EndNoteInfo {
    constructor(
        recordNumber,
        title,
        authors,
        journal,
        year,
        volume,
        issue,
        pages,
        abstractText,
        doi,
        url,
        publicationType,
        publisher,
        filePath
    ) {
        this.recordNumber = recordNumber;
        this.title = title;
        this.authors = authors;
        this.journal = journal;
        this.year = year;
        this.volume = volume;
        this.issue = issue;
        this.pages = pages;
        this.abstract = abstractText;
        this.doi = doi;
        this.url = url;
        this.publicationType = publicationType;
        this.publisher = publisher;
        this.filePath = filePath;
    }
}

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
            if (element && await element.isVisible()) {
                return true;
            }
        } catch (error) {
        }
    }

    const url = page.url();
    const captchaKeywords = ['sorry', 'captcha', 'recaptcha'];
    if (captchaKeywords.some(keyword => url.toLowerCase().includes(keyword))) {
        return true;
    }

    const pageContent = await page.content();
    const contentKeywords = [
        '请进行人机身份验证',
        '检测到异常流量',
        'unusual traffic',
        'automated requests'
    ];
    if (contentKeywords.some(keyword => pageContent.toLowerCase().includes(keyword.toLowerCase()))) {
        return true;
    }

    return false;
}

async function handleCaptchaManually(page) {
    addLog('warn', '====================================');
    addLog('warn', '⚠️  检测到人机身份验证！');
    addLog('warn', '📌 请在弹出的浏览器窗口中手动完成验证');
    addLog('warn', '📌 完成后脚本会自动继续运行');
    addLog('warn', '====================================\n');

    await page.bringToFront();
    if (!existsSync(path.join(currentOutputDir, 'screenshots'))) mkdirSync(path.join(currentOutputDir, 'screenshots'), {recursive: true});
    await page.screenshot({path: path.join(currentOutputDir, 'screenshots', `captcha_detected_${Date.now()}.png`)});

    try {
        const captchaElement = await page.$('.g-recaptcha, #captcha-form, [class*="captcha"], .rc-anchor, div:has-text("请进行人机身份验证")');
        if (captchaElement) {
            await captchaElement.evaluate((element) => {
                element.style.border = '3px solid red';
                element.style.boxShadow = '0 0 20px yellow';
                element.scrollIntoView({behavior: 'smooth', block: 'center'});
            });
        }
    } catch (error) {
    }

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
                const searchResults = await page.$('#gs_res_ccl_mid, .gs_r, .gsc_a_tr');
                if (searchResults) {
                    captchaResolved = true;
                    addLog('success', '\n✅ 验证已完成，继续爬取数据...\n');
                    break;
                }
            } catch (error) {
                captchaResolved = true;
                addLog('success', '\n✅ 页面已恢复正常，继续爬取数据...\n');
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
        addLog('error', '\n❌ 等待验证超时（10分钟），请重新运行脚本并及时完成验证');
        throw new Error('人机验证处理超时');
    }

    await page.waitForTimeout(3000);
}

async function waitForSearchOrCaptcha(page, timeout = 30000) {
    try {
        await page.waitForTimeout(3000);

        if (await checkForCaptcha(page)) {
            addLog('info', '🔍 等待搜索结果时检测到人机验证...');
            await handleCaptchaManually(page);
        }

        try {
            await page.waitForSelector('#gs_res_ccl_mid', {timeout: timeout});
        } catch (error) {
            await page.waitForSelector('.gsc_a_tr, .gs_r, .gs_scl', {timeout: 5000});
        }

    } catch (error) {
        if (await checkForCaptcha(page)) {
            addLog('info', '⏱️  等待搜索结果超时，检测到人机验证...');
            await handleCaptchaManually(page);
            await waitForSearchOrCaptcha(page, timeout);
        } else {
            addLog('info', '⚠️  等待搜索结果失败，但未检测到验证，继续尝试...');
        }
    }
}

function getTestPaperInfoList() {
    return [
        // 1. Brook, A. (2022)
        new PaperInfo(
            "(Un)making the grade: An instructor's guide to mitigating the negative impacts of grades within a neoliberal university system",
            "Brook, A.",
            "", // abstractText
            "", // citations
            "2022",
            "McGill Journal of Education, 57(2), 195-210",
            "ungrading assessment", // remark (原searchKeyword)
            "2024-01-01", // searchTime (原extractTime)
            "", // resultCountFormatted
            ""  // endNoteLink
        ),
        // 2. Stommel, J. (2020)
        new PaperInfo(
            "How to ungrade",
            "Stommel, J.",
            "",
            "",
            "2020",
            "In S. D. Blum (Ed.), Ungrading: Why rating students undermines learning (and what to do instead) (pp. 25-42). West Virginia University Press",
            "ungrading how-to",
            "2024-01-01",
            "",
            ""
        ),
        // 3. Stommel, J. (2023)
        new PaperInfo(
            "Do we need the word 'ungrading'?",
            "Stommel, J.",
            "",
            "",
            "2023",
            "Zeal: A Journal for the Liberal Arts, 1(2), 82-87",
            "ungrading terminology",
            "2024-01-01",
            "",
            ""
        ),
        // 4. Gorichanaz, T. (2024)
        new PaperInfo(
            "\"It made me feel like it was okay to be wrong\": Student experiences with ungrading",
            "Gorichanaz, T.",
            "",
            "",
            "2024",
            "Active Learning in Higher Education, 25(1), 67-80",
            "student experiences ungrading",
            "2024-01-01",
            "",
            ""
        ),
        // 5. Katopodis, C. (2023)
        new PaperInfo(
            "Self-evaluation: The humanistic skill we need in a just society",
            "Katopodis, C.",
            "",
            "",
            "2023",
            "Zeal: A Journal for the Liberal Arts, 1(2), 141-146",
            "self-evaluation assessment",
            "2024-01-01",
            "",
            ""
        ),
        // 6. McCloud, L. I. (2023)
        new PaperInfo(
            "Keeping receipts: Thoughts on ungrading from a Black woman professor",
            "McCloud, L. I.",
            "",
            "",
            "2023",
            "Zeal: A Journal for the Liberal Arts, 1(2), 101-105",
            "ungrading diversity equity",
            "2024-01-01",
            "",
            ""
        ),
        // 7. Shepard, L. A., Penuel, W. R., & Pellegrino, J. W. (2018)
        new PaperInfo(
            "Using learning and motivation theories to coherently link formative assessment, grading practices, and large-scale assessment",
            "Shepard, L. A., Penuel, W. R., & Pellegrino, J. W.",
            "",
            "",
            "2018",
            "Educational Measurement: Issues and Practice, 37(1), 21-34",
            "formative assessment grading",
            "2024-01-01",
            "",
            ""
        ),
        // 8. Cochran-Smith, M., & Lytle, S. (1999)  （原有数据，保留）
        new PaperInfo(
            "Relationships of knowledge and practice: Teacher learning communities",
            "Cochran-Smith, M., & Lytle, S.",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            ""
        ),
        // 9. Wormeli, R. (2011)  （原有数据，保留）
        new PaperInfo(
            "Redos and retakes done right",
            "Wormeli, R.",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            ""
        ),
        // 10. Katopodis, C., & Davidson, C. N. (2020)  （原有数据，保留）
        new PaperInfo(
            "Contract grading and peer review",
            "Katopodis, C., & Davidson, C. N.",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            ""
        ),
        // 11. Sackstein, S. (2020)
        new PaperInfo(
            "Shifting the grading mindset",
            "Sackstein, S.",
            "",
            "",
            "2020",
            "In S. D. Blum (Ed.), Ungrading: Why rating students undermines learning (and what to do instead) (pp. 74-81). West Virginia University Press",
            "grading mindset change",
            "2024-01-01",
            "",
            ""
        )
    ];
}

function generateSearchKeywords(testData) {
    const keywords = [];
    for (const paper of testData) {
        const author = paper.authors || "";
        let title = paper.title || "";

        let cleanTitle = title.replace(/["':]/g, " ").trim();
        if (cleanTitle.length > 100) cleanTitle = cleanTitle.substring(0, 100);

        let searchKeyword;
        if (PRECISE_SEARCH_ENABLED) {
            searchKeyword = `"${cleanTitle}" ${author}`;
        } else {
            searchKeyword = `${author} ${cleanTitle}`;
        }

        if (searchKeyword.length > 150) searchKeyword = searchKeyword.substring(0, 150);
        keywords.push(searchKeyword.trim());
    }
    return keywords;
}

function formatResultCount(count) {
    if (count === 1) return "1";
    else if (count > 1) return "大于1";
    return "0";
}

function calculateStringSimilarity(str1, str2) {
    if (!str1 || !str2) return 0.0;

    const shorter = str1.length <= str2.length ? str1.toLowerCase() : str2.toLowerCase();
    const longer = str1.length > str2.length ? str1.toLowerCase() : str2.toLowerCase();

    let matches = 0;
    for (let i = 0; i < shorter.length - 2; i++) {
        const substr = shorter.substring(i, i + 3);
        if (longer.includes(substr)) matches++;
    }

    return Math.min(1.0, matches / Math.max(1, (shorter.length / 3)));
}

function calculateMatchSimilarity(originalPaper, foundTitle, foundAuthors) {
    if (!originalPaper || !foundTitle || !foundAuthors) return 0.0;

    const titleSimilarity = calculateStringSimilarity(originalPaper.title, foundTitle);
    const authorSimilarity = calculateStringSimilarity(originalPaper.authors, foundAuthors);

    return titleSimilarity * 0.7 + authorSimilarity * 0.3;
}

async function closeCitationPopup(page) {
    try {
        const closeButton = page.locator("#gs_cit-x");
        if (await closeButton.isVisible()) {
            await humanClick(page, closeButton);
            await randomDelay(page);
            addLog('info', "已关闭引用弹窗");
            await page.waitForSelector("#gs_cit", {state: "hidden", timeout: 3000});
        }
    } catch (e) {
        addLog('info', `关闭弹窗失败: ${e.message}`);
    }
}

async function humanType(page, locator, text) {
    await locator.fill('');
    for (const char of text) {
        await locator.type(char, { delay: 50 + Math.random() * 80 });
        await page.waitForTimeout(10);
    }
}
async function humanClick(page, locator) {
    try {
        const box = await locator.boundingBox();
        if (box) {
            await page.mouse.move(box.x + 10, box.y + 10, { steps: 8 });
            await page.waitForTimeout(200);
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
            await page.waitForTimeout(150);
        }
        await locator.click({ delay: 150 });
        return true;
    } catch (e) {
        addLog(`人类点击模拟失败: ${e.message}`);
        return false;
    }
}

async function extractAndDownloadEndNoteFile(page, result) {
    let endNoteLink = null;
    let downloadedFilePath = null;

    try {
        let citeButton = result.locator(".gs_or_cit").first();
        if (!await citeButton.isVisible()) {
            citeButton = result.locator("a[class*='gs_or_cit']").first();
        }

        if (await citeButton.isVisible()) {
            addLog('info', "点击引用按钮...");
            await citeButton.click();
            await randomDelay(page);  // 随机延迟
            await page.waitForSelector("#gs_cit", {timeout: 5000});
            await page.waitForSelector("#gs_cit .gs_citi[href*='scholar.enw']", {timeout: 5000});

            const endNoteLinkElement = page.locator("#gs_cit .gs_citi[href*='scholar.enw']").first();
            if (await endNoteLinkElement.isVisible()) {
                endNoteLink = await endNoteLinkElement.getAttribute("href");
                addLog('info', `EndNote链接: ${endNoteLink}`);

                let downloadPromise;
                try {
                    downloadPromise = page.waitForDownload({timeout: 10000});
                    await humanClick(page, endNoteLinkElement);
                    await randomDelay(page);

                    const download = await downloadPromise;
                    const tempFilePath = await download.path();
                    addLog('info', `临时文件路径: ${tempFilePath}`);

                    if (existsSync(tempFilePath)) {
                        if (!existsSync(crawlerState.filePaths.endnoteDir)) {
                            mkdirSync(crawlerState.filePaths.endnoteDir, {recursive: true});
                        }

                        const targetFileName = `scholar_${fileIndex}.enw`;
                        fileIndex++;
                        downloadedFilePath = path.join(crawlerState.filePaths.endnoteDir, targetFileName);

                        copyFileSync(tempFilePath, downloadedFilePath);
                        addLog('info', `EndNote文件已保存到: ${downloadedFilePath}`);
                    }
                } catch (e) {
                    addLog('info', "正在下载...");
                    downloadPromise = new Promise((resolve) => {
                        page.once('download', resolve);
                    });
                    await humanClick(page, endNoteLinkElement);
                    await randomDelay(page);

                    const download = await downloadPromise;
                    const tempFilePath = await download.path();

                    if (existsSync(tempFilePath)) {
                        if (!existsSync(crawlerState.filePaths.endnoteDir)) {
                            mkdirSync(crawlerState.filePaths.endnoteDir, {recursive: true});
                        }

                        const targetFileName = `scholar_${fileIndex}.enw`;
                        fileIndex++;
                        downloadedFilePath = path.join(crawlerState.filePaths.endnoteDir, targetFileName);

                        copyFileSync(tempFilePath, downloadedFilePath);
                        addLog('info', `EndNote文件已保存到: ${downloadedFilePath}`);
                    }
                }

                await closeCitationPopup(page);
            }
        } else {
            addLog('info', "未找到引用按钮");
        }
    } catch (e) {
        addLog('info', `下载EndNote失败: ${e.message}`);
        await closeCitationPopup(page);
    }

    return {endNoteLink, downloadedFilePath};
}

function parseEndNoteFile(filePath) {
    try {
        let content;
        try {
            content = readFileSync(filePath, 'utf8');
        } catch (e) {
            content = readFileSync(filePath, 'latin1');
        }

        const lines = content.split(/\r?\n/);

        const fields = {
            '%T': 'title',
            '%A': 'authors',
            '%J': 'journal',
            '%D': 'year',
            '%V': 'volume',
            '%N': 'issue',
            '%P': 'pages',
            '%X': 'abstract',
            '%R': 'doi',
            '%U': 'url',
            '%TY': 'type',
            '%C': 'city',
            '%I': 'publisher',
            '%KW': 'keywords',
            '%PB': 'publisher',
            '%SN': 'issn',
            '%AU': 'authors',
            '%TI': 'title'
        };

        const parsedData = {
            recordNumber: '',
            title: '',
            authors: '',
            journal: '',
            year: '',
            volume: '',
            issue: '',
            pages: '',
            abstract: '',
            doi: '',
            url: '',
            publicationType: '',
            publisher: '',
            filePath: filePath
        };

        const authorList = [];

        for (const line of lines) {
            if (!line || line.trim() === '') continue;

            const fieldCode = line.substring(0, 2);
            if (!fields[fieldCode]) continue;

            let value = line.substring(2).trim();
            if (!value) continue;

            switch (fieldCode) {
                case '%A':
                    authorList.push(value);
                    break;
                case '%T':
                    parsedData.title = value;
                    break;
                case '%J':
                    parsedData.journal = value;
                    break;
                case '%D':
                    const yearMatch = value.match(/\b(19|20)\d{2}\b/);
                    parsedData.year = yearMatch ? yearMatch[0] : value;
                    break;
                case '%V':
                    parsedData.volume = value;
                    break;
                case '%N':
                    parsedData.issue = value;
                    break;
                case '%P':
                    parsedData.pages = value;
                    break;
                case '%X':
                    parsedData.abstract = value;
                    break;
                case '%R':
                    parsedData.doi = value;
                    break;
                case '%U':
                    parsedData.url = value;
                    break;
                case '%TY':
                    parsedData.publicationType = value;
                    break;
                case '%I':
                    parsedData.publisher = value;
                    break;
                default:
                    break;
            }
        }

        if (authorList.length > 0) {
            parsedData.authors = authorList.join('; ');
        }

        const fileName = path.basename(filePath);
        const numMatch = fileName.match(/\d+/);
        parsedData.recordNumber = numMatch ? numMatch[0] : '0';

        return new EndNoteInfo(
            parsedData.recordNumber,
            parsedData.title || '未找到标题',
            parsedData.authors || '未找到作者',
            parsedData.journal || '未找到期刊',
            parsedData.year || '未找到年份',
            parsedData.volume || '无',
            parsedData.issue || '无',
            parsedData.pages || '无',
            parsedData.abstract || '未找到摘要',
            parsedData.doi || '无',
            parsedData.url || '无',
            parsedData.publicationType || 'Unknown',
            parsedData.publisher || '无',
            parsedData.filePath
        );
    } catch (error) {
        addLog('error', `解析文件 ${filePath} 失败: ${error.message}`);
        return new EndNoteInfo(
            '0',
            `解析失败: ${error.message}`,
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            'Error',
            '',
            filePath
        );
    }
}

function parseEndNoteFilesAndExportExcel(dirPath) {
    addLog('info', '====================================');
    addLog('info', '开始解析EndNote (.enw) 文件');
    addLog('info', '====================================');

    if (!existsSync(dirPath)) {
        addLog('info', `目录不存在: ${dirPath}`);
        return [];
    }

    const files = fs.readdirSync(dirPath);
    const enwFiles = files
        .filter(file => file.toLowerCase().endsWith('.enw'))
        .map(file => path.join(dirPath, file));

    if (enwFiles.length === 0) {
        addLog('info', `目录 ${dirPath} 中未找到.enw文件`);
        return [];
    }

    addLog('info', `找到 ${enwFiles.length} 个.enw文件，开始解析...`);

    const parsedDataList = [];
    for (const filePath of enwFiles) {
        addLog('info', `解析文件: ${path.basename(filePath)}`);
        const parsedData = parseEndNoteFile(filePath);
        parsedDataList.push(parsedData);
    }

    if (parsedDataList.length > 0) {
        const workbook = new excel.Workbook();
        const worksheet = workbook.addWorksheet('EndNote解析结果');

        const headers = [
            '记录编号',
            '标题',
            '作者',
            '期刊/出版物',
            '年份',
            '卷',
            '期',
            '页码',
            '摘要',
            'DOI',
            'URL链接',
            '出版类型',
            '出版商',
            '源文件路径'
        ];

        headers.forEach((header, index) => {
            worksheet.cell(1, index + 1)
                .string(header)
                .style({font: {bold: true}});
        });

        parsedDataList.forEach((data, rowIndex) => {
            const row = rowIndex + 2;
            worksheet.cell(row, 1).string(data.recordNumber);
            worksheet.cell(row, 2).string(data.title);
            worksheet.cell(row, 3).string(data.authors);
            worksheet.cell(row, 4).string(data.journal);
            worksheet.cell(row, 5).string(data.year);
            worksheet.cell(row, 6).string(data.volume);
            worksheet.cell(row, 7).string(data.issue);
            worksheet.cell(row, 8).string(data.pages);
            worksheet.cell(row, 9).string(data.abstract);
            worksheet.cell(row, 10).string(data.doi);
            worksheet.cell(row, 11).string(data.url);
            worksheet.cell(row, 12).string(data.publicationType);
            worksheet.cell(row, 13).string(data.publisher);
            worksheet.cell(row, 14).string(data.filePath);
        });

        workbook.write(crawlerState.filePaths.endnoteExcel);
        addLog('info', `\nEndNote解析结果已导出到: ${path.resolve(crawlerState.filePaths.endnoteExcel)}`);

        addLog('info', `\n解析完成统计:`);
        addLog('info', `- 总文件数: ${enwFiles.length}`);
        addLog('info', `- 成功解析: ${parsedDataList.filter(d => d.publicationType !== 'Error').length}`);
        addLog('info', `- 解析失败: ${parsedDataList.filter(d => d.publicationType === 'Error').length}`);
    }

    return parsedDataList;
}

async function extractTitle(result) {
    const selectors = ["h3.gs_rt a", "h3.gs_rt", ".gs_rt a", ".gs_rt"];
    for (const selector of selectors) {
        try {
            const titleElement = result.locator(selector).first();
            if (await titleElement.isVisible()) {
                let title = await titleElement.textContent();
                title = title.replace(/^\[PDF\]\s*/, "").replace(/^\[HTML\]\s*/, "").replace(/^\[图书\]\s*/, "").trim();
                if (title) return title;
            }
        } catch (e) {
        }
    }
    return "未找到标题";
}

async function extractAuthors(result) {
    try {
        const authorDiv = result.locator("div.gs_a").first();
        if (await authorDiv.isVisible()) {
            const fullText = await authorDiv.textContent();
            if (fullText.includes("-")) {
                return fullText.split("-")[0].trim();
            }
            return fullText.trim();
        }
    } catch (e) {
        addLog('info', `提取作者失败: ${e.message}`);
    }
    return "未找到作者";
}

async function extractPublication(result) {
    try {
        const authorDiv = result.locator("div.gs_a").first();
        if (await authorDiv.isVisible()) {
            const fullText = await authorDiv.textContent();
            if (fullText.includes("-")) {
                return fullText.split("-")[1].trim();
            }
            return fullText.trim();
        }
    } catch (e) {
        addLog('info', `提取出版信息失败: ${e.message}`);
    }
    return "";
}

async function extractAbstract(result) {
    try {
        const abstractElement = result.locator("div.gs_rs").first();
        if (await abstractElement.isVisible()) {
            const text = await abstractElement.textContent();
            return text.trim() || "未找到摘要";
        }
    } catch (e) {
        addLog('info', `提取摘要失败: ${e.message}`);
    }
    return "未找到摘要";
}

async function extractCitations(result) {
    try {
        const citationElement = result.locator("a:has-text('被引用次数'), a:has-text('Cited by')").first();
        if (await citationElement.isVisible()) {
            const text = await citationElement.textContent();
            const match = text.match(/\d+/);
            return match ? match[0] : "0";
        }
    } catch (e) {
        addLog('info', `提取引用数失败: ${e.message}`);
    }
    return "0";
}

function extractYear(text) {
    const match = text.match(/\b(19|20)\d{2}\b/);
    return match ? match[0] : "";
}

async function extractCompleteResult(result, searchKeyword, originalPaper, isMatch, searchType, resultCountFormatted, page) {
    const title = await extractTitle(result);
    const authors = await extractAuthors(result);
    const publication = await extractPublication(result);
    const year = extractYear(publication);
    const abstractText = await extractAbstract(result);
    const citations = await extractCitations(result);

    let endNoteLink = null;
    let downloadedFilePath = null;
    if (PRECISE_SEARCH_ENABLED && resultCountFormatted === "1") {
        const downloadResult = await extractAndDownloadEndNoteFile(page, result);
        endNoteLink = downloadResult.endNoteLink;
        downloadedFilePath = downloadResult.downloadedFilePath;
    }

    let remark = `${searchKeyword} [${searchType}${isMatch ? "-匹配" : ""}]`;
    if (downloadedFilePath) {
        remark += ` | EndNote文件: ${downloadedFilePath}`;
    } else if (endNoteLink) {
        remark += ` | EndNote链接: ${endNoteLink}`;
    }

    const searchTime = new Date().toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).replace(/\//g, '-');

    const paperInfo = new PaperInfo(
        title, authors, abstractText, citations, year, publication,
        remark, searchTime, resultCountFormatted, endNoteLink
    );
    paperInfo.downloadedFilePath = downloadedFilePath;

    return paperInfo;
}

async function handlePreciseSearch(page, searchResults, resultCount, searchKeyword, originalPaper, resultCountFormatted) {
    addLog('info', "执行精确搜索，查找最匹配结果");
    let bestMatch = null;
    let bestSimilarity = 0;

    const maxCheck = Math.min(resultCount, 5);
    for (let i = 0; i < maxCheck; i++) {
        const result = searchResults.nth(i);
        try {
            const title = await extractTitle(result);
            const authors = await extractAuthors(result);
            const similarity = calculateMatchSimilarity(originalPaper, title, authors);

            // addLog('info', `结果${i + 1}相似度: ${similarity.toFixed(2)}`);

            if (similarity > bestSimilarity) {
                bestSimilarity = similarity;
                bestMatch = await extractCompleteResult(
                    result, searchKeyword, originalPaper,
                    similarity >= TITLE_SIMILARITY_THRESHOLD,
                    "精确搜索", resultCountFormatted,
                    page
                );
            }
        } catch (e) {
            addLog('info', `检查结果${i + 1}失败: ${e.message}`);
        }
    }

    if (bestMatch) {
        if (bestSimilarity >= TITLE_SIMILARITY_THRESHOLD) {
            bestMatch.remark = bestMatch.remark.replace("精确搜索", "精确搜索-高度匹配");
        } else {
            bestMatch.remark = bestMatch.remark.replace("精确搜索", "精确搜索-部分匹配");
        }
        successPaperList.push(bestMatch);
        return true;
    } else {
        recordFailedPaperData(originalPaper, searchKeyword, "精确搜索未找到匹配结果", resultCountFormatted);
        return false;
    }
}

async function handleGeneralSearch(page, searchResults, resultCount, searchKeyword, originalPaper, resultCountFormatted) {
    addLog('info', "执行泛化搜索，提取所有结果");
    let foundMatch = false;
    const maxResults = Math.min(resultCount, 10);

    for (let i = 0; i < maxResults; i++) {
        const result = searchResults.nth(i);
        try {
            const title = await extractTitle(result);
            const authors = await extractAuthors(result);

            const isMatch = originalPaper.title.toLowerCase().includes(title.toLowerCase().substring(0, 20)) ||
                title.toLowerCase().includes(originalPaper.title.toLowerCase().substring(0, 20));

            const paperInfo = await extractCompleteResult(
                result, searchKeyword, originalPaper, isMatch,
                "泛化搜索", resultCountFormatted,
                page
            );

            successPaperList.push(paperInfo);
            if (isMatch) foundMatch = true;
        } catch (e) {
            addLog('info', `提取结果${i + 1}失败: ${e.message}`);
        }
    }

    if (!foundMatch) {
        addLog('info', "泛化搜索未找到匹配结果");
    }
    return true;
}

function recordFailedPaperData(originalPaper, searchKeyword, failureReason, resultCountFormatted) {
    const searchTime = new Date().toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).replace(/\//g, '-');

    const remark = `${searchKeyword} [检索失败: ${failureReason}]`;
    const failedPaper = new PaperInfo(
        originalPaper.title,
        originalPaper.authors,
        `检索失败: ${failureReason}`,
        "N/A",
        originalPaper.year,
        originalPaper.publication,
        remark,
        searchTime,
        resultCountFormatted,
        null
    );

    failedPaperList.push(failedPaper);
    addLog('info', `记录失败数据: ${failureReason}`);
}

async function extractSearchResults(page, searchKeyword, originalPaper) {
    try {
        addLog('info', "=== 开始提取搜索结果 ===");

        if (await checkForCaptcha(page)) {
            await handleCaptchaManually(page);
        }

        await waitForSearchOrCaptcha(page);

        let searchResults = page.locator("div[data-cid] .gs_ri, .gs_r .gs_ri, .gs_scl .gs_ri");
        let resultCount = await searchResults.count();
        let resultCountFormatted = formatResultCount(resultCount);

        if (resultCount === 0) {
            searchResults = page.locator(".gs_ri");
            resultCount = await searchResults.count();
            resultCountFormatted = formatResultCount(resultCount);
            addLog('info', `备用选择器找到${resultCount}个结果`);
        }

        if (resultCount === 0) {
            addLog('info', "未找到任何结果");
            if (!existsSync(path.join(currentOutputDir, 'screenshots'))) mkdirSync(path.join(currentOutputDir, 'screenshots'), {recursive: true});
            await page.screenshot({path: path.join(currentOutputDir, 'screenshots', `debug_no_results_${Date.now()}.png`)});

            recordFailedPaperData(originalPaper, searchKeyword, "未找到搜索结果", resultCountFormatted);
            return false;
        }

        if (PRECISE_SEARCH_ENABLED) {
            return await handlePreciseSearch(page, searchResults, resultCount, searchKeyword, originalPaper, resultCountFormatted);
        } else {
            return await handleGeneralSearch(page, searchResults, resultCount, searchKeyword, originalPaper, resultCountFormatted);
        }
    } catch (e) {
        addLog('info', `提取结果失败: ${e.message}`);
        recordFailedPaperData(originalPaper, searchKeyword, `提取结果出错: ${e.message}`, "N/A");
        return false;
    }
}

async function crawlScholarData(page, searchKeyword, originalPaper) {
    try {
        addLog('info', "访问Google Scholar...");
        await page.goto("https://scholar.google.com/", {waitUntil: "networkidle"});

        if (await checkForCaptcha(page)) {
            await handleCaptchaManually(page);
        }

        const searchInput = page.locator("input[name='q']");
        await searchInput.waitFor({state: "visible", timeout: 10000});
        await searchInput.clear();
        await searchInput.fill(searchKeyword);
        addLog('info', "输入关键词:" + searchKeyword);

        await searchInput.press("Enter");
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(2000);

        return await extractSearchResults(page, searchKeyword, originalPaper);
    } catch (e) {
        addLog('info', `爬取失败: ${e.message}`);
        recordFailedPaperData(originalPaper, searchKeyword, `爬取出错: ${e.message}`, "N/A");
        return false;
    }
}

function writeToExcel(dataList, filePath, sheetName) {
    if (!dataList || dataList.length === 0) {
        addLog('info', `${sheetName} 无数据可写入`);
        return;
    }

    const workbook = new excel.Workbook();
    const worksheet = workbook.addWorksheet(sheetName);

    const headers = [
        "标题", "作者", "摘要", "引用数", "年份",
        "出版信息", "备注", "搜索时间", "结果数量", "EndNote链接", "下载路径"
    ];

    headers.forEach((header, index) => {
        worksheet.cell(1, index + 1).string(header);
    });

    dataList.forEach((paper, rowIndex) => {
        const row = rowIndex + 2;
        worksheet.cell(row, 1).string(paper.title || "");
        worksheet.cell(row, 2).string(paper.authors || "");
        worksheet.cell(row, 3).string(paper.abstract || "");
        worksheet.cell(row, 4).string(paper.citations || "");
        worksheet.cell(row, 5).string(paper.year || "");
        worksheet.cell(row, 6).string(paper.publication || "");
        worksheet.cell(row, 7).string(paper.remark || "");
        worksheet.cell(row, 8).string(paper.searchTime || "");
        worksheet.cell(row, 9).string(paper.resultCountFormatted || "");
        worksheet.cell(row, 10).string(paper.endNoteLink || "");
        worksheet.cell(row, 11).string(paper.downloadedFilePath || "");
    });

    workbook.write(filePath);
    addLog('info', `${sheetName} 已导出到: ${filePath}`);
}

async function setupOutputAndLogs(timestamp,customKeywords ) {
    // 创建输出目录
    if (!fs.existsSync(currentOutputDir)) {
        fs.mkdirSync(currentOutputDir, { recursive: true });
        const subDirs = ['screenshots', 'endnote_downloads', 'logs', 'data'];
        for (const dir of subDirs) {
            const subDirPath = path.join(currentOutputDir, dir);
            fs.mkdirSync(subDirPath, { recursive: true });
        }
    }

    // 设置文件路径
    crawlerState.filePaths = {
        successExcel: path.join(currentOutputDir, 'data', `success_${timestamp}.xlsx`),
        failedExcel: path.join(currentOutputDir, 'data', `failed_${timestamp}.xlsx`),
        endnoteExcel: path.join(currentOutputDir, 'data', `endnote_${timestamp}.xlsx`),
        endnoteDir: path.join(currentOutputDir, 'endnote_downloads')
    };

    // 创建日志文件
    const logDir = path.join(currentOutputDir, 'logs');
    const logFileName = `${timestamp}.log`;
    const logFilePath = path.join(logDir, logFileName);
    logStream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });

    addLog('info', `日志文件已创建: ${logFilePath}`);
    addLog('info', `谷歌学术检索启动，关键词：${customKeywords.join(', ')}，输出目录：${currentOutputDir}`);
}

async function setupBrowserEnvironment() {
    // 清理残留进程
    cleanupAllChromiumData();

    // 确保浏览器环境
    const browserPath = await ensureBrowser();
    if (!browserPath) {
        throw new Error('未找到/下载浏览器，无法继续');
    }

    // 创建唯一临时目录
    const random = Math.random().toString(36).substring(2, 8);
    currentUserDataDir = path.join(require('os').tmpdir(), `scholar_clean_${Date.now()}_${random}`);
    fs.mkdirSync(currentUserDataDir, { recursive: true });
    addLog('info', `创建临时目录: ${currentUserDataDir}`);

    // 启动浏览器
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
        downloadsPath: crawlerState.filePaths.endnoteDir
    });
    const page = await context.newPage();

    return { browserPath, context, page };
}

async function processKeywords(page, searchKeywords) {
    for (const [index, keyword] of searchKeywords.entries()) {
        if (!crawlerState.isRunning) {
            addLog('warn', '检测到停止信号，终止爬取');
            break;
        }

        addLog('info', `\n===== 处理第 ${index + 1}/${searchKeywords.length} 个关键词 =====`);
        addLog('info', `关键词: ${keyword}`);
        crawlerState.progress = Math.round((index / searchKeywords.length) * 100);

        await page.goto('https://scholar.google.com', { timeout: 30000 });
        await randomDelay(page);

        if (await checkForCaptcha(page)) {
            await handleCaptchaManually(page);
        }

        // 使用 humanType 模拟输入
        const searchInput = page.locator('input[name="q"]');
        await searchInput.waitFor({ state: 'visible', timeout: 10000 });
        await humanType(page, searchInput, keyword);
        await randomDelay(page, 800, 2000);

        // 模拟按回车
        await page.keyboard.press('Enter');
        await page.waitForLoadState('networkidle');
        await randomDelay(page);

        const originalPaper = {
            title: keyword.replace(/"|'/g, '').split(' ').slice(0, 5).join(' '),
            authors: '',
            year: '',
            publication: ''
        };

        await extractSearchResults(page, keyword, originalPaper);
    }
}

async function finalizeResults() {
    parseEndNoteFilesAndExportExcel(crawlerState.filePaths.endnoteDir);
    writeToExcel(successPaperList, crawlerState.filePaths.successExcel, "成功搜索结果");
    writeToExcel(failedPaperList, crawlerState.filePaths.failedExcel, "检索失败结果");

    crawlerState.progress = 100;
    crawlerState.result = {
        successCount: successPaperList.length,
        failedCount: failedPaperList.length,
        successList: successPaperList,
        failedList: failedPaperList
    };
    crawlerState.isRunning = false;

    addLog('success', `爬取完成，成功: ${successPaperList.length}，失败: ${failedPaperList.length}`);
}

// 封装核心爬虫函数（供接口调用）
async function crawlGoogleScholar(customKeywords = []) {
    resetCrawlerState();
    crawlerState.isRunning = true;

    // 1. 设置输出目录和日志
    const timestamp = new Date().toISOString().replace(/[-:\.T]/g, '').slice(0, 15);
    currentOutputDir = path.join(process.cwd(), 'output', timestamp);
    crawlerState.currentDir = currentOutputDir;

    await setupOutputAndLogs(timestamp,customKeywords);

    // 重置全局变量
    successPaperList = [];
    failedPaperList = [];
    fileIndex = 1;

    let browser = null;
    try {
        // 2. 准备浏览器环境
        const { browserPath, context, page } = await setupBrowserEnvironment();
        browser = browserPath ? browserInstance : null; // browserInstance 已设置

        // 3. 获取搜索关键词
        const searchKeywords = generateSearchKeywords(getTestPaperInfoList());
        addLog('info', `\n=== 开始爬取谷歌学术 ===`);
        addLog('info', `关键词数量: ${searchKeywords.length}`);
        addLog('info', `精确搜索模式: ${PRECISE_SEARCH_ENABLED}`);

        // 4. 遍历关键词处理
        await processKeywords(page, searchKeywords);

        // 5. 最终处理
        await finalizeResults();

        return crawlerState.result;

    } catch (error) {
        crawlerState.isRunning = false;
        // 错误分类
        if (error.message.includes('ERR_CONNECTION_TIMED_OUT')) {
            crawlerState.error = {
                type: 'PROXY_ERROR',
                message: '连接谷歌学术超时！请检查网络',
                detail: error.message
            };
            addLog('error', crawlerState.error.message);
        } else if (error.message.includes('人机验证')) {
            crawlerState.error = {
                type: 'VERIFICATION_ERROR',
                message: '检测到谷歌学术人机验证！请手动完成验证后重试',
                detail: error.message
            };
            addLog('error', crawlerState.error.message);
        } else if (error.message.includes('ERR_PROXY_CONNECTION_FAILED')) {
            crawlerState.error = {
                type: 'PROXY_CONNECT_ERROR',
                message: '代理连接失败！请检查代理工具是否正常运行，或代理地址/端口是否正确',
                detail: error.message
            };
            addLog('error', crawlerState.error.message);
        } else {
            crawlerState.error = {
                type: 'UNKNOWN_ERROR',
                message: `爬虫执行失败：${error.message}`,
                detail: error.stack || error.message
            };
            addLog('error', crawlerState.error.message);
        }
        throw new Error(JSON.stringify(crawlerState.error));
    } finally {
        // 关闭文件流
        if (logStream) {
            logStream.end();
            logStream = null;
        }
        // 关闭浏览器
        if (browser) {
            try {
                await browser.close();
                browserInstance = null;
            } catch (e) {
                addLog('error', `关闭浏览器失败: ${e.message}`);
                if (process.platform === 'win32') {
                    try {
                        require('child_process').execSync('taskkill /F /IM chrome.exe /T 2>nul');
                        require('child_process').execSync('taskkill /F /IM chromium.exe /T 2>nul');
                    } catch (e) {}
                }
            }
        }
        // 清理临时目录
        if (currentUserDataDir) {
            try {
                fs.rmSync(currentUserDataDir, { recursive: true, force: true });
                addLog('info', `已清理临时目录: ${currentUserDataDir}`);
            } catch (e) {
                addLog('info', `清理临时目录失败: ${e.message}`);
            }
        }
        addLog('info', '\n=== 爬虫执行结束 ===');
    }
}

// 获取爬虫状态（供前端接口调用）
function getCrawlerState() {
    return {...crawlerState};
}

// 导出函数
module.exports = {
    crawlGoogleScholar,
    getCrawlerState,
    resetCrawlerState,
    stopCrawler,
    restartCrawler
};
