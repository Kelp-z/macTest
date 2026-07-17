// core/base-crawler.js
const BrowserManager = require('../infrastructure/browser-manager');
const ExcelExporter = require('../infrastructure/excel-exporter');
const ErrorHandler = require('../infrastructure/error-handler');
const Logger = require('../infrastructure/logger');
const ConfigManager  = require('../infrastructure/config-manager.js');
const { createInterventionSession }  = require('../facade/intervention-session.js');
const path = require('path');
const fs = require('fs');
class BaseCrawler {
    constructor(crawlerType) {
        this.crawlerType = crawlerType;
        this.configManager = ConfigManager;
        this.logger = new Logger(crawlerType);
        this.browserManager = new BrowserManager();
        this.errorHandler = new ErrorHandler();
        this.excelExporter = new ExcelExporter();

        // 创建独立的干预会话，用于处理人机验证等交互
        this.interventionSession = createInterventionSession(300000);
        this.state = {
            isRunning: false,
            process: 0,
            log: [],
            error: null,
            result: null
        };
        // 任务相关信息
        this.taskId = null;
        this.taskType = null;
    }
    /**
     * 生成任务ID和任务类型
     * @param {Object} options - 选项对象
     * @returns {Object} { taskId, taskType }
     */
    _generateTaskInfo(options = {}) {
        const taskId = options.taskId || `${this.crawlerType}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        const defaultTaskType = `${this.crawlerType.toUpperCase()}_SEARCH`;
        const taskType = options.taskType || defaultTaskType;

        return { taskId, taskType };
    }

    async crawl(params){
        if (this.state.isRunning){
            throw new Error('Crawler is already running');
        }
        this.state.isRunning = true;
        this.state.process = 0;
        this.state.logs = [];
        this.state.error = null;
        // 提取参数
        const { keywords, options = {} } = params;
        this.crawlOptions = options;

        // 生成任务信息（如果外部已提供则使用外部的）
        const { taskId, taskType } = this._generateTaskInfo(options);
        this.taskId = taskId;
        this.taskType = taskType;
        try{
            await this.beforeCrawl();
            await this.initBrowser();


            this.updateProgress(10, '开始登录');
            await this.login();

            this.updateProgress(30, '开始搜索');
            const searchResults = await this.search(params);

            this.updateProgress(70, '提取数据');
            const extractedData = await this.extractData(searchResults);

            this.updateProgress(90, '保存结果');
            const saveResult = await this.saveResults(extractedData);

            this.updateProgress(100, '完成');
            await this.afterCrawl();

            // 保存完整的结果数据
            this.state.result = {
                ...extractedData,
                ...saveResult
            };
            // 检查是否全部失败，如果是则截图
            await this.checkAndScreenshotAllFailed(extractedData);

            return this.state.result;
        }catch(error){
            this.logger.error(`爬虫执行出错: ${error.message}`);
            this.state.error = this.errorHandler.format(error, this.crawlerType, {
                taskId: this.taskId,
                taskType: this.taskType
            });
            await this.takeErrorScreenshot();
            throw this.state.error;
        }finally {
            // 清理会话
            this.interventionSession.cancelSource(this.crawlerType, '爬虫执行结束');
            // keepAlive 时仅缩回后台，不关闭浏览器；停止/重置时再强制关闭
            try {
                this.browserManager.removeBrowserCloseListener(this.browser);
            } catch (e) {}
            await this.cleanup({ force: false });
            this.state.isRunning = false;
        }
    }
    async beforeCrawl(){
        this.logger.info('爬虫开始执行');

        // 确保状态正确初始化
        this.state.isRunning = true;
        this.state.progress = 0;
        this.state.log = [];
        this.state.error = null;
        this.state.result = null;
    }
    async afterCrawl(){
        this.logger.info('爬虫执行完成')
    }

    /**
     * 是否常驻复用浏览器（默认 true）
     */
    _shouldKeepBrowserAlive() {
        try {
            return this.configManager.getBrowserOptions().keepAlive !== false;
        } catch (e) {
            return true;
        }
    }

    /**
     * 当前浏览器实例是否仍可用
     */
    _isBrowserAlive() {
        try {
            if (!this.browser || !this.page) return false;
            if (typeof this.page.isClosed === 'function' && this.page.isClosed()) return false;
            if (typeof this.browser.isConnected === 'function' && !this.browser.isConnected()) return false;
            return true;
        } catch (e) {
            return false;
        }
    }

    _setupBrowserCloseListener() {
        if (!this.browser) return;
        this.browserManager.removeBrowserCloseListener(this.browser);
        this.browserManager.setupBrowserCloseListener(this.browser, (closeInfo) => {
            this.logger.error(`浏览器异常关闭: ${closeInfo.message}`);
            if (!this.state.error) {
                this.state.error = this.errorHandler.format(
                    new Error(closeInfo.message),
                    this.crawlerType
                );
            }
            this.state.isRunning = false;
            if (this.interventionSession) {
                this.interventionSession.cancelSource(this.crawlerType, '浏览器异常关闭');
            }
            this.page = null;
            this.context = null;
            this.browser = null;
        });
    }

    async initBrowser(){
        // 复用已最小化的浏览器，避免每任务开关闪烁
        if (this._isBrowserAlive()) {
            this.logger.info('复用常驻浏览器（保持最小化）');
            await this.browserManager.hideWindow(this.page, this.browser);
            this._setupBrowserCloseListener();
            return;
        }

        this.browser = await this.browserManager.launch(this.configManager.getBrowserOptions());
        const {page,context} = await this.browserManager.createPage(this.browser);
        this.page = page;
        this.context = context;
        // 默认最小化到后台，避免检索时弹出窗口打断用户
        await this.browserManager.applyInitialVisibility(this.page, this.browser);
        this._setupBrowserCloseListener();
    }

    /**
     * 清理浏览器
     * @param {{force?: boolean}} options - force=true 时强制关闭（停止/重置/退出）
     */
    async cleanup(options = {}){
        const force = options.force === true;
        if (!this.browser) return;

        // 先尽量缩回后台
        try {
            if (this.page && !this.page.isClosed()) {
                await this.browserManager.hideWindow(this.page, this.browser);
            }
        } catch (e) {
            // 忽略
        }

        if (this._shouldKeepBrowserAlive() && !force) {
            this.logger.info('keepAlive：浏览器保持最小化，供下一任务复用');
            try {
                this.browserManager.removeBrowserCloseListener(this.browser);
            } catch (e) {}
            return;
        }

        try {
            // 检查浏览器是否还连着
            if (this.browser.isConnected && this.browser.isConnected()) {
                await this.browserManager.close(this.browser);
            } else if (this.browser._persistentContext) {
                await this.browserManager.close(this.browser);
            } else {
                this.logger.info('浏览器已断开，跳过关闭');
            }
        } catch (error) {
            this.logger.warn(`清理浏览器时出错: ${error.message}`);
        } finally {
            // 清空引用，避免后续代码误用
            this.browser = null;
            this.page = null;
            this.context = null;
        }
    }



    updateProgress(progress,message){
        this.state.progress = progress;
        if(message){
            this.logger.info(`进度${progress}%:${message}`);
        }
    }
    addLog(level,message){
        this.state.log.push({
            timestamp:new Date().toISOString(),
            level,
            message
        });
    }

    getState(){
        return{...this.state};
    }

    async stop(){
        this.logger.info('收到停止请求');

        // 先设置运行状态为 false，让正在执行的操作能检测到
        this.state.isRunning = false;

        // 取消所有待处理的干预会话（验证码、手动操作等）
        if (this.interventionSession) {
            this.interventionSession.cancelSource(this.crawlerType, '用户停止爬虫');
        }
        // 停止时强制关闭常驻浏览器（勿先单独关 page，以免残留无页的 context）
        await this.cleanup({ force: true });

        this.logger.info('爬虫已停止');
    }
    /**
     * 重置状态
     */
    resetState(){
        this.logger.info('重置爬虫状态');

        // 取消所有待处理的干预会话
        if (this.interventionSession) {
            this.interventionSession.cancelSource(this.crawlerType, '状态重置');
        }

        // 异步强制关闭常驻浏览器（reset 接口多为同步调用）
        Promise.resolve(this.cleanup({ force: true })).catch((err) => {
            this.logger.warn(`重置时关闭浏览器失败: ${err.message}`);
        });

        // 重置基础状态
        this.state = {
            isRunning: false,
            progress: 0,
            log: [],
            error: null,
            result: null
        };

        this.logger.info('爬虫状态已重置');
    }

    async login(){
        throw new Error('子类必须实现 login 方法');
    }

    async search(params){
        throw new Error('子类必须实现 search 方法');
    }

    async extractData(params){
        throw new Error('子类必须实现 extractData 方法');
    }

    async saveResults(data){
        return data;
    }
    /**
     * 判断是否为浏览器关闭错误
     */
    _isBrowserClosedError(error) {
        return this.errorHandler.isBrowserClosedError(error);
    }

    /**
     * 安全的延迟方法
     * @param {number} min - 最小延迟时间（毫秒）
     * @param {number} max - 最大延迟时间（毫秒）
     */
    async safeDelay(min = 1000, max = 3000) {
        // 检查 page 是否是有效的 Playwright Page 对象
        if (!this.page || typeof this.page.isClosed !== 'function') {
            if (!this._loggedPageClosed) {
                this.logger.warn('页面无效，跳过延迟');
                this._loggedPageClosed = true;
            }
            return;
        }

        if (this.page.isClosed()) {
            if (!this._loggedPageClosed) {
                this.logger.warn('页面已关闭，跳过延迟');
                this._loggedPageClosed = true;
            }
            return;
        }
        this._loggedPageClosed = false;
        const delay = Math.floor(Math.random() * (max - min + 1)) + min;

        try {
            await this.page.waitForTimeout(delay);
        } catch (error) {
            // 如果页面在等待期间被关闭，忽略错误
            if (this._isBrowserClosedError(error)) {
                this.logger.warn('等待期间页面被关闭');
                return;
            }
            throw error;
        }
    }

    /**
     * 检查浏览器状态
     * @returns {boolean} 浏览器是否可用
     */
    isBrowserAvailable() {
        return this.page && !this.page.isClosed() && this.state.isRunning;
    }

    /**
     * 请求用户干预（统一接口）
     * @param {string} type - 干预类型 ('captcha' | 'manual')
     * @param {Object} data - 干预数据
     * @returns {Promise<void>}
     */
    /**
     * 需要在浏览器中操作时临时显示窗口（人机验证 / 登录 / 手动干预）
     */
    async _showBrowserForIntervention() {
        if (this.page && this.browserManager) {
            await this.browserManager.showWindow(this.page, this.browser);
        }
    }

    /**
     * 干预结束后将浏览器重新最小化到后台
     */
    async _hideBrowserAfterIntervention() {
        if (this.page && this.browserManager) {
            await this.browserManager.hideWindow(this.page, this.browser);
        }
    }

    async requestIntervention(type, data = {}) {
        const io = require('../infrastructure/socket-io-manager').getIo();

        if (!io) {
            this.logger.warn('Socket.IO 未初始化，无法发送干预请求');
            return;
        }

        if (type === 'captcha') {
            // 图片验证码：Electron 输入 + 同时弹出浏览器便于手动登录
            await this._showBrowserForIntervention();
            const captchaId = Date.now().toString();
            const promise = this.interventionSession.createCaptchaPromise(this.crawlerType, captchaId);

            io.emit('user-intervention-required', {
                id: captchaId,
                type: 'captcha',
                source: this.crawlerType,
                data
            });

            try {
                const captchaCode = await promise;
                this.logger.info(`用户已输入验证码: ${captchaCode}`);
                return captchaCode;
            } finally {
                // 登录流程若还需继续验证，由上层决定是否再次 show；此处不强制 hide
            }

        } else if (type === 'manual') {
            // 手动操作需在浏览器中完成，临时弹出窗口
            await this._showBrowserForIntervention();
            try {
                const promise = this.interventionSession.createManualPromise(this.crawlerType);

                io.emit('user-intervention-required', {
                    type: 'manual',
                    source: this.crawlerType,
                    data
                });

                await promise;
                this.logger.info('用户已确认手动操作完成');
            } finally {
                await this._hideBrowserAfterIntervention();
            }

        } else {
            throw new Error(`不支持的干预类型: ${type}`);
        }
    }

    /**
     * 提交验证码
     */
    submitCaptcha(captchaId, captchaCode) {
        const result = this.interventionSession.submitCaptcha(this.crawlerType, captchaId, captchaCode);
        if (!result.ok) {
            this.logger.warn(`验证码提交失败: ${result.msg}`);
        }
        return result;
    }

    /**
     * 确认手动操作完成
     */
    confirmManual() {
        const result = this.interventionSession.confirmManual(this.crawlerType);
        if (!result.ok) {
            this.logger.warn(`手动操作确认失败: ${result.msg}`);
        }
        return result;
    }

    /**
     * 取消当前干预会话
     */
    cancelIntervention(reason = '用户停止') {
        this.interventionSession.cancelSource(this.crawlerType, reason);
        this.logger.info(`干预会话已取消: ${reason}`);
    }
    /**
     * 检查是否全部失败，如果是则截图
     * @param {Object} extractedData - 提取的数据
     */
    async checkAndScreenshotAllFailed(extractedData) {
        try {
            if (!extractedData) return;

            // 检查是否有成功列表和失败列表
            const successList = extractedData.successList || [];
            const failedList = extractedData.failedList || [];

            // 如果成功列表为空且失败列表不为空，说明全部失败
            if (successList.length === 0 && failedList.length > 0) {
                this.logger.warn(`所有检索均失败（共${failedList.length}条），正在截取错误现场...`);

                // 创建错误对象并截图
                const allFailedError = new Error(`全部检索失败: 成功0条，失败${failedList.length}条`);
                this.state.error = this.errorHandler.format(allFailedError, this.crawlerType, {
                    taskId: this.taskId,
                    taskType: this.taskType
                });

                await this.takeErrorScreenshot();

                this.logger.info('全部失败截图已完成');
            }
        } catch (error) {
            this.logger.warn(`检查全部失败状态时出错: ${error.message}`);
        }
    }
    /**
     * 截取错误截图并保存到指定目录
     * @returns {Promise<string|null>} 截图路径
     */
    async takeErrorScreenshot(){
        if (!this.page || typeof this.page.isClosed !== 'function' || this.page.isClosed()) {
            this.logger.warn('页面对象无效或已关闭，跳过截图');
            return null;
        }
        // 检查浏览器是否还连接
        if (!this.browser || !this.browser.isConnected || !this.browser.isConnected()) {
            this.logger.warn('浏览器已断开，跳过截图');
            return null;
        }
        try {
            // 获取错误截图目录
            const screenshotDir = this.errorHandler.getErrorScreenshotDir();

            // 生成截图文件名
            const filename = this.errorHandler.generateScreenshotFilename(
                this.crawlerType,
                this.taskType,
                this.taskId
            );

            const filepath = path.join(screenshotDir, filename);
            // 执行截图前再次检查页面状态
            if (this.page.isClosed()) {
                this.logger.warn('截图前页面已关闭，跳过');
                return null;
            }
            // 执行截图
            await this.page.screenshot({ path: filepath, fullPage: true });
            this.logger.info(`[错误截图] 截图已保存: ${filepath}`);

            // 将截图路径附加到错误对象中
            if (this.state.error) {
                this.state.error.screenshotPath = filepath;
            }

            return filepath;
        } catch (error) {
            this.logger.error(`[错误截图] 截图失败: ${error.message}`);
            return null;
        }
    }

}

module.exports = BaseCrawler;
