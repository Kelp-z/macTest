// src/crawlers/wos-author-crawler.js
const BaseCrawler = require('../core/base-crawler');
const fs = require('fs');
const path = require('path');
const {humanClick, humanType} = require('../utils/playwright-utils');
const {
    getWosAuthorCredentials,
    saveWosAuthorCredentials,
    loadLegacyUserCredentials
} = require('../infrastructure/user-credentials-store');

/**
 * WoS (Web of Science) 作者爬虫类
 */

class WosAuthorCrawler extends BaseCrawler {
    constructor() {
        super('wos-author');
        const crawlerConfig = this.configManager.getCrawlerConfig('wos-author');
        this.searchConfig = {
            OUTPUT_BASE_DIR_NAME: crawlerConfig.OUTPUT_BASE_DIR_NAME ?? 'output/wos_authors',
            LOGIN_URL: 'https://access.clarivate.com/login?app=wos',
            TARGET_URL: 'https://webofscience.clarivate.cn/wos/author/author-search'

        };

        // WoS 登录凭证（按终端 ID 隔离，启动任务时再加载）
        this.credentials = {
            email: '',
            password: ''
        };
        this.terminalId = '';
        this._boundTerminalId = null;

        this.authorsResultList = [];
        this.shouldStop = false;
        this.currentOutputDir = null;

    }

    async beforeCrawl() {
        await super.beforeCrawl();
        this.logger.info('WoS 作者爬虫初始化完成');
        this.shouldStop = false;
        this.authorsResultList = [];

        // 绑定当前终端；切换终端时强制关闭浏览器，避免 Clarivate 会话串号
        const terminalId = String(
            this.crawlOptions?.terminalId ||
            this.crawlOptions?.terminalID ||
            ''
        ).trim();
        this.terminalId = terminalId;
        if (this._boundTerminalId && terminalId && this._boundTerminalId !== terminalId) {
            this.logger.info(
                `检测到终端切换 (${this._boundTerminalId} -> ${terminalId})，关闭浏览器会话以防串号`
            );
            try {
                await this.cleanup({ force: true });
            } catch (e) {
                this.logger.warn(`切换终端时关闭浏览器失败: ${e.message}`);
            }
            this.page = null;
            this.context = null;
            this.browser = null;
        }
        if (terminalId) {
            this._boundTerminalId = terminalId;
        }

        const timestamp = new Date().toISOString().replace(/[-:\.T]/g, '').slice(0, 15);
        this.currentOutputDir = path.join(
            process.cwd(),
            this.searchConfig.OUTPUT_BASE_DIR_NAME,
            timestamp
        );
        if (!fs.existsSync(this.currentOutputDir)) {
            fs.mkdirSync(this.currentOutputDir, {recursive: true});
        }
        this.logger.info(`输出目录已创建: ${this.currentOutputDir}`);
        if (terminalId) {
            this.logger.info(`当前终端: ${terminalId}（WoS 账密按终端隔离）`);
        } else {
            this.logger.warn('未传入 terminalId，无法按终端隔离账密');
        }
    }

    /**
     * 停止爬虫
     */
    async stop() {
        this.logger.info('WoS 作者爬虫收到停止请求');

        // 设置 WoS 特有的停止标志
        this.shouldStop = true;

        // 调用父类的通用停止逻辑
        await super.stop();

        this.logger.info('WoS 作者爬虫已停止');
    }

    /**
     * 重置状态
     */
    resetState() {
        this.logger.info('重置 WoS 作者爬虫状态');

        // 重置 WoS 特有状态
        this.shouldStop = false;
        this.authorsResultList = [];
        this.currentOutputDir = null;

        // 调用父类的通用重置逻辑
        super.resetState();

        this.logger.info('WoS 作者爬虫状态已重置');
    }

    async login() {
        this.logger.info('正在准备 WoS 作者登录');
        // 每次登录前从配置刷新凭证（上次手动登录可能已写入）
        this._reloadCredentialsFromConfig();

        // 若浏览器会话仍有效，直接进入搜索页，无需弹窗
        try {
            await this.page.goto(this.searchConfig.TARGET_URL, {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });
            if (await this._isOnAuthorSearchReady()) {
                this.logger.info('检测到有效登录会话，跳过登录与弹窗');
                await this._closeCookiePopup();
                await this._handlePostLoginInterventions();
                return;
            }
        } catch (e) {
            this.logger.info(`会话预检未通过，进入登录流程: ${e.message}`);
        }

        this.logger.info('正在访问 WoS 登录页面');
        await this.page.goto(this.searchConfig.LOGIN_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 120000
        });
        // 等待登录表单加载
        await this.page.waitForSelector('input[formcontrolname="email"]', {timeout: 15000});
        await this.page.waitForSelector('input[formcontrolname="password"]', {timeout: 15000});

        if (this.page.isClosed()) {
            throw new Error('浏览器窗口已关闭');
        }
        // 检查是否有有效凭证：有则静默自动登录，不再弹窗
        if (this.credentials.email && this.credentials.password) {
            this.logger.info(
                `使用当前终端(${this.terminalId || '未知'})已保存的 WoS 账密自动登录（不弹窗）`
            );
            await this._autoLogin();
            this._persistCredentialsIfNeeded();
        } else {
            this.logger.warn('当前终端无已保存的 WoS 账密，请手动完成登录（成功后按终端保存）');
            await this._manualLogin();
        }

        // 导航到作者搜索页
        if (!this._isAuthenticatedWosUrl(this.page.url())) {
            this.logger.info('导航到作者搜索页...');
            await this.page.goto(this.searchConfig.TARGET_URL, {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });
        }
        if (!(await this._isOnAuthorSearchReady())) {
            throw new Error('登录后未能进入作者搜索页，请确认账号已登录成功');
        }
        await this._closeCookiePopup();
        await this.safeDelay(5000, 7000);
        this.logger.info('已成功到达作者搜索页面');
        await this._closeCookiePopup();
        // 处理登录后的弹窗和验证
        await this._handlePostLoginInterventions();
    }

    /**
     * 按当前终端加载 WoS 作者凭证（兼容旧版按用户库 / config.json 全局账密并迁移）
     */
    _reloadCredentialsFromConfig() {
        try {
            if (this.terminalId) {
                const stored = getWosAuthorCredentials(this.terminalId);
                if (stored?.email && stored?.password) {
                    this.credentials = {
                        email: stored.email,
                        password: stored.password
                    };
                    return;
                }
            }

            // 兼容：旧版按 App 用户存储 → 迁移到当前终端
            const legacy = loadLegacyUserCredentials();
            if (legacy?.email && legacy?.password) {
                this.credentials = { email: legacy.email, password: legacy.password };
                if (this.terminalId) {
                    try {
                        saveWosAuthorCredentials(this.terminalId, this.credentials);
                        this.logger.info(
                            `已将旧版按用户存储的 WoS 账密迁移到终端「${this.terminalId}」`
                        );
                    } catch (migrateErr) {
                        this.logger.warn(`迁移旧版用户账密失败: ${migrateErr.message}`);
                    }
                }
                return;
            }

            // 兼容旧版：全局 config.json 中的账密，迁移到当前终端后清空全局
            this.configManager.reload();
            const crawlerConfig = this.configManager.getCrawlerConfig('wos-author');
            const email = crawlerConfig.credentials?.email || '';
            const password = crawlerConfig.credentials?.password || '';
            if (email && password) {
                this.credentials = { email, password };
                if (this.terminalId) {
                    try {
                        saveWosAuthorCredentials(this.terminalId, this.credentials);
                        this.configManager.updateCrawlerConfig('wos-author', {
                            credentials: { email: '', password: '' }
                        });
                        this.logger.info(
                            `已将全局 WoS 账密迁移到终端「${this.terminalId}」，并清除 config.json 中的共享凭证`
                        );
                    } catch (migrateErr) {
                        this.logger.warn(`迁移全局账密失败: ${migrateErr.message}`);
                    }
                } else {
                    this.logger.warn('使用旧版全局 WoS 账密（未绑定终端 ID）');
                }
                return;
            }

            this.credentials = { email: '', password: '' };
        } catch (e) {
            this.logger.warn(`读取凭证失败: ${e.message}`);
            this.credentials = { email: '', password: '' };
        }
    }

    /**
     * 将当前内存中的账密按终端 ID 写入本地凭证库
     */
    _persistCredentialsIfNeeded() {
        if (!this.credentials?.email || !this.credentials?.password) return;
        if (!this.terminalId) {
            this.logger.warn('未绑定终端 ID，跳过保存 WoS 账密');
            return;
        }
        try {
            saveWosAuthorCredentials(this.terminalId, {
                email: this.credentials.email,
                password: this.credentials.password
            });
            this.logger.info(
                `WoS 作者账密已保存到终端「${this.terminalId}」，下次将自动登录`
            );
        } catch (e) {
            this.logger.warn(`保存账密失败: ${e.message}`);
        }
    }

    /**
     * 从登录表单抓取用户已输入的邮箱密码
     */
    async _captureCredentialsFromForm() {
        try {
            const email = await this.page.locator('input[formcontrolname="email"]').inputValue().catch(() => '');
            const password = await this.page.locator('input[formcontrolname="password"]').inputValue().catch(() => '');
            if (email && password) {
                this.credentials = { email: email.trim(), password };
                return true;
            }
        } catch (e) {
            // 页面可能已跳转
        }
        return false;
    }

    /**
     * 是否已进入可用的作者搜索页（比单纯 URL 更可靠）
     */
    async _isOnAuthorSearchReady() {
        try {
            const url = this.page.url();
            if (!this._isAuthenticatedWosUrl(url)) return false;
            // 作者搜索页常见输入框
            const searchInput = this.page.locator(
                'input[placeholder*="author" i], input[aria-label*="author" i], input[data-ta="author-search-input"], mat-form-field input'
            ).first();
            const visible = await searchInput.isVisible({ timeout: 5000 }).catch(() => false);
            if (visible) return true;
            // URL 已是 author-search 也视为成功（不同地区 DOM 可能不同）
            return url.toLowerCase().includes('author-search') || url.toLowerCase().includes('/wos/author');
        } catch (e) {
            return false;
        }
    }

    /**
     * 严格判断是否为「已登录后的 WoS」地址（排除注册页）
     */
    _isAuthenticatedWosUrl(url) {
        const u = String(url || '').toLowerCase();
        if (!u) return false;
        // 注册 / 创建账号等
        if (/register|sign[\s_-]*up|create[\s_-]*account|registration|enrol/.test(u)) {
            return false;
        }
        // 仍在 Clarivate 登录入口
        if (u.includes('access.clarivate.com') && u.includes('login')) {
            return false;
        }
        if (u.includes('/login') && !u.includes('webofscience')) {
            return false;
        }
        // 已进入 Web of Science 作者相关站
        if (u.includes('webofscience') && (u.includes('/wos/author') || u.includes('author-search'))) {
            return true;
        }
        if (u.includes('webofscience.clarivate') && !u.includes('login')) {
            return true;
        }
        return false;
    }

    /**
     * 自动登录
     */
    async _autoLogin() {
        const maxRetries = 3;
        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            if (!this.state.isRunning) {
                throw new Error('爬虫已停止，自动登录中断');
            }
            try {
                this.logger.info(`自动登录尝试 ${attempt}/${maxRetries}...`);

                // 等待页面元素稳定加载
                await this.page.waitForSelector('input[formcontrolname="email"]', {
                    timeout: 15000,
                    state: 'visible'
                });
                await this.page.waitForSelector('input[formcontrolname="password"]', {
                    timeout: 15000,
                    state: 'visible'
                });
                await this.page.waitForSelector('#signIn-btn', {
                    timeout: 15000,
                    state: 'visible'
                });

                // 额外延迟确保元素完全稳定
                await this.safeDelay(1000, 1500);

                const emailInput = await this.page.$('input[formcontrolname="email"]');
                const passwordInput = await this.page.$('input[formcontrolname="password"]');
                const loginButton = await this.page.$('#signIn-btn');

                if (!emailInput || !passwordInput || !loginButton) {
                    throw new Error('未找到登录表单元素');
                }

                // 清空并重新填写
                await emailInput.fill('');
                await passwordInput.fill('');
                await this.safeDelay(300, 500);

                await emailInput.fill(this.credentials.email);
                await passwordInput.fill(this.credentials.password);

                // 等待输入完成
                await this.safeDelay(500, 800);

                // 验证输入是否正确
                const emailValue = await emailInput.inputValue();
                const passwordValue = await passwordInput.inputValue();

                if (emailValue !== this.credentials.email) {
                    throw new Error(`邮箱填写失败：期望 "${this.credentials.email}"，实际 "${emailValue}"`);
                }

                this.logger.info('已自动填写邮箱和密码');

                // 点击登录按钮（不使用 waitForNavigation，因为 WoS 是 SPA）
                await humanClick(this.page, loginButton);

                // 等待登录结果（最多等待 30 秒）
                const loginSuccess = await this._waitForLoginResult(30000);

                if (loginSuccess) {
                    this.logger.info('自动登录成功');
                    await this.safeDelay(3000, 5000);
                    return; // 登录成功，退出重试循环
                } else {
                    throw new Error('登录后未检测到页面跳转或状态变化');
                }

            } catch (error) {
                lastError = error;
                this.logger.warn(`自动登录尝试 ${attempt} 失败: ${error.message}`);

                // 如果不是最后一次尝试，等待后重试
                if (attempt < maxRetries) {
                    this.logger.info(`等待 3 秒后重试...`);
                    await this.safeDelay(3000, 3000);
                    if (!this.state.isRunning) break;
                    // 刷新页面，重新开始
                    try {
                        await this.page.reload({waitUntil: 'domcontentloaded', timeout: 30000});
                        await this.safeDelay(2000, 3000);
                    } catch (reloadError) {
                        this.logger.warn(`页面刷新失败: ${reloadError.message}`);
                    }
                }
            }
        }

        // 所有重试都失败
        throw new Error(`自动登录失败（已重试 ${maxRetries} 次）。请验证账号密码是否正确。\n最后错误: ${lastError?.message}`);
    }

    /**
     * 等待登录结果（检测页面跳转或状态变化）
     * @param {number} timeoutMs - 超时时间（毫秒）
     * @returns {Promise<boolean>} - 是否登录成功
     */
    async _waitForLoginResult(timeoutMs = 30000) {
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            try {
                // 先检查页面是否仍然可用
                if (!this.page || this.page.isClosed()) {
                    this.logger.warn('页面已关闭，无法检测登录状态');
                    return false;
                }

                const currentUrl = this.page.url();

                // 严格：必须进入已登录的 WoS 作者站，排除注册页
                if (this._isAuthenticatedWosUrl(currentUrl)) {
                    this.logger.info('检测到页面跳转，登录成功');
                    return true;
                }

                // 只在 URL 仍在登录页时才检查错误提示
                if (currentUrl.includes('login') && !/register|sign[\s_-]*up/.test(currentUrl.toLowerCase())) {
                    try {
                        const content = await this.page.content();
                        if (content.includes('Please try again') ||
                            content.includes('Invalid email/password') ||
                            content.includes('Please enter a password') ||
                            content.includes('Please enter a valid email address')) {
                            this.logger.warn('检测到登录错误提示');
                            return false;
                        }
                    } catch (contentError) {
                        // 如果读取 content 失败（页面正在导航），忽略错误，继续循环
                        if (contentError.message.includes('navigating')) {
                            this.logger.info('页面正在导航，等待完成...');
                            // 短暂延迟后继续检查 URL
                            await this.safeDelay(500, 500);
                            continue;
                        }

                    }
                }

                await this.safeDelay(1000, 1000);
            } catch (error) {
                // 捕获所有意外错误，记录但不中断
                this.logger.warn(`检测登录状态时出错: ${error.message}`);
                await this.safeDelay(1000, 1000);
            }
        }

        this.logger.warn('等待登录结果超时');
        return false;
    }

    /**
     * 手动登录（等待用户操作）；成功后把账密按终端 ID 写入本地凭证库
     */
    async _manualLogin() {
        if (!this.state.isRunning) {
            throw new Error('爬虫已停止，登录中断');
        }
        this.logger.warn('请在浏览器中手动输入账号密码并点击登录（不要只点注册切换）');

        await this._showBrowserForIntervention();
        try {
            this._sendManualLoginNotification().catch(err => {
                this.logger.warn(`发送通知失败: ${err.message}`);
            });
            const startTime = Date.now();
            const timeout = 10 * 60 * 1000; // 10分钟超时

            while (Date.now() - startTime < timeout && this.state.isRunning) {
                if (!this.page || this.page.isClosed()) {
                    throw new Error('浏览器窗口已关闭，登录中断');
                }
                try {
                    // 还在登录页时持续抓取表单账密，跳转后就读不到了
                    const url = this.page.url();
                    if (url.includes('login') || url.includes('access.clarivate.com')) {
                        await this._captureCredentialsFromForm();
                    }

                    if (this._isAuthenticatedWosUrl(url) || await this._isOnAuthorSearchReady()) {
                        // 若跳转前没抓到密码，再试一次（可能还在 SPA 过渡）
                        if (!this.credentials.password) {
                            await this._captureCredentialsFromForm();
                        }
                        this.logger.info('检测到用户已手动登录成功');
                        this._persistCredentialsIfNeeded();
                        return;
                    }

                    // 点到注册页：明确提示，不要当成已登录
                    if (/register|sign[\s_-]*up|create[\s_-]*account|registration/i.test(url)) {
                        this.logger.warn('当前在注册页，请切回登录并完成登录（不会判定为已登录）');
                    }
                } catch (error) {
                    if (this.page && this.page.isClosed()) {
                        throw new Error('浏览器窗口已关闭，登录中断');
                    }
                    this.logger.warn(`获取页面状态失败: ${error.message}`);
                }
                await this.safeDelay(2000, 2000);
            }

            throw new Error('用户手动登录超时（10分钟）');
        } finally {
            await this._hideBrowserAfterIntervention();
        }
    }

    /**
     * 发送手动登录通知到前端
     */
    async _sendManualLoginNotification() {
        const io = require('../infrastructure/socket-io-manager').getIo();
        if (!io) {
            this.logger.warn('Socket.IO 未初始化');
            return;
        }

        // 发送事件到前端，触发弹窗提示
        io.emit('user-intervention-required', {
            id: `manual-login-${Date.now()}`,
            type: 'manual-login',
            source: this.crawlerType,
            data: {
                message: '请在弹出的浏览器窗口中手动登录 WoS 账号',
                instruction: '1. 输入邮箱和密码并点击登录（不要只点注册）\n2. 登录成功后账密会写入配置，下次自动登录且不再弹窗\n3. 爬虫将自动继续'
            }
        });

        this.logger.info('已发送手动登录提示到前端');
    }

    /**
     * 处理登录后的弹窗和验证
     */
    async _handlePostLoginInterventions() {
        this.logger.info('开始处理登录后的弹窗与验证...');
        await this._closeCookiePopup();
        await this._waitForCaptchaClear();
        await this._waitForCrossBorderAcknowledgement();
        this.logger.info('所有弹窗/验证已处理完成');
    }

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

    /**
     * 等待人机验证清除
     */
    async _waitForCaptchaClear(timeoutMs = 600000) {
        const captchaTexts = [
            "There is unusual activity coming from your account or institution",
            "verify you are human",
            "Please verify you are human to proceed",
            "security check",
            "captcha"
        ];
        const startTime = Date.now();
        let notified = false;
        let windowShown = false;

        while (Date.now() - startTime < timeoutMs && this.state.isRunning) {
            const content = await this.page.content();
            const hasCaptcha = captchaTexts.some(text =>
                content.toLowerCase().includes(text.toLowerCase())
            );
            if (hasCaptcha) {
                if (!notified) {
                    notified = true;
                    this.logger.warn('检测到人机验证，请在浏览器中手动完成验证');
                    await this._showBrowserForIntervention();
                    windowShown = true;
                    try {
                        const io = require('../infrastructure/socket-io-manager').getIo();
                        if (io) {
                            io.emit('user-intervention-required', {
                                id: `captcha-manual-${Date.now()}`,
                                type: 'captcha-manual',
                                source: this.crawlerType,
                                data: {
                                    message: '检测到人机验证，请在浏览器中完成验证',
                                    instruction: '完成验证后，爬虫将自动继续'
                                }
                            });
                            this.logger.info('已发送人机验证提示到前端');
                        }
                    } catch (error) {
                        this.logger.warn(`发送干预提示失败: ${error.message}`);
                    }
                }

                await this._closeCookiePopup();
                await this.safeDelay(2000, 2000);
            } else {
                if (notified) {
                    this.logger.info('人机验证已完成，继续执行');
                }
                if (windowShown) {
                    await this._hideBrowserAfterIntervention();
                }
                return;
            }
        }

        if (windowShown) {
            await this._hideBrowserAfterIntervention();
        }
        if (Date.now() - startTime >= timeoutMs) {
            throw new Error('等待人机验证超时（10分钟）');
        }
    }

    /**
     * 等待跨境数据传输确认
     */
    async _waitForCrossBorderAcknowledgement(timeoutMs = 600000) {
        const targetText = "Cross Border Personal Data Transfer Acknowledgement.";
        const startTime = Date.now();
        let autoAttempts = 0;
        const maxAutoAttempts = 5;

        while (Date.now() - startTime < timeoutMs && this.state.isRunning) {
            const content = await this.page.content();
            if (!content.includes(targetText)) {
                return;
            }

            if (autoAttempts < maxAutoAttempts) {
                this.logger.info(`尝试自动处理跨境确认 (${autoAttempts + 1}/${maxAutoAttempts})`);
                try {
                    // 勾选复选框
                    await this.page.evaluate(() => {
                        const checkboxes = document.querySelectorAll('mat-checkbox input[type="checkbox"]');
                        for (let cb of checkboxes) {
                            if (!cb.checked) {
                                cb.checked = true;
                                cb.dispatchEvent(new Event('change', { bubbles: true }));
                                cb.dispatchEvent(new Event('click', { bubbles: true }));
                            }
                        }
                    });
                    // 多次尝试点击确认按钮，直到弹窗消失或达到最大尝试次数
                    let retry = 0;
                    const maxRetry = 3;
                    let clickSuccess = false;
                    while (retry < maxRetry) {
                        // 点击确认按钮
                        await this.page.evaluate(() => {
                            const btn = document.querySelector('#cbdt_confirm');
                            if (btn && !btn.disabled) {
                                btn.click();
                            }
                        });
                        addLog('info', `已通过 JavaScript 点击 Confirm and continue 按钮 (第 ${retry+1} 次)`);

                        // 等待一小段时间让页面处理
                        await this.page.waitForTimeout(2000);

                        // 检查弹窗是否消失
                        const newContent = await this.page.content();
                        if (!newContent.includes(targetText)) {
                            addLog('success', '跨境数据传输确认页面已自动处理完成');
                            clickSuccess = true;
                            break;
                        }
                        retry++;
                    }

                    if (clickSuccess) {
                        return;
                    } else {
                        addLog('warn', '多次点击确认按钮后弹窗仍未消失，可能仍需手动处理');
                    }


                    const newContent = await this.page.content();
                    if (!newContent.includes(targetText)) {
                        this.logger.info('跨境确认已自动处理');
                        return;
                    }
                } catch (err) {
                    this.logger.error(`自动处理跨境确认失败: ${err.message}`);
                }
                autoAttempts++;
                await this.safeDelay(5000, 5000);
            } else {
                this.logger.warn('请手动完成跨境数据传输确认');
                await this._showBrowserForIntervention();
                try {
                    while (Date.now() - startTime < timeoutMs && this.state.isRunning) {
                        const newContent = await this.page.content();
                        if (!newContent.includes(targetText)) {
                            this.logger.info('用户已手动完成跨境确认');
                            return;
                        }
                        await this.safeDelay(5000, 5000);
                    }
                    throw new Error('等待跨境确认超时');
                } finally {
                    await this._hideBrowserAfterIntervention();
                }
            }
        }
    }

    /**
     * 执行搜索
     */
    async search(params) {
        const {keywords: rawInput, options = {}} = params;
        this.logger.info('搜索开始前，检查并处理弹窗...');
        await this._closeCookiePopup();
        await this._waitForCaptchaClear(60000); // 快速检查，60秒超时

        this.logger.info('弹窗处理完成，开始解析作者数据');

        const authors = this._preprocessAuthors(rawInput);

        if (!authors || authors.length === 0) {
            throw new Error('作者列表不能为空');
        }

        this.logger.info(`开始检索，共 ${authors.length} 个作者`);

        const results = [];
        for (let i = 0; i < authors.length; i++) {
            if (this.shouldStop || !this.state.isRunning) {
                this.logger.info('检测到停止信号，终止检索');
                break;
            }

            if (!this.isBrowserAvailable()) {
                this.logger.warn('浏览器不可用，终止检索');
                break;
            }

            const author = authors[i];
            this.logger.info(`准备检索第 ${i + 1} 个作者，检查页面状态...`);
            await this._closeCookiePopup();
            await this.safeDelay(1000, 2000);
            this.updateProgress(
                Math.round((i / authors.length) * 60) + 30,
                `处理第 ${i + 1}/${authors.length} 个作者：${author.familyName} ${author.givenName}`
            );
            // 等待表单加载
            await this.page.waitForSelector('#snSearchType', {timeout: 15000});
            this.logger.info('已找到作者搜索表单 #snSearchType');
            try {
                const result = await this._searchSingleAuthor(author);
                results.push(result);
                this.authorsResultList.push(result);
            } catch (error) {
                if (this.errorHandler.isBrowserClosedError(error)) {
                    this.logger.error('浏览器已关闭，终止任务');
                    throw new Error('浏览器已关闭，终止任务，无法继续检索');
                    break;
                }

                this.logger.error(`作者 "${author.familyName} ${author.givenName}" 检索失败: ${error.message}`);
                this._recordFailedAuthor(author, error.message);
            }

            // 返回搜索页准备下一个
            if (i < authors.length - 1) {
                await this._returnToSearchPage();
                await this.safeDelay(3000, 6000);
            }
        }

        return results;
    }

    /**
     * 预处理作者输入
     */
    _preprocessAuthors(input) {
        if (!Array.isArray(input) || input.length === 0) {
            this.logger.error('输入数据为空');
            return [];
        }

        const firstItem = input[0];

        // 字符串数组
        if (typeof firstItem === 'string') {
            return input.map(name => {
                const parts = name.trim().split(/\s+/);
                if (parts.length === 1) {
                    return {familyName: parts[0], givenName: '', orcid: ''};
                } else if (parts.length === 2) {
                    return {familyName: parts[0], givenName: parts[1], orcid: ''};
                } else {
                    return {
                        familyName: parts[0],
                        givenName: parts.slice(1).join(' '),
                        orcid: ''
                    };
                }
            }).filter(a => a.familyName);
        }

        // 对象数组
        if (typeof firstItem === 'object' && firstItem !== null) {
            return input.map(item => {
                const familyName = item.familyName || item.lastName || '';
                const givenName = item.givenName || item.firstName || '';

                if (familyName && givenName) {
                    return {
                        familyName,
                        givenName,
                        orcid: item.orcid || ''
                    };
                }

                if (item.authorName) {
                    const nameParts = item.authorName.trim().split(/\s+/);
                    return {
                        familyName: nameParts[0],
                        givenName: nameParts.slice(1).join(' '),
                        orcid: item.orcid || ''
                    };
                }

                this.logger.warn(`作者数据格式无效: ${JSON.stringify(item)}`);
                return null;
            }).filter(Boolean);
        }

        this.logger.warn('未知输入类型');
        return [];
    }

    /**
     * 搜索单个作者
     */
    async _searchSingleAuthor(author) {
        this.logger.info(`\n--- 处理作者: ${author.familyName} ${author.givenName} ---`);

        const mode = (author.orcid && author.orcid.trim() !== '') ? 'Author Identifiers' : 'Name Search';
        await this._switchToSearchMode(mode);

        let result;
        if (mode === 'Author Identifiers') {
            result = await this._searchByOrcid(author);
        } else {
            result = await this._searchByName(author);
        }

        return {
            index: author.index,
            familyName: author.familyName,
            givenName: author.givenName,
            hasResults: result.totalResults > 0,
            totalResults: result.totalResults,
            authors: result.authorItems,
            resultPageUrl: this.page.url()
        };
    }

    /**
     * 切换搜索模式
     */
    async _switchToSearchMode(targetMode) {
        await this._waitForCaptchaClear();
        await this.safeDelay(1000, 1000);
        const dropdownButton = await this.page.$('#snSearchType wos-select button');
        if (!dropdownButton) throw new Error('未找到检索方式选择按钮');

        const selectedTextSpan = await dropdownButton.$('span.dropdown-text');
        let currentMode = '';
        if (selectedTextSpan) {
            currentMode = await selectedTextSpan.textContent();
            currentMode = currentMode ? currentMode.trim() : '';
        }

        if (currentMode === targetMode) {
            return;
        }

        this.logger.info(`切换检索模式: ${currentMode} -> ${targetMode}`);
        await humanClick(this.page, dropdownButton);

        let targetOption = null;
        if (targetMode === 'Name Search') {
            targetOption = await this.page.$('div[role="option"][aria-label="Name Search"]');
        } else {
            targetOption = await this.page.$('div[role="option"][aria-label="Author Identifiers"]');
        }

        if (!targetOption) throw new Error(`未找到目标选项: ${targetMode}`);
        await humanClick(this.page, targetOption);
        await this.safeDelay(2000, 2000);
    }

    /**
     * 通过姓名搜索（带重试机制和可靠的下拉框关闭）
     */
    async _searchByName(author) {
        const maxRetries = 3;
        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                this.logger.info(`姓名检索尝试 ${attempt}/${maxRetries}: ${author.familyName}, ${author.givenName}`);

                const lastNameInput = await this.page.$('input[aria-label="Last Name"]');
                const firstNameInput = await this.page.$('input[aria-label="First Name"]');
                const searchButton = await this.page.$('button[data-ta="run-search"]');

                if (!lastNameInput || !firstNameInput || !searchButton) {
                    throw new Error('未找到姓名输入框或搜索按钮');
                }

                // 清空输入框
                await lastNameInput.fill('');
                await firstNameInput.fill('');
                await this.safeDelay(300, 500);

                // 填写姓名
                await humanType(this.page, lastNameInput, author.familyName);
                await humanType(this.page, firstNameInput, author.givenName);

                // 等待输入完成
                await this.safeDelay(500, 800);

                // 多种方案关闭自动补全下拉框（组合使用，确保成功）
                await this._closeAutocompleteDropdown();

                // 关闭 Cookie 弹窗
                await this._closeCookiePopup();

                // 点击搜索按钮
                const clickSuccess = await humanClick(this.page, searchButton);
                if (!clickSuccess) {
                    throw new Error('点击搜索按钮失败');
                }

                // 等待页面响应
                await this.safeDelay(2000, 3000);

                // 检查是否触发了人机验证
                await this._waitForCaptchaClear();

                // 检查是否有服务器错误
                const hasServerError = await this.checkForServerError();
                if (hasServerError) {
                    throw new Error('检测到服务器错误 (Server.unexpectedError)');
                }

                // 等待结果元素出现
                const resultAppeared = await Promise.race([
                    this.page.waitForSelector('h1.search-info-title', {timeout: 30000}).then(() => true).catch(() => false),
                    this.page.waitForSelector('text="Your search found no results"', {timeout: 30000}).then(() => true).catch(() => false),
                    this.page.waitForSelector('h1[data-test="author-name"]', {timeout: 30000}).then(() => true).catch(() => false)
                ]);

                if (!resultAppeared) {
                    throw new Error('等待搜索结果超时');
                }

                await this.safeDelay(3000, 5000);
                return await this._parseSearchResults();

            } catch (error) {
                lastError = error;
                this.logger.warn(`姓名检索尝试 ${attempt} 失败: ${error.message}`);

                // 如果不是最后一次尝试，等待后重试
                if (attempt < maxRetries) {
                    const waitTime = 3000 + Math.random() * 2000; // 3-5秒随机延迟
                    this.logger.info(`等待 ${Math.round(waitTime / 1000)} 秒后重试...`);
                    await this.safeDelay(waitTime, waitTime);

                    // 刷新页面，清除可能的错误状态
                    try {
                        await this.page.reload({waitUntil: 'domcontentloaded', timeout: 30000});
                        await this.safeDelay(2000, 3000);

                        // 重新导航到搜索页
                        await this.page.goto(this.searchConfig.TARGET_URL, {
                            waitUntil: 'domcontentloaded',
                            timeout: 30000
                        });
                        await this.safeDelay(2000, 3000);
                    } catch (reloadError) {
                        this.logger.warn(`页面刷新失败: ${reloadError.message}`);
                    }
                }
            }
        }

        // 所有重试都失败
        throw new Error(`姓名检索失败（已重试 ${maxRetries} 次）。最后错误: ${lastError?.message}`);
    }

    /**
     * 关闭自动补全下拉框（多种方案组合，确保可靠）
     */
    async _closeAutocompleteDropdown() {
        try {
            // 按 ESC 键
            await this.page.keyboard.press('Escape');
            await this.safeDelay(200, 300);

            // 检查下拉框是否仍然存在
            const dropdownExists = await this.page.$('.mat-mdc-autocomplete-panel.mat-mdc-autocomplete-visible');
            if (dropdownExists) {
                this.logger.info('ESC 键未关闭下拉框，尝试方案2...');

                // 点击页面空白区域（body 的左上角）
                try {
                    await this.page.click('body', {position: {x: 10, y: 10}, force: true});
                    await this.safeDelay(200, 300);
                } catch (e) {
                    this.logger.warn('点击 body 失败，尝试方案3...');
                }

                // 再次检查
                const stillExists = await this.page.$('.mat-mdc-autocomplete-panel.mat-mdc-autocomplete-visible');
                if (stillExists) {
                    this.logger.info('下拉框仍然存在，尝试方案3...');

                    // 使用 JavaScript 强制隐藏
                    await this.page.evaluate(() => {
                        const panels = document.querySelectorAll('.mat-mdc-autocomplete-panel');
                        panels.forEach(panel => {
                            panel.style.display = 'none';
                            panel.classList.remove('mat-mdc-autocomplete-visible');
                            panel.classList.add('mat-mdc-autocomplete-hidden');
                        });
                    });
                    await this.safeDelay(200, 300);
                }
            }

            this.logger.info('自动补全下拉框已关闭');
        } catch (error) {
            this.logger.warn(`关闭下拉框时出错: ${error.message}，继续执行`);
        }
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


    /**
     * 通过 ORCID 搜索
     */
    /**
     * 通过 ORCID 搜索（带重试机制）
     */
    async _searchByOrcid(author) {
        const maxRetries = 3;
        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                this.logger.info(`ORCID 检索尝试 ${attempt}/${maxRetries}: ${author.orcid}`);

                const orcidInput = await this.page.$('input[aria-label="Web of Science ResearcherID or ORCID"]');
                const searchButton = await this.page.$('button[data-ta="run-search"]');

                if (!orcidInput || !searchButton) {
                    throw new Error('未找到 ORCID 输入框或搜索按钮');
                }

                // 清空输入框
                await orcidInput.fill('');
                await this.safeDelay(300, 500);

                // 填写 ORCID
                await orcidInput.fill(author.orcid);
                await this.safeDelay(500, 800);

                // 关闭 Cookie 弹窗
                await this._closeCookiePopup();

                // 点击搜索按钮
                const clickSuccess = await humanClick(this.page, searchButton);
                if (!clickSuccess) {
                    throw new Error('点击搜索按钮失败');
                }

                // 等待页面响应
                await this.safeDelay(2000, 3000);

                // 检查是否触发了人机验证
                await this._waitForCaptchaClear();

                // 检查是否有服务器错误
                const hasServerError = await this.checkForServerError();
                if (hasServerError) {
                    throw new Error('检测到服务器错误 (Server.unexpectedError)');
                }

                // 等待结果出现
                const resultAppeared = await Promise.race([
                    this.page.waitForSelector('h1.search-info-title', {timeout: 30000}).then(() => true).catch(() => false),
                    this.page.waitForSelector('text="Your search found no results"', {timeout: 30000}).then(() => true).catch(() => false),
                    this.page.waitForSelector('h1[data-test="author-name"]', {timeout: 30000}).then(() => true).catch(() => false)
                ]);

                if (!resultAppeared) {
                    throw new Error('等待搜索结果超时');
                }

                await this.safeDelay(5000, 5000);
                return await this._parseSearchResults();

            } catch (error) {
                lastError = error;
                this.logger.warn(`ORCID 检索尝试 ${attempt} 失败: ${error.message}`);

                // 如果不是最后一次尝试，等待后重试
                if (attempt < maxRetries) {
                    const waitTime = 3000 + Math.random() * 2000; // 3-5秒随机延迟
                    this.logger.info(`等待 ${Math.round(waitTime / 1000)} 秒后重试...`);
                    await this.safeDelay(waitTime, waitTime);

                    // 刷新页面，清除可能的错误状态
                    try {
                        await this.page.reload({waitUntil: 'domcontentloaded', timeout: 30000});
                        await this.safeDelay(2000, 3000);

                        // 重新导航到搜索页
                        await this.page.goto(this.searchConfig.TARGET_URL, {
                            waitUntil: 'domcontentloaded',
                            timeout: 30000
                        });
                        await this.safeDelay(2000, 3000);
                    } catch (reloadError) {
                        this.logger.warn(`页面刷新失败: ${reloadError.message}`);
                    }
                }
            }
        }

        // 所有重试都失败
        throw new Error(`ORCID 检索失败（已重试 ${maxRetries} 次）。最后错误: ${lastError?.message}`);
    }


    /**
     * 解析搜索结果
     */
    async _parseSearchResults() {
        const hasNoResult = await this.page.$('text="Your search found no results"') !== null;
        const isDetailPage = await this.page.$('h1[data-test="author-name"]') !== null;
        const hasResultsList = await this.page.$('h1.search-info-title') !== null;

        let totalResults = 0;
        let authorItems = [];

        if (hasNoResult) {
            this.logger.warn('检索无结果');
        } else if (isDetailPage) {
            this.logger.info('直接进入作者详情页');
            const detail = await this._extractAuthorDetail();
            if (detail) {
                authorItems = [detail];
                totalResults = 1;
            }
        } else if (hasResultsList) {
            const resultCountSpan = await this.page.$('h1.search-info-title span.brand-blue');
            if (resultCountSpan) {
                const countText = await resultCountSpan.textContent();
                totalResults = parseInt(countText, 10) || 0;
                this.logger.info(`检索到 ${totalResults} 个作者结果`);
            }

            if (totalResults > 0) {
                authorItems = await this._extractAuthorList();

                // 提取前5个作者的详情
                const maxDetails = 5;
                for (let idx = 0; idx < Math.min(authorItems.length, maxDetails); idx++) {
                    if (this.shouldStop) break;

                    const auth = authorItems[idx];
                    if (auth.authorUrl) {
                        this.logger.info(`正在提取第 ${idx + 1} 个作者的详情: ${auth.authorName}`);
                        const detail = await this._extractAuthorDetailFromUrl(auth.authorUrl);
                        if (detail) {
                            auth.orcid = detail.orcid;
                            auth.hIndex = detail.hIndex;
                            if (detail.institution) auth.institution = detail.institution;
                        }
                    }
                    await this.safeDelay(1000, 2000);
                }
            }
        }

        return {totalResults, authorItems};
    }

    /**
     * 提取作者列表
     */
    async _extractAuthorList() {
        const records = await this.page.$$('app-author-summary-record');
        const authorItems = [];

        for (const record of records) {
            const nameLink = await record.$('h3.author-name a');
            let authorName = '';
            let authorUrl = '';

            if (nameLink) {
                authorName = await nameLink.textContent();
                authorName = authorName ? authorName.trim() : '';
                authorUrl = await nameLink.getAttribute('href');
                if (authorUrl && !authorUrl.startsWith('http')) {
                    authorUrl = 'https://webofscience.clarivate.cn' + authorUrl;
                }
            }

            const paragraphs = await record.$$eval('p.font-size-14', ps =>
                ps.map(p => p.textContent.trim())
            );

            let institution = '';
            let location = '';
            let researcherId = '';

            for (const text of paragraphs) {
                if (text.includes('Web of Science ResearcherID')) {
                    const match = text.match(/ResearcherID[:\s]+(\S+)/);
                    if (match) researcherId = match[1];
                } else {
                    if (!institution) institution = text;
                    else if (!location) location = text;
                }
            }

            authorItems.push({
                authorName,
                authorUrl,
                institution,
                location,
                researcherId,
                orcid: '',
                hIndex: ''
            });
        }

        this.logger.info(`成功解析 ${authorItems.length} 个作者条目`);
        return authorItems;
    }

    /**
     * 提取作者详情（当前页面）
     */
    async _extractAuthorDetail() {
        try {
            const authorName = await this.page.$eval('h1[data-test="author-name"]', el => el.textContent.trim());

            // ResearcherID
            let researcherId = '';
            const ridSection = await this.page.$('div[data-test="rid"]');
            if (ridSection) {
                const ridSpan = await ridSection.$('span:has-text("Web of Science ResearcherID") + span');
                if (ridSpan) {
                    researcherId = await ridSpan.textContent();
                    researcherId = researcherId.trim();
                }
            }

            // ORCID
            let orcid = '';
            const orcidLink = await this.page.$('a.wat-other-identifiers-orcid-link');
            if (orcidLink) {
                const href = await orcidLink.getAttribute('href');
                const match = href.match(/orcid\.org\/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/);
                if (match) orcid = match[1];
            }

            // H-Index
            let hIndex = '';
            const hIndexDiv = await this.page.$('.wat-author-metric-inline-block .wat-author-metric');
            if (hIndexDiv) {
                hIndex = await hIndexDiv.textContent();
                hIndex = hIndex.trim();
            }

            // 机构
            let institution = '';
            const orgSection = await this.page.$('app-display-data:has(span:has-text("Organizations")) .author-detail-section-content');
            if (orgSection) {
                const orgSpans = await orgSection.$$eval('span', spans => spans.map(s => s.textContent()));
                institution = orgSpans.join(', ');
            }

            return {
                authorName,
                authorUrl: this.page.url(),
                institution,
                location: '',
                researcherId,
                orcid,
                hIndex
            };
        } catch (error) {
            this.logger.error(`提取作者详情失败: ${error.message}`);
            return null;
        }
    }

    /**
     * 从 URL 提取作者详情
     */
    async _extractAuthorDetailFromUrl(authorUrl) {
        this.logger.info(`正在访问作者详情页: ${authorUrl}`);
        const newPage = await this.page.context().newPage();

        try {
            await newPage.goto(authorUrl, {waitUntil: 'domcontentloaded', timeout: 30000});
            await newPage.waitForSelector('h1[data-test="author-name"]', {timeout: 15000});
            await this.safeDelay(1000, 2000);

            const detail = await this._extractAuthorDetailOnPage(newPage);
            return detail;
        } catch (error) {
            this.logger.error(`访问详情页失败: ${error.message}`);
            return null;
        } finally {
            await newPage.close();
        }
    }

    /**
     * 在指定页面上提取作者详情
     */
    async _extractAuthorDetailOnPage(page) {
        try {
            const authorName = await page.$eval('h1[data-test="author-name"]', el => el.textContent.trim());

            let researcherId = '';
            const ridSection = await page.$('div[data-test="rid"]');
            if (ridSection) {
                const ridSpan = await ridSection.$('span:has-text("Web of Science ResearcherID") + span');
                if (ridSpan) {
                    researcherId = await ridSpan.textContent();
                    researcherId = researcherId.trim();
                }
            }

            let orcid = '';
            const orcidLink = await page.$('a.wat-other-identifiers-orcid-link');
            if (orcidLink) {
                const href = await orcidLink.getAttribute('href');
                const match = href.match(/orcid\.org\/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/);
                if (match) orcid = match[1];
            }

            let hIndex = '';
            const hIndexDiv = await page.$('.wat-author-metric-inline-block .wat-author-metric');
            if (hIndexDiv) {
                hIndex = await hIndexDiv.textContent();
                hIndex = hIndex.trim();
            }

            let institution = '';
            const orgSection = await page.$('app-display-data:has(span:has-text("Organizations")) .author-detail-section-content');
            if (orgSection) {
                const orgSpans = await orgSection.$$eval('span', spans => spans.map(s => s.textContent()));
                institution = orgSpans.join(', ');
            }

            return {
                authorName,
                authorUrl: page.url(),
                institution,
                location: '',
                researcherId,
                orcid,
                hIndex
            };
        } catch (error) {
            this.logger.error(`提取作者详情失败: ${error.message}`);
            return null;
        }
    }

    /**
     * 返回搜索页
     */
    async _returnToSearchPage() {
        this.logger.info('正在返回作者搜索页...');
        await this.page.goto(this.searchConfig.TARGET_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        await this._closeCookiePopup();
        await this.safeDelay(3000, 5000);
        this.logger.info('已返回作者搜索页面');
    }

    /**
     * 提取数据
     */
    async extractData(searchResults) {
        this.logger.info('开始整理提取的数据');

        const successList = this.authorsResultList.filter(item => item.hasResults === true);
        const failedList = this.authorsResultList.filter(item => item.hasResults === false || item.remark);

        return {
            successList: successList,
            failedList: failedList,
            totalCount: this.authorsResultList.length,
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
            resultExcel: path.join(dataDir, `wos_authors_${timestamp}.xlsx`)
        };

        // 导出 Excel
        this.excelExporter.exportWosAuthorResults(
            data.successList,
            filePaths.resultExcel
        );

        return {
            successCount: data.successList.length,
            failedCount: 0,
            outputDir: this.currentOutputDir,
            filePaths
        };
    }

    /**
     * 记录失败的作者
     */
    _recordFailedAuthor(author, reason) {
        this.authorsResultList.push({
            index: author.index,
            familyName: author.familyName,
            givenName: author.givenName,
            hasResults: false,
            totalResults: 0,
            authors: [],
            resultPageUrl: '',
            remark: `检索失败: ${reason}`
        });

        this.logger.info(`记录失败数据: ${reason}`);
    }
}

module.exports = WosAuthorCrawler;
