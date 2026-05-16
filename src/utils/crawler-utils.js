const path = require('path');

/**
 * 统一检测所有类型的验证码（人机验证 + 传统字符验证码）
 * @param {Page} page - 要检测的页面
 * @returns {Promise<boolean>}
 */
async function isAnyCaptchaPresent(page) {
    const url = page.url();
    if (url.includes('/sorry/index')) return true;

    try {
        const bodyText = await page.textContent('body');
        if (bodyText.includes('请键入下图显示的字符以继续操作')) return true;
    } catch (e) {}

    const captchaSelectors = [
        '#captcha-form',
        'form[action*="captcha"]',
        '.g-recaptcha',
        'iframe[src*="recaptcha"]',
        'div:has-text("请进行人机身份验证")',
        'div:has-text("unusual traffic")'
    ];

    for (const selector of captchaSelectors) {
        try {
            const element = await page.$(selector);
            if (element && await element.isVisible()) return true;
        } catch (e) {}
    }

    return false;
}

/**
 * 处理人机验证（reCAPTCHA 等）
 * @param {Page} page
 * @param {Object} context - 上下文（logger, browserManager, getCurrentOutputDir, shouldStopRef, isRunningRef）
 */
async function handleHumanCaptcha(page, context) {
    const { logger, browserManager, getCurrentOutputDir, shouldStopRef, isRunningRef } = context;

    logger.warn('⚠️ 检测到人机验证，请手动完成');

    const outputDir = getCurrentOutputDir();
    const screenshotPath = await browserManager.takeScreenshot(
        page,
        'captcha',
        path.join(outputDir, 'screenshots')
    );

    const io = require('../infrastructure/socket-io-manager').getIo();
    if (io) {
        io.emit('user-intervention-required', {
            type: 'captcha-manual',
            source: 'google',
            data: {
                message: '请在弹出的浏览器窗口中完成人机验证',
                instruction: '验证完成后爬虫将自动继续，请勿关闭浏览器窗口。',
                screenshotPath: screenshotPath ? `/screenshots/${path.basename(screenshotPath)}` : null,
                timestamp: Date.now()
            }
        });
        logger.info('已发送人机验证提醒到前端');
    }

    let waitTime = 0;
    const maxWaitTime = 600000; // 10分钟
    const checkInterval = 5000;

    while (waitTime < maxWaitTime) {
        if (shouldStopRef() || !isRunningRef()) {
            throw new Error('用户停止任务');
        }
        await page.waitForTimeout(checkInterval);
        waitTime += checkInterval;

        if (!await isAnyCaptchaPresent(page)) {
            try {
                const searchResults = await page.$('#gs_res_ccl_mid');
                if (searchResults) {
                    logger.info('✅ 验证已完成');
                    return;
                }
            } catch (error) {
                logger.info('✅ 页面已恢复正常');
                return;
            }
        }
    }
    throw new Error('人机验证处理超时');
}

/**
 * 处理传统字符验证码（图片验证码）
 * @param {Page} page
 * @param {Object} context - 上下文（logger, shouldStopRef, isRunningRef）
 */
async function handleTraditionalCaptcha(page, context) {
    const { logger, shouldStopRef, isRunningRef } = context;

    logger.warn('⚠️ 检测到字符验证码，等待用户输入');

    const io = require('../infrastructure/socket-io-manager').getIo();
    if (io) {
        io.emit('user-intervention-required', {
            type: 'captcha-manual',
            source: 'google',
            data: {
                message: '请在浏览器窗口中输入验证码',
                instruction: '请手动输入验证码并提交，完成后爬虫将自动继续',
                timestamp: Date.now()
            }
        });
    }

    let waitTime = 0;
    const maxWaitTime = 600000;
    const checkInterval = 5000;

    while (waitTime < maxWaitTime) {
        if (shouldStopRef() || !isRunningRef()) {
            throw new Error('用户停止任务');
        }
        await page.waitForTimeout(checkInterval);
        waitTime += checkInterval;

        if (!await isAnyCaptchaPresent(page)) {
            logger.info('✅ 字符验证码已解决');
            return;
        }
    }
    throw new Error('字符验证码处理超时');
}

/**
 * 统一处理所有验证码（自动判断类型并调用相应处理）
 * @param {Page} page
 * @param {Object} context
 */
async function handleAnyCaptcha(page, context) {
    const url = page.url();
    if (url.includes('/sorry/index')) {
        await handleTraditionalCaptcha(page, context);
        return;
    }

    let bodyText = '';
    try {
        bodyText = await page.textContent('body');
    } catch (e) {}

    if (bodyText.includes('请键入下图显示的字符以继续操作')) {
        await handleTraditionalCaptcha(page, context);
        return;
    }

    await      handleHumanCaptcha(page, context);
}

// utils/crawler-utils.js

/**
 * 检测 Google 反脚本检测页面
 * @param {Page} page
 * @param {Function} logger
 * @returns {Promise<{isBlocked: boolean, message: string}>}
 */
async function checkGoogleAntiBot(page, logger) {
    try {
        const url = page.url();

        // URL 特征
        if (url.includes('/sorry/') || url.includes('google.com/sorry')) {
            logger && logger.error('检测到 Google 反脚本检测 (URL特征)');
            return { isBlocked: true, message: '遭遇谷歌反脚本检测，检索中断' };
        }

        // 页面内容特征
        const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');

        const indicators = [
            "We're sorry",
            "automated queries",
            "can't process your request right now",
            "your computer or network may be sending automated queries"
        ];

        const matched = indicators.find(ind =>
            bodyText.toLowerCase().includes(ind.toLowerCase())
        );

        if (matched) {
            logger && logger.error(`检测到 Google 反脚本检测 (文本特征: "${matched}")`);
            return { isBlocked: true, message: '遭遇谷歌反脚本检测，检索中断' };
        }

        return { isBlocked: false, message: '' };
    } catch (error) {
        return { isBlocked: false, message: '' };
    }
}


// 直接导出所有工具方法
module.exports = {
    isAnyCaptchaPresent,
    handleAnyCaptcha,
    handleHumanCaptcha,
    handleTraditionalCaptcha,
    checkGoogleAntiBot
};
