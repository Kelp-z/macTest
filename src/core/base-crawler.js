// core/base-crawler.js
const BrowserManager = require('../infrastructure/browser-manager');
const ExcelExporter = require('../infrastructure/excel-exporter');
const ErrorHandler = require('../infrastructure/error-handler');
const Logger = require('../infrastructure/logger');
const ConfigManager  = require('../infrastructure/config-manager.js');
const { createInterventionSession }  = require('../facade/intervention-session.js');

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
    }

    async crawl(params){
        if (this.state.isRunning){
            throw new Error('Crawler is already running');
        }
        this.state.isRunning = true;
        this.state.process = 0;
        this.state.logs = [];
        this.state.error = null;
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

            return this.state.result;
        }catch(error){
            this.state.error = this.errorHandler.format(error, this.crawlerType);
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

            this.stop();
            // 设置错误状态
            if (!this.state.error) {
                this.state.error = this.errorHandler.format(
                    new Error(closeInfo.message),
                    this.crawlerType
                );
            }
        });
    }

    async cleanup(){
        if (this.browser){
            await this.browserManager.close(this.browser);
        }
    }

    async takeErrorScreenshot(){
        if (this.page){
            return await this.browserManager.takeScreenshot(this.page,'error');
        }
        return null;
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
        // 检查浏览器是否仍然打开
        if (!this.page || !this.page.context() || this.page.isClosed()) {
            this.logger.warn('页面已关闭，跳过延迟');
            return;
        }

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
}

module.exports = BaseCrawler;
