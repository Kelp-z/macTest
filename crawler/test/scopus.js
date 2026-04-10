const { chromium } = require('playwright'); // 移除未使用的expect
const ExcelJS = require('exceljs');
const Tesseract = require('tesseract.js');
const readlineSync = require('readline-sync');
const fs = require('fs');
const path = require('path');

// 常量配置
const CONFIG = {
    EXCEL_FILE_PATH: path.join(__dirname, 'src/main/resources/scopus.xlsx'),
    TESSERACT_DATA_PATH: path.join(__dirname, 'src/main/resources/tessdata'),
    FILE_PATH: path.join(__dirname, 'src/main/resources/【5】编辑部引用情况表.xlsx'),
    USER_NAME: '28199134',
    PASSWORD: '460256',
    BASE_URL: 'https://www.2447.net/',
    OUTPUT_DIR: path.join(__dirname, 'src/main/resources/output') // 新增：输出文件夹
};
// 日期格式化工具
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day}:${hours}:${minutes}:${seconds}`;
}

// 验证码识别
async function getCaptchaText(page) {
    try {
        const captchaImage = page.locator('img[src*="ShowKey"][title*="看不清楚"]');
        await captchaImage.waitFor({ state: 'visible', timeout: 100000 });

        // 截图保存验证码
        const screenshot = await captchaImage.screenshot();
        const tempPath = path.join(__dirname, 'captcha_temp.png');
        fs.writeFileSync(tempPath, screenshot);

        // Tesseract.js 识别
        const { data: { text } } = await Tesseract.recognize(
            tempPath,
            'eng', // 英文识别
            {
                tessdataDir: CONFIG.TESSERACT_DATA_PATH,
                logger: m => console.log(`OCR进度: ${m.status}`)
            }
        );

        // 清理临时文件
        fs.unlinkSync(tempPath);
        // 过滤非字母数字并转小写
        return text.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    } catch (e) {
        console.log('验证码识别失败:', e.message);
        return null;
    }
}

// 读取Excel L列数据
async function readColumnLSafely(filePath) {
    const columnData = [];
    try {
        if (!fs.existsSync(filePath)) {
            console.log('文件不存在:', filePath);
            return columnData;
        }

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);

        // 获取工作表（优先"引用表"，否则取第二个表）
        let worksheet = workbook.getWorksheet('引用表');
        if (!worksheet) {
            worksheet = workbook.worksheets[1]; // JS中索引从0开始，对应Java的getSheetAt(1)
        }

        if (!worksheet) {
            console.log('未找到有效工作表');
            return columnData;
        }

        const columnLIndex = 11; // L列（A=0）

        // 从第3行开始读取（JS中row.number从1开始，对应Java的索引2）
        worksheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
            if (rowNum >= 3) {
                const cell = row.getCell(columnLIndex + 1); // ExcelJS中列索引从1开始
                if (cell && cell.value) {
                    let value = '';
                    // 处理不同类型的单元格值
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


// 写入Excel（每次生成新文件，不追加）
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
        const fileName = `SCOPUS-${timestamp}.xlsx`;
        const filePath = path.join(CONFIG.OUTPUT_DIR, fileName);

        // 确保输出目录存在
        if (!fs.existsSync(CONFIG.OUTPUT_DIR)) {
            fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('scopus');

        // 定义列配置（与数据字段对应）
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
        console.log(`数据写入成功，文件：${filePath}，共 ${newDataList.length} 条记录`);
    } catch (e) {
        console.log('写入失败:', e.message);
        console.error(e.stack);
    }
}

// 模拟人类点击（核心优化：降低反爬概率）
async function humanClick(page, locator) {
    try {
        const box = await locator.boundingBox();
        if (box) {
            // 模拟鼠标移动（分步）
            await page.mouse.move(box.x + 10, box.y + 10, { steps: 8 });
            await page.waitForTimeout(200);
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
            await page.waitForTimeout(150);
        }
        // 带延迟点击
        await locator.click({ delay: 150 });
        return true;
    } catch (e) {
        console.log('人类点击模拟失败:', e.message);
        return false;
    }
}

// 模拟人类输入（核心优化：降低反爬概率）
async function humanType(page, locator, text) {
    await locator.fill(''); // 先清空
    for (const char of text) {
        await locator.type(char, { delay: 50 + Math.random() * 80 }); // 随机延迟
        // 错误：locator.waitForTimeout(10)
        // 正确：page.waitForTimeout(10)
        await page.waitForTimeout(10);
    }
}


// 封装：初始化浏览器环境（最小化防反爬 + 稳定初始化）
async function initBrowser() {
    // 1. 先获取目标网站的根域名（用于授予弹窗权限）
    const baseUrlObj = new URL(CONFIG.BASE_URL);
    const baseOrigin = `${baseUrlObj.protocol}//${baseUrlObj.host}`; // 例如：https://www.2447.net
    // 1. 用 launchPersistentContext 直接创建上下文（避免 browser 嵌套问题）
    const context = await chromium.launchPersistentContext('', {
        headless: false, // 非无头模式
        viewport: { width: 1920, height: 1080 },
        args: ['--disable-popup-blocking'],
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'America/New_York'
    });

    const page = context.pages()[0];

    // 2. 注入最小化防检测脚本（避免干扰页面初始化）
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
    });

    // 3. 导航到目标网站（用 waitUntil: 'domcontentloaded' 避免卡住）
    await page.goto(CONFIG.BASE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });
    console.log('页面标签：', await page.title());

    return { playwright: context, page };
}

// 封装：登录流程（优化等待策略）
async function login(page) {
    const MAX_LOGIN_ATTEMPTS = 5; // 最大尝试次数

    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
        console.log(`\n========== 第 ${attempt} 次登录尝试 ==========`);

        // 步骤1：确保在登录页（如果不在，则点击登录按钮进入）
        try {
            // 先检查是否已登录（用于后续重试时避免重复点击）
            const isLoggedIn = await page.locator('text=帐号名称').isVisible().catch(() => false);
            if (isLoggedIn) {
                console.log('检测到已登录状态，跳过登录流程');
                break; // 已登录，直接跳出循环
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
            // 如果失败，可能页面结构变化，尝试刷新后重试
            await page.reload().catch(() => {});
            continue;
        }

        // 步骤3：输入验证码（手动）
        let captchaCode = '';
        try {
            const key = page.locator('#key');
            await key.waitFor({ state: 'visible', timeout: 5000 });
            captchaCode = readlineSync.question(`请输入验证码 (尝试 ${attempt}/${MAX_LOGIN_ATTEMPTS}): `);
            await humanType(page, key, captchaCode);
            console.log('验证码填写完成');
        } catch (e) {
            console.log('未找到验证码输入框，可能已自动登录或页面异常');
            // 没有验证码输入框，可能页面已自动登录，尝试检测登录状态
            const loggedIn = await page.locator('text=帐号名称').isVisible().catch(() => false);
            if (loggedIn) {
                console.log('检测到已登录状态');
                break;
            } else {
                continue; // 否则重试
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
            continue; // 重试
        }

        // 步骤5：等待页面加载并校验登录结果
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
        // 额外等待3秒，让可能出现的欢迎信息渲染
        await page.waitForTimeout(3000);

        // 检查是否登录成功：寻找包含“你好：”和数字的欢迎信息
        const welcomePattern = /你好：[0-9]+，欢迎登录/;
        let loginSuccess = false;
        try {
            // 使用正则表达式匹配文本内容
            const welcomeElement = page.locator(`text=${welcomePattern}`).first();
            await welcomeElement.waitFor({ state: 'visible', timeout: 5000 });
            const welcomeText = await welcomeElement.textContent();
            console.log(`检测到欢迎信息: ${welcomeText}`);
            loginSuccess = true;
        } catch (e) {
            console.log('未检测到欢迎信息，可能登录失败');
        }

        if (loginSuccess) {
            console.log('✅ 登录成功！');
            break; // 成功，退出循环
        }

        // 登录失败：检查是否回到了登录页
        const returnedToLogin = await page.url().includes('doaction.php') ||
            await page.locator('#username').isVisible({ timeout: 3000 }).catch(() => false);
        if (returnedToLogin) {
            console.log('登录失败，返回登录页，准备重试...');
            // 可以选择清空输入框，但下次循环会重新填写，不清空也可以
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
        console.log('跳转提示元素不存在，页面可能已自动跳转:', e.message);
    }
}
// 新增辅助函数
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
        for (const selector of inputSelectors) {
            try {
                const locator = page.locator(selector).first();
                if (await locator.isVisible({ timeout: 500 }).catch(() => false)) {
                    console.log('检测到 Scopus 搜索输入框');
                    return true;
                }
            } catch (e) {}
        }
        for (const selector of buttonSelectors) {
            try {
                const locator = page.locator(selector).first();
                if (await locator.isVisible({ timeout: 500 }).catch(() => false)) {
                    console.log('检测到 Scopus 搜索按钮');
                    return true;
                }
            } catch (e) {}
        }
        await page.waitForTimeout(checkInterval);
    }
    console.log('等待 Scopus 页面超时，未检测到关键元素');
    return false;
}

// 修改后的 navigateToScopus
async function navigateToScopus(page, browserContext) {
    // 跳转到首页
    const home = page.locator('text=首页');
    await home.waitFor({ state: 'visible', timeout: 10000 });
    if (await home.isEnabled()) {
        await humanClick(page, home);
        console.log('首页跳转成功');
    } else {
        console.log('首页跳转失败');
    }

    // 点击英文数据库
    const englishDatabase = page.locator('text=英文数据库');
    await englishDatabase.waitFor({ state: 'visible', timeout: 10000 });
    if (await englishDatabase.isEnabled()) {
        await humanClick(page, englishDatabase);
        console.log('英文数据库点击成功');
    } else {
        console.log('英文数据库点击失败');
    }

    // 打开SCOPUS文摘新页面（用 Promise.all 稳定捕获 popup）
    let newPage;
    try {
        [newPage] = await Promise.all([
            page.waitForEvent('popup', { timeout: 15000 }),
            page.click('text=SCOPUS文摘')
        ]);
        console.log('SCOPUS文摘页面打开成功');
    } catch (e) {
        throw new Error('打开SCOPUS文摘页面失败: ' + e.message);
    }

    // 等待新页面加载完成，并确保镜像链接出现
    await newPage.waitForLoadState('domcontentloaded', { timeout: 30000 });
    await newPage.waitForSelector('div.shuoming a', { timeout: 30000 });
    console.log('SCOPUS文摘页面加载完成，开始解析镜像链接');

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

    console.log('\n可用的 Scopus 镜像站点：');
    links.forEach(link => {
        console.log(`${link.index}. ${link.text} - ${link.href}`);
    });

    // 自动尝试每个链接
    let scopusPage = null;
    for (let i = 0; i < links.length; i++) {
        const link = links[i];
        console.log(`\n[自动尝试 ${i+1}/${links.length}] 正在打开: ${link.text} (${link.href})`);

        let newTab;
        try {
            [newTab] = await Promise.all([
                browserContext.waitForEvent('page', { timeout: 30000 }),
                newPage.locator('div.shuoming a').nth(i).click()
            ]);
        } catch (e) {
            console.log(`点击链接后未检测到新页面: ${e.message}`);
            continue;
        }

        // 等待新页面加载，最多60秒
        try {
            await newTab.waitForLoadState('domcontentloaded', { timeout: 60000 });
            const url = newTab.url();
            if (url === 'about:blank') {
                throw new Error('页面仍为 about:blank');
            }
            // 使用通用检测函数验证页面
            const isReady = await waitForScopusReady(newTab, 30000);
            if (!isReady) {
                throw new Error('页面缺少 Scopus 检索元素');
            }
            console.log(`✅ 成功加载 Scopus 页面: ${url}`);
            scopusPage = newTab;
            break; // 成功找到可用页面，退出循环
        } catch (error) {
            console.log(`❌ 加载失败: ${error.message}`);
            await newTab.close().catch(() => {});
            // 继续尝试下一个链接
        }
    }

    // 如果自动尝试全部失败，进入手动模式
    if (!scopusPage) {
        console.log('\n⚠️ 所有镜像站点自动尝试均失败。');
        console.log('请手动在浏览器中打开一个可用的 Scopus 页面（例如点击任意镜像链接）。');
        const answer = readlineSync.question('当您已打开正常 Scopus 页面后，请输入 Y 继续: ').trim().toUpperCase();
        if (answer !== 'Y') {
            throw new Error('用户未确认手动操作，退出');
        }

        // 获取浏览器中最新打开的页面（用户手动打开的页面）
        const allPages = browserContext.pages();
        const candidatePage = allPages[allPages.length - 1];
        const url = candidatePage.url();
        if (!url || url === 'about:blank') {
            throw new Error('手动打开的页面无效，请确保打开了正常的 Scopus 页面');
        }

        // 等待页面加载并检查关键元素
        try {
            await candidatePage.waitForLoadState('domcontentloaded', { timeout: 30000 });
            const isReady = await waitForScopusReady(candidatePage, 30000);
            if (!isReady) {
                throw new Error('手动打开的页面似乎不是 Scopus 检索页');
            }
            console.log(`✅ 手动确认 Scopus 页面: ${url}`);
            scopusPage = candidatePage;
        } catch (e) {
            throw new Error('手动打开的页面不是有效的 Scopus 检索页，请检查');
        }
    }

    console.log('\n🚀 已进入 Scopus 页面，开始抓取论文...\n');
    return scopusPage;
}

// 封装：检索单篇论文（核心优化：等待策略 + 定位器 + 反爬）
async function searchSinglePaper(latestPage, searchKeyWords) {
    let paperData = null;
    let isRecruit = false;

    try {
        // 核心优化：替换networkidle为domcontentloaded + 业务元素等待
        await latestPage.waitForLoadState('domcontentloaded', { timeout: 120000 });
        console.log(`【${searchKeyWords}】页面DOM加载完成，开始查找输入框`);

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
                console.log(`【${searchKeyWords}】找到Search documents输入框（定位方式：${locator.toString()}`);
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
        console.log(`【${searchKeyWords}】输入框已填充检索内容`);

        // 点击搜索按钮（优化定位器 + 人类点击）
        let submitButton = null;
        const buttonLocators = [
            latestPage.locator('button[type="submit"].Button_button__9XFW1:has-text("Search")'),
            latestPage.locator('button[type="submit"]:has(span:text("Search"))'),
            latestPage.locator('button:visible:has-text("Search")')
        ];

        for (const locator of buttonLocators) {
            try {
                await locator.waitFor({ state: 'visible', timeout: 8000 });
                submitButton = locator;
                console.log(`【${searchKeyWords}】找到Search按钮（定位方式：${locator.toString()}`);
                break;
            } catch (e) {
                console.log(`【${searchKeyWords}】定位器 ${locator.toString()} 未找到按钮，尝试下一个...`);
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
                console.log(`【${searchKeyWords}】Search按钮点击成功（第${i+1}次尝试）`);
                break;
            } catch (e) {
                console.log(`【${searchKeyWords}】第${i+1}次点击按钮失败：${e.message}`);
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
            console.log(`【${searchKeyWords}】未搜索到结果\n`);
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
            console.log(`【${searchKeyWords}】找到 ${count} 个匹配结果`);

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
                console.log(`【${searchKeyWords}】EID:`, eid.trim(), '\n');

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
                console.log(`【${searchKeyWords}】未搜索到结果`);
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
        console.log(`【${searchKeyWords}】搜索错误`, e.message);
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

// 封装：批量检索论文
async function batchSearchPapers(latestPage) {
    const dataList = [];
    // 待检索的论文标题列表（可切换为从Excel读取）
    // const searchKeyWordsList = await readColumnLSafely(CONFIG.FILE_PATH);
    const searchKeyWordsList = [
        'From pathology to therapy: A comprehensive review of ATRX mutation related molecular functions and disorders',
        'Enhancing Cybersecurity Defenses in Healthcare Using AI: A Pivotal Role in Fortifying Digital Health Infrastructure',
        'PBertKla: a protein large language model for predicting human lysine lactylation sites'
    ];

    // 遍历检索标题（增加间隔，降低反爬）
    for (let i = 0; i < searchKeyWordsList.length; i++) {
        const keyword = searchKeyWordsList[i];
        console.log(`\n开始检索第 ${i+1}/${searchKeyWordsList.length} 篇论文：${keyword.substring(0, 50)}...`);
        const paperData = await searchSinglePaper(latestPage, keyword);
        if (paperData) {
            dataList.push(paperData);
        }
        // 每篇检索后等待5-8秒（随机），模拟人类操作间隔
        if (i < searchKeyWordsList.length - 1) {
            const waitTime = 5000 + Math.random() * 3000;
            console.log(`等待 ${Math.round(waitTime/1000)} 秒后检索下一篇...`);
            await latestPage.waitForTimeout(waitTime);
        }
    }

    return dataList;
}

// 等待用户确认是否开始抓取
async function waitUserConfirm() {
    return new Promise((resolve) => {
        const loop = () => {
            const ans = readlineSync.question('是否开始抓取？输入 Y 开始，N 30秒后再问：').trim().toUpperCase();
            if (ans === 'Y') {
                resolve(true);
            } else if (ans === 'N') {
                console.log('30秒后再次询问...');
                setTimeout(() => loop(), 30000);
            } else {
                console.log('输入错误，请输入 Y 或 N');
                loop();
            }
        };
        loop();
    });
}

// 封装：清理资源
async function cleanUp(context, browser) {
    await context.close();
    await browser.close();
    console.log('浏览器已关闭，资源清理完成');
}

// 主函数（简化，只负责流程调度）
async function main() {
    let context = null;
    let page = null;
    let scopusPage = null;
    let dataList = [];

    try {
        const browserObj = await initBrowser();
        context = browserObj.playwright;  // PersistentContext
        page = browserObj.page;

        await login(page);
        scopusPage = await navigateToScopus(page, context);
        dataList = await batchSearchPapers(scopusPage);
        await writeToExcel(dataList);
        console.log('所有流程执行完成！');
    } catch (e) {
        console.error('主流程异常:', e.message);
        console.error(e.stack);
    } finally {
        if (context) {
            await context.close();
            console.log('浏览器已关闭，资源清理完成');
        }
    }
}

// 执行主函数
main();
