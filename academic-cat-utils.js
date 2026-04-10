// academic-cat-utils.js
const { humanClick, humanType } = require('./crawler-utils');
const fs = require('fs');
const path = require('path');
const { getIo  } = require('./crawler-utils');
const io = getIo();



// 辅助函数：获取密码输入框
async function getPasswordInput(page) {
    const passwordSelectors = [
        'input[type="password"]',
        '#password',
        'input[name="password"]',
        'input[placeholder*="密码"]',
        'input[placeholder*="Password"]',
        'input[aria-label*="密码"]',
        'input[aria-label*="password"]'
    ];
    for (const selector of passwordSelectors) {
        const loc = page.locator(selector).first();
        if (await loc.isVisible().catch(() => false)) {
            return loc;
        }
    }
    // 尝试通过 label 定位
    const labelInput = page.getByLabel('密码:');
    if (await labelInput.isVisible().catch(() => false)) {
        return labelInput;
    }
    return null;
}
/**
 * 登录学术猫代理网站
 * @param {Page} page
 * @param {Object} config
 * @param {Function} onCaptchaRequired
 * @param {Function} addLog
 * @param {Function} setCaptchaState
 * @param {Function} isStopRequested 返回布尔值，表示是否应该停止
 * @param {string} customCaptchaDir 自定义验证码目录（任务独立）
 * @returns {Promise<void>}
 */
async function academicCatLogin(page, config, onCaptchaRequired, addLog, setCaptchaState, isStopRequested, customCaptchaDir) {
    // 使用传入的验证码目录，如果未传则使用 config 中的
    const captchaDir = customCaptchaDir || config.CAPTCHA_DIR;
    const MAX_LOGIN_ATTEMPTS = 5;

    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
        if (isStopRequested && isStopRequested()) {
            throw new Error('用户停止');
        }
        addLog(`\n========== 第 ${attempt} 次登录尝试 ==========`);

        // 检查是否已登录
        const isLoggedIn = await page.locator('text=你好：').first().isVisible().catch(() => false);
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
            await humanType(page, page.locator('#username'), config.USER_NAME);
            await humanType(page, page.getByLabel('密码:'), config.PASSWORD);
            addLog('账号密码填写完成');
        } catch (e) {
            addLog(`填写失败: ${e.message}`);
            await page.reload().catch(() => {});
            continue;
        }

        // 等待验证码输入（通过回调）（原处理，无针对验证码刷新的处理）
        // let captchaCode;
        // try {
        //     await page.locator('#key').waitFor({ state: 'visible', timeout: 5000 });
        //
        //     // 截图并保存验证码（保存到任务独立目录）
        //     const captchaImage = page.locator('img[src*="ShowKey"][title*="看不清楚"]');
        //     await captchaImage.waitFor({ state: 'visible', timeout: 10000 });
        //     const screenshot = await captchaImage.screenshot();
        //
        //     // 生成唯一文件名
        //     const captchaId = `${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        //     const imagePath = path.join(captchaDir, `${captchaId}.png`);
        //     fs.writeFileSync(imagePath, screenshot);
        //
        //     // 通知状态开始（使用正确的参数名 setCaptchaState）
        //     if (setCaptchaState) setCaptchaState('start', captchaId, imagePath);
        //
        //     addLog(`验证码请求已发送，等待用户输入... (ID: ${captchaId})`);
        //
        //     // 注意：onCaptchaRequired 期望返回用户输入的验证码字符串
        //     captchaCode = await onCaptchaRequired({
        //         captchaId,
        //         imagePath   // 传递绝对路径，由 server.js 构造 URL
        //     });
        //
        //     addLog('验证码已收到，正在填写...');
        //     await humanType(page, page.locator('#key'), captchaCode);
        // } catch (e) {
        //     addLog(`验证码处理失败: ${e.message}`);
        //     if (e.message === '用户停止') {
        //         throw e;
        //     }
        //     // 其他错误，刷新验证码后重试
        //     try {
        //         await page.locator('img[src*="ShowKey"]').click();
        //         await page.waitForTimeout(1000);
        //     } catch (clickErr) {}
        //     continue;
        // } finally {
        //     // 结束等待状态
        //     if (setCaptchaState) setCaptchaState('end');
        // }
        //
        // // 点击登录
        // const confirm = page.locator('text=登 录');
        // await confirm.waitFor({ state: 'visible', timeout: 10000 });
        // await humanClick(page, confirm);
        // await page.waitForLoadState('domcontentloaded');
        // await page.waitForTimeout(3000);
        //
        // // 校验登录结果
        // const welcomePattern = /你好：[0-9]+，欢迎登录/;
        // try {
        //     await page.locator(`text=${welcomePattern}`).first().waitFor({ state: 'visible', timeout: 5000 });
        //     addLog('✅ 登录成功！');
        //     break;
        // } catch (e) {
        //     addLog('登录失败，可能验证码错误');
        //     const returnedToLogin = await page.url().includes('doaction.php') ||
        //         await page.locator('#username').isVisible({ timeout: 3000 }).catch(() => false);
        //     if (!returnedToLogin) {
        //         throw new Error('登录后进入未知页面');
        //     }
        // }
        // if (isStopRequested && isStopRequested()) throw new Error('用户停止');

        // 确保当前是登录页且账号密码已填写（防止用户手动操作后清空）
        const isLoginPageNow = await page.url().includes('doaction.php') ||
            await page.locator('#username').isVisible({ timeout: 1000 }).catch(() => false);
        if (isLoginPageNow) {
            // 重新填写用户名（如果为空或与配置不符）
            const usernameInput = page.locator('#username');
            const currentUsername = await usernameInput.inputValue().catch(() => '');
            if (currentUsername !== config.USER_NAME) {
                await usernameInput.fill(config.USER_NAME);
                addLog('重新填写用户名');
            }
            // 重新填写密码
            const pwdInput = await getPasswordInput(page);
            if (pwdInput) {
                const currentPwd = await pwdInput.inputValue().catch(() => '');
                if (currentPwd !== config.PASSWORD) {
                    await pwdInput.fill(config.PASSWORD);
                    addLog('重新填写密码');
                }
            } else {
                addLog('警告：未找到密码输入框，可能页面未加载完成');
            }
        }

        // 验证码处理循环（支持验证码错误后刷新）
        let captchaResolved = false;
        let loginSuccess = false;

        while (!captchaResolved && !loginSuccess) {
            if (isStopRequested && isStopRequested()) throw new Error('用户停止');

            // 获取验证码图片
            await page.locator('#key').waitFor({ state: 'visible', timeout: 5000 });
            const captchaImage = page.locator('img[src*="ShowKey"][title*="看不清楚"]');
            await captchaImage.waitFor({ state: 'visible', timeout: 10000 });
            const screenshot = await captchaImage.screenshot();

            const captchaId = `${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
            const imagePath = path.join(captchaDir, `${captchaId}.png`);
            fs.writeFileSync(imagePath, screenshot);

            if (setCaptchaState) setCaptchaState('start', captchaId, imagePath);
            addLog(`验证码请求已发送，等待用户输入... (ID: ${captchaId})`);


            // 创建手动登录检测 Promise
            const manualLoginPromise = new Promise((resolve) => {
                const checkInterval = setInterval(async () => {
                    try {
                        const loggedIn = await page.locator('text=你好：').first().isVisible().catch(() => false);
                        if (loggedIn) {
                            clearInterval(checkInterval);
                            addLog('检测到用户手动完成登录，结束等待');
                            if (setCaptchaState) setCaptchaState('end');
                            // 通知前端取消验证码弹窗
                            if (io) io.emit('captcha-cancel', { captchaId });
                            resolve('manual');
                        }
                    } catch (e) {}
                }, 2000);
                // 设置超时，避免无限等待
                setTimeout(() => {
                    clearInterval(checkInterval);
                }, 300000);
            });

            let captchaCode = null;
            try {
                // 同时等待验证码输入和手动登录，谁先完成就继续
                const result = await Promise.race([
                    onCaptchaRequired({ captchaId, imagePath }),
                    manualLoginPromise
                ]);
                if (result === 'manual') {
                    // 用户已手动登录，直接跳出循环
                    loginSuccess = true;
                    captchaResolved = true;
                    break;
                } else {
                    captchaCode = result;
                }
            } catch (err) {
                clearInterval(checkInterval);
                addLog(`验证码等待失败: ${err.message}`);
                if (setCaptchaState) setCaptchaState('end');
                throw err;
            }

            addLog('验证码已收到，正在填写...');
            await humanType(page, page.locator('#key'), captchaCode);

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
                loginSuccess = true;
                captchaResolved = true;
                if (setCaptchaState) setCaptchaState('end');
                break;
            } catch (e) {
                addLog('登录失败，可能验证码错误');

                // 清空验证码输入框
                await page.locator('#key').fill('');
                let passwordInput = null;
                const passwordSelectors = [
                    'input[type="password"]',
                    '#password',
                    'input[name="password"]',
                    'input[placeholder*="密码"]',
                    'input[aria-label*="密码"]'
                ];
                for (const selector of passwordSelectors) {
                    const loc = page.locator(selector).first();
                    if (await loc.isVisible().catch(() => false)) {
                        passwordInput = loc;
                        break;
                    }
                }
                if (passwordInput) {
                    const currentPwd = await passwordInput.inputValue();
                    if (currentPwd !== config.PASSWORD) {
                        await humanType(page, passwordInput, config.PASSWORD);
                        addLog('重新填写密码');
                    }
                }
                // 刷新验证码图片（点击图片刷新）
                try {
                    await page.locator('img[src*="ShowKey"]').click();
                    await page.waitForTimeout(1000);
                } catch (clickErr) {}
                // 继续循环，重新获取验证码图片
                addLog('验证码已刷新，请重新输入');
                // 通知前端更新验证码图片（通过重新调用 onCaptchaRequired）
                // 注意：这里需要先结束当前等待（前端已经 resolve 过了），然后重新触发 onCaptchaRequired
                // 但 onCaptchaRequired 是一个新的调用，会生成新的 captchaId 和 imageUrl
                // 前端需要监听新的 captcha-required 事件来更新图片
                // 我们将在下一轮循环中重新截图并发送新事件，因此 continue 即可
                continue;
            }
        }

        if (loginSuccess) break;
        if (isStopRequested && isStopRequested()) throw new Error('用户停止');

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

/**
 * 从中间页导航到目标数据库（如 Scopus 或 Web of Science）
 * @param {Page} page 当前页面（已登录）
 * @param {BrowserContext} context 浏览器上下文
 * @param {Object} config 包含 SCREENSHOT_DIR 等
 * @param {Object} target 目标信息：{ text: 链接文本, filterPattern: 过滤正则, checkReady: 判断函数 }
 * @param {Function} onManualModeRequired 手动模式回调
 * @param {Function} addLog 日志函数
 * @param isStopRequested
 * @returns {Promise<Page>} 目标数据库页面
 */
async function academicCatNavigateToTarget(page, context, config, target, onManualModeRequired, addLog,isStopRequested,setManualMode) {
    if (isStopRequested && isStopRequested()) throw new Error('用户停止');
    // 点击首页
    const home = page.locator('text=首页');
    await home.waitFor({ state: 'visible', timeout: 10000 });
    await humanClick(page, home);
    addLog('首页跳转成功');

    // 点击英文数据库
    const englishDatabase = page.locator('dt a:has-text("英文数据库")');
    await englishDatabase.waitFor({ state: 'visible', timeout: 10000 });
    await humanClick(page, englishDatabase);
    addLog('英文数据库点击成功');

    if (isStopRequested && isStopRequested()) throw new Error('用户停止');
    // 打开目标链接的中间页
    let middlePage;
    [middlePage] = await Promise.all([
        context.waitForEvent('page', { timeout: 15000 }),
        (async () => {
            const targetLink = page.locator(`text=${target.text}`);
            await targetLink.waitFor({ state: 'visible', timeout: 10000 });
            await humanClick(page, targetLink);
            addLog(`${target.text} 打开成功`);
        })()
    ]);

    await middlePage.waitForLoadState('domcontentloaded', { timeout: 30000 });
    await middlePage.waitForSelector('div.shuoming a', { timeout: 30000 });
    addLog('中间页加载完成，开始解析镜像链接');

    // 提取所有镜像链接
    const linkElements = await middlePage.locator('div.shuoming a').elementHandles();
    const links = [];
    for (let i = 0; i < linkElements.length; i++) {
        const el = linkElements[i];
        const text = await el.textContent();
        const href = await el.getAttribute('href');
        links.push({
            index: i + 1,
            text: text ? text.trim() : '',
            href: href || ''
        });
    }
    if (links.length === 0) throw new Error('未找到任何镜像链接');

    // 根据目标文本过滤
    const filteredLinks = links.filter(link => new RegExp(target.filterPattern, 'i').test(link.text));
    if (filteredLinks.length === 0) throw new Error(`未找到任何 ${target.text} 镜像链接`);

    addLog(`\n可用的 ${target.text} 镜像站点：`);
    filteredLinks.forEach(link => addLog(`${link.index}. ${link.text} - ${link.href}`));

    // 自动尝试每个链接
    let targetPage = null;
    // 测试用，暂时注释此段尝试代码
    for (let i = 0; i < filteredLinks.length; i++) {
        if (isStopRequested && isStopRequested()) throw new Error('用户停止');
        const link = filteredLinks[i];
        addLog(`\n[自动尝试 ${i + 1}/${filteredLinks.length}] 正在打开: ${link.text} (${link.href})`);

        let newTab;
        try {
            [newTab] = await Promise.all([
                context.waitForEvent('page', { timeout: 30000 }),
                middlePage.locator('div.shuoming a').nth(link.index - 1).click()
            ]);
            addLog(`新页面已创建，初始URL: ${newTab.url()}`);
        } catch (e) {
            addLog(`点击链接后未检测到新页面: ${e.message}`);
            continue;
        }

        // 检测维护提示
        try {
            // 使用正则表达式匹配任何包含“该入口”和“维护中”的文本
            const maintenanceLocator = newTab.locator('text=/该入口.*维护中/');
            await maintenanceLocator.first().waitFor({ state: 'visible', timeout: 5000 });
            const maintenanceText = await maintenanceLocator.first().textContent();
            addLog(`⛔ 检测到维护提示: "${maintenanceText}"`);
            await newTab.close().catch(() => {});
            continue;
        } catch (e) {
            addLog('未检测到维护提示，继续检查目标元素');
        }

        try {
            await newTab.waitForLoadState('domcontentloaded', { timeout: 60000 });
            const url = newTab.url();
            if (url === 'about:blank') throw new Error('about:blank');
            const isValid = await target.checkReady(newTab);
            if (isValid) {
                addLog(`✅ 成功加载 ${target.text} 页面: ${url}`);
                targetPage = newTab;
                break;
            } else {
                throw new Error('页面缺少目标元素');
            }
        } catch (error) {
            addLog(`❌ 加载失败 (${newTab.url()}): ${error.message}`);
            await newTab.close().catch(() => {});
        }
    }

    // 手动模式
    if (!targetPage) {
        addLog(`\n⚠️ 所有 ${target.text} 镜像站点自动尝试均失败。`);
        addLog(`请手动在浏览器中打开一个可用的 ${target.text} 页面（例如点击任意镜像链接）。`);

        while (true) {
            addLog('等待用户手动确认...');
            // 通知爬虫：进入手动模式
            if (typeof setManualMode === 'function') {
                setManualMode(true);
            }
            await onManualModeRequired();

            const allPages = context.pages();
            const candidatePage = allPages[allPages.length - 1];
            const url = candidatePage.url();
            const title = await candidatePage.title().catch(() => '无法获取标题');

            // 截图
            const screenshotPath = path.join(config.SCREENSHOT_DIR, `manual-${Date.now()}.png`);
            try {
                await candidatePage.screenshot({ path: screenshotPath, fullPage: true });
                addLog(`截图已保存: ${screenshotPath}`);
            } catch (e) {}

            addLog(`手动打开的页面信息: URL=${url}, 标题=${title}`);
            if (!url || url === 'about:blank') {
                addLog('页面无效（about:blank），请重新打开');
                continue;
            }

            try {
                await candidatePage.waitForLoadState('domcontentloaded', { timeout: 30000 });
                const isValid = await target.checkReady(candidatePage);
                if (!isValid) throw new Error(`不是 ${target.text} 页面`);
                addLog(`✅ 手动确认 ${target.text} 页面: ${url}`);
                targetPage = candidatePage;
                if (typeof setManualMode === 'function') {
                    setManualMode(false);
                }

                break;
            } catch (e) {
                addLog(`验证失败: ${e.message}`);
                continue;
            }
        }
    }

    return targetPage;
}

module.exports = {
    academicCatLogin,
    academicCatNavigateToTarget
};
