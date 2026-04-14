// google-scholar-crawler.js
// const { chromium } = require('playwright');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin()); // 激活隐身插件
const excel = require('excel4node');
const fs = require('fs');
const path = require('path');
const os = require('os');
let generateExcel= ''
const errorUtils = require('./error-utils');
const {takeErrorScreenshot,requestUserIntervention } = require("./crawler-utils");
const {
    humanClick,
    humanType,
    randomDelay,
    formatDateTime,
    calculateStringSimilarity,
    calculateMatchSimilarity,
    ensureDir
} = require('./crawler-utils');

//  配置读取
const DEFAULT_CONFIG = {
    PRECISE_SEARCH_ENABLED: true,
    TITLE_SIMILARITY_THRESHOLD: 0.8,
    VISIT_CITATION_ENABLED: true,
    MAX_CITATION_PAGES: 2,
    OUTPUT_BASE_DIR_NAME: 'output/google'
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
const googleConfig = userConfig.googleScholar || {};
const merged = { ...DEFAULT_CONFIG, ...googleConfig };

// 将配置赋值给常量
const PRECISE_SEARCH_ENABLED = merged.PRECISE_SEARCH_ENABLED;
const TITLE_SIMILARITY_THRESHOLD = merged.TITLE_SIMILARITY_THRESHOLD;
const VISIT_CITATION_ENABLED = merged.VISIT_CITATION_ENABLED;
const MAX_CITATION_PAGES = merged.MAX_CITATION_PAGES;
const OUTPUT_BASE_DIR = path.join(process.cwd(), merged.OUTPUT_BASE_DIR_NAME);

//  全局状态
let crawlerState = {
    isRunning: false,
    progress: 0,
    logs: [],
    result: { successCount: 0, failedCount: 0, successList: [], failedList: [] },
    filePaths: { successExcel: '', failedExcel: '', endnoteExcel: '', endnoteDir: '' },
    error: null,
    currentDir: '',
    logIndex: 0
};

// 内部全局变量
let successPaperList = [];
let failedPaperList = [];
let fileIndex = 1;
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
        result: { successCount: 0, failedCount: 0, successList: [], failedList: [] },
        filePaths: { successExcel: '', failedExcel: '', endnoteExcel: '', endnoteDir: '' },
        error: null,
        currentDir: '',
        logIndex: 0
    };
    successPaperList = [];
    failedPaperList = [];
    fileIndex = 1;
    currentUserDataDir = null;
    currentOutputDir = null;
    shouldStop = false;
}

function getCrawlerState() {
    return { ...crawlerState };
}

async function stopCrawler() {
    addLog('info', '开始停止谷歌学术检索任务...');
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
                } catch (err) {}
            }
        } finally {
            browserInstance = null;
        }
    }
    if (currentUserDataDir) {
        try {
            fs.rmSync(currentUserDataDir, { recursive: true, force: true });
            addLog('info', `已清理临时目录：${currentUserDataDir}`);
        } catch (e) {
            addLog('info', `清理临时目录失败：${e.message}`);
        }
    }
    addLog('success', '谷歌学术检索任务已停止');
}

async function restartCrawler(customKeywords = []) {
    await stopCrawler();
    if (crawlerState.currentDir) {
        try {
            fs.rmSync(crawlerState.currentDir, { recursive: true, force: true });
            addLog('info', `已删除上一次检索目录：${crawlerState.currentDir}`);
        } catch (e) {
            addLog('info', `删除目录失败：${e.message}`);
        }
    }
    resetCrawlerState();
    addLog('info', '开始重新执行谷歌学术检索');
    return await crawlGoogleScholar(customKeywords);
}

//  内部辅助函数

// 检查人机验证
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
        } catch (error) {}
    }
    const url = page.url();
    const captchaKeywords = ['sorry', 'captcha', 'recaptcha'];
    if (captchaKeywords.some(keyword => url.toLowerCase().includes(keyword))) return true;
    const pageContent = await page.content();
    const contentKeywords = ['请进行人机身份验证', '检测到异常流量', 'unusual traffic', 'automated requests'];
    return contentKeywords.some(keyword => pageContent.toLowerCase().includes(keyword.toLowerCase()));
}

// 处理人机验证（手动）
async function handleCaptchaManually(page) {
    addLog('warn', '================');
    addLog('warn', '⚠️  检测到人机身份验证！');
    addLog('warn', '📌 请在弹出的浏览器窗口中手动完成验证');
    addLog('warn', '📌 完成后脚本会自动继续运行');
    addLog('warn', '================\n');

    await requestUserIntervention({
        type: 'captcha-manual',
        data: { message: '请手动完成浏览器中的人机验证' }
    });
    await page.bringToFront();
    // 截图目录（开发阶段）
    // ensureDir(path.join(currentOutputDir, 'screenshots'));
    // await page.screenshot({ path: path.join(currentOutputDir, 'screenshots', `captcha_detected_${Date.now()}.png`) });

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

// 等待搜索结果或验证码
async function waitForSearchOrCaptcha(page, timeout = 30000) {
    try {
        await page.waitForTimeout(3000);
        if (await checkForCaptcha(page)) {
            addLog('info', '🔍 等待搜索结果时检测到人机验证...');
            await handleCaptchaManually(page);
        }
        try {
            await page.waitForSelector('#gs_res_ccl_mid', { timeout: timeout });
        } catch (error) {
            await page.waitForSelector('.gsc_a_tr, .gs_r, .gs_scl', { timeout: 5000 });
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

//  论文信息类
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
        this.citationLink = ''; // 引用链接
    }
}

// 添加 citations 和 citingPapers 等字段
class EndNoteInfo {
    constructor(recordNumber, title, authors, journal, year, volume, issue, pages, abstractText, doi, url, publicationType, publisher, filePath, citations = '0', citingPapers = [], id = null) {
        this.id = id;  // 原始论文 ID(非抓取结果)
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
        this.citations = citations;
        this.citingPapers = citingPapers;
        this.citationLink = ''; // 论文本身的引用链接
    }
}

//  数据提取函数
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
        } catch (e) {}
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
async function extractCitationLink(page, result) {
    try {
        const linkElement = result.locator("a:has-text('被引用次数'), a:has-text('Cited by')").first();
        if (await linkElement.isVisible()) {
            const href = await linkElement.getAttribute('href');
            if (href) {
                // 拼接为绝对 URL（基于当前页面地址）
                const absoluteUrl = new URL(href, page.url()).href;
                return absoluteUrl;
            }
        }
    } catch (e) {
        addLog('info', `提取引用链接失败: ${e.message}`);
    }
    return '';
}
function extractYear(text) {
    const match = text.match(/\b(19|20)\d{2}\b/);
    return match ? match[0] : "";
}

// 关闭引用弹窗
async function closeCitationPopup(page) {
    try {
        const closeButton = page.locator("#gs_cit-x");
        if (await closeButton.isVisible()) {
            await humanClick(page, closeButton);
            await randomDelay(page);
            addLog('info', "已关闭引用弹窗");
            await page.waitForSelector("#gs_cit", { state: "hidden", timeout: 3000 });
        }
    } catch (e) {
        addLog('info', `关闭弹窗失败: ${e.message}`);
    }
}
// 在引用页面中下载指定文章的 EndNote 文件
async function downloadEndNoteFromCitation(page, result, downloadDir, citationIndex, articleIndex) {
    let downloadedFilePath = null;
    try {
        // 查找引用按钮
        const citeButton = result.locator('a.gs_or_cit').first();
        if (!await citeButton.isVisible()) {
            addLog('info', `文章 ${articleIndex}: 未找到引用按钮`);
            return null;
        }

        addLog('info', `文章 ${articleIndex}: 点击引用按钮...`);
        await citeButton.click();
        await randomDelay(page);

        // 等待弹窗和 EndNote 链接
        await page.waitForSelector('#gs_cit', { timeout: 5000 });
        await page.waitForSelector('#gs_cit .gs_citi[href*="scholar.enw"]', { timeout: 5000 });

        const endNoteLinkElement = page.locator('#gs_cit .gs_citi[href*="scholar.enw"]').first();
        if (!await endNoteLinkElement.isVisible()) {
            addLog('info', `文章 ${articleIndex}: 未找到 EndNote 链接`);
            await closeCitationPopup(page);
            return null;
        }

        const endNoteLink = await endNoteLinkElement.getAttribute('href');
        addLog('info', `文章 ${articleIndex}: EndNote链接: ${endNoteLink}`);

        // 触发下载
        let downloadPromise;
        try {
            downloadPromise = page.waitForDownload({ timeout: 10000 });
            await humanClick(page, endNoteLinkElement);
            await randomDelay(page);

            const download = await downloadPromise;
            const tempFilePath = await download.path();
            addLog('info', `文章 ${articleIndex}: 临时文件路径: ${tempFilePath}`);

            if (fs.existsSync(tempFilePath)) {
                ensureDir(downloadDir);
                const targetFileName = `citation_${citationIndex}_article_${articleIndex}_${Date.now()}.enw`;
                downloadedFilePath = path.join(downloadDir, targetFileName);
                fs.copyFileSync(tempFilePath, downloadedFilePath);
                addLog('info', `文章 ${articleIndex}: EndNote文件已保存到: ${downloadedFilePath}`);
            }
        } catch (e) {
            addLog('info', `文章 ${articleIndex}: 下载过程中出错: ${e.message}，尝试备用方式...`);
            downloadPromise = new Promise((resolve) => {
                page.once('download', resolve);
            });
            await humanClick(page, endNoteLinkElement);
            await randomDelay(page);

            const download = await downloadPromise;
            const tempFilePath = await download.path();

            if (fs.existsSync(tempFilePath)) {
                ensureDir(downloadDir);
                const targetFileName = `citation_${citationIndex}_article_${articleIndex}_${Date.now()}.enw`;
                downloadedFilePath = path.join(downloadDir, targetFileName);
                fs.copyFileSync(tempFilePath, downloadedFilePath);
                addLog('info', `文章 ${articleIndex}: EndNote文件已保存到: ${downloadedFilePath}`);
            }
        }

        // 关闭弹窗
        await closeCitationPopup(page);
        return downloadedFilePath;

    } catch (error) {
        addLog('error', `文章 ${articleIndex}: 下载 EndNote 失败: ${error.message}`);
        await closeCitationPopup(page).catch(() => {});
        return null;
    }
}

// 访问引用链接visitCitationLinks
async function visitCitationLinks(page, paperList) {
    if (!paperList || paperList.length === 0) {
        addLog('info', '没有成功抓取的论文，跳过访问引用链接');
        return;
    }

    addLog('info', '开始访问论文的引用链接');


    const context = page.context();
    let visitedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < paperList.length; i++) {
        const paper = paperList[i];
        const citationLink = paper.citationLink;

        if (!citationLink) {
            addLog('info', `论文 ${i+1}: 无引用链接，跳过`);
            continue;
        }

        addLog('info', `论文 ${i+1}/${paperList.length}: 正在访问引用链接: ${citationLink}`);

        // 为当前引用链接创建专属下载子目录
        const citationDownloadDir = path.join(crawlerState.filePaths.endnoteDir, 'citations', `citation_${i}`);
        ensureDir(citationDownloadDir);

        let newPage = null;
        const citingPapers = []; // 存储从该链接解析出的引用文章

        try {
            // 创建新页面
            newPage = await context.newPage();
            await newPage.goto(citationLink, { timeout: 30000, waitUntil: 'networkidle' }).catch(async (e) => {
                addLog('info', `加载引用页面超时: ${e.message}，继续尝试...`);
                await newPage.waitForTimeout(5000);
            });

            // 检查验证码（跳过引用的人机验证，仅方便测试）
            // if (await checkForCaptcha(newPage)) {
            //     addLog('warn', `引用页面 ${citationLink} 检测到人机验证，需要手动处理`);
            //     const screenshotDir = path.join(currentOutputDir, 'screenshots', 'citation');
            //     ensureDir(screenshotDir);
            //     await newPage.screenshot({ path: path.join(screenshotDir, `captcha_${Date.now()}.png`) });
            //     addLog('warn', `已截图验证码，跳过该引用链接`);
            //     failedCount++;
            //     continue;
            // }

            // 检查验证码（正式处理）
            if (await checkForCaptcha(newPage)) {
                addLog('info', `引用页面 ${citationLink} 检测到人机验证，需要手动处理`);
                // 保存截图（开发阶段）
                // const screenshotDir = path.join(currentOutputDir, 'screenshots', 'citation');
                // ensureDir(screenshotDir);
                // await newPage.screenshot({ path: path.join(screenshotDir, `captcha_${Date.now()}.png`) });
                try {
                    // 等待用户手动解决验证码
                    await handleCaptchaManually(newPage);
                    addLog('info', `引用页面验证码已解决，继续抓取`);
                    // 等待页面稳定
                    await newPage.waitForTimeout(3000);
                    // 验证码解决后继续后续处理，不跳过
                } catch (captchaError) {
                    addLog('info', `引用页面验证码处理失败: ${captchaError.message}，跳过该引用链接`);
                    failedCount++;
                    continue;
                }
            }

            await newPage.waitForTimeout(3000);

            // 分页处理
            let currentPageNum = 1;
            let hasNextPage = true;

            while (hasNextPage && currentPageNum <= MAX_CITATION_PAGES) {
                addLog('info', `处理引用页面第 ${currentPageNum} 页`);

                // 获取当前页的文章列表（引用页面结构）
                const articleResults = newPage.locator('#gs_res_ccl_mid .gs_r.gs_or.gs_scl');
                const articleCount = await articleResults.count();
                addLog('info', `当前页找到 ${articleCount} 篇文章`);

                if (articleCount === 0) {
                    addLog('info', '未找到文章列表，可能页面结构变化');
                    // 保存截图（开发阶段）
                    // const screenshotDir = path.join(currentOutputDir, 'screenshots', 'citation');
                    // ensureDir(screenshotDir);
                    // await newPage.screenshot({ path: path.join(screenshotDir, `no_articles_${Date.now()}.png`) });
                    break; // 跳出循环
                }

                // 遍历当前页每篇文章，下载其 EndNote 并解析
                let articleSuccess = 0;
                let articleFail = 0;
                for (let j = 0; j < articleCount; j++) {
                    const article = articleResults.nth(j);
                    const globalArticleIndex = citingPapers.length + j + 1; // 用于日志
                    addLog('info', `  处理文章 ${globalArticleIndex}...`);

                    try {
                        const downloadedFilePath = await downloadEndNoteFromCitation(newPage, article, citationDownloadDir, i, globalArticleIndex);
                        if (downloadedFilePath) {
                            // 解析下载的 EndNote 文件
                            const parsed = parseEndNoteFile(downloadedFilePath);
                            // 添加源引用文章信息
                            const citingPaper = {
                                sourceArticle: paper.title, // 原始文章标题
                                ...parsed                // 展开解析结果
                            };
                            citingPapers.push(citingPaper);
                            articleSuccess++;
                        } else {
                            articleFail++;
                        }
                    } catch (err) {
                        addLog('info', `  文章 ${globalArticleIndex} 处理异常: ${err.message}`);
                        articleFail++;
                    }

                    await randomDelay(newPage, 2000, 4000);
                }

                addLog('info', `当前页处理完成: 成功下载并解析 ${articleSuccess} 个, 失败 ${articleFail} 个`);

                // 检查是否有下一页
                hasNextPage = false;
                try {
                    const nextPageLink = newPage.locator('a:has-text("下一页")').first();
                    if (await nextPageLink.isVisible()) {
                        const href = await nextPageLink.getAttribute('href');
                        if (href) {
                            const nextUrl = new URL(href, newPage.url()).href;
                            addLog('info', `找到下一页链接: ${nextUrl}`);
                            await newPage.goto(nextUrl, { timeout: 30000, waitUntil: 'networkidle' }).catch(async (e) => {
                                addLog('info', `加载下一页超时: ${e.message}，继续尝试...`);
                                await newPage.waitForTimeout(5000);
                            });

                            if (await checkForCaptcha(newPage)) {
                                addLog('info', `下一页检测到人机验证，需要手动处理`);
                                // 保存截图（开发阶段）
                                // const screenshotDir = path.join(currentOutputDir, 'screenshots', 'citation');
                                // ensureDir(screenshotDir);
                                // await newPage.screenshot({ path: path.join(screenshotDir, `captcha_next_${Date.now()}.png`) });
                                // addLog('info', `已截图验证码，跳过后续翻页`);
                                break;
                            }

                            await newPage.waitForTimeout(3000);
                            currentPageNum++;
                            hasNextPage = true;
                        } else {
                            addLog('info', '下一页链接无 href 属性，停止翻页');
                        }
                    } else {
                        addLog('info', '未找到下一页链接，停止翻页');
                    }
                } catch (e) {
                    addLog('info', `检查下一页时出错: ${e.message}，停止翻页`);
                }
            }

            addLog('info', `引用链接处理完成: 总共下载并解析 ${citingPapers.length} 个引用文章`);
            visitedCount++;

            // 将解析出的引用文章列表附加到原始文章对象
            paper.citingPapers = citingPapers;

        } catch (error) {
            addLog('info', `访问引用链接 ${citationLink} 失败: ${error.message}`);
            failedCount++;
            paper.citingPapers = []; // 标记为空
        } finally {
            if (newPage) {
                await newPage.close();
            }
        }

        await randomDelay(page, 3000, 6000);
    }

    addLog('info', `引用链接访问完成: 成功处理 ${visitedCount} 个链接, 失败 ${failedCount} 个链接`);
}

// 打印最终检索结果汇总函数
function printSummary(endNoteList) {
    addLog('info', `总共成功检索主文章: ${endNoteList.length} 篇`);

    endNoteList.forEach((item, index) => {
        addLog('info', `\n--- 主文章 ${index+1} ---`);
        addLog('info', `标题: ${item.title}`);
        addLog('info', `作者: ${item.authors}`);
        addLog('info', `年份: ${item.year}`);
        addLog('info', `出版信息: ${item.journal}`);
        addLog('info', `引用数: ${item.citations}`);
        addLog('info', `引用链接: ${item.citationLink || '无'}`);

        const citingPapers = item.citingPapers || [];
        if (citingPapers.length > 0) {
            addLog('info', `  该文章的引用页面包含 ${citingPapers.length} 篇引用文章:`);
            citingPapers.forEach((citing, j) => {
                addLog('info', `    [${j+1}] 标题: ${citing.title}`);
                addLog('info', `         作者: ${citing.authors}`);
                addLog('info', `         年份: ${citing.year}`);
                addLog('info', `         期刊: ${citing.journal}`);
                addLog('info', `         DOI: ${citing.doi}`);
            });
        } else {
            addLog('info', `  该文章无引用文章或未成功解析。`);
        }
    });

    addLog('info', '\n================ 汇总结束 ================\n');
}

// 导出引用文章列表到 Excel
function exportCitingPapersToExcel(paperList) {
    if (!paperList || paperList.length === 0) {
        addLog('info', '没有主文章，跳过引用文章导出');
        return;
    }

    const allCitingPapers = [];
    paperList.forEach(paper => {
        const citingPapers = paper.citingPapers || [];
        citingPapers.forEach(citing => {
            allCitingPapers.push(citing);
        });
    });

    if (allCitingPapers.length === 0) {
        addLog('info', '未找到任何引用文章，跳过 Excel 导出');
        return;
    }

    addLog('info', `开始导出引用文章到 Excel，共 ${allCitingPapers.length} 条记录`);

    const workbook = new excel.Workbook();
    const worksheet = workbook.addWorksheet('引用文章');

    // 定义表头（增加“源引用文章”列）
    const headers = [
        '源引用文章',
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
        worksheet.cell(1, index + 1).string(header).style({ font: { bold: true } });
    });

    allCitingPapers.forEach((citing, rowIndex) => {
        const row = rowIndex + 2;
        worksheet.cell(row, 1).string(citing.sourceArticle || '');  // 源引用文章
        worksheet.cell(row, 2).string(citing.recordNumber || '');
        worksheet.cell(row, 3).string(citing.title || '');
        worksheet.cell(row, 4).string(citing.authors || '');
        worksheet.cell(row, 5).string(citing.journal || '');
        worksheet.cell(row, 6).string(citing.year || '');
        worksheet.cell(row, 7).string(citing.volume || '');
        worksheet.cell(row, 8).string(citing.issue || '');
        worksheet.cell(row, 9).string(citing.pages || '');
        worksheet.cell(row, 10).string(citing.abstract || '');
        worksheet.cell(row, 11).string(citing.doi || '');
        worksheet.cell(row, 12).string(citing.url || '');
        worksheet.cell(row, 13).string(citing.publicationType || '');
        worksheet.cell(row, 14).string(citing.publisher || '');
        worksheet.cell(row, 15).string(citing.filePath || '');
    });

    workbook.write(crawlerState.filePaths.citingExcel);
    addLog('success', `引用文章 Excel 已导出到: ${crawlerState.filePaths.citingExcel}`);
}
// 返回解析后的 EndNoteInfo
async function extractAndDownloadEndNoteFile(page, result) {
    let endNoteLink = null;
    let downloadedFilePath = null;
    let parsedEndNote = null;

    try {
        let citeButton = result.locator(".gs_or_cit").first();
        if (!await citeButton.isVisible()) {
            citeButton = result.locator("a[class*='gs_or_cit']").first();
        }

        if (await citeButton.isVisible()) {
            addLog('info', "点击引用按钮...");
            await citeButton.click();
            await randomDelay(page);
            await page.waitForSelector("#gs_cit", { timeout: 5000 });
            await page.waitForSelector("#gs_cit .gs_citi[href*='scholar.enw']", { timeout: 5000 });

            const endNoteLinkElement = page.locator("#gs_cit .gs_citi[href*='scholar.enw']").first();
            if (await endNoteLinkElement.isVisible()) {
                endNoteLink = await endNoteLinkElement.getAttribute("href");
                addLog('info', `EndNote链接: ${endNoteLink}`);

                let downloadPromise;
                try {
                    downloadPromise = page.waitForDownload({ timeout: 10000 });
                    await humanClick(page, endNoteLinkElement);
                    await randomDelay(page);

                    const download = await downloadPromise;
                    const tempFilePath = await download.path();
                    addLog('info', `临时文件路径: ${tempFilePath}`);

                    if (fs.existsSync(tempFilePath)) {
                        if (!fs.existsSync(crawlerState.filePaths.endnoteDir)) {
                            fs.mkdirSync(crawlerState.filePaths.endnoteDir, { recursive: true });
                        }

                        const targetFileName = `scholar_${fileIndex}.enw`;
                        fileIndex++;
                        downloadedFilePath = path.join(crawlerState.filePaths.endnoteDir, targetFileName);

                        fs.copyFileSync(tempFilePath, downloadedFilePath);
                        addLog('info', `EndNote文件已保存到: ${downloadedFilePath}`);

                        // 立即解析并返回
                        parsedEndNote = parseEndNoteFile(downloadedFilePath);
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

                    if (fs.existsSync(tempFilePath)) {
                        if (!fs.existsSync(crawlerState.filePaths.endnoteDir)) {
                            fs.mkdirSync(crawlerState.filePaths.endnoteDir, { recursive: true });
                        }

                        const targetFileName = `scholar_${fileIndex}.enw`;
                        fileIndex++;
                        downloadedFilePath = path.join(crawlerState.filePaths.endnoteDir, targetFileName);

                        fs.copyFileSync(tempFilePath, downloadedFilePath);
                        addLog('info', `EndNote文件已保存到: ${downloadedFilePath}`);
                        parsedEndNote = parseEndNoteFile(downloadedFilePath);
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

    return { endNoteLink, downloadedFilePath, parsedEndNote };
}

// 解析单个EndNote文件
function parseEndNoteFile(filePath) {
    try {
        let content;
        try {
            content = fs.readFileSync(filePath, 'utf8');
        } catch (e) {
            content = fs.readFileSync(filePath, 'latin1');
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
            '%TI': 'title',
            '%0': 'publicationType',
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
                case '%0':
                    parsedData.publicationType = value;
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

        // citations 暂时设为0，稍后在 extractCompleteResult 中根据原始数据设置
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
            parsedData.filePath,
            '0',            // citations 占位
            []              // citingPapers 占位
        );
    } catch (error) {
        addLog('info', `解析文件 ${filePath} 失败: ${error.message}`);
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
            filePath,
            '0',
            []
        );
    }
}

// 解析所有EndNote文件并导出Excel
function parseEndNoteFilesAndExportExcel(dirPath) {
    addLog('info', '================');
    addLog('info', '开始解析EndNote (.enw) 文件');
    addLog('info', '================');

    if (!fs.existsSync(dirPath)) {
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
            '记录编号', '标题', '作者', '期刊/出版物', '年份', '卷', '期', '页码',
            '摘要', 'DOI', 'URL链接', '出版类型', '出版商', '源文件路径'
        ];

        headers.forEach((header, index) => {
            worksheet.cell(1, index + 1).string(header).style({ font: { bold: true } });
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

// 记录失败论文数据
function recordFailedPaperData(originalPaper, searchKeyword, failureReason, resultCountFormatted) {
    const searchTime = new Date().toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).replace(/\//g, '-');

    const remark = `${searchKeyword} [检索失败: ${failureReason}]`;
    // 构造一个基础的 EndNoteInfo，填充原始数据中的标题、作者等
    const failedEndNote = new EndNoteInfo(
        '',                             // recordNumber
        originalPaper.title || '未知标题',
        originalPaper.authors || '未知作者',
        '',                             // journal
        originalPaper.year || '',
        '',                             // volume
        '',                             // issue
        '',                             // pages
        `检索失败: ${failureReason}`,
        originalPaper.doi || '',
        '',                             // url
        'Failed',
        '',                             // publisher
        '',                             // filePath
        originalPaper.citations || '0',
        [],                              // citingPapers
        originalPaper.id                 // 传入 id
    );
    // 添加一些额外字段以兼容原 PaperInfo 的用途
    failedEndNote.remark = remark;
    failedEndNote.searchTime = searchTime;
    failedEndNote.resultCountFormatted = resultCountFormatted;
    failedEndNote.citationLink = ''; // 添加空链接

    failedPaperList.push(failedEndNote);
    addLog('info', `记录失败数据: ${failureReason}`);
}
// 提取完整结果
async function extractCompleteResult(result, searchKeyword, originalPaper, isMatch, searchType, resultCountFormatted, page) {
    // 从页面提取基础信息（备用）
    const title = await extractTitle(result);
    const authors = await extractAuthors(result);
    const publication = await extractPublication(result);
    const year = extractYear(publication);
    const abstractText = await extractAbstract(result);
    const citations = await extractCitations(result);
    const citationLink = await extractCitationLink(page, result); // 提取链接

    let endNoteLink = null;
    let downloadedFilePath = null;
    let parsedEndNote = null; // 解析后的 EndNoteInfo
    if (PRECISE_SEARCH_ENABLED && resultCountFormatted === "1") {
        const downloadResult = await extractAndDownloadEndNoteFile(page, result);
        endNoteLink = downloadResult.endNoteLink;
        downloadedFilePath = downloadResult.downloadedFilePath;
        parsedEndNote = downloadResult.parsedEndNote; // 可能是 EndNoteInfo 对象
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

    let endNoteInfo;
    if (parsedEndNote) {
        // 使用解析得到的 EndNoteInfo，并补充缺失的字段
        endNoteInfo = parsedEndNote;
        // 设置原始ID
        endNoteInfo.id = originalPaper.id;
        // 用页面抓取的 citations 覆盖（如果解析结果中没有的话）
        endNoteInfo.citations = citations;
        // 补充其他字段
        endNoteInfo.citationLink = citationLink;
        endNoteInfo.remark = remark;
        endNoteInfo.searchTime = searchTime;
        endNoteInfo.resultCountFormatted = resultCountFormatted;
        endNoteInfo.downloadedFilePath = downloadedFilePath;
        endNoteInfo.endNoteLink = endNoteLink;
    } else {
        // 未能下载 EndNote，则基于页面信息构造一个基础的 EndNoteInfo
        endNoteInfo = new EndNoteInfo(
            '',                             // recordNumber
            title,
            authors,
            publication,                    // 暂存到 journal 字段
            year,
            '',                             // volume
            '',                             // issue
            '',                             // pages
            abstractText,
            originalPaper.doi || '',         // 优先使用原始数据的 DOI
            '',                             // url
            'Unknown',
            '',                             // publisher
            downloadedFilePath || '',
            citations,
            [],                            // citingPapers
            originalPaper.id
        );
        endNoteInfo.citationLink = citationLink;
        endNoteInfo.remark = remark;
        endNoteInfo.searchTime = searchTime;
        endNoteInfo.resultCountFormatted = resultCountFormatted;
        endNoteInfo.endNoteLink = endNoteLink;
    }

    return endNoteInfo;
}

// 处理精确搜索
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

// 处理泛化搜索
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

// 提取搜索结果
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
            // 保存截图（开发阶段）
            // ensureDir(path.join(currentOutputDir, 'screenshots'));
            // await page.screenshot({ path: path.join(currentOutputDir, 'screenshots', `debug_no_results_${Date.now()}.png`) });

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

// 格式结果数量
function formatResultCount(count) {
    if (count === 1) return "1";
    else if (count > 1) return "大于1";
    return "0";
}

// 生成搜索关键词
function getTestPaperInfoList() {
    return [
        new PaperInfo(
            "A unifying aetiological explanation for anomalies of human tooth number and size",
            "AH Brook", "", "", "2022",
            "McGill Journal of Education, 57(2), 195-210",
            "ungrading assessment", "2024-01-01", "", ""
        ),
        new PaperInfo(
            "How to ungrade",
            "Stommel, J.", "", "", "2020",
            "In S. D. Blum (Ed.), Ungrading: Why rating students undermines learning (and what to do instead) (pp. 25-42). West Virginia University Press",
            "ungrading how-to", "2024-01-01", "", ""
        ),
        new PaperInfo(
            "Do we need the word 'ungrading'?",
            "Stommel, J.", "", "", "2023",
            "Zeal: A Journal for the Liberal Arts, 1(2), 82-87",
            "ungrading terminology", "2024-01-01", "", ""
        ),
        new PaperInfo(
            "\"It made me feel like it was okay to be wrong\": Student experiences with ungrading",
            "Gorichanaz, T.", "", "", "2024",
            "Active Learning in Higher Education, 25(1), 67-80",
            "student experiences ungrading", "2024-01-01", "", ""
        ),
        // new PaperInfo(
        //     "Self-evaluation: The humanistic skill we need in a just society",
        //     "Katopodis, C.", "", "", "2023",
        //     "Zeal: A Journal for the Liberal Arts, 1(2), 141-146",
        //     "self-evaluation assessment", "2024-01-01", "", ""
        // ),
        // new PaperInfo(
        //     "Keeping receipts: Thoughts on ungrading from a Black woman professor",
        //     "McCloud, L. I.", "", "", "2023",
        //     "Zeal: A Journal for the Liberal Arts, 1(2), 101-105",
        //     "ungrading diversity equity", "2024-01-01", "", ""
        // ),
        // new PaperInfo(
        //     "Using learning and motivation theories to coherently link formative assessment, grading practices, and large-scale assessment",
        //     "Shepard, L. A., Penuel, W. R., & Pellegrino, J. W.", "", "", "2018",
        //     "Educational Measurement: Issues and Practice, 37(1), 21-34",
        //     "formative assessment grading", "2024-01-01", "", ""
        // ),
        // new PaperInfo(
        //     "Relationships of knowledge and practice: Teacher learning communities",
        //     "Cochran-Smith, M., & Lytle, S.", "", "", "", "", "", "", ""
        // ),
        // new PaperInfo(
        //     "Redos and retakes done right",
        //     "Wormeli, R.", "", "", "", "", "", "", ""
        // ),
        // new PaperInfo(
        //     "Contract grading and peer review",
        //     "Katopodis, C., & Davidson, C. N.", "", "", "", "", "", "", ""
        // ),
        // new PaperInfo(
        //     "Shifting the grading mindset",
        //     "Sackstein, S.", "", "", "2020",
        //     "In S. D. Blum (Ed.), Ungrading: Why rating students undermines learning (and what to do instead) (pp. 74-81). West Virginia University Press",
        //     "grading mindset change", "2024-01-01", "", ""
        // )
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
            // searchKeyword = `${author}："${cleanTitle}" `;
            // 适配谷歌学术高级搜索：allintitle: "标题" author:"作者"
            searchKeyword = `allintitle: "${cleanTitle}" author:"${author}"`;
        } else {
            searchKeyword = `${author} ${cleanTitle}`;
        }

        if (searchKeyword.length > 150) searchKeyword = searchKeyword.substring(0, 150);
        keywords.push(searchKeyword.trim());
    }
    return keywords;
}

// 写入Excel
function writeToExcel(dataList, filePath, sheetName) {
    if (!dataList || dataList.length === 0) {
        addLog('info', `${sheetName} 无数据可写入`);
        return;
    }

    const workbook = new excel.Workbook();
    const worksheet = workbook.addWorksheet(sheetName);

    // 定义 EndNoteInfo 的表头
    const headers = [
        "记录编号", "标题", "作者", "期刊/出版物", "年份", "卷", "期", "页码",
        "摘要", "DOI", "URL链接", "出版类型", "出版商", "引用数", "引用链接",
        "备注", "搜索时间", "结果数量", "EndNote链接", "下载路径", "源文件路径"
    ];

    headers.forEach((header, index) => {
        worksheet.cell(1, index + 1).string(header);
    });

    dataList.forEach((item, rowIndex) => {
        const row = rowIndex + 2;
        worksheet.cell(row, 1).string(item.recordNumber || '');
        worksheet.cell(row, 2).string(item.title || '');
        worksheet.cell(row, 3).string(item.authors || '');
        worksheet.cell(row, 4).string(item.journal || '');
        worksheet.cell(row, 5).string(item.year || '');
        worksheet.cell(row, 6).string(item.volume || '');
        worksheet.cell(row, 7).string(item.issue || '');
        worksheet.cell(row, 8).string(item.pages || '');
        worksheet.cell(row, 9).string(item.abstract || '');
        worksheet.cell(row, 10).string(item.doi || '');
        worksheet.cell(row, 11).string(item.url || '');
        worksheet.cell(row, 12).string(item.publicationType || '');
        worksheet.cell(row, 13).string(item.publisher || '');
        worksheet.cell(row, 14).string(item.citations || '');
        worksheet.cell(row, 15).string(item.citationLink || '');
        worksheet.cell(row, 16).string(item.remark || '');
        worksheet.cell(row, 17).string(item.searchTime || '');
        worksheet.cell(row, 18).string(item.resultCountFormatted || '');
        worksheet.cell(row, 19).string(item.endNoteLink || '');
        worksheet.cell(row, 20).string(item.downloadedFilePath || '');
        worksheet.cell(row, 21).string(item.filePath || '');
    });

    workbook.write(filePath);
    addLog('info', `${sheetName} 已导出到: ${filePath}`);
}


// 设置输出目录和日志文件
async function setupOutputAndLogs(currentOutputDir, timestamp, customKeywords) {
    ensureDir(currentOutputDir);
    // 保存截图（开发阶段）
    // const subDirs = ['screenshots', 'endnote_downloads', 'logs', 'data'];
    const subDirs = [ 'endnote_downloads', 'data'];
    for (const dir of subDirs) {
        ensureDir(path.join(currentOutputDir, dir));
    }

    crawlerState.filePaths = {
        successExcel: path.join(currentOutputDir, 'data', `success_${timestamp}.xlsx`),
        failedExcel: path.join(currentOutputDir, 'data', `failed_${timestamp}.xlsx`),
        endnoteExcel: path.join(currentOutputDir, 'data', `endnote_${timestamp}.xlsx`),
        endnoteDir: path.join(currentOutputDir, 'endnote_downloads'),
        citingExcel: path.join(currentOutputDir, 'data', `citing_papers_${timestamp}.xlsx`)
    };

    // 独立日志目录
    const logBaseDir = userConfig.LOG_BASE_DIR || path.join(process.cwd(), 'logs');
    ensureDir(logBaseDir);
    const logFilePath = path.join(logBaseDir, `${timestamp}_google_crawler.log`);
    logStream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });

    // addLog('info', `日志文件已创建: ${logFilePath}`);
    addLog('info', `谷歌学术检索启动，关键词：${customKeywords.join(', ')}，输出目录：${currentOutputDir}`);
}

// 查找本地浏览器
function findLocalBrowser() {
    addLog('info', '\n=== 开始查找本地浏览器 ===');

    // 导入工具函数
    const { isMacOSApp, getMacOSAppExecutable } = require('./crawler-utils');

    // 递归查找函数
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
                            addLog('info', `✓ 找到 macOS 应用包并提取可执行文件: ${fullPath}`);
                            addLog('info', `  可执行文件路径: ${executable}`);
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
                    addLog('info', `✓ 找到浏览器（递归查找）: ${fullPath}`);
                    return fullPath;
                }
            }
        } catch (error) {
            addLog('error', `查找浏览器时出错: ${error.message}`);
        }
        return null;
    }

    const keyDirs = [
        '/Users/chuanyunxu/Documents/Dev/Java/workspace/SPM/SPM_Retriever/browsers/chromium-1217/chrome-mac-arm64',
        path.join(process.cwd(), 'browsers'),
        // path.join(path.dirname(process.execPath), 'browsers'),
        // process.cwd(),
        // path.dirname(process.execPath)
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

// 确保浏览器可用
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

        const { execSync } = require('child_process');
        execSync(`npx playwright install chromium`, {
            stdio: 'inherit',
            cwd: process.cwd(),
            env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: downloadDir }
        });

        addLog('success', '✓ 浏览器下载完成！');
        return findLocalBrowser();
    } catch (downloadError) {
        addLog('error', `浏览器下载失败: ${downloadError.message}`);
        return null;
    }
}

// 清理 Chromium 数据
function cleanupAllChromiumData() {
    addLog('info', '=== 开始清理 Chromium 数据 ===\n');
    const { execSync } = require('child_process');

    try {
        if (process.platform === 'win32') {
            execSync('taskkill /F /IM chrome.exe /T 2>nul', { stdio: 'ignore' });
            execSync('taskkill /F /IM chromium.exe /T 2>nul', { stdio: 'ignore' });
            addLog('info', '✓ 已终止残留进程');
        }
    } catch (e) {}

    const tmpDir = os.tmpdir();
    try {
        const files = fs.readdirSync(tmpDir);
        for (const file of files) {
            if (file.startsWith('scholar_') || file.startsWith('playwright_')) {
                const fullPath = path.join(tmpDir, file);
                try {
                    fs.rmSync(fullPath, { recursive: true, force: true });
                    addLog('info', `✓ 删除: ${file}`);
                } catch (e) {}
            }
        }
    } catch (e) {}

    addLog('info', '=== 清理完成 ===\n');
}

// 设置浏览器环境
async function setupBrowserEnvironment() {
    // cleanupAllChromiumData();

    debugger

    const browserPath = await ensureBrowser();
    if (!browserPath) {
        throw new Error('未找到/下载浏览器，无法继续');
    }

    const random = Math.random().toString(36).substring(2, 8);
    currentUserDataDir = path.join(os.tmpdir(), `scholar_clean_${Date.now()}_${random}`);
    fs.mkdirSync(currentUserDataDir, { recursive: true });
    addLog('info', `创建临时目录: ${currentUserDataDir}`);

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

// 处理关键词列表
async function processKeywords(page, searchKeywords, originalPapers = []) {
    for (const [index, keyword] of searchKeywords.entries()) {
        if (shouldStop || !crawlerState.isRunning) {
            addLog('info', '检测到停止信号，终止爬取');
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

        const searchInput = page.locator('input[name="q"]');
        await searchInput.waitFor({ state: 'visible', timeout: 10000 });
        await humanType(page, searchInput, keyword);
        await randomDelay(page, 800, 2000);
        await page.keyboard.press('Enter');
        await page.waitForLoadState('networkidle');
        await randomDelay(page);

        // 获取对应的原始论文对象（如果有）
        const originalPaper = originalPapers[index] || {
            id: null,
            title: keyword.replace(/["']/g, '').split(' ').slice(0, 5).join(' '),
            authors: '',
            year: '',
            publication: '',
            citations: '0',
            doi: ''
        };

        await extractSearchResults(page, keyword, originalPaper);
    }
}

// 最终处理
async function finalizeResults() {
    parseEndNoteFilesAndExportExcel(crawlerState.filePaths.endnoteDir);
    if (generateExcel) {
        writeToExcel(successPaperList, crawlerState.filePaths.successExcel, "成功搜索结果");
        writeToExcel(failedPaperList, crawlerState.filePaths.failedExcel, "检索失败结果");
    }
    crawlerState.progress = 100;
    crawlerState.result = {
        successCount: successPaperList.length,
        failedCount: failedPaperList.length,
        successList: successPaperList,
        failedList: failedPaperList
    };
    crawlerState.isRunning = false;

    addLog('info', `爬取完成，成功: ${successPaperList.length}，失败: ${failedPaperList.length}`);
}
/**
 * 将前端传入的论文 JSON 数组转换为 PaperInfo 对象列表
 * @param {Array} frontendPapers - 前端论文数据，每个对象应包含 title, authors, citations（可选）
 * @returns {Array<PaperInfo>}
 */
function convertFrontendPapersToPaperInfo(frontendPapers) {
    if (!Array.isArray(frontendPapers)) {
        throw new Error('前端传入的数据必须是一个数组');
    }

    return frontendPapers.map(item => ({
        title: item.title || '',
        authors: item.authors || '',
        abstract: '',
        citations: item.citations !== undefined ? String(item.citations) : '',
        year: '',
        publication: '',
        remark: '',
        searchTime: '',
        resultCountFormatted: '',
        endNoteLink: '',
        downloadedFilePath: '',
        citationLink: ''
    }));
}

//  主爬虫函数
async function crawlGoogleScholar(input = [], options = {}) {
    // 从 options 获取任务类型，默认为普通检索(真实性验证，不抓取引用文章)
    console.log("测试任务类型："+ options.taskType )
    const taskType = options.taskType || 'GOOGLE_SCHOLAR_VERIFICATION';
    const shouldVisitCitations = (taskType === 'GOOGLE_SCHOLAR_REFERENCE');
    generateExcel = options.generateExcel !== undefined ? options.generateExcel : true;

    const customOutputDir = options.outputDir;   // 获取自定义输出目录

    let baseOutputDir;
    if (customOutputDir && customOutputDir.trim() !== '') {
        baseOutputDir = customOutputDir;
        addLog('info', `使用自定义输出目录: ${baseOutputDir}`);
    } else {
        baseOutputDir = OUTPUT_BASE_DIR;   // 原来的默认输出目录
        addLog('info', `使用默认输出目录: ${baseOutputDir}`);
    }
    ensureDir(baseOutputDir);   // 确保目录存在
    // 更严格的输入处理逻辑
    let searchKeywords;
    let originalPapers = [];
    if (Array.isArray(input) && input.length > 0) {
        const firstItem = input[0];


        // 判断是否是论文对象数组（包含title字段）
        if (typeof firstItem === 'object' && firstItem !== null && 'title' in firstItem) {
            console.log('识别为论文对象数组，准备生成搜索关键词');
            const paperInfoList = convertFrontendPapersToPaperInfo(input);
            console.log(`paperInfoList 数量: ${paperInfoList.length}`);
            searchKeywords = generateSearchKeywords(paperInfoList);
            console.log('生成的搜索关键词:', searchKeywords);
            originalPapers = input; // 保存原始论文对象（包含 id）
        }
        // 兼容旧的字符串关键词数组
        else if (typeof firstItem === 'string') {
            console.log('识别为字符串关键词列表');
            // 为每个关键词创建简单的paper对象
            const paperInfoList = input.map(keyword => ({
                title: keyword,
                authors: '',
                abstract: '',
                citations: '',
                year: '',
                publication: '',
                remark: '',
                searchTime: '',
                resultCountFormatted: '',
                endNoteLink: '',
                downloadedFilePath: '',
                citationLink: ''
            }));
            searchKeywords = generateSearchKeywords(paperInfoList);
        }
        else {
            console.log('未知输入类型，使用测试数据');
            searchKeywords = generateSearchKeywords(getTestPaperInfoList());
        }
    } else {
        console.log('输入为空，使用测试数据');
        searchKeywords = generateSearchKeywords(getTestPaperInfoList());
    }

    // 重置爬虫状态
    resetCrawlerState();
    crawlerState.isRunning = true;
    shouldStop = false;

    const timestamp = new Date().toISOString().replace(/[-:\.T]/g, '').slice(0, 15);
    currentOutputDir = path.join(baseOutputDir, timestamp);   // 改为 baseOutputDir
    crawlerState.currentDir = currentOutputDir;

    await setupOutputAndLogs(currentOutputDir, timestamp, searchKeywords);

    successPaperList = [];
    failedPaperList = [];
    fileIndex = 1;

    let page = null;
    let context = null;

    try {
        // 准备浏览器环境
        const { context: ctx, page: p } = await setupBrowserEnvironment();
        context = ctx;
        page = p;

        addLog('info', `\n=== 开始爬取谷歌学术 ===`);
        addLog('info', `关键词数量: ${searchKeywords.length}`);
        addLog('info', `任务类型: ${taskType}`);
        addLog('info', `精确搜索模式: ${PRECISE_SEARCH_ENABLED}`);

        // 处理关键词（抓取主论文）
        await processKeywords(page, searchKeywords, originalPapers);

        // 根据任务类型决定是否抓取引用链接
        if (shouldVisitCitations) {
            addLog('info', `任务类型为 ${taskType}，开始抓取引用链接中的文章`);
            try {
                await visitCitationLinks(page, successPaperList);
            } catch (visitError) {
                addLog('info', `访问引用链接过程中发生错误: ${visitError.message}`);
            }
        } else {
            addLog('info', `任务类型为 ${taskType}，跳过引用链接抓取`);
        }


        // 所有工作完成后，最终处理（写入 Excel、汇总等）
        await finalizeResults();

        // 打印汇总信息并导出引用文章 Excel
        printSummary(successPaperList);
        exportCitingPapersToExcel(successPaperList);
        return crawlerState.result;
    } catch (error)  {
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
        const formattedError = errorUtils.formatError(error, 'google');
        crawlerState.error = formattedError;
        // 将原始详细信息写入日志
        addLog('info', formattedError.detail);
        addLog('error', `用户提示：${formattedError.userMessage}`);
        // 抛出自定义错误
        throw formattedError;


    } finally {
        // 清理工作（原样保留）
        if (logStream) {
            logStream.end();
            logStream = null;
        }
        if (browserInstance) {
            try {
                await browserInstance.close();
                browserInstance = null;
            } catch (e) {
                addLog('info', `关闭浏览器失败: ${e.message}`);
            }
        }
        if (currentUserDataDir) {
            try {
                fs.rmSync(currentUserDataDir, { recursive: true, force: true });
                addLog('info', `已清理临时目录: ${currentUserDataDir}`);
            } catch (e) {
                addLog('info', `清理临时目录失败: ${e.message}`);
            }
        }
        crawlerState.isRunning = false;
        addLog('info', '\n=== 爬虫执行结束 ===');
    }
}
if (require.main === module) {
    const args = process.argv.slice(2); // 获取所有命令行参数

    if (args.length > 0) {
        // 尝试将参数合并为一个字符串（用空格连接，恢复被拆分的 JSON）
        const combined = args.join(' ').trim();

        // 如果合并后的字符串以 '[' 开头，尝试解析为 JSON 数组
        if (combined.startsWith('[')) {
            try {
                const papers = JSON.parse(combined);
                crawlGoogleScholar(papers)
                    .then(() => process.exit(0))
                    .catch(err => {
                        console.error('爬虫执行失败:', err);
                        process.exit(1);
                    });
            } catch (e) {
                console.error('合并参数解析 JSON 失败，尝试作为关键词列表处理:', e.message);
                // 解析失败，则将原参数视为关键词列表（注意：args 可能仍是拆分后的，但 generateSearchKeywords 会处理）
                crawlGoogleScholar(args)
                    .then(() => process.exit(0))
                    .catch(err => {
                        console.error('爬虫执行失败:', err);
                        process.exit(1);
                    });
            }
        } else {
            // 不以 '[' 开头，直接作为关键词列表
            crawlGoogleScholar(args)
                .then(() => process.exit(0))
                .catch(err => {
                    console.error('爬虫执行失败:', err);
                    process.exit(1);
                });
        }
    } else {
        // 没有命令行参数，则尝试从标准输入读取
        let inputData = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => inputData += chunk);
        process.stdin.on('end', () => {
            if (inputData.trim()) {
                try {
                    const papers = JSON.parse(inputData);
                    crawlGoogleScholar(papers)
                        .then(() => process.exit(0))
                        .catch(err => {
                            console.error(err);
                            process.exit(1);
                        });
                } catch (e) {
                    console.error('解析标准输入数据失败:', e.message);
                    // 使用测试数据
                    crawlGoogleScholar()
                        .then(() => process.exit(0))
                        .catch(err => {
                            console.error(err);
                            process.exit(1);
                        });
                }
            } else {
                // 无输入，使用测试数据
                crawlGoogleScholar()
                    .then(() => process.exit(0))
                    .catch(err => {
                        console.error(err);
                        process.exit(1);
                    });
            }
        });
    }
}
//  导出模块
module.exports = {
    crawlGoogleScholar,
    getCrawlerState,
    resetCrawlerState,
    stopCrawler,
    restartCrawler
};
