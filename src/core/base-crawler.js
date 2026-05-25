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
            // 移除浏览器关闭监听器
            this.browserManager.removeBrowserCloseListener(this.browser);
            // 清理会话
            this.interventionSession.cancelSource(this.crawlerType, '爬虫执行结束');
            await this.cleanup();
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

    async initBrowser(){
        this.browser = await this.browserManager.launch(this.configManager.browserOptions);
        const {page,context} = await this.browserManager.createPage(this.browser);
        this.page = page;
        this.context = context;
        //  设置浏览器关闭监听器
        this.browserManager.setupBrowserCloseListener(this.browser, (closeInfo) => {
            this.logger.error(`浏览器异常关闭: ${closeInfo.message}`);


            // 设置错误状态
            if (!this.state.error) {
                this.state.error = this.errorHandler.format(
                    new Error(closeInfo.message),
                    this.crawlerType
                );
            }
            // 只标记停止，不调用 this.stop()
            // this.stop() 会调 cleanup() 导致 browser.close()，但浏览器已经断了
            this.state.isRunning = false;

            // 取消干预会话
            if (this.interventionSession) {
                this.interventionSession.cancelSource(this.crawlerType, '浏览器异常关闭');
            }


            this.page = null;
            this.context = null;
            this.browser = null;
        });
    }

    async cleanup(){
        if (!this.browser) return;

        try {
            // 检查浏览器是否还连着
            if (this.browser.isConnected && this.browser.isConnected()) {
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
        // 强制关闭页面，中断任何正在进行的等待
        if (this.page && !this.page.isClosed()) {
            try {
                await this.page.close();
                this.logger.info('已主动关闭页面，中断等待操作');
            } catch (err) {
                this.logger.warn(`关闭页面时出错: ${err.message}`);
            }
        }
        // 清理浏览器资源
        await this.cleanup();

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
    async requestIntervention(type, data = {}) {
        const io = require('../infrastructure/socket-io-manager').getIo();

        if (!io) {
            this.logger.warn('Socket.IO 未初始化，无法发送干预请求');
            return;
        }

        if (type === 'captcha') {
            // 使用 intervention-session 管理验证码
            const captchaId = Date.now().toString();
            const promise = this.interventionSession.createCaptchaPromise(this.crawlerType, captchaId);

            // 发送事件到前端
            io.emit('user-intervention-required', {
                id: captchaId,
                type: 'captcha',
                source: this.crawlerType,
                data
            });

            // 等待用户输入
            const captchaCode = await promise;
            this.logger.info(`用户已输入验证码: ${captchaCode}`);
            return captchaCode;

        } else if (type === 'manual') {
            // 使用 intervention-session 管理手动操作
            const promise = this.interventionSession.createManualPromise(this.crawlerType);

            // 发送事件到前端
            io.emit('user-intervention-required', {
                type: 'manual',
                source: this.crawlerType,
                data
            });

            // 等待用户确认
            await promise;
            this.logger.info('用户已确认手动操作完成');

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
