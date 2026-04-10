const express = require('express');
const http = require('http');
const {Server} = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const {chromium} = require('playwright');
const ExcelJS = require('exceljs');
const readlineSync = require('readline-sync'); // 仅保留用于手动模式（其实已替换）

// ========== 配置 ==========
const CONFIG = {
    USER_NAME: '28199134',
    PASSWORD: '460256',
    BASE_URL: 'https://www.2447.net/',
    OUTPUT_DIR: path.join(__dirname, 'src/main/resources/output'),
    CAPTCHA_DIR: path.join(__dirname, 'captcha_temp'),
    SCREENSHOT_DIR: path.join(__dirname, 'screenshots')
};

// 确保目录存在
[CONFIG.CAPTCHA_DIR, CONFIG.OUTPUT_DIR, CONFIG.SCREENSHOT_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
});

// ========== 全局状态 ==========
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
    captchaResolve: null,
    captchaReject: null,
    stopRequested: false,
    manualModeActive: false,
    manualModeResolve: null,
    manualModeReject: null
};
let shouldStop = false;

function addLog(message) {
    const logEntry = {time: new Date().toISOString(), message};
    crawlerState.logs.push(logEntry);
    crawlerState.logIndex++;
    if (crawlerState.logs.length > 1000) crawlerState.logs.shift();
    console.log(message);
}

// ========== Express & Socket.io ==========
const app = express();
const server = http.createServer(app);
const io = new Server(server, {cors: {origin: '*'}});

app.use(cors());
app.use(express.json());
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use('/captcha', express.static(CONFIG.CAPTCHA_DIR));

io.on('connection', (socket) => {
    addLog('前端已连接');
    socket.on('disconnect', () => addLog('前端断开连接'));
});

// ========== 工具函数 ==========
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day}:${hours}:${minutes}:${seconds}`;
}

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
        addLog(`人类点击模拟失败: ${e.message}`);
        return false;
    }
}

async function humanType(page, locator, text) {
    await locator.fill('');
    for (const char of text) {
        await locator.type(char, {delay: 50 + Math.random() * 80});
        await page.waitForTimeout(10);
    }
}

// ========== 验证码等待函数 ==========
async function waitForCaptchaFromUser(page) {
    const captchaImage = page.locator('img[src*="ShowKey"][title*="看不清楚"]');
    await captchaImage.waitFor({state: 'visible', timeout: 10000});
    const screenshot = await captchaImage.screenshot();
    const captchaId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const imagePath = path.join(CONFIG.CAPTCHA_DIR, `${captchaId}.png`);
    fs.writeFileSync(imagePath, screenshot);

    crawlerState.waitingForCaptcha = true;
    crawlerState.captchaId = captchaId;
    crawlerState.captchaImagePath = `/captcha/${captchaId}.png`;
    io.emit('captcha-required', {captchaId, imageUrl: crawlerState.captchaImagePath});
    addLog(`验证码请求已发送，等待用户输入... (ID: ${captchaId})`);

    return new Promise((resolve, reject) => {
        crawlerState.captchaResolve = resolve;
        crawlerState.captchaReject = reject;

        const timeout = setTimeout(() => {
            if (crawlerState.waitingForCaptcha && crawlerState.captchaId === captchaId) {
                crawlerState.waitingForCaptcha = false;
                crawlerState.captchaId = null;
                crawlerState.captchaImagePath = null;
                reject(new Error('验证码输入超时'));
            }
        }, 300000);
    });
}

// ========== 登录流程 ==========
async function login(page) {
    const MAX_LOGIN_ATTEMPTS = 5;

    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
        addLog(`\n========== 第 ${attempt} 次登录尝试 ==========`);

        // 检查是否已登录
        const isLoggedIn = await page.locator('text=你好：').first().isVisible().catch(() => false);
        if (isLoggedIn) {
            addLog('检测到已登录状态，跳过登录流程');
            break;
        }

        // 确保在登录页
        const isLoginPage = await page.url().includes('doaction.php') ||
            await page.locator('#username').isVisible({timeout: 3000}).catch(() => false);
        if (!isLoginPage) {
            const loginBtn = page.locator('text=用户登录');
            await loginBtn.waitFor({state: 'visible', timeout: 10000});
            await humanClick(page, loginBtn);
            await page.waitForLoadState('domcontentloaded');
        }

        // 填写用户名密码
        try {
            await page.locator('#username').waitFor({state: 'visible', timeout: 10000});
            await humanType(page, page.locator('#username'), CONFIG.USER_NAME);
            await humanType(page, page.getByLabel('密码:'), CONFIG.PASSWORD);
            addLog('账号密码填写完成');
        } catch (e) {
            addLog(`填写失败: ${e.message}`);
            await page.reload().catch(() => {
            });
            continue;
        }

        // 等待验证码输入（手动）
        let captchaCode;
        try {
            await page.locator('#key').waitFor({state: 'visible', timeout: 5000});
            captchaCode = await waitForCaptchaFromUser(page);
            addLog('验证码已收到，正在填写...');
            await humanType(page, page.locator('#key'), captchaCode);
        } catch (e) {
            addLog(`验证码处理失败: ${e.message}`);
            try {
                await page.locator('img[src*="ShowKey"]').click();
                await page.waitForTimeout(1000);
            } catch (clickErr) {
            }
            continue;
        }

        // 点击登录
        const confirm = page.locator('text=登 录');
        await confirm.waitFor({state: 'visible', timeout: 10000});
        await humanClick(page, confirm);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(3000);

        // 校验登录结果
        const welcomePattern = /你好：[0-9]+，欢迎登录/;
        try {
            await page.locator(`text=${welcomePattern}`).first().waitFor({state: 'visible', timeout: 5000});
            addLog('✅ 登录成功！');
            break;
        } catch (e) {
            addLog('登录失败，可能验证码错误');
            const returnedToLogin = await page.url().includes('doaction.php') ||
                await page.locator('#username').isVisible({timeout: 3000}).catch(() => false);
            if (!returnedToLogin) {
                throw new Error('登录后进入未知页面');
            }
        }
    }

    // 登录后跳转
    try {
        const jump = page.locator('text=如果您的浏览器没有自动跳转，请点击这里');
        await jump.waitFor({state: 'visible', timeout: 5000});
        await humanClick(page, jump);
        addLog('点击跳转链接');
    } catch (e) {
        addLog('跳转提示不存在，可能已自动跳转');
    }
}

// ========== 辅助函数：判断是否为有效的 WoS 页面 ==========
async function isWosPage(page) {
    try {
        await page.locator('#composeQuerySmartSearch').waitFor({timeout: 10000});
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

// 获取搜索按钮（多种选择器）
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
            if (await button.isVisible({timeout: 1000})) {
                return button;
            }
        } catch (e) {
        }
    }
    throw new Error('找不到搜索按钮');
}

// ========== 导航到 Web of Science 页面（包含手动模式循环） ==========
async function navigateToWoS(page, context) {
    // 点击首页
    const home = page.locator('text=首页');
    await home.waitFor({state: 'visible', timeout: 10000});
    await humanClick(page, home);
    addLog('首页跳转成功');

    // 点击英文数据库
    const englishDatabase = page.locator('text=英文数据库');
    await englishDatabase.waitFor({state: 'visible', timeout: 10000});
    await humanClick(page, englishDatabase);
    addLog('英文数据库点击成功');

    // 打开 (SCI)Web of Science 中间页
    let middlePage;
    [middlePage] = await Promise.all([
        context.waitForEvent('page', {timeout: 15000}),
        (async () => {
            const sciLink = page.locator('text=(SCI)Web of Science');
            await sciLink.waitFor({state: 'visible', timeout: 10000});
            await humanClick(page, sciLink);
            addLog('(SCI)Web of Science 打开成功');
        })()
    ]);

    await middlePage.waitForLoadState('domcontentloaded', {timeout: 30000});
    await middlePage.waitForSelector('div.shuoming a', {timeout: 30000});
    addLog('中间页加载完成，开始解析镜像链接');

    // 提取所有镜像链接
    const links = await middlePage.$$eval('div.shuoming a', (anchors) => {
        return anchors.map((a, index) => ({
            index: index + 1,
            text: a.textContent.trim(),
            href: a.href
        }));
    });

    if (links.length === 0) throw new Error('未找到任何镜像链接');

    // 过滤出 SCI 相关的链接
    const sciLinks = links.filter(link => /sci/i.test(link.text));
    if (sciLinks.length === 0) throw new Error('未找到任何 SCI 镜像链接');

    addLog('\n可用的 SCI 镜像站点：');
    sciLinks.forEach(link => addLog(`${link.index}. ${link.text} - ${link.href}`));

    // 自动尝试每个链接
    let wosPage = null;
    for (let i = 0; i < sciLinks.length; i++) {
        if (shouldStop) {
            addLog('⏹️ 收到停止信号，停止尝试镜像');
            break;
        }
        const link = sciLinks[i];
        addLog(`\n[自动尝试 ${i + 1}/${sciLinks.length}] 正在打开: ${link.text} (${link.href})`);


        let newTab;
        try {
            [newTab] = await Promise.all([
                context.waitForEvent('page', {timeout: 30000}),
                middlePage.locator('div.shuoming a').nth(link.index - 1).click()
            ]);
            addLog(`新页面已创建，初始URL: ${newTab.url()}`);
        } catch (e) {
            addLog(`点击链接后未检测到新页面: ${e.message}`);
            continue;
        }
// 检测“维护中”提示
        try {
            await newTab.locator('text=该入口定时维护中').first().waitFor({state: 'visible', timeout: 5000});
            const maintenanceText = await newTab.locator('text=该入口定时维护中').first().textContent();
            addLog(`⛔ 检测到维护提示: "${maintenanceText}"`);
            await newTab.close().catch(() => {
            });
            continue; // 跳过此链接
        } catch (e) {
            addLog('未检测到维护提示，继续检查 WoS 元素');
        }
        try {
            await newTab.waitForLoadState('domcontentloaded', {timeout: 60000});
            const url = newTab.url();
            if (url === 'about:blank') throw new Error('about:blank');
            const isValid = await isWosPage(newTab);
            if (isValid) {
                addLog(`✅ 成功加载 Web of Science 页面: ${url}`);
                wosPage = newTab;
                break;
            } else {
                throw new Error('页面缺少搜索输入框');
            }
        } catch (error) {
            addLog(`❌ 加载失败 (${newTab.url()}): ${error.message}`);
            await newTab.close().catch(() => {
            });
        }
    }

    // 手动模式循环
    if (!wosPage) {
        addLog('\n⚠️ 所有 SCI 镜像站点自动尝试均失败。');
        addLog('请手动在浏览器中打开一个可用的 Web of Science 页面（例如点击任意 SCI 镜像链接）。');

        while (true) {
            if (shouldStop) throw new Error('用户停止');

            crawlerState.manualModeActive = true;
            io.emit('manual-mode-required');

            try {
                await new Promise((resolve, reject) => {
                    crawlerState.manualModeResolve = resolve;
                    crawlerState.manualModeReject = reject;
                    setTimeout(() => reject(new Error('手动操作超时')), 300000);
                });
            } catch (err) {
                addLog(`手动操作等待失败: ${err.message}`);
                crawlerState.manualModeActive = false;
                crawlerState.manualModeResolve = null;
                crawlerState.manualModeReject = null;
                if (err.message === '用户停止') throw err;
                continue;
            }

            const allPages = context.pages();
            const candidatePage = allPages[allPages.length - 1];
            const url = candidatePage.url();
            const title = await candidatePage.title().catch(() => '无法获取标题');

            const screenshotPath = path.join(CONFIG.SCREENSHOT_DIR, `manual-${Date.now()}.png`);
            try {
                await candidatePage.screenshot({path: screenshotPath, fullPage: true});
                addLog(`截图已保存: ${screenshotPath}`);
            } catch (e) {
            }

            addLog(`手动打开的页面信息: URL=${url}, 标题=${title}`);
            if (!url || url === 'about:blank') {
                addLog('页面无效（about:blank），请重新打开');
                crawlerState.manualModeActive = false;
                crawlerState.manualModeResolve = null;
                crawlerState.manualModeReject = null;
                continue;
            }

            try {
                await candidatePage.waitForLoadState('domcontentloaded', {timeout: 30000});
                const isValid = await isWosPage(candidatePage);
                if (!isValid) throw new Error('不是 WoS 页面');
                addLog(`✅ 手动确认 WoS 页面: ${url}`);
                wosPage = candidatePage;
                break;
            } catch (e) {
                addLog(`验证失败: ${e.message}`);
                crawlerState.manualModeActive = false;
                crawlerState.manualModeResolve = null;
                crawlerState.manualModeReject = null;
                continue;
            }
        }
    }

    await wosPage.locator('#composeQuerySmartSearch').waitFor({state: 'visible', timeout: 30000});
    addLog('\n🚀 已进入 Web of Science 页面，开始检索...\n');
    return wosPage;
}

// ========== 处理Cookie/遮罩层 ==========
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

// ========== 等待搜索结果 ==========
async function waitForSearchResults(page) {
    try {
        await page.waitForSelector("[data-ta='summary-record-title-link']", {timeout: 10000});
        addLog('搜索结果加载完成');
    } catch (e) {
        addLog('等待搜索结果超时');
    }
}

// ========== 高亮提取和匹配函数（与代码一完全相同） ==========
function extractHighlightedWords(html) { /* ... 保持原样 ... */
}

function checkMeaningfulHighlight(highlighted) { /* ... 保持原样 ... */
}

function checkCorePhrase(search, title, highlighted) { /* ... 保持原样 ... */
}

async function isCompleteMatch(resultLocator, searchKeyword) { /* ... 保持原样 ... */
}

async function hasCompleteMatchResults(page, searchKeyword) { /* ... 保持原样 ... */
}

// ========== 处理单个关键词 ==========
async function processKeyword(page, keyword) {
    let isRecruit = false;
    let accessionNo = '';

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
            return {isRecruit: 'false', accessionNo, title: keyword, searchTime: formatDate(new Date())};
        }
        await searchButton.click();
        addLog('搜索按钮点击成功');

        await handleCookieConsent(page);
        await page.waitForLoadState('networkidle');
        addLog('搜索完成');

        await page.waitForTimeout(4000);
        await handleCookieConsent(page);

        const hasMatch = await hasCompleteMatchResults(page, keyword);
        if (hasMatch) {
            const resultLinks = page.locator("[data-ta='summary-record-title-link']");
            await resultLinks.first().click();
            await page.waitForLoadState('networkidle');

            const spreadOut = page.locator("[data-ta='HiddenSecTa-showMoreDataButton']");
            if (await spreadOut.isVisible()) {
                await spreadOut.click();
                await page.waitForTimeout(1000);
            }

            accessionNo = await page.locator("[data-ta='HiddenSecTa-accessionNo']").textContent();
            accessionNo = accessionNo.trim();
            isRecruit = true;
            addLog(`是否收录: true, 入藏号: ${accessionNo}`);

            await page.goBack();
            await page.waitForLoadState('networkidle');
        } else {
            addLog('是否收录: false');
            accessionNo = '无';
        }
    } catch (e) {
        addLog(`处理关键词出错: ${e.message}`);
    }

    return {
        isRecruit: String(isRecruit),
        accessionNo,
        title: keyword,
        searchTime: formatDate(new Date())
    };
}

// ========== 批量检索 ==========
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

// ========== 写入Excel ==========
async function writeToExcel(newDataList) {
    let filePath;
    try {
        const now = new Date();
        const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
        const fileName = `WOS-${timestamp}.xlsx`;
        filePath = path.join(CONFIG.OUTPUT_DIR, fileName);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('web of science');
        const columnConfig = [
            {key: 'isRecruit', header: '是否收录', width: 10},
            {key: 'accessionNo', header: '入藏号', width: 20},
            {key: 'title', header: '论文标题', width: 80},
            {key: 'searchTime', header: '检索时间', width: 20}
        ];
        worksheet.columns = columnConfig.map(item => ({header: item.header, key: item.key, width: item.width}));

        newDataList.forEach(item => worksheet.addRow(item));
        await workbook.xlsx.writeFile(filePath);
        addLog(`数据写入成功，文件：${filePath}，共 ${newDataList.length} 条记录`);
    } catch (e) {
        addLog('写入失败:' + e.message);
        console.error(e.stack);
    }
    return filePath;
}

// ========== 启动浏览器 ==========
async function launchBrowser() {
    const browser = await chromium.launch({
        headless: false,
        args: ['--disable-popup-blocking']
    });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: {width: 1920, height: 1080},
        locale: 'en-US',
        timezoneId: 'America/New_York'
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
        delete navigator.__proto__.webdriver;
        window.chrome = {runtime: {}};
    });
    return {browser, context, page};
}

// ========== 爬虫主函数 ==========
async function runCrawler(keywords) {
    let browser = null;
    let context = null;
    let page = null;
    shouldStop = false;

    try {
        ({browser, context, page} = await launchBrowser());

        await page.goto(CONFIG.BASE_URL, {waitUntil: 'domcontentloaded'});
        addLog('页面标签: ' + await page.title());

        if (shouldStop) throw new Error('用户停止');
        await login(page);

        if (shouldStop) throw new Error('用户停止');
        const wosPage = await navigateToWoS(page, context);

        if (shouldStop) throw new Error('用户停止');
        const results = await batchSearchPapers(wosPage, keywords);

        if (!shouldStop) {
            const filePath = await writeToExcel(results);
            addLog(`✅ 爬取完成，结果文件：${filePath}`);
            return {results, filePath};
        } else {
            addLog('⏹️ 爬虫已停止，未生成结果文件');
            return {results: [], filePath: null};
        }
    } catch (err) {
        if (err.message === '用户停止') addLog('⏹️ 爬虫已被用户手动停止');
        else addLog(`❌ 爬虫错误: ${err.message}`);
        throw err;
    } finally {
        if (browser) await browser.close();
    }
}

// ========== API 接口 ==========
app.post('/api/crawl/start', async (req, res) => {
    const {keywords} = req.body;
    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
        return res.status(400).json({code: 400, msg: '关键词数组不能为空'});
    }
    if (crawlerState.isRunning) {
        return res.status(409).json({code: 409, msg: '爬虫正在运行中'});
    }

    // 重置状态
    Object.assign(crawlerState, {
        isRunning: true,
        progress: 0,
        logs: [],
        result: null,
        filePaths: [],
        error: null,
        waitingForCaptcha: false,
        captchaId: null,
        captchaImagePath: null,
        stopRequested: false,
        manualModeActive: false,
        manualModeResolve: null,
        manualModeReject: null
    });

    addLog('🚀 爬虫启动');

    (async () => {
        try {
            const {results, filePath} = await runCrawler(keywords);
            if (results && results.length > 0) {
                crawlerState.result = results;
                crawlerState.filePaths = [filePath];
            }
        } catch (err) {
            crawlerState.error = err.message;
        } finally {
            crawlerState.isRunning = false;
            crawlerState.waitingForCaptcha = false;
            crawlerState.stopRequested = false;
            crawlerState.manualModeActive = false;
            addLog('爬虫停止');
        }
    })();

    res.status(202).json({code: 202, msg: '爬虫已启动'});
});

app.post('/api/crawl/stop', (req, res) => {
    if (!crawlerState.isRunning) {
        return res.status(400).json({code: 400, msg: '没有正在运行的爬虫'});
    }
    shouldStop = true;
    crawlerState.stopRequested = true;
    if (crawlerState.manualModeActive && crawlerState.manualModeReject) {
        crawlerState.manualModeReject(new Error('用户停止'));
        crawlerState.manualModeActive = false;
        crawlerState.manualModeResolve = null;
        crawlerState.manualModeReject = null;
    }
    addLog('⏹️ 收到停止请求，正在停止...');
    res.status(200).json({code: 200, msg: '停止信号已发送'});
});

app.post('/api/captcha/submit', (req, res) => {
    const {captchaId, captchaCode} = req.body;
    if (!captchaId || !captchaCode) return res.status(400).json({code: 400, msg: '缺少参数'});

    if (crawlerState.waitingForCaptcha && crawlerState.captchaId === captchaId && crawlerState.captchaResolve) {
        crawlerState.captchaResolve(captchaCode);
        crawlerState.waitingForCaptcha = false;
        crawlerState.captchaId = null;
        crawlerState.captchaImagePath = null;
        crawlerState.captchaResolve = null;
        crawlerState.captchaReject = null;
        addLog(`验证码 ${captchaId} 已提交`);
        return res.json({code: 200, msg: '验证码已提交'});
    }
    res.status(404).json({code: 404, msg: '无效的验证码请求'});
});

app.post('/api/crawl/manual-confirm', (req, res) => {
    if (!crawlerState.manualModeActive) {
        return res.status(400).json({code: 400, msg: '未处于手动模式'});
    }
    if (crawlerState.manualModeResolve) {
        crawlerState.manualModeResolve();
        crawlerState.manualModeActive = false;
        crawlerState.manualModeResolve = null;
        crawlerState.manualModeReject = null;
        addLog('用户已确认手动操作，继续执行');
        return res.json({code: 200, msg: '已确认'});
    }
    res.status(500).json({code: 500, msg: '内部错误'});
});

app.get('/api/crawl/status', (req, res) => {
    res.json({
        code: 200,
        data: {
            isRunning: crawlerState.isRunning,
            progress: crawlerState.progress,
            logs: crawlerState.logs,
            result: crawlerState.result,
            filePaths: crawlerState.filePaths,
            error: crawlerState.error,
            logIndex: crawlerState.logIndex,
            waitingForCaptcha: crawlerState.waitingForCaptcha,
            captchaImageUrl: crawlerState.captchaImagePath,
            stopRequested: crawlerState.stopRequested,
            manualModeActive: crawlerState.manualModeActive
        }
    });
});

app.post('/api/crawl/reset', (req, res) => {
    Object.assign(crawlerState, {
        isRunning: false,
        progress: 0,
        logs: [],
        result: null,
        filePaths: [],
        error: null,
        waitingForCaptcha: false,
        captchaId: null,
        captchaImagePath: null,
        stopRequested: false,
        manualModeActive: false,
        manualModeResolve: null,
        manualModeReject: null
    });
    addLog('状态已重置');
    res.json({code: 200, msg: '状态已重置'});
});

const PORT = 3003;
server.listen(PORT, () => {
    console.log(`Web of Science 爬虫服务运行在 http://localhost:${PORT}`);
});
