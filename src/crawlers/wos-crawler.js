// src/crawlers/wos-crawler.js
const BaseCrawler = require('../core/base-crawler');
const fs = require('fs');
const path = require('path');
const { humanClick, humanType } = require('../utils/playwright-utils');
const { academicCatLogin, academicCatNavigateToTarget } = require('../utils/academic-cat-utils');
const { checkForServerError } = require('../crawlers/wos-author-crawler');
const configManager = require("../infrastructure/config-manager");
const { getSafeProjectPath } = require('../utils/common-utils');

/**
 * wos 论文爬虫类
 */
class WosCrawler extends BaseCrawler {
    constructor() {
        super('wos');

        const crawlerConfig = this.configManager.getCrawlerConfig('wos');

        this.searchConfig = {
            BASE_URL: crawlerConfig.BASE_URL || 'https://www.2447.net/',
            OUTPUT_BASE_DIR_NAME: crawlerConfig.OUTPUT_DIR_NAME || 'output/wos',
            CAPTCHA_DIR_NAME: crawlerConfig.CAPTCHA_DIR_NAME || 'captcha_temp',
            SCREENSHOT_DIR_NAME: crawlerConfig.SCREENSHOT_DIR_NAME || 'screenshot'
        };

        // 登录凭证
        this.credentials = {
            userName: crawlerConfig.USER_NAME || '',
            password: crawlerConfig.PASSWORD || ''
        };

        this.results = [];
        this.shouldStop = false;
        this.currentOutputDir = null;
        this.manualModeActive = false;
        this.availableLinks = [];      // 存储所有可用镜像链接
        this.currentLinkIndex = -1;    // 当前使用的链接索引
        this.middlePage = null;        // 中间页引用
    }

    _getBrowserHomeUrl() {
        return this.searchConfig.BASE_URL || 'https://www.2447.net/';
    }
    async beforeCrawl() {
        await super.beforeCrawl();
        this.logger.info('WoS 收录检测爬虫初始化完成');

        // 重置 WoS 特有状态
        this.shouldStop = false;
        this.results = [];
        this.currentOutputDir = null;
        this.manualModeActive = false;

        // 重置验证码相关状态
        this.state.waitingForCaptcha = false;
        this.state.captchaId = null;
        this.state.captchaImagePath = null;

        // 创建输出目录
        const timestamp = new Date().toISOString().replace(/[-:\.T]/g, '').slice(0, 15);
        this.currentOutputDir = path.join(
            process.cwd(),
            this.searchConfig.OUTPUT_BASE_DIR_NAME,
            timestamp
        );
        if (!fs.existsSync(this.currentOutputDir)) {
            fs.mkdirSync(this.currentOutputDir, { recursive: true });
        }
        this.logger.info(`输出目录已创建: ${this.currentOutputDir}`);
    }
    /**
     * 登录 WoS(通过学术猫,支持验证码)
     */
    async login() {
        this.logger.info('正在访问学术猫登录页面');
        await this.page.goto(this.searchConfig.BASE_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 150000
        });

        this.logger.info('学术猫页面已加载');

        // 定义验证码回调
        const onCaptchaRequired = async (data) => {
            const { captchaId, imagePath } = data;
            await this._showBrowserForIntervention();

            const fileName = path.basename(imagePath);
            const configManager = require('../infrastructure/config-manager');
            const localBaseUrl = configManager.getLocalBaseUrl();
            const imageUrl = `${localBaseUrl}/captcha/${fileName}`;

            this.state.waitingForCaptcha = true;
            this.state.captchaId = captchaId;
            this.state.captchaImagePath = imageUrl;
            this.logger.info(`验证码已生成: ${imageUrl}`);

            const promise = this.interventionSession.createCaptchaPromise(this.crawlerType, captchaId);

            const io = require('../infrastructure/socket-io-manager').getIo();
            if (io) {
                io.emit('user-intervention-required', {
                    id: captchaId,
                    type: 'captcha',
                    source: this.crawlerType,
                    data: {
                        imageUrl,
                        message: '请输入验证码，或在弹出的浏览器中手动登录学术猫',
                        instruction: '可在本界面填写验证码；也可直接在浏览器窗口中完成登录。'
                    }
                });
            }

            try {
                const captchaCode = await promise;
                this.state.waitingForCaptcha = false;
                this.state.captchaId = null;
                this.state.captchaImagePath = null;
                return captchaCode;
            } catch (error) {
                this.state.waitingForCaptcha = false;
                this.state.captchaId = null;
                this.state.captchaImagePath = null;
                throw error;
            }
        };

        // 定义手动模式回调
        const onManualModeRequired = async () => {
            this.logger.warn('需要手动干预,请在前端确认');
            await this._showBrowserForIntervention();
            try {
                const promise = this.interventionSession.createManualPromise(this.crawlerType);

                const io = require('../infrastructure/socket-io-manager').getIo();
                if (io) {
                    io.emit('user-intervention-required', {
                        type: 'manual',
                        source: this.crawlerType,
                        data: { message: '请在浏览器中完成操作,然后点击确认按钮' }
                    });
                }

                await promise;
                this.logger.info('用户已确认手动操作完成');
            } finally {
                await this._hideBrowserAfterIntervention();
            }
        };
        const captchaDir = getSafeProjectPath(this.searchConfig.CAPTCHA_DIR_NAME);
        // 使用学术猫登录
        try {
            await academicCatLogin(
                this.page,
                {
                    BASE_URL: this.searchConfig.BASE_URL,
                    USER_NAME: this.credentials.userName,
                    PASSWORD: this.credentials.password,
                    // CAPTCHA_DIR: path.join(process.cwd(), this.searchConfig.CAPTCHA_DIR_NAME)
                    CAPTCHA_DIR: captchaDir
                },
                onCaptchaRequired,
                (msg) => this.logger.info(msg),
                (msg) => this.state.waitingForCaptcha = msg,
                () => this.shouldStop
            );
        } finally {
            await this._hideBrowserAfterIntervention();
        }

        if (this.shouldStop) {
            throw new Error('用户停止登录');
        }

        // 导航到 WoS 页面
        await this._navigateToWos(onManualModeRequired);
    }

    getState() {
        return {
            ...super.getState(),
            waitingForCaptcha: this.state.waitingForCaptcha || false,
            captchaId: this.state.captchaId || null,
            captchaImagePath: this.state.captchaImagePath || null,
            manualModeActive: this.manualModeActive || false,
        };
    }
    /**
     * 导航到 WoS 页面(使用学术猫工具)
     */
    async   _navigateToWos(onManualModeRequired) {
        this.logger.info('正在导航到 Web of Science...');

        const target = {
            text: '(SCI)Web of Science',
            filterPattern: 'sci',
            checkReady: this._waitForWosReady.bind(this)
        };

        const screenshotDir = getSafeProjectPath(this.searchConfig.SCREENSHOT_DIR_NAME || 'output/screenshots');
        if (!fs.existsSync(screenshotDir)) {
            fs.mkdirSync(screenshotDir, { recursive: true });
        }

        const captchaDir = getSafeProjectPath(this.searchConfig.CAPTCHA_DIR_NAME);


        // const wosPage = await academicCatNavigateToTarget(
        //     this.page,
        //     this.context,
        //     {
        //         BASE_URL: this.searchConfig.BASE_URL,
        //         CAPTCHA_DIR: captchaDir,
        //         SCREENSHOT_DIR_NAME: screenshotDir
        //     },
        //     target,
        //     onManualModeRequired,
        //     (msg) => this.logger.info(msg),
        //     () => this.shouldStop,
        //     (active) => {
        //         this.manualModeActive = active;
        //     }
        // );
        //
        // if (wosPage && wosPage !== this.page) {
        //     this.page = wosPage;
        // }
        //
        // this.logger.info('已成功到达 WoS 搜索页面');
        const result = await academicCatNavigateToTarget(
            this.page,
            this.context,
            {
                BASE_URL: this.searchConfig.BASE_URL,
                CAPTCHA_DIR: captchaDir,
                SCREENSHOT_DIR_NAME: screenshotDir
            },
            target,
            onManualModeRequired,
            (msg) => this.logger.info(msg),
            () => this.shouldStop,
            (active) => {
                this.manualModeActive = active;
            }
        );
        // 保存中间页和可用链接信息，用于后续切换站点
        this.middlePage = result.middlePage || null;
        this.availableLinks = result.availableLinks || [];
        this.currentLinkIndex = result.currentLinkIndex || 0;
        this.allFilteredLinks = result.allFilteredLinks || []; // 保存所有过滤后的链接

        if (result.page && result.page !== this.page) {
            this.page = result.page;
        }

        this.logger.info('已成功到达 WoS 搜索页面');
    }
    /**
     * 等待 WoS 页面就绪
     */
    // async _waitForWosReady(page = null,timeout = 30000) {
    //     if (typeof page === 'number') {
    //         timeout = page;
    //         page = null;
    //     }
    //     const targetPage = page;
    //
    //     let currentUrl = targetPage.url();
    //     this.logger.info(`_waitForWosReady 开始，页面 URL: ${currentUrl}`);
    //     // 如果页面 URL 不是 WoS 域名（或镜像站的最终跳转域名），直接快速失败
    //     const wosDomains = ['webofscience.com', 'clarivate.cn', 'webofknowledge.com'];
    //     const isWosUrl = wosDomains.some(domain => currentUrl.includes(domain));
    //     if (!isWosUrl) {
    //         this.logger.warn(`当前页面 (${currentUrl}) 不是 WoS 页面，放弃检测`);
    //         throw new Error(`Not a WoS page: ${currentUrl}`);
    //     }
    //
    //     const startTime = Date.now();
    //     const selector = '#composeQuerySmartSearch';  // 只保留最可靠的 id
    //
    //     while (Date.now() - startTime < timeout) {
    //         if (this.shouldStop) return false;
    //         try {
    //             // 只要元素出现在 DOM 中就认为成功，不要求立即可见
    //             await targetPage.waitForSelector(selector, { timeout: 10000 });
    //             // 再等一小段时间让其真正稳定可见
    //             await targetPage.waitForFunction(
    //                 (sel) => {
    //                     const el = document.querySelector(sel);
    //                     return el && el.offsetParent !== null;
    //                 },
    //                 { timeout: 10000 },
    //                 selector
    //             );
    //             this.logger.info('检测到 WoS 搜索输入框');
    //             return true;
    //         } catch (e) {
    //             // 忽略，继续循环
    //         }
    //         await this.safeDelay(1000, 2000);
    //     }
    //     throw new Error('等待 WoS 页面超时，未检测到关键元素');
    // }

    // async _waitForWosReady(page = null, timeout = 30000) {
    //     if (typeof page === 'number') {
    //         timeout = page;
    //         page = null;
    //     }
    //     const targetPage = page || this.page;
    //     this.logger.info(`_waitForWosReady 开始，页面 URL: ${targetPage.url()}`);
    //
    //     const selector = '#composeQuerySmartSearch';
    //     const startTime = Date.now();
    //
    //     // 1. 先等待元素出现在 DOM 中（不要求可见），确保元素已渲染
    //     try {
    //         await targetPage.waitForSelector(selector, { state: 'attached', timeout: 15000 });
    //         this.logger.info('搜索框 DOM 元素已存在');
    //     } catch (err) {
    //         throw new Error(`搜索框元素未出现在 DOM 中: ${err.message}`);
    //     }
    //
    //     await this._closeCookiePopup()
    //     // 2. 尝试关闭可能遮挡输入框的弹窗（如 Cookie 同意、隐私声明等）
    //     const closePopup = async () => {
    //         // 常见的有 Accept / Got it / 同意 按钮
    //         const acceptButtons = [
    //             'button:has-text("Accept")',
    //             'button:has-text("Agree")',
    //             'button:has-text("Got it")',
    //             'button:has-text("同意")',
    //             'button:has-text("关闭")',
    //             '[aria-label="Close"]',
    //             '.cookie-accept',
    //             '.privacy-accept'
    //         ];
    //         for (const btnSelector of acceptButtons) {
    //             try {
    //                 const btn = targetPage.locator(btnSelector).first();
    //                 if (await btn.isVisible({ timeout: 1000 })) {
    //                     await btn.click();
    //                     this.logger.info(`关闭弹窗: ${btnSelector}`);
    //                     await targetPage.waitForTimeout(1000);
    //                 }
    //             } catch (e) {}
    //         }
    //     };
    //     await closePopup();
    //
    //     // 3. 再次等待元素可见（此时覆盖层应已关闭）
    //     while (Date.now() - startTime < timeout) {
    //         if (this.shouldStop) return false;
    //         try {
    //             await targetPage.waitForSelector(selector, { state: 'visible', timeout: 5000 });
    //             // 额外确保元素可交互（offsetParent 不为 null）
    //             await targetPage.waitForFunction(
    //                 (sel) => {
    //                     const el = document.querySelector(sel);
    //                     return el && el.offsetParent !== null;
    //                 },
    //                 { timeout: 3000 },
    //                 selector
    //             );
    //             this.logger.info(`✅ 检测到可见的 WoS 搜索输入框 (${targetPage.url()})`);
    //             return true;
    //         } catch (e) {
    //             this.logger.debug(`等待可见失败，尝试关闭弹窗: ${e.message}`);
    //             await closePopup(); // 再次尝试关闭可能的弹窗
    //             await this.safeDelay(1000, 2000);
    //         }
    //     }
    //     throw new Error(`等待 WoS 页面超时，未检测到可见的关键元素 (最后 URL: ${targetPage.url()})`);
    // }

    // async _waitForWosReady(page = null, timeout = 30000) {
    //     // 兼容调用方式：第一个参数可能是超时时间
    //     if (typeof page === 'number') {
    //         timeout = page;
    //         page = null;
    //     }
    //     const targetPage = page || this.page;
    //     this.logger.info(`_waitForWosReady 开始，页面 URL: ${targetPage.url()}`);
    //
    //     const selector = '#composeQuerySmartSearch';
    //     const startTime = Date.now();
    //
    //     // 1. 确保元素已挂载到 DOM 中
    //     try {
    //         await targetPage.waitForSelector(selector, { state: 'attached', timeout: 15000 });
    //         this.logger.info('搜索框 DOM 元素已存在');
    //     } catch (err) {
    //         throw new Error(`搜索框元素未出现在 DOM 中: ${err.message}`);
    //     }
    //
    //     // 2. 关闭已知的 Cookie 弹窗（特定实现）
    //     await this._closeCookiePopup();
    //
    //     // 3. 通用弹窗清理函数：点击常见按钮 + 暴力删除遮挡层
    //     const closePopup = async () => {
    //         // 3.1 尝试点击“接受/同意”按钮
    //         const acceptButtons = [
    //             'button:has-text("Accept")',
    //             'button:has-text("Agree")',
    //             'button:has-text("Got it")',
    //             'button:has-text("同意")',
    //             'button:has-text("关闭")',
    //             '[aria-label="Close"]',
    //             '.cookie-accept',
    //             '.privacy-accept'
    //         ];
    //         for (const btnSelector of acceptButtons) {
    //             try {
    //                 const btn = targetPage.locator(btnSelector).first();
    //                 if (await btn.isVisible({ timeout: 1000 })) {
    //                     await btn.click();
    //                     this.logger.info(`关闭弹窗(按钮): ${btnSelector}`);
    //                     await targetPage.waitForTimeout(1000);
    //                 }
    //             } catch (e) {}
    //         }
    //
    //         // 3.2 暴力移除常见遮挡层（之前已添加的代码）
    //         await targetPage.evaluate(() => {
    //             const overlaySelectors = [
    //                 '.onetrust-pc-dark-filter',
    //                 '.cookie-overlay',
    //                 '.modal-backdrop',
    //                 '#onetrust-consent-sdk',
    //                 '.privacy-consent',
    //                 '.cc-window',
    //                 '.cc-overlay',
    //                 '.ot-sdk-container',
    //                 '.ot-floating-button',
    //             ];
    //             overlaySelectors.forEach(sel => {
    //                 document.querySelectorAll(sel).forEach(el => el.remove());
    //             });
    //             // 恢复页面滚动和交互
    //             document.body.style.overflow = '';
    //             document.body.style.position = '';
    //             document.documentElement.style.overflow = '';
    //             document.body.style.pointerEvents = '';
    //         });
    //     };
    //
    //     // 第一次清理弹窗
    //     await closePopup();
    //
    //     // 4. 核心等待：轮询检查元素尺寸（宽度 > 0）即可认为就绪
    //     this.logger.info('开始轮询检查搜索框的尺寸...');
    //     while (Date.now() - startTime < timeout) {
    //         // 检测停止信号
    //         if (this.shouldStop) {
    //             this.logger.info('检测到停止信号，退出 WoS 就绪等待');
    //             return false;
    //         }
    //
    //         try {
    //             // 使用 waitForFunction 检查组件的 bounding box 是否有效
    //             await targetPage.waitForFunction(
    //                 (sel) => {
    //                     const el = document.querySelector(sel);
    //                     return el && el.getBoundingClientRect().width > 0;
    //                 },
    //                 { timeout: 5000 },  // 每次检查最多等5秒
    //                 selector
    //             );
    //
    //             this.logger.info(`✅ 搜索框已具有非零尺寸，视为可用 (${targetPage.url()})`);
    //             return true;
    //         } catch (e) {
    //             // 尺寸检查失败，重新尝试清理弹窗并延迟
    //             this.logger.debug('搜索框尺寸无效，重新清理弹窗');
    //             await closePopup();
    //             await this.safeDelay(1000, 2000);
    //         }
    //     }
    //
    //     // 超时
    //     throw new Error(`等待 WoS 页面超时，未检测到可用的搜索框 (最后 URL: ${targetPage.url()})`);
    // }


    async _waitForWosReady(page = null, timeout = 30000) {
        if (typeof page === 'number') {
            timeout = page;
            page = null;
        }

        const targetPage = page || this.page;
        this.logger.info(`_waitForWosReady 开始，页面 URL: ${targetPage.url()}`);

        this._closeCookiePopup();
        // 可能的搜索框选择器（优先级从左到右）
        const inputSelectors = [
            '#composeQuerySmartSearch',
            'input[data-ta="search-criteria-input"]',
            'input[aria-label="Search documents, researchers, affiliations, and more"]',
            'input[placeholder*="Search documents"]',
        ];

        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            if (this.shouldStop) {
                this.logger.info('检测到停止信号，退出等待 WoS 页面');
                return false;
            }

            for (const selector of inputSelectors) {
                try {
                    // 只要求元素挂载到 DOM，不要求视觉可见
                    await targetPage.waitForSelector(selector, {
                        state: 'attached',
                        timeout: 10000,
                    });

                    // 额外确认元素有实际尺寸（布局宽度 > 0），确保可操作
                    const ready = await targetPage.evaluate((sel) => {
                        const el = document.querySelector(sel);
                        return el && el.offsetWidth > 0;
                    }, selector);

                    if (ready) {
                        this.logger.info('检测到可用的 WoS 搜索输入框');
                        return true;
                    }
                } catch (e) {
                    // 当前选择器失败，尝试下一个
                    continue;
                }
            }

            // 所有选择器本轮均失败，等待后重试
            await this.safeDelay(2000, 3000);
        }

        throw new Error('等待 WoS 页面超时，未检测到关键元素');
    }
    // async _waitForWosReady(page = null, timeout = 30000) {
    //     const targetPage = page || this.page;   // 兼容旧调用
    //     this.logger.info(`等待 WoS 搜索输入框可见 (页面: ${targetPage.url()})`);
    //     const selector = '#composeQuerySmartSearch';
    //     try {
    //         await targetPage.waitForSelector(selector, { state: 'visible', timeout });
    //         this.logger.info('✅ 检测到 WoS 搜索输入框');
    //         await targetPage.waitForTimeout(1000);
    //         return true;
    //     } catch (err) {
    //         // 保存调试信息
    //         const screenshot = await targetPage.screenshot({ path: `wos-error-${Date.now()}.png` });
    //         this.logger.error(`等待失败: ${err.message}`);
    //         throw new Error('等待 WoS 页面超时，未检测到关键元素');
    //     }
    // }
    /**
     * 执行搜索
     */
    /**
     * 关闭 Cookie 弹窗
     */
    async _closeCookiePopup() {
        try {
            const closeButton = await this.page.$('#onetrust-close-btn-container button.onetrust-close-btn-handler');
            if (closeButton && await closeButton.isVisible()) {
                this.logger.info('检测到 Cookie 弹窗，正在关闭...');
                await humanClick(this.page, closeButton);
                await this.safeDelay(1000, 1000);
            }
        } catch (error) {
            this.logger.warn(`关闭 Cookie 弹窗失败: ${error.message}`);
        }
    }
    async search(params) {
        const { keywords: rawInput } = params;

        this.logger.info('搜索开始前,检查页面状态...');
        await this.safeDelay(1000, 2000);

        // 预处理关键词
        const keywords = this._preprocessKeywords(rawInput);

        if (!keywords || keywords.length === 0) {
            throw new Error('关键词列表不能为空');
        }

        this.logger.info(`开始检索,共 ${keywords.length} 篇论文`);

        const results = [];
        for (let i = 0; i < keywords.length; i++) {
            if (this.shouldStop || !this.state.isRunning) {
                this.logger.info('检测到停止信号,终止检索');
                break;
            }

            if (!this.isBrowserAvailable()) {
                this.logger.warn('浏览器不可用,终止检索');
                break;
            }

            const keyword = keywords[i];
            this.logger.info(`准备检索第 ${i + 1}/${keywords.length} 篇论文`);

            this.updateProgress(
                Math.round((i / keywords.length) * 100),
                `处理第 ${i + 1}/${keywords.length} 篇论文:${keyword.substring(0, 50)}`
            );

            try {
                const result = await this._searchSinglePaper(keyword);
                results.push(result);

                if (i < keywords.length - 1) {
                    await this.safeDelay(5000, 8000);
                }
            } catch (error) {
                if (this.errorHandler.isBrowserClosedError(error)) {
                    this.logger.error('浏览器已关闭,终止任务');
                    break;
                }

                this.logger.error(`论文 "${keyword.substring(0, 50)}" 检索失败: ${error.message}`);

                results.push({
                    isRecruit: 'false',
                    accessionNo: '无',
                    title: keyword,
                    searchTime: new Date().toISOString(),
                    indexedDate: '',
                    remark: `检索失败: ${error.message}`
                });
            }
        }
        this.results = results;
        return results;
    }

    /**
     * 预处理关键词
     */
    _preprocessKeywords(input) {
        if (!Array.isArray(input) || input.length === 0) {
            this.logger.error('输入数据为空');
            return [];
        }

        const firstItem = input[0];

        // 对象数组(论文对象)
        if (typeof firstItem === 'object' && firstItem !== null) {
            return input.map(item => {
                if (item.title) {
                    return item.title;
                }
                this.logger.warn(`论文数据格式无效: ${JSON.stringify(item)}`);
                return null;
            }).filter(Boolean);
        }

        // 字符串数组
        if (typeof firstItem === 'string') {
            return input.filter(kw => kw && kw.trim());
        }

        this.logger.warn('未知输入类型');
        return [];
    }
    /**
     * 检索单篇论文
     */
    async _searchSinglePaper(keyword) {
        await this._closeCookiePopup()
        if (!this.isBrowserAvailable()) {
            throw new Error('浏览器不可用，无法执行搜索');
        }
        this.logger.info(`检索论文: ${keyword.substring(0, 50)}...`);

        // 定位输入框
        const inputElement = await this.page.$('#composeQuerySmartSearch');
        if (!inputElement) {
            throw new Error('未找到搜索输入框');
        }

        // 清空并输入关键词
        await inputElement.fill('');
        await this.safeDelay(300, 500);

        await humanType(this.page, inputElement, keyword);
        this.logger.info(`输入框已填充: ${keyword}`);

        // 定位搜索按钮
        const buttonSelectors = [
            "button[data-pendo='smart-search-query']",
            "button[data-ta='run-search']",
            "button[type='submit']"
        ];

        let submitButton = null;
        for (const selector of buttonSelectors) {
            if (!this.isBrowserAvailable()) {
                throw new Error('浏览器已关闭，无法继续搜索');
            }
            try {
                submitButton = await this.page.$(selector);
                if (submitButton && await submitButton.isVisible()) {
                    this.logger.info('找到搜索按钮');
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        if (!submitButton) {
            throw new Error('未找到搜索按钮');
        }

        // 点击搜索按钮
        await humanClick(this.page, submitButton);
        this.logger.info('搜索按钮点击成功');

        if (!this.isBrowserAvailable()) {
            throw new Error('浏览器已关闭，无法处理搜索结果');
        }

        // 等待页面响应
        await this.safeDelay(3000, 5000);

        // 处理 Cookie 弹窗
        await this._handleCookieConsent();


        const hasAccessDenied = await this._checkAccessDenied();
        if (hasAccessDenied) {
            this.logger.warn('检测到权限错误："You have no access to the requested resource"，尝试切换站点...');

            // 尝试切换到下一个可用站点
            const switched = await this._trySwitchToNextSite();
            if (switched) {
                this.logger.info('站点切换成功，重新执行搜索');
                // 递归重新搜索
                return this._searchSinglePaper(keyword);
            } else {
                this.logger.error('所有可用站点均出现权限错误');
                throw new Error('所有镜像站点均无搜索权限');
            }
        }
        const hasServerError = await this.checkForServerError();
        if (hasServerError) {
            this.logger.warn('检测到服务器错误："You have no access to the requested resource"，尝试切换站点...');

            // 尝试切换到下一个可用站点
            const switched = await this._trySwitchToNextSite();
            if (switched) {
                this.logger.info('站点切换成功，重新执行搜索');
                // 递归重新搜索
                return this._searchSinglePaper(keyword);
            } else {
                this.logger.error('所有可用站点均出现服务器错误');
                throw new Error('所有镜像站点均出现服务器错误');
            }
        }
        // 判断是否有结果
        const hasResults = await this._checkSearchResults();

        if (!hasResults) {
            const isAccessDenied = await this._checkAccessDenied();
            const hasServerError = await this.checkForServerError();
            const accessionNo = '无';

            let remark = '';
            if (hasServerError) {
                remark = '服务器错误，可能遭遇反爬检测';

            } else if (isAccessDenied) {
                remark = '无权限访问此资源';
            }

            this.logger.warn(`未搜索到结果: ${keyword.substring(0, 50)}${
                hasServerError ? ' (服务器错误)' : isAccessDenied ? ' (无权限)' : ''
            }`);
            return {
                isRecruit: 'false',
                accessionNo,
                title: keyword,
                searchTime: new Date().toISOString(),
                indexedDate: '',
                remark
            };
        }

        // 提取详细信息
        return await this._extractPaperDetails(keyword);
    }
    /**
     * 尝试切换到下一个可用站点
     * @returns {Promise<boolean>} 是否切换成功
     */
    async _trySwitchToNextSite() {
        if (!this.allFilteredLinks || this.allFilteredLinks.length === 0) {
            this.logger.error('没有可用的镜像链接列表');
            return false;
        }

        // 关闭当前无权限的页面
        try {
            await this.page.close();
        } catch (e) {
            this.logger.warn('关闭当前页面失败:', e.message);
        }

        // 尝试剩余的链接
        for (let i = this.currentLinkIndex + 1; i < this.allFilteredLinks.length; i++) {
            if (this.shouldStop || !this.state.isRunning) {
                this.logger.info('检测到停止信号，终止站点切换');
                return false;
            }

            const link = this.allFilteredLinks[i];
            this.logger.info(`\n[切换站点 ${i + 1}/${this.allFilteredLinks.length}] 正在打开: ${link.text} (${link.href})`);

            let newTab;
            try {
                [newTab] = await Promise.all([
                    this.context.waitForEvent('page', { timeout: 60000 }),
                    this.middlePage.locator('div.shuoming a').nth(link.index - 1).click()
                ]);
                this.logger.info(`新页面已创建，初始URL: ${newTab.url()}`);
            } catch (e) {
                this.logger.warn(`点击链接后未检测到新页面: ${e.message}`);
                continue;
            }

            // 检测维护提示
            try {
                const errorLocator = newTab.locator('text=/该入口.*维护中|请重新进入|下载量已达.*上限|本日下载量.*上限|请联系单位管理员/i');
                await errorLocator.first().waitFor({ state: 'visible', timeout: 5000 });
                const errorText = await errorLocator.first().textContent();
                this.logger.warn(`⛔ 检测到限制提示: "${errorText}"`);
                await newTab.close().catch(() => {});
                continue;
            } catch (e) {
                // 无限制提示，继续检查
            }

            try {
                await newTab.waitForLoadState('networkidle', { timeout: 60000 });
                await newTab.waitForTimeout(3000);

                const url = newTab.url();
                if (url === 'about:blank') {
                    await newTab.close().catch(() => {});
                    continue;
                }

                // 检查页面就绪
                let isValid = false;
                for (let retry = 0; retry < 2; retry++) {
                    try {
                        isValid = await this._waitForWosReady(newTab, 30000);
                        if (isValid) break;
                    } catch (e) {
                        // 忽略
                    }
                    if (retry === 0) {
                        this.logger.info('首次检测失败，等待 5 秒后重试...');
                        await new Promise(r => setTimeout(r, 5000));
                    }
                }

                if (isValid) {
                    this.logger.info(`✅ 成功切换到新站点: ${url}`);
                    this.page = newTab;
                    this.currentLinkIndex = i;

                    // 关闭旧的中间页（可选）
                    // await this.middlePage.close().catch(() => {});

                    return true;
                } else {
                    await newTab.close().catch(() => {});
                }
            } catch (error) {
                this.logger.error(`❌ 加载失败 (${newTab.url()}): ${error.message}`);
                await newTab.close().catch(() => {});
            }
        }

        this.logger.error('所有剩余站点均无法使用');
        return false;
    }
    /**
     * 处理 Cookie 弹窗
     */
    async _handleCookieConsent() {
        try {
            await this.safeDelay(1500, 1500);
            const removed = await this.page.evaluate(() => {
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
            });
            if (removed) {
                this.logger.info('成功处理Cookie弹窗');
            }
        } catch (e) {
            this.logger.warn(`处理Cookie弹窗时出错: ${e.message}`);
        }
    }
    /**
     * 检查搜索结果
     */
    async _checkSearchResults() {
        try {
            const resultLinks = await this.page.$$("[data-ta='summary-record-title-link']");
            return resultLinks.length > 0;
        } catch (error) {
            this.logger.warn(`检查结果时出错: ${error.message}`);
            return false;
        }
    }
    async _checkAccessDenied() {
        try {
            const accessDenied = await this.page.$('span.errMsg:text("You have no access to the requested resource")');
            return !!accessDenied;
        } catch (error) {
            return false;
        }
    }
    /**
     * 提取论文详细信息
     */
    async _extractPaperDetails(keyword) {
        try {
            // 点击第一个结果
            const firstResult = await this.page.$("[data-ta='summary-record-title-link']");
            if (!firstResult) {
                throw new Error('未找到结果链接');
            }

            await humanClick(this.page, firstResult);
            await this.safeDelay(3000, 5000);

            // 点击展开详细信息按钮
            const spreadOut = await this.page.$("[data-ta='HiddenSecTa-showMoreDataButton']");
            if (spreadOut && await spreadOut.isVisible()) {
                await humanClick(this.page, spreadOut);
                await this.safeDelay(1000, 1000);
            }

            // 提取入藏号
            let accessionNo = '';
            let isRecruit = false;
            try {
                const accessionNoElement = await this.page.$("[data-ta='HiddenSecTa-accessionNo']");
                if (accessionNoElement) {
                    accessionNo = await accessionNoElement.textContent();
                    accessionNo = accessionNo.trim();
                    isRecruit = true;
                    this.logger.info(`是否收录: true, 入藏号: ${accessionNo}`);
                } else {
                    this.logger.info('是否收录: false, 未找到入藏号');
                    accessionNo = '无';
                }
            } catch (e) {
                this.logger.warn(`获取入藏号失败: ${e.message}`);
            }

            // 提取 Indexed 日期
            let indexedDate = '';
            try {
                await this.page.waitForSelector('span[name="indexedDate"]', { timeout: 10000 });
                const indexedElement = await this.page.$('span[name="indexedDate"]');
                if (indexedElement) {
                    indexedDate = await indexedElement.textContent();
                    indexedDate = indexedDate.trim();
                    this.logger.info(`Indexed 日期: ${indexedDate}`);
                }
            } catch (e) {
                this.logger.warn(`提取 Indexed 日期失败: ${e.message}`);
                // 尝试备用选择器
                try {
                    await this.page.waitForSelector('[data-ta="FullRTa-indexedDate"]', { timeout: 5000 });
                    const altElement = await this.page.$('[data-ta="FullRTa-indexedDate"]');
                    if (altElement) {
                        indexedDate = await altElement.textContent();
                        indexedDate = indexedDate.trim();
                        this.logger.info(`使用备用选择器找到 Indexed 日期: ${indexedDate}`);
                    }
                } catch (err) {
                    this.logger.warn(`备用选择器也未找到 Indexed 日期`);
                }
            }

            // 返回上一页
            await this.page.goBack();
            await this.safeDelay(2000, 3000);

            return {
                isRecruit: String(isRecruit),
                accessionNo: accessionNo || '无',
                title: keyword,
                searchTime: new Date().toISOString(),
                indexedDate: indexedDate
            };

        } catch (error) {
            this.logger.error(`提取论文详情失败: ${error.message}`);

            // 尝试返回
            try {
                await this.page.goBack();
            } catch (e) {
                // 忽略
            }

            return {
                isRecruit: 'false',
                accessionNo: '无',
                title: keyword,
                searchTime: new Date().toISOString(),
                indexedDate: '',
                remark: `提取详情失败: ${error.message}`
            };
        }
    }
    /**
     * 提取数据
     */
    async extractData(searchResults) {
        this.logger.info('开始整理提取的数据');


        const successList = searchResults.filter(r => r.isRecruit === 'true');
        const failedList = searchResults.filter(r => r.isRecruit === 'false' || r.remark);

        return {
            successList: successList,
            failedList: failedList,
            totalCount: searchResults.length,
            successCount: successList.length,
            failedCount: failedList.length
        };
    }
    /**
     * 保存结果
     */
    async saveResults(data) {
        this.logger.info('开始保存结果');

        const timestamp = path.basename(this.currentOutputDir);
        const dataDir = path.join(this.currentOutputDir, 'data');

        const filePaths = {
            resultExcel: path.join(dataDir, `WOS-${timestamp}.xlsx`)
        };

        // 导出 Excel
        this.excelExporter.exportWosResults(
            data.successList,
            filePaths.resultExcel
        );

        return {
            successCount: data.successList.length,
            failedCount: data.failedList.length,
            outputDir: this.currentOutputDir,
            filePaths
        };
    }
    /**
     * 停止爬虫
     */
    async stop() {
        this.logger.info('WoS 收录检测爬虫收到停止请求');

        this.shouldStop = true;

        this.state.waitingForCaptcha = false;
        this.state.captchaId = null;
        this.state.captchaImagePath = null;

        await super.stop();

        this.logger.info('WoS 收录检测爬虫已停止');
    }

    /**
     * 重置状态
     */
    resetState() {
        this.logger.info('重置 WoS 收录检测爬虫状态');

        this.state = {
            isRunning: false,
            progress: 0,
            log: [],
            error: null,
            result: null
        };

        this.shouldStop = false;
        this.results = [];
        this.currentOutputDir = null;
        this.manualModeActive = false;

        this.state.waitingForCaptcha = false;
        this.state.captchaId = null;
        this.state.captchaImagePath = null;

        this.interventionSession.cancelSource(this.crawlerType, '状态重置');

        this.logger.info('WoS 收录检测爬虫状态已重置');
    }
    /**
     * 检查是否有服务器错误
     * @returns {Promise<boolean>} - 是否有服务器错误
     */
    async checkForServerError() {
        try {
            const content = await this.page.content();
            return content.includes('Server.unexpectedError') ||
                content.includes('Unexpected Error') ||
                content.includes('服务器错误') ||
                content.includes('Service Unavailable');
        } catch (error) {
            this.logger.warn(`检查服务器错误失败: ${error.message}`);
            return false;
        }
    }


}
module.exports = WosCrawler;
