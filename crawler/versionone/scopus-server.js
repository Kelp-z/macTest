const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const ExcelJS = require('exceljs');
const Tesseract = require('tesseract.js');
const readlineSync = require('readline-sync'); // 保留，但不再用于命令行输入

// addLog 配置 addLog
const CONFIG = {
    // EXCEL_FILE_PATH: path.join(__dirname, 'src/main/resources/scopus.xlsx'),
    // TESSERACT_DATA_PATH: path.join(__dirname, 'src/main/resources/tessdata'),
    // FILE_PATH: path.join(__dirname, 'src/main/resources/【5】编辑部引用情况表.xlsx'),
    SCREENSHOT_DIR: path.join(__dirname, 'screenshots'),
    USER_NAME: '28199134',
    PASSWORD: '460256',
    BASE_URL: 'https://www.2447.net/',
    OUTPUT_DIR: path.join(__dirname, 'crawler/src/main/resources/output'),
    CAPTCHA_DIR: path.join(__dirname, 'captcha_temp') // 临时存放验证码图片
};

// 确保目录存在
if (!fs.existsSync(CONFIG.CAPTCHA_DIR)) fs.mkdirSync(CONFIG.CAPTCHA_DIR, { recursive: true });
if (!fs.existsSync(CONFIG.OUTPUT_DIR)) fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });

// addLog 全局状态 addLog
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
    stopRequested: false , // 新增：是否收到停止信号
    manualModeActive: false,
    manualModeResolve: null,
    manualModeReject: null
};
let shouldStop = false; // 全局停止标志

// 日志函数（同时存储到状态）
function addLog(message) {
    const logEntry = { time: new Date().toISOString(), message };
    crawlerState.logs.push(logEntry);
    crawlerState.logIndex++;
    if (crawlerState.logs.length > 1000) crawlerState.logs.shift();
    console.log(message); // 控制台输出
}

// addLog Express & Socket.io addLog
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());

 // 前端页面
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 提供验证码图片访问
app.use('/captcha', express.static(CONFIG.CAPTCHA_DIR));

// addLog Socket.io 连接处理 addLog
io.on('connection', (socket) => {
    addLog('前端已连接');
    socket.on('disconnect', () => {
        addLog('前端断开连接');
    });
});


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

async function humanType(page, locator, text) {
    await locator.fill('');
    for (const char of text) {
        await locator.type(char, { delay: 50 + Math.random() * 80 });
        await page.waitForTimeout(10);
    }
}


/**
 * 等待用户通过前端输入验证码
 * @param {Page} page - Playwright 页面对象，用于截图
 * @returns {Promise<string>} 用户输入的验证码
 */
async function waitForCaptchaFromUser(page) {
    // 截取验证码图片
    const captchaImage = page.locator('img[src*="ShowKey"][title*="看不清楚"]');
    await captchaImage.waitFor({ state: 'visible', timeout: 10000 });
    const screenshot = await captchaImage.screenshot();
    const captchaId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const imagePath = path.join(CONFIG.CAPTCHA_DIR, `${captchaId}.png`);
    fs.writeFileSync(imagePath, screenshot);

    // 设置全局等待状态
    crawlerState.waitingForCaptcha = true;
    crawlerState.captchaId = captchaId;
    crawlerState.captchaImagePath = `/captcha/${captchaId}.png`;

    // 通过 Socket 通知前端
    io.emit('captcha-required', {
        captchaId,
        imageUrl: crawlerState.captchaImagePath
    });
    addLog(`验证码请求已发送，等待用户输入... (ID: ${captchaId})`);

    // 创建一个 Promise，等待用户提交
    return new Promise((resolve, reject) => {
        crawlerState.captchaResolve = resolve;
        crawlerState.captchaReject = reject;

        // 设置超时（5分钟）
        const timeout = setTimeout(() => {
            if (crawlerState.waitingForCaptcha && crawlerState.captchaId === captchaId) {
                crawlerState.waitingForCaptcha = false;
                crawlerState.captchaId = null;
                crawlerState.captchaImagePath = null;
                reject(new Error('验证码输入超时'));
            }
        }, 300000);

        // 当 resolve 被调用时，清除超时
        // 注意：resolve 会在 /api/captcha/submit 中被调用
        // 我们需要在 resolve 后清除超时，但这里无法直接捕获，将在接口中处理
        // 为了简单，我们将在接口中清除超时
    });
}

// 登录流程（修改，使用 waitForCaptchaFromUser）
async function login(page) {
    const MAX_LOGIN_ATTEMPTS = 5;

    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
        addLog(`\naddLog 第 ${attempt} 次登录尝试 addLog`);

        // 检查是否已登录
        const isLoggedIn = await page.locator('text=帐号名称').isVisible().catch(() => false);
        if (isLoggedIn) {
            addLog('检测到已登录状态，跳过登录流程');
            break;
        }

        // 确保在登录页
        const isLoginPage = await page.url().includes('doaction.php') ||
            await page.locator('#username').isVisible({ timeout: 3000 }).catch(() => false);
        if (!isLoginPage) {
            const loginBtn = page.locator('text=用户登录');
            await loginBtn.waitFor({ state: 'visible', timeout: 10000 });
            await humanClick(page, loginBtn);
            await page.waitForLoadState('domcontentloaded');
        }

        // 填写用户名密码
        try {
            await page.locator('#username').waitFor({ state: 'visible', timeout: 10000 });
            await humanType(page, page.locator('#username'), CONFIG.USER_NAME);
            await humanType(page, page.getByLabel('密码:'), CONFIG.PASSWORD);
            addLog('账号密码填写完成');
        } catch (e) {
            addLog(`填写失败: ${e.message}`);
            continue;
        }

        // 等待验证码输入（手动）
        let captchaCode;
        try {
            // 确保验证码输入框可见
            await page.locator('#key').waitFor({ state: 'visible', timeout: 5000 });
            // 调用等待用户输入
            captchaCode = await waitForCaptchaFromUser(page);
            addLog('验证码已收到，正在填写...');
            await humanType(page, page.locator('#key'), captchaCode);
        } catch (e) {
            addLog(`验证码处理失败: ${e.message}`);
            // 如果超时或被拒绝，尝试刷新验证码（点击图片）
            try {
                await page.locator('img[src*="ShowKey"]').click();
                await page.waitForTimeout(1000);
            } catch (clickErr) {}
            continue;
        }

        // 点击登录
        const confirm = page.locator('text=登 录');
        await confirm.waitFor({ state: 'visible', timeout: 10000 });
        await humanClick(page, confirm);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(3000);

        // 校验登录结果
        const welcomePattern = /你好：[0-9]+，欢迎登录/;
        try {
            await page.locator(`text=${welcomePattern}`).first().waitFor({ state: 'visible', timeout: 5000 });
            addLog('✅ 登录成功！');
            break;
        } catch (e) {
            addLog('登录失败，可能验证码错误');
            const returnedToLogin = await page.url().includes('doaction.php') ||
                await page.locator('#username').isVisible({ timeout: 3000 }).catch(() => false);
            if (!returnedToLogin) {
                throw new Error('登录后进入未知页面');
            }
            // 继续循环
        }
    }

    // 登录后跳转
    try {
        const jump = page.locator('text=如果您的浏览器没有自动跳转，请点击这里');
        await jump.waitFor({ state: 'visible', timeout: 5000 });
        await humanClick(page, jump);
        addLog('点击跳转链接');
    } catch (e) {
        addLog('跳转提示不存在，可能已自动跳转');
    }
}


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

//  navigateToScopus
async function navigateToScopus(page, browserContext) {
    // 跳转到首页
    const home = page.locator('text=首页');
    await home.waitFor({ state: 'visible', timeout: 10000 });
    if (await home.isEnabled()) {
        await humanClick(page, home);
        addLog('首页跳转成功');
    } else {
        addLog('首页跳转失败');
    }

    // 点击英文数据库
    const englishDatabase = page.locator('text=英文数据库');
    await englishDatabase.waitFor({ state: 'visible', timeout: 10000 });
    if (await englishDatabase.isEnabled()) {
        await humanClick(page, englishDatabase);
        addLog('英文数据库点击成功');
    } else {
        addLog('英文数据库点击失败');
    }

    // 打开SCOPUS文摘新页面（用 Promise.all 稳定捕获 popup）
    let newPage;
    try {
        [newPage] = await Promise.all([
            page.waitForEvent('popup', { timeout: 15000 }),
            page.click('text=SCOPUS文摘')
        ]);
        addLog('SCOPUS文摘页面打开成功');
    } catch (e) {
        throw new Error('打开SCOPUS文摘页面失败: ' + e.message);
    }

    // 等待新页面加载完成，并确保镜像链接出现
    await newPage.waitForLoadState('domcontentloaded', { timeout: 30000 });
    await newPage.waitForSelector('div.shuoming a', { timeout: 30000 });
    addLog('SCOPUS文摘页面加载完成，开始解析镜像链接');

    // 提取所有镜像链接
    const links = await newPage.$$eval('div.shuoming a', (anchors) => {
        return anchors.map((a, index) => ({
            index: index + 1,
            text: a.textContent.trim(),
            href: a.href
        }));
    });

    if (links.length === 0) {
        throw new Error('未找到任何镜像链接');
    }

    addLog('\n可用的 Scopus 镜像站点：');
    links.forEach(link => {
        addLog(`${link.index}. ${link.text} - ${link.href}`);
    });

    // 自动尝试每个链接
    let scopusPage = false;
    for (let i = 0; i < links.length; i++) {
        if (shouldStop) {
            addLog('⏹️ 收到停止信号，停止尝试镜像');
            break;
        }
        const link = links[i];
        addLog(`\n[自动尝试 ${i+1}/${links.length}] 正在打开: ${link.text} (${link.href})`);

        let newTab;
        try {
            [newTab] = await Promise.all([
                browserContext.waitForEvent('page', { timeout: 30000 }),
                newPage.locator('div.shuoming a').nth(i).click()
            ]);
            const initialUrl = newTab.url();
            addLog(`新页面已打开，当前URL: ${initialUrl}`);
        } catch (e) {
            addLog(`点击链接后未检测到新页面: ${e.message}`);
            continue;
        }

        // 等待页面加载
        try {
            await newTab.waitForLoadState('domcontentloaded', { timeout: 60000 });
            await newTab.waitForTimeout(2000); // 等待动态内容
            const url = newTab.url();
            addLog(`页面加载完成，URL: ${url}`);
            addLog(`页面标题: ${await newTab.title()}`);


            let pageType = 'unknown';

            // 检测维护提示
            try {
                await newTab.locator('text=该入口定时维护中').first().waitFor({ state: 'visible', timeout: 5000 });
                const maintenanceText = await newTab.locator('text=该入口定时维护中').first().textContent();
                addLog(`⛔ 检测到维护提示: "${maintenanceText}"`);
                await newTab.close().catch(() => {});
                continue; // 跳过此链接
            } catch (e) {
                addLog('未检测到维护提示，继续检查 Scopus 元素');
            }

            // 2. 检测是否为空白页
            if (url === 'about:blank') {
                throw new Error('页面仍为 about:blank');
            }

            // 3. 使用通用函数检测是否为真正的 Scopus 页面
            const isReady = await waitForScopusReady(newTab, 30000);
            if (!isReady) {
                // 如果既不是维护页，也不是 Scopus 页，则记录并关闭
                // 打印页面可见文本片段
                const bodyText = await newTab.locator('body').textContent().catch(() => '');
                addLog(`页面内容片段: ${bodyText.substring(0, 200)}`);
                throw new Error('页面缺少 Scopus 检索元素');
            }

            addLog(`✅ 成功加载 Scopus 页面: ${url}`);
            scopusPage = newTab;
            break; // 成功找到可用页面，退出循环

        } catch (error) {
            let finalUrl = 'unknown';
            try {
                finalUrl = newTab.url();
            } catch (e) {}
            addLog(`❌ 加载失败: ${error.message}, URL: ${finalUrl}`);
            await newTab.close().catch(() => {});
            // 继续尝试下一个链接
        }
    }


    // 如果自动尝试全部失败，进入手动模式
    if (!scopusPage) {
        addLog('\n⚠️ 所有镜像站点自动尝试均失败。');
        addLog('请手动在浏览器中打开一个可用的 Scopus 页面（例如点击任意镜像链接）。');

        // 确保截图目录存在
        if (!fs.existsSync(CONFIG.SCREENSHOT_DIR)) {
            fs.mkdirSync(CONFIG.SCREENSHOT_DIR, { recursive: true });
        }

        // 循环，允许用户多次尝试
        while (true) {
            if (shouldStop) {
                throw new Error('用户停止');
            }

            // 设置手动模式状态
            crawlerState.manualModeActive = true;
            io.emit('manual-mode-required'); // 通知前端

            // 等待前端确认
            try {
                await new Promise((resolve, reject) => {
                    crawlerState.manualModeResolve = resolve;
                    crawlerState.manualModeReject = reject;

                    const timeout = setTimeout(() => {
                        if (crawlerState.manualModeActive) {
                            crawlerState.manualModeActive = false;
                            crawlerState.manualModeResolve = null;
                            crawlerState.manualModeReject = null;
                            reject(new Error('手动操作超时'));
                        }
                    }, 300000); // 5分钟超时
                });
            } catch (err) {
                addLog(`手动操作等待失败: ${err.message}`);
                crawlerState.manualModeActive = false;
                crawlerState.manualModeResolve = null;
                crawlerState.manualModeReject = null;

                if (err.message === '用户停止') {
                    throw err; // 用户主动停止，退出
                }
                // 超时或其他错误，继续循环让用户重新尝试
                continue;
            }

            // 用户确认后，获取最新页面
            const allPages = browserContext.pages();
            const candidatePage = allPages[allPages.length - 1];
            const url = candidatePage.url();
            const title = await candidatePage.title().catch(() => '无法获取标题');

            // 截图保存
            const screenshotTimestamp = Date.now();
            const screenshotPath = path.join(CONFIG.SCREENSHOT_DIR, `manual-${screenshotTimestamp}.png`);
            try {
                await candidatePage.screenshot({ path: screenshotPath, fullPage: true });
                addLog(`手动页面截图已保存: ${screenshotPath}`);
            } catch (screenshotErr) {
                addLog(`截图失败: ${screenshotErr.message}`);
            }

            addLog(`手动打开的页面信息: URL=${url}, 标题=${title}`);

            if (!url || url === 'about:blank') {
                addLog('手动打开的页面无效（about:blank），请重新打开正确的 Scopus 页面');
                crawlerState.manualModeActive = false;
                crawlerState.manualModeResolve = null;
                crawlerState.manualModeReject = null;
                continue;
            }

            // 等待页面加载并检查关键元素
            try {
                await candidatePage.waitForLoadState('domcontentloaded', { timeout: 30000 });
                const isReady = await waitForScopusReady(candidatePage, 30000);
                if (!isReady) {
                    addLog('手动打开的页面似乎不是 Scopus 检索页，请重新选择');
                    crawlerState.manualModeActive = false;
                    crawlerState.manualModeResolve = null;
                    crawlerState.manualModeReject = null;
                    continue;
                }
                addLog(`✅ 手动确认 Scopus 页面: ${url}`);
                scopusPage = candidatePage;
                break; // 成功，退出循环
            } catch (e) {
                addLog(`手动页面验证失败: ${e.message}`);
                crawlerState.manualModeActive = false;
                crawlerState.manualModeResolve = null;
                crawlerState.manualModeReject = null;
                continue; // 继续尝试
            }

        }
    }

    addLog('\n🚀 已进入 Scopus 页面，开始抓取论文...\n');
    return scopusPage;
}

// 封装：检索单篇论文（等待策略 + 定位器 + 反爬）
async function searchSinglePaper(latestPage, searchKeyWords) {
    let paperData = null;
    let isRecruit = false;

    try {
        // 替换networkidle为domcontentloaded + 业务元素等待
        await latestPage.waitForLoadState('domcontentloaded', { timeout: 120000 });
        addLog(`【${searchKeyWords}】页面DOM加载完成，开始查找输入框`);

        // 定位输入框（兼容Playwright语法）
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
                addLog(`【${searchKeyWords}】找到Search documents输入框（定位方式：${locator.toString()}`);
                break;
            } catch (e) {
                continue;
            }
        }

        if (!inputElement) {
            throw new Error('未找到Search documents输入框');
        }

        // 人类输入检索内容
        await humanType(latestPage,inputElement, searchKeyWords);
        addLog(`【${searchKeyWords}】输入框已填充检索内容`);

        // 点击搜索按钮（优化定位器 + 人类点击）
        let submitButton = null;
        const buttonLocators = [
            latestPage.locator('button[type="submit"].Button_button__9XFW1:has-text("Search")'),
            latestPage.locator('button[type="submit"]:has(span:text("Search"))'),
            latestPage.locator('button:visible:has-text("Search")')
        ];

        if (shouldStop) {
            addLog('⏹️ 收到停止信号，跳过当前论文');
            return null;
        }

        for (const locator of buttonLocators) {
            try {
                await locator.waitFor({ state: 'visible', timeout: 8000 });
                submitButton = locator;
                addLog(`【${searchKeyWords}】找到Search按钮（定位方式：${locator.toString()}`);
                break;
            } catch (e) {
                addLog(`【${searchKeyWords}】定位器 ${locator.toString()} 未找到按钮，尝试下一个...`);
                continue;
            }
        }

        if (!submitButton) {
            throw new Error('未找到Search按钮，请检查页面DOM是否匹配');
        }

        // 重试点击按钮（人类点击）
        let clickSuccess = false;
        for (let i = 0; i < 3; i++) { // 最多重试3次
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

        if (!clickSuccess) {
            throw new Error('多次点击Search按钮失败，请手动检查页面');
        }

        // 等待搜索结果加载（替换networkidle）
        await latestPage.waitForLoadState('domcontentloaded', { timeout: 10000 });
        await latestPage.waitForTimeout(3000); // 额外等待3秒

        // 判断是否有检索结果（优化定位器）
        const titleKeyword = searchKeyWords.substring(0, 50); // 缩短匹配文本，避免过长
        const allElements = latestPage.locator(`span:has-text("${titleKeyword}")`);
        let hasResults = false;

        try {
            await allElements.first().waitFor({ state: 'visible', timeout: 8000 });
            hasResults = true;
        } catch (e) {
            hasResults = false;
        }

        if (!hasResults) {
            addLog(`【${searchKeyWords}】未搜索到结果\n`);
            paperData = {
                eid: '无',
                isRecruit: 'false',
                title: searchKeyWords,
                searchTime: formatDate(new Date())
            };
            await latestPage.goBack();
            await latestPage.waitForLoadState('domcontentloaded');
        } else {
            const count = await allElements.count();
            addLog(`【${searchKeyWords}】找到 ${count} 个匹配结果`);

            if (count > 0) {
                await humanClick(latestPage, allElements.first()); // 人类点击
                isRecruit = true;

                // 展开所有信息
                const showAll = latestPage.locator('text=Show all information');
                await showAll.waitFor({ state: 'visible', timeout: 100000 });
                await humanClick(latestPage, showAll); // 人类点击

                // 获取EID
                const EID = latestPage.locator('dd[data-testid="document-info-eid"]');
                await EID.waitFor({ state: 'visible', timeout: 100000 });
                const eid = await EID.textContent();
                addLog(`【${searchKeyWords}】EID:`, eid.trim(), '\n');

                paperData = {
                    eid: eid.trim(),
                    isRecruit: String(isRecruit),
                    title: searchKeyWords,
                    searchTime: formatDate(new Date())
                };

                // 返回上两级页面
                await latestPage.evaluate(() => window.history.go(-2));
                await latestPage.waitForLoadState('domcontentloaded');
            } else {
                addLog(`【${searchKeyWords}】未搜索到结果`);
                paperData = {
                    eid: '无',
                    isRecruit: String(isRecruit),
                    title: searchKeyWords,
                    searchTime: formatDate(new Date())
                };
                await latestPage.goBack();
                await latestPage.waitForLoadState('domcontentloaded');
            }
        }
    } catch (e) {
        addLog(`【${searchKeyWords}】搜索错误`, e.message);
        // 异常时默认返回无结果
        paperData = {
            eid: '无',
            isRecruit: 'false',
            title: searchKeyWords,
            searchTime: formatDate(new Date())
        };
    }

    return paperData;
}

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

async function writeToExcel(newDataList) {
    let filePath; // 声明在外部，使其在整个函数内可访问
    try {
        // 生成带时间戳的文件名
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hour = String(now.getHours()).padStart(2, '0');
        const minute = String(now.getMinutes()).padStart(2, '0');
        const second = String(now.getSeconds()).padStart(2, '0');
        const timestamp = `${year}-${month}-${day}_${hour}-${minute}-${second}`;
        const fileName = `SCOPUS-${timestamp}.xlsx`;
        filePath = path.join(CONFIG.OUTPUT_DIR, fileName); // 赋值给外部变量

        // 确保输出目录存在
        if (!fs.existsSync(CONFIG.OUTPUT_DIR)) {
            fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('scopus');

        // 定义列配置
        const columnConfig = [
            { key: 'eid', header: 'EID', width: 30 },
            { key: 'isRecruit', header: '是否收录', width: 10 },
            { key: 'title', header: '论文标题', width: 80 },
            { key: 'searchTime', header: '检索时间', width: 20 }
        ];
        worksheet.columns = columnConfig.map(item => ({ header: item.header, key: item.key, width: item.width }));

        // 写入数据
        newDataList.forEach(item => {
            worksheet.addRow({
                eid: item.eid,
                isRecruit: item.isRecruit,
                title: item.title,
                searchTime: item.searchTime
            });
        });

        await workbook.xlsx.writeFile(filePath);
        addLog(`数据写入成功，文件：${filePath}，共 ${newDataList.length} 条记录`);
    } catch (e) {
        addLog('写入失败:', e.message);
        console.error(e.stack);
        // 可以选择抛出错误，让上层处理，或者返回 null
        // throw e;
    }
    return filePath; // 现在可以正确返回
}

// addLog 爬虫主函数 addLog
async function runCrawler(keywords) {
    let context = null;
    let page = null;
    shouldStop = false; // 重置停止标志

    try {
        context = await chromium.launchPersistentContext('', {
            headless: false,
            viewport: { width: 1800, height: 960 },
            args: ['--disable-popup-blocking'],
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            locale: 'en-US',
            timezoneId: 'America/New_York'
        });
        page = context.pages()[0];
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
        });

        await page.goto(CONFIG.BASE_URL, { waitUntil: 'domcontentloaded' });

        if (shouldStop) throw new Error('用户停止');
        await login(page);

        if (shouldStop) throw new Error('用户停止');
        const scopusPage = await navigateToScopus(page, context);

        if (shouldStop) throw new Error('用户停止');
        const results = await batchSearchPapers(scopusPage, keywords);

        if (!shouldStop) {
            const filePath = await writeToExcel(results);
            addLog(`✅ 爬取完成，结果文件：${filePath}`);
            return { results, filePath };
        } else {
            addLog('⏹️ 爬虫已停止，未生成结果文件');
            return { results: [], filePath: null };
        }

    } catch (err) {
        if (err.message === '用户停止') {
            addLog('⏹️ 爬虫已被用户手动停止');
        } else {
            addLog(`❌ 爬虫错误: ${err.message}`);
        }
        throw err;
    } finally {
        if (context) await context.close();
    }

}

app.post('/api/crawl/start', async (req, res) => {
    const { keywords } = req.body;
    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
        return res.status(400).json({ code: 400, msg: '关键词数组不能为空' });
    }

    if (crawlerState.isRunning) {
        return res.status(409).json({ code: 409, msg: '爬虫正在运行中' });
    }

    // 重置状态
    crawlerState.isRunning = true;
    crawlerState.progress = 0;
    crawlerState.logs = [];
    crawlerState.result = null;
    crawlerState.filePaths = [];
    crawlerState.error = null;
    crawlerState.waitingForCaptcha = false;
    crawlerState.captchaId = null;
    crawlerState.captchaImagePath = null;
    crawlerState.stopRequested = false;

    addLog('🚀 爬虫启动');

    (async () => {
        try {
            const { results, filePath } = await runCrawler(keywords);
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
            addLog('爬虫停止');
        }
    })();

    res.status(202).json({ code: 202, msg: '爬虫已启动' });
});

app.post('/api/crawl/stop', (req, res) => {
    if (!crawlerState.isRunning) {
        return res.status(400).json({ code: 400, msg: '没有正在运行的爬虫' });
    }
    // 设置全局停止标志
    shouldStop = true;
    crawlerState.stopRequested = true;

    // 如果处于手动模式，主动 reject 等待的 Promise
    if (crawlerState.manualModeActive && crawlerState.manualModeReject) {
        crawlerState.manualModeReject(new Error('用户停止'));
        crawlerState.manualModeActive = false;
        crawlerState.manualModeResolve = null;
        crawlerState.manualModeReject = null;
    }

    addLog('⏹️ 收到停止请求，正在停止...');
    res.status(200).json({ code: 200, msg: '停止信号已发送' });
});

app.post('/api/captcha/submit', (req, res) => {
    const { captchaId, captchaCode } = req.body;
    if (!captchaId || !captchaCode) return res.status(400).json({ code: 400, msg: '缺少参数' });

    if (crawlerState.waitingForCaptcha && crawlerState.captchaId === captchaId) {
        if (crawlerState.captchaResolve) {
            crawlerState.captchaResolve(captchaCode);
            crawlerState.waitingForCaptcha = false;
            crawlerState.captchaId = null;
            crawlerState.captchaImagePath = null;
            crawlerState.captchaResolve = null;
            crawlerState.captchaReject = null;
            addLog(`验证码 ${captchaId} 已提交`);
            return res.json({ code: 200, msg: '验证码已提交' });
        }
    }
    res.status(404).json({ code: 404, msg: '无效的验证码请求' });
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
    crawlerState.isRunning = false;
    crawlerState.progress = 0;
    crawlerState.logs = [];
    crawlerState.result = null;
    crawlerState.filePaths = [];
    crawlerState.error = null;
    crawlerState.waitingForCaptcha = false;
    crawlerState.captchaId = null;
    crawlerState.captchaImagePath = null;
    crawlerState.stopRequested = false;
    crawlerState.manualModeActive = false;
    crawlerState.manualModeResolve = null;
    crawlerState.manualModeReject = null;
    addLog('状态已重置');
    res.json({ code: 200, msg: '状态已重置' });
});

app.post('/api/crawl/manual-confirm', (req, res) => {
    if (!crawlerState.manualModeActive) {
        return res.status(400).json({ code: 400, msg: '未处于手动模式' });
    }
    if (crawlerState.manualModeResolve) {
        crawlerState.manualModeResolve();
        crawlerState.manualModeActive = false;
        crawlerState.manualModeResolve = null;
        crawlerState.manualModeReject = null;
        addLog('用户已确认手动操作，继续执行');
        return res.json({ code: 200, msg: '已确认' });
    }
    res.status(500).json({ code: 500, msg: '内部错误' });
});

const PORT = 3002;
server.listen(PORT, () => {
    console.log(`Scopus 交互式爬虫服务运行在 http://localhost:${PORT}`);
});
