// src/utils/playwright-utils.js
const path = require('path');
const fs = require('fs');
const { ensureDir } = require('./common-utils');

/**
 * 模拟人类点击：移动鼠标、停顿、点击
 */
async function humanClick(page, locator) {
    try {
        // 检查页面是否仍然可用
        if (!page || page.isClosed()) {
            console.log('人类点击跳过: 页面已关闭');
            return false;
        }

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
        // 如果是浏览器关闭错误，静默处理
        if (e.message.includes('has been closed') || e.message.includes('Target closed')) {
            console.log('人类点击跳过: 浏览器已关闭');
            return false;
        }
        console.log(`人类点击模拟失败: ${e.message}`);
        return false;
    }
}

/**
 * 模拟人类输入：逐个字符输入，带随机延迟
 * @param {object} [options]
 * @param {boolean} [options.fast] - 检索场景用较快方式，大幅缩短长标题输入时间
 */
async function humanType(page, locator, text, options = {}) {
    // 检查页面是否仍然可用
    if (!page || page.isClosed()) {
        console.log('人类输入跳过: 页面已关闭');
        return;
    }

    const fast = options.fast === true;
    // 长查询用稍快击键，但仍逐字输入（瞬时 fill 更容易触发 Scholar 风控）
    if (fast && String(text || '').length > 24) {
        await locator.fill('');
        for (const char of String(text)) {
            await locator.type(char, { delay: 80 + Math.random() * 100 });
            if (Math.random() < 0.08) {
                await page.waitForTimeout(120 + Math.random() * 200);
            }
        }
        await page.waitForTimeout(120 + Math.random() * 180);
        return;
    }

    await locator.fill('');
    for (const char of text) {
        const typeDelay = fast
            ? (20 + Math.random() * 40)
            : (80 + Math.random() * 140);
        await locator.type(char, { delay: typeDelay });
        if (!fast && Math.random() < 0.08) {
            await page.waitForTimeout(120 + Math.random() * 280);
        } else {
            await page.waitForTimeout(fast ? (5 + Math.random() * 15) : (15 + Math.random() * 40));
        }
    }
}

/**
 * 随机延迟，模拟人类操作间隔
 */
async function randomDelay(page, min = 500, max = 1500) {
    const delay = min + Math.random() * (max - min);
    await page.waitForTimeout(delay);
}

/**
 * 保存错误截图
 */
async function takeErrorScreenshot(page, context = 'unknown') {
    if (!page || page.isClosed()) {
        console.warn('[截图] 页面对象无效或已关闭，无法截图');
        return null;
    }
    try {
        const screenshotDir = path.join(process.cwd(), 'output', 'screenshots');
        ensureDir(screenshotDir);
        const timestamp = Date.now();
        const safeContext = context.replace(/[^a-z0-9]/gi, '_').slice(0, 50);
        const filename = `error_${timestamp}_${safeContext}.png`;
        const filePath = path.join(screenshotDir, filename);
        await page.screenshot({ path: filePath, fullPage: true });
        console.log(`[截图] 错误截图已保存: ${filePath}`);
        return filePath;
    } catch (err) {
        console.error(`[截图] 保存截图失败: ${err.message}`);
        return null;
    }
}

module.exports = {
    humanClick,
    humanType,
    randomDelay,
    takeErrorScreenshot
};
