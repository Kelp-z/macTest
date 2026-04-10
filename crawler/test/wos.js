const { chromium } = require('playwright');
const ExcelJS = require('exceljs');
const readlineSync = require('readline-sync');
const fs = require('fs');
const path = require('path');

// 常量配置
const CONFIG = {
    OUTPUT_DIR: path.join(__dirname, 'src/main/resources/output'), // 新增：输出文件夹
    USER_NAME: '28199134',
    PASSWORD: '460256',
    BASE_URL: 'https://www.2447.net/'
};

// 日期格式化
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day}:${hours}:${minutes}:${seconds}`;
}

// 模拟人类点击
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
        console.log('人类点击模拟失败:', e.message);
        return false;
    }
}

// 模拟人类输入
async function humanType(page, locator, text) {
    await locator.fill('');
    for (const char of text) {
        await locator.type(char, { delay: 50 + Math.random() * 80 });
        await page.waitForTimeout(10);
    }
}

// 读取Excel L列数据（使用ExcelJS）
async function readColumnLSafely(filePath) {
    const columnData = [];
    try {
        if (!fs.existsSync(filePath)) {
            console.log('文件不存在:', filePath);
            return columnData;
        }

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);

        let worksheet = workbook.getWorksheet('引用表');
        if (!worksheet) {
            worksheet = workbook.worksheets[1]; // 取第二个工作表
        }
        if (!worksheet) {
            console.log('未找到有效工作表');
            return columnData;
        }

        const columnLIndex = 11; // L列（0-based）

        worksheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
            if (rowNum >= 3) { // 从第3行开始
                const cell = row.getCell(columnLIndex + 1); // ExcelJS列从1开始
                if (cell && cell.value) {
                    let value = '';
                    if (cell.type === 'number') {
                        value = cell.value.toString();
                    } else if (cell.type === 'string') {
                        value = cell.value.trim();
                    } else if (cell.type === 'formula') {
                        value = cell.result ? cell.result.toString().trim() : '';
                    }
                    if (value) {
                        columnData.push(value);
                    }
                }
            }
        });

        console.log(`从L列读取到 ${columnData.length} 行数据`);
    } catch (e) {
        console.error('读取L列失败:', e.message);
    }
    return columnData;
}

// 写入Excel
async function writeToExcel(newDataList) {
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
        const fileName = `WOS-${timestamp}.xlsx`;
        const filePath = path.join(CONFIG.OUTPUT_DIR, fileName);

        // 确保输出目录存在
        if (!fs.existsSync(CONFIG.OUTPUT_DIR)) {
            fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('web of science');

        // 定义列配置
        const columnConfig = [
            { key: 'isRecruit', header: '是否收录', width: 10 },
            { key: 'accessionNo', header: '入藏号', width: 20 },
            { key: 'title', header: '论文标题', width: 80 },
            { key: 'searchTime', header: '检索时间', width: 20 }
        ];
        worksheet.columns = columnConfig.map(item => ({ header: item.header, key: item.key, width: item.width }));

        // 写入数据
        newDataList.forEach(item => {
            worksheet.addRow({
                isRecruit: item.isRecruit,
                accessionNo: item.accessionNo,
                title: item.title,
                searchTime: item.searchTime
            });
        });

        await workbook.xlsx.writeFile(filePath);
        console.log(`数据写入成功，文件：${filePath}，共 ${newDataList.length} 条记录`);
    } catch (e) {
        console.log('写入失败:', e.message);
        console.error(e.stack);
    }
}

// 处理Cookie/遮罩层（直接执行JS）
async function handleCookieConsent(page) {
    try {
        console.log('检查并处理Cookie弹窗...');
        await page.waitForTimeout(1500);

        const removed = await page.evaluate(`
            () => {
                try {
                    let found = false;
                    // 移除遮罩层
                    const overlays = document.querySelectorAll('.onetrust-pc-dark-filter, .cookie-overlay, .modal-backdrop');
                    overlays.forEach(overlay => { overlay.remove(); found = true; });
                    // 移除弹窗主体
                    const dialogs = document.querySelectorAll('#onetrust-consent-sdk, .onetrust-pc-dark-filter, .cookie-consent, .modal-dialog');
                    dialogs.forEach(dialog => { dialog.remove(); found = true; });
                    // 恢复滚动
                    document.body.style.overflow = 'auto';
                    document.documentElement.style.overflow = 'auto';
                    document.body.style.pointerEvents = 'auto';
                    return found;
                } catch (e) {
                    return false;
                }
            }
        `);

        if (removed) {
            console.log('成功处理Cookie弹窗');
        } else {
            console.log('未检测到Cookie弹窗');
        }

        // 尝试点击接受按钮
        const acceptSelectors = [
            "button:has-text('Accept')",
            "button:has-text('Agree')",
            "button:has-text('同意')",
            "button:has-text('接受所有 Cookie')",
            "#accept-recommended-btn-handler",
            ".ot-pc-refuse-all-handler"
        ];

        for (const selector of acceptSelectors) {
            try {
                const button = page.locator(selector);
                if (await button.isVisible({ timeout: 500 })) {
                    await button.click();
                    console.log('点击接受按钮:', selector);
                    await page.waitForTimeout(1000);
                    break;
                }
            } catch (e) {
                // 忽略
            }
        }
    } catch (e) {
        console.log('处理Cookie弹窗时出错:', e.message);
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
            if (await button.isVisible({ timeout: 1000 })) {
                console.log('使用选择器找到搜索按钮:', selector);
                return button;
            }
        } catch (e) {
            // 继续
        }
    }
    throw new Error('找不到搜索按钮');
}

// 等待搜索结果出现
async function waitForSearchResults(page) {
    try {
        console.log('等待搜索结果加载...');
        await page.waitForSelector("[data-ta='summary-record-title-link']", { timeout: 10000 });
        console.log('搜索结果加载完成');
    } catch (e) {
        console.log('等待搜索结果超时:', e.message);
    }
}

// 从HTML中提取高亮词（<mark>标签）
function extractHighlightedWords(html) {
    const highlighted = [];
    const regex = /<mark>(.*?)<\/mark>/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
        const text = match[1].trim();
        if (text) highlighted.push(text.toLowerCase());
    }
    // 备用方法
    if (highlighted.length === 0 && html.includes('<mark>')) {
        const parts = html.split('<mark>');
        for (let i = 1; i < parts.length; i++) {
            const endIdx = parts[i].indexOf('</mark>');
            if (endIdx > -1) {
                const text = parts[i].substring(0, endIdx).trim();
                if (text) highlighted.push(text.toLowerCase());
            }
        }
    }
    return highlighted;
}

// 检查是否有意义的高亮（非过多单字）
function checkMeaningfulHighlight(highlighted) {
    if (highlighted.length === 0) return false;
    let singleWordCount = 0;
    for (const word of highlighted) {
        if (word.split(/\s+/).length === 1) singleWordCount++;
    }
    const ratio = singleWordCount / highlighted.length;
    console.log(`单个单词比例: ${(ratio * 100).toFixed(1)}%`);
    return !(ratio > 0.7 && highlighted.length > 3);
}

// 检查核心短语是否完整
function checkCorePhrase(search, title, highlighted) {
    const cleanSearch = search.replace(/,/g, '').replace(/ and /g, ' ');
    const searchWords = cleanSearch.split(/\s+/);
    console.log('搜索词拆分:', searchWords);

    const allHighlights = highlighted.join('').replace(/\s/g, '');
    const searchWithoutSpaces = cleanSearch.replace(/\s/g, '');

    if (allHighlights.includes(searchWithoutSpaces) || searchWithoutSpaces.includes(allHighlights)) {
        console.log('整个搜索短语被高亮覆盖');
        return true;
    }

    // 检查长短语
    for (let phraseLength = 5; phraseLength >= 3; phraseLength--) {
        for (let i = 0; i <= searchWords.length - phraseLength; i++) {
            const phrase = searchWords.slice(i, i + phraseLength).join(' ');
            if (title.includes(phrase)) {
                console.log(`找到${phraseLength}词短语:`, phrase);
                const phraseNoSpaces = phrase.replace(/\s/g, '');
                for (const h of highlighted) {
                    if (h.replace(/\s/g, '').includes(phraseNoSpaces)) {
                        console.log('短语被高亮:', phrase);
                        return true;
                    }
                }
                if (phraseLength >= 5) {
                    console.log('长短语存在（未高亮）:', phrase);
                    return true;
                }
            }
        }
    }

    console.log('未找到足够长的核心短语');
    return false;
}

// 判断是否完全匹配
async function isCompleteMatch(resultLocator, searchKeyword) {
    try {
        const titleText = (await resultLocator.textContent()).toLowerCase();
        const titleHtml = (await resultLocator.innerHTML()).toLowerCase();
        const searchLower = searchKeyword.toLowerCase();

        console.log('\n=== 匹配检查 ===');
        console.log('搜索:', searchLower);
        console.log('标题:', titleText);

        // 直接包含
        if (titleText.includes(searchLower.replace(/,/g, '').replace(/ and /g, ' '))) {
            console.log('直接包含搜索短语');
            return true;
        }

        const highlighted = extractHighlightedWords(titleHtml);
        console.log('高亮词:', highlighted);

        if (!checkMeaningfulHighlight(highlighted)) {
            console.log('高亮无意义（单词被拆散）');
            return false;
        }

        const corePhraseComplete = checkCorePhrase(searchLower, titleText, highlighted);
        console.log('核心短语完整:', corePhraseComplete);
        return corePhraseComplete;
    } catch (e) {
        console.log('匹配检查出错:', e.message);
        return false;
    }
}

// 检查是否有完全匹配的结果
async function hasCompleteMatchResults(page, searchKeyword) {
    try {
        await waitForSearchResults(page);

        const resultLinks = page.locator("[data-ta='summary-record-title-link']");
        const count = await resultLinks.count();
        console.log(`检索到 ${count} 个结果`);
        if (count === 0) return false;

        const firstResult = resultLinks.first();
        return await isCompleteMatch(firstResult, searchKeyword);
    } catch (e) {
        console.log('检查完全匹配时出错:', e.message);
        return false;
    }
}

/**
 * 启动浏览器并返回 browser, context, page 对象
 * 禁用弹窗拦截，允许正常打开新窗口
 */
async function launchBrowser() {
    const browser = await chromium.launch({
        headless: false,
        args: ['--disable-popup-blocking'] // 关键：禁用弹窗拦截
    });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        timezoneId: 'America/New_York'
    });
    const page = await context.newPage();

    // 移除自动化特征
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        delete navigator.__proto__.webdriver;
        window.chrome = { runtime: {} };
    });

    return { browser, context, page };
}

/**
 * 登录流程（改进版：带重试和登录成功校验）
 * @param {Page} page - Playwright 页面对象
 */
async function login(page) {
    const MAX_LOGIN_ATTEMPTS = 5; // 最大尝试次数

    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
        console.log(`\n========== 第 ${attempt} 次登录尝试 ==========`);

        // 步骤1：确保在登录页（如果不在，则点击登录按钮进入）
        try {
            // 先检查是否已登录（防止重复点击）
            const isLoggedIn = await page.locator('text=你好：').first().isVisible().catch(() => false);
            if (isLoggedIn) {
                console.log('检测到已登录状态，跳过登录流程');
                break;
            }

            // 判断当前是否在登录页（通过URL或元素）
            const isLoginPage = await page.url().includes('doaction.php') ||
                await page.locator('#username').isVisible({ timeout: 3000 }).catch(() => false);

            if (!isLoginPage) {
                // 不在登录页，点击“用户登录”链接
                const loginBtn = page.locator('text=用户登录');
                await loginBtn.waitFor({ state: 'visible', timeout: 10000 });
                await humanClick(page, loginBtn);
                console.log('点击用户登录按钮');
                await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
            }
        } catch (e) {
            console.log('进入登录页失败:', e.message);
            // 继续尝试，可能已处于登录页
        }

        // 步骤2：填写用户名和密码
        try {
            const username = page.locator('#username');
            await username.waitFor({ state: 'visible', timeout: 10000 });
            await humanType(page, username, CONFIG.USER_NAME);
            console.log('账号填写完成');

            const password = page.getByLabel('密码:');
            await humanType(page, password, CONFIG.PASSWORD);
            console.log('密码填写完成');
        } catch (e) {
            console.log('填写用户名密码失败:', e.message);
            await page.reload().catch(() => {});
            continue;
        }

        // 步骤3：手动输入验证码
        let captchaCode = '';
        try {
            const key = page.locator('#key');
            await key.waitFor({ state: 'visible', timeout: 5000 });
            captchaCode = readlineSync.question(`请输入验证码 (尝试 ${attempt}/${MAX_LOGIN_ATTEMPTS}): `);
            await humanType(page, key, captchaCode);
            console.log('验证码填写完成');
        } catch (e) {
            console.log('未找到验证码输入框，可能已自动登录或页面异常');
            const loggedIn = await page.locator('text=你好：').first().isVisible().catch(() => false);
            if (loggedIn) {
                console.log('检测到已登录状态');
                break;
            } else {
                continue;
            }
        }

        // 步骤4：点击登录按钮
        try {
            const confirm = page.locator('text=登 录');
            await confirm.waitFor({ state: 'visible', timeout: 10000 });
            await humanClick(page, confirm);
            console.log('登录按钮点击成功');
        } catch (e) {
            console.log('点击登录按钮失败:', e.message);
            continue;
        }

        // 步骤5：等待页面加载并校验登录结果
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
        await page.waitForTimeout(3000); // 额外等待欢迎信息渲染

        // 检查是否登录成功：寻找包含“你好：”和数字的欢迎信息
        let loginSuccess = false;
        try {
            const welcomeElement = page.locator('text=/你好：[0-9]+，欢迎登录/').first();
            await welcomeElement.waitFor({ state: 'visible', timeout: 5000 });
            const welcomeText = await welcomeElement.textContent();
            console.log(`检测到欢迎信息: ${welcomeText}`);
            loginSuccess = true;
        } catch (e) {
            console.log('未检测到欢迎信息，可能登录失败');
        }

        if (loginSuccess) {
            console.log('✅ 登录成功！');
            break;
        }

        // 登录失败：检查是否回到了登录页
        const returnedToLogin = await page.url().includes('doaction.php') ||
            await page.locator('#username').isVisible({ timeout: 3000 }).catch(() => false);
        if (returnedToLogin) {
            console.log('登录失败，返回登录页，准备重试...');
            continue;
        } else {
            // 既没有成功也没有回到登录页，可能是其他异常页面
            throw new Error('登录后进入未知页面，请检查');
        }
    }

    // 登录后跳转处理（原有逻辑）
    try {
        const jump = page.locator('text=如果您的浏览器没有自动跳转，请点击这里');
        await jump.waitFor({ state: 'visible', timeout: 5000 });
        if (await jump.isEnabled()) {
            await humanClick(page, jump);
            console.log('点击跳转链接，可以开始使用学术猫');
        }
    } catch (e) {
        console.log('跳转提示不存在，可能已自动跳转');
    }
}

/**
 * 从登录后的页面导航至 Web of Science 新标签页，并返回新页面的 Page 对象
 * @param {Page} page - 当前页面（登录后）
 * @param {BrowserContext} context - 浏览器上下文，用于监听新页面
 * @returns {Promise<Page>} Web of Science 页面的 Page 对象
 */
/**
 * 从登录后的页面导航至 Web of Science 新标签页，并返回新页面的 Page 对象
 * 自动尝试多个 SCI 镜像站点，如果全部失败则进入手动模式
 * @param {Page} page - 当前页面（登录后）
 * @param {BrowserContext} context - 浏览器上下文，用于监听新页面
 * @returns {Promise<Page>} Web of Science 页面的 Page 对象
 */
async function navigateToWoS(page, context) {
    // 点击首页
    const home = page.locator('text=首页');
    await home.waitFor({ state: 'visible', timeout: 10000 });
    await humanClick(page, home);
    console.log('首页跳转成功');

    // 点击英文数据库
    const englishDatabase = page.locator('text=英文数据库');
    await englishDatabase.waitFor({ state: 'visible', timeout: 10000 });
    await humanClick(page, englishDatabase);
    console.log('英文数据库点击成功');

    // 打开 (SCI)Web of Science 中间页（包含多个镜像链接）
    let middlePage;
    [middlePage] = await Promise.all([
        context.waitForEvent('page', { timeout: 15000 }),
        (async () => {
            const sciLink = page.locator('text=(SCI)Web of Science');
            await sciLink.waitFor({ state: 'visible', timeout: 10000 });
            await humanClick(page, sciLink);
            console.log('(SCI)Web of Science 打开成功');
        })()
    ]);

    // 等待中间页加载完成，并获取所有镜像链接
    await middlePage.waitForLoadState('domcontentloaded', { timeout: 30000 });
    await middlePage.waitForSelector('div.shuoming a', { timeout: 30000 });
    console.log('中间页加载完成，开始解析镜像链接');

    // 提取所有镜像链接（文本和 href）
    const links = await middlePage.$$eval('div.shuoming a', (anchors) => {
        return anchors.map((a, index) => ({
            index: index + 1,
            text: a.textContent.trim(),
            href: a.href
        }));
    });

    if (links.length === 0) {
        throw new Error('未找到任何镜像链接');
    }

    // 过滤出 SCI/Sci 相关的链接（文本包含 SCI 或 Sci，不区分大小写）
    const sciLinks = links.filter(link => /sci/i.test(link.text));
    if (sciLinks.length === 0) {
        throw new Error('未找到任何 SCI 镜像链接');
    }

    console.log('\n可用的 SCI 镜像站点：');
    sciLinks.forEach(link => {
        console.log(`${link.index}. ${link.text} - ${link.href}`);
    });

    // 自动尝试每个链接
    let wosPage = null;
    for (let i = 0; i < sciLinks.length; i++) {
        const link = sciLinks[i];
        console.log(`\n[自动尝试 ${i+1}/${sciLinks.length}] 正在打开: ${link.text} (${link.href})`);

        let newTab;
        try {
            [newTab] = await Promise.all([
                context.waitForEvent('page', { timeout: 30000 }),
                middlePage.locator('div.shuoming a').nth(link.index - 1).click()
            ]);
        } catch (e) {
            console.log(`点击链接后未检测到新页面: ${e.message}`);
            continue;
        }

        // 打印初始URL
        const initialUrl = newTab.url();
        console.log(`新页面已创建，初始URL: ${initialUrl}`);

        // 等待新页面加载，最多60秒
        try {
            await newTab.waitForLoadState('domcontentloaded', { timeout: 60000 });
            const url = newTab.url();
            console.log(`加载后URL: ${url}`);
            if (url === 'about:blank') {
                throw new Error('页面仍为 about:blank');
            }

            const isValid = await isWosPage(newTab);
            if (isValid) {
                console.log(`✅ 成功加载 Web of Science 页面: ${url}`);
                wosPage = newTab;
                break;
            } else {
                throw new Error('页面缺少搜索输入框，可能不是有效的 WoS 页面');
            }
        } catch (error) {
            const failedUrl = newTab.url();
            console.log(`❌ 加载失败 (URL: ${failedUrl}): ${error.message}`);
            await newTab.close().catch(() => {});
        }
    }

    // 如果自动尝试全部失败，进入手动模式
    if (!wosPage) {
        console.log('\n⚠️ 所有 SCI 镜像站点自动尝试均失败。');
        console.log('请手动在浏览器中打开一个可用的 Web of Science 页面（例如点击任意 SCI 镜像链接）。');
        const answer = readlineSync.question('当您已打开正常 Web of Science 页面后，请输入 Y 继续: ').trim().toUpperCase();
        if (answer !== 'Y') {
            throw new Error('用户未确认手动操作，退出');
        }

        // 获取浏览器中最新打开的页面（用户手动打开的页面）
        const allPages = context.pages();
        // 取最后一个页面，通常是用户最新操作的页面
        const candidatePage = allPages[allPages.length - 1];
        const url = candidatePage.url();
        if (!url || url === 'about:blank') {
            throw new Error('手动打开的页面无效，请确保打开了正常的 Web of Science 页面');
        }

        // 等待页面加载并检查是否为有效 WoS 页面
        try {
            await candidatePage.waitForLoadState('domcontentloaded', { timeout: 30000 });
            const isValid = await isWosPage(candidatePage);
            if (!isValid) {
                throw new Error('手动打开的页面似乎不是 Web of Science 检索页');
            }
            console.log(`✅ 手动确认 Web of Science 页面: ${url}`);
            wosPage = candidatePage;
        } catch (e) {
            throw new Error('手动打开的页面不是有效的 Web of Science 检索页，请检查');
        }
    }

    // 最终确保页面包含搜索输入框，等待其稳定
    await wosPage.locator('#composeQuerySmartSearch').waitFor({ state: 'visible', timeout: 30000 });
    console.log('\n🚀 已进入 Web of Science 页面，开始检索论文...\n');
    return wosPage;
}

/**
 * 辅助函数：判断页面是否为有效的 Web of Science 检索页
 * @param {Page} page - 待检测的页面
 * @returns {Promise<boolean>}
 */
async function isWosPage(page) {
    try {
        // 优先检查搜索输入框（特定ID）
        await page.locator('#composeQuerySmartSearch').waitFor({ timeout: 10000 });
        return true;
    } catch (e) {
        try {
            // 其次检查搜索按钮（通过 getSearchButton 逻辑）
            await getSearchButton(page);
            return true;
        } catch (e2) {
            return false;
        }
    }
}

/**
 * 处理单个关键词：搜索、判断是否收录、获取入藏号
 * @param {Page} page - Web of Science 页面的 Page 对象
 * @param {string} keyword - 搜索关键词
 * @returns {Promise<Object>} 包含 isRecruit, accessionNo, title, searchTime 的对象
 */
async function processKeyword(page, keyword) {
    let isRecruit = false;
    let accessionNo = '';

    try {
        console.log(`\n开始处理: ${keyword}`);

        await handleCookieConsent(page);

        // 填写搜索框
        const loadInput = page.locator('#composeQuerySmartSearch');
        await loadInput.fill(keyword);
        console.log('已填写搜索内容:', keyword);

        await handleCookieConsent(page);

        // 获取并点击搜索按钮
        const searchButton = await getSearchButton(page);
        if (!(await searchButton.isEnabled())) {
            console.log('搜索按钮不可用，跳过');
            return { isRecruit: 'false', accessionNo, title: keyword, searchTime: formatDate(new Date()) };
        }
        await searchButton.click();
        console.log('搜索按钮点击成功');

        await handleCookieConsent(page);
        await page.waitForLoadState('networkidle');
        console.log('搜索完成');

        await page.waitForTimeout(4000);
        await handleCookieConsent(page);

        const hasMatch = await hasCompleteMatchResults(page, keyword);
        console.log('是否匹配:', hasMatch);

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
            console.log('是否收录:', isRecruit, '\n入藏号:', accessionNo);

            // 返回上一页
            await page.goBack();
            await page.waitForLoadState('networkidle');
        } else {
            console.log('是否收录:', isRecruit);
            accessionNo = '无';
        }
    } catch (e) {
        console.log(`处理关键词 "${keyword}" 时发生错误:`, e.message);
        // 发生错误时保留已获取的部分数据（isRecruit=false, accessionNo=''）
    }

    return {
        isRecruit: String(isRecruit),
        accessionNo,
        title: keyword,
        searchTime: formatDate(new Date())
    };
}

async function main() {
    let browser, context, page;

    try {
        // 1. 启动浏览器
        ({ browser, context, page } = await launchBrowser());

        // 2. 导航到基础页面
        await page.goto(CONFIG.BASE_URL, { waitUntil: 'domcontentloaded' });
        console.log('页面标签:', await page.title());

        // 3. 登录
        await login(page);

        // 4. 导航至 Web of Science 页面
        const wosPage = await navigateToWoS(page, context);

        // 5. 准备搜索词列表（可从 Excel 读取或硬编码）
        const searchKeyWordsList = [
            'From pathology to therapy: A comprehensive review of ATRX mutation related molecular functions and disorders',
            'Enhancing Cybersecurity Defenses in Healthcare Using AI: A Pivotal Role in Fortifying Digital Health Infrastructure',
            'PBertKla: a protein large language model for predicting human lysine lactylation sites'
        ];
        // 若要使用 Excel 读取，可取消下面注释：
        // const searchKeyWordsList = await readColumnLSafely('你的文件路径.xlsx');

        const dataList = [];

        // 6. 循环处理每个关键词
        for (const keyword of searchKeyWordsList) {
            const result = await processKeyword(wosPage, keyword);
            dataList.push(result);
        }

        // 7. 写入 Excel
        await writeToExcel(dataList);
        console.log('所有流程完成');

    } catch (e) {
        console.error('主流程异常:', e.message);
        console.error(e.stack);
    } finally {
        if (browser) await browser.close();
    }
}

// 执行
main();
