// src/crawlers/scopus-crawler.js
const BaseCrawler = require('../core/base-crawler');
const fs = require('fs');
const path = require('path');
const { humanClick, humanType } = require('../utils/playwright-utils');
const { academicCatLogin, academicCatNavigateToTarget } = require('../utils/academic-cat-utils');

/**
 * Scopus 论文爬虫类
 */
class ScopusCrawler extends BaseCrawler {
    constructor() {
        super('scopus');

        const crawlerConfig = this.configManager.getCrawlerConfig('scopus');

        this.searchConfig = {
            BASE_URL: crawlerConfig.BASE_URL || 'https://www.2447.net/',
            OUTPUT_BASE_DIR_NAME: crawlerConfig.OUTPUT_DIR_NAME || 'output/scopus',
            CAPTCHA_DIR_NAME: crawlerConfig.CAPTCHA_DIR_NAME || 'captcha_temp',
            SCREENSHOT_DIR_NAME:crawlerConfig.SCREENSHOT_DIR_NAME || 'screenshot'
        };

        // 登录凭证
        this.credentials = {
            userName: crawlerConfig.USER_NAME || '',
            password: crawlerConfig.PASSWORD || ''
        };

        this.results = [];
        this.shouldStop = false;
        this.currentOutputDir = null;

    }

    async beforeCrawl() {
        await super.beforeCrawl();
        this.logger.info('Scopus 爬虫初始化完成');

        // 重置 Scopus 特有状态
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
     * 登录 Scopus（通过学术猫，支持验证码）
     */
    async login() {
        this.logger.info('正在访问学术猫登录页面');
        await this.page.goto(this.searchConfig.BASE_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 150000
        });

        this.logger.info('学术猫页面已加载');
        //  定义验证码回调（返回 Promise）
        const onCaptchaRequired = async (data) => {
            const { captchaId, imagePath } = data;

            // 转换为可访问的 URL
            const taskId = imagePath.split(path.sep).slice(-2, -1)[0];
            const fileName = path.basename(imagePath);
            const imageUrl = `http://localhost:3000/captcha/${fileName}`;

            this.state.waitingForCaptcha = true;
            this.state.captchaId = captchaId;
            this.state.captchaImagePath = imageUrl;
            this.logger.info(`验证码已生成: ${imageUrl}`);

            //  使用 intervention-session 创建等待 Promise
            const promise = this.interventionSession.createCaptchaPromise(this.crawlerType, captchaId);

            //  发送事件到前端（通过 Socket.IO）
            const io = require('../infrastructure/socket-io-manager').getIo();
            if (io) {
                io.emit('user-intervention-required', {
                    id: captchaId,
                    type: 'captcha',
                    source: this.crawlerType,
                    data: { imageUrl }
                });
            }
            try {
                const captchaCode = await promise;
                // 验证码输入完成，清除等待状态
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

        //  定义手动模式回调
        const onManualModeRequired = async () => {
            this.logger.warn('需要手动干预，请在前端确认');

            //  使用 intervention-session 创建等待 Promise
            const promise = this.interventionSession.createManualPromise(this.crawlerType);

            //  发送事件到前端
            const io = require('../infrastructure/socket-io-manager').getIo();
            if (io) {
                io.emit('user-intervention-required', {
                    type: 'manual',
                    source: this.crawlerType,
                    data: { message: '请在浏览器中完成操作，然后点击确认按钮' }
                });
            }

            //  等待用户确认
            await promise;
            this.logger.info('用户已确认手动操作完成');
        };

        // 使用学术猫登录（支持验证码）
        await academicCatLogin(
            this.page,
            {
                BASE_URL: this.searchConfig.BASE_URL,
                USER_NAME: this.credentials.userName,
                PASSWORD: this.credentials.password,
                CAPTCHA_DIR: path.join(process.cwd(), this.searchConfig.CAPTCHA_DIR_NAME)
            },
            onCaptchaRequired,
            (msg) => this.logger.info(msg),
            (msg)=>this.state.waitingForCaptcha = msg,
            () => this.shouldStop
        );

        if (this.shouldStop) {
            throw new Error('用户停止登录');
        }

        // 导航到 Scopus 页面
        await this._navigateToScopus(onManualModeRequired);
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
     * 导航到 Scopus 页面（使用学术猫工具）
     */
    async _navigateToScopus(onManualModeRequired) {
        this.logger.info('正在导航到 Scopus...');

        // 定义目标信息
        const target = {
            text: 'SCOPUS文摘',
            filterPattern: 'scopus',
            checkReady: this._waitForScopusReady.bind(this)
        };
        const screenshotDir = path.join(process.cwd(), this.searchConfig.SCREENSHOT_DIR_NAME || 'output/screenshots');
        if (!fs.existsSync(screenshotDir)) {
            fs.mkdirSync(screenshotDir, { recursive: true });
        }
        // 使用学术猫导航工具（支持手动干预）
        const scopusPage = await academicCatNavigateToTarget(
            this.page,
            this.context,
            {
                BASE_URL: this.searchConfig.BASE_URL,
                CAPTCHA_DIR: path.join(process.cwd(), this.searchConfig.CAPTCHA_DIR_NAME),
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

        // 更新 page 引用（如果导航打开了新标签页）
        if (scopusPage && scopusPage !== this.page) {
            this.page = scopusPage;
        }

        this.logger.info('已成功到达 Scopus 搜索页面');
    }

    /**
     * 等待 Scopus 页面就绪
     */
    async _waitForScopusReady(page = null,timeout = 30000) {
        if (typeof page === 'number') {
            timeout = page;
            page = null;
        }
        const targetPage = page || this.page;
        const inputSelectors = [
            'label:has(span:text("Search documents")) input.styleguide-input_input__b0U41',
            'label:has-text("Search documents") input[class*="styleguide-input_input"]',
            'input[id^="autosuggest-"][id$="-input"][class*="styleguide-input_input"]',
            'input[placeholder*="Search"]',
            'input[aria-label*="Search"]'
        ];

        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            if (this.shouldStop) {
                this.logger.info('检测到停止信号，退出页面等待');
                return false;
            }

            for (const selector of inputSelectors) {
                try {
                    await targetPage.waitForSelector(selector, {
                        timeout: 10000,
                        state: 'visible'
                    });
                    this.logger.info('检测到 Scopus 搜索输入框');
                    return true;
                } catch (e) {
                    continue;
                }
            }
            await this.safeDelay(2000, 3000);
        }

        throw new Error('等待 Scopus 页面超时，未检测到关键元素');
    }

    /**
     * 执行搜索
     */
    async search(params) {
        const { keywords: rawInput } = params;

        this.logger.info('搜索开始前，检查页面状态...');
        await this.safeDelay(1000, 2000);

        // 预处理关键词
        const keywords = this._preprocessKeywords(rawInput);

        if (!keywords || keywords.length === 0) {
            throw new Error('关键词列表不能为空');
        }

        this.logger.info(`开始检索，共 ${keywords.length} 篇论文`);

        const results = [];
        for (let i = 0; i < keywords.length; i++) {
            if (this.shouldStop || !this.state.isRunning) {
                this.logger.info('检测到停止信号，终止检索');
                break;
            }

            if (!this.isBrowserAvailable()) {
                this.logger.warn('浏览器不可用，终止检索');
                break;
            }

            const keyword = keywords[i];
            this.logger.info(`准备检索第 ${i + 1}/${keywords.length} 篇论文`);

            this.updateProgress(
                Math.round((i / keywords.length) * 100),
                `处理第 ${i + 1}/${keywords.length} 篇论文：${keyword.substring(0, 50)}`
            );

            try {
                const result = await this._searchSinglePaper(keyword);
                results.push(result);

                // 随机延迟（5-8秒）
                if (i < keywords.length - 1) {
                    await this.safeDelay(5000, 8000);
                }
            } catch (error) {
                if (this.errorHandler.isBrowserClosedError(error)) {
                    this.logger.error('浏览器已关闭，终止任务');
                    break;
                }

                this.logger.error(`论文 "${keyword.substring(0, 50)}" 检索失败: ${error.message}`);

                // 记录失败但继续
                results.push({
                    eid: '无',
                    isRecruit: 'false',
                    title: keyword,
                    searchTime: new Date().toISOString(),
                    doi: '',
                    pubDate: '',
                    remark: `检索失败: ${error.message}`
                });
            }
        }

        return results;
    }

    /**
     * 预处理关键词（支持对象数组和字符串数组）
     */
    _preprocessKeywords(input) {
        if (!Array.isArray(input) || input.length === 0) {
            this.logger.error('输入数据为空');
            return [];
        }

        const firstItem = input[0];

        // 对象数组（论文对象）
        if (typeof firstItem === 'object' && firstItem !== null) {
            return input.map(item => {
                // 优先使用 title
                if (item.title) {
                    return item.title;
                }
                // 其次使用 authorName
                if (item.authorName) {
                    return item.authorName;
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
        this.logger.info(`检索论文: ${keyword.substring(0, 50)}...`);

        // 定位输入框
        const inputSelectors = [
            'label:has(span:text("Search documents")) input.styleguide-input_input__b0U41',
            'label:has-text("Search documents") input[class*="styleguide-input_input"]',
            'input[id^="autosuggest-"][id$="-input"][class*="styleguide-input_input"]'
        ];

        let inputElement = null;
        for (const selector of inputSelectors) {
            try {
                inputElement = await this.page.$(selector);
                if (inputElement && await inputElement.isVisible()) {
                    this.logger.info('找到搜索输入框');
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        if (!inputElement) {
            throw new Error('未找到搜索输入框');
        }

        // 清空并输入关键词（加引号）
        await inputElement.fill('');
        await this.safeDelay(300, 500);

        const quotedKeyword = `"${keyword}"`;
        await humanType(this.page, inputElement, quotedKeyword);
        this.logger.info(`输入框已填充: ${quotedKeyword}`);

        // 定位搜索按钮
        const buttonSelectors = [
            'button[type="submit"].Button_button__9XFW1:has-text("Search")',
            'button[type="submit"]:has(span:text("Search"))',
            'button:visible:has-text("Search")'
        ];

        let submitButton = null;
        for (const selector of buttonSelectors) {
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

        // 重试机制：点击搜索按钮（最多3次）
        let clickSuccess = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await humanClick(this.page, submitButton);
                clickSuccess = true;
                this.logger.info(`搜索按钮点击成功（第${attempt}次尝试）`);
                break;
            } catch (e) {
                this.logger.warn(`第${attempt}次点击失败: ${e.message}`);
                if (attempt < 3) {
                    await this.safeDelay(500, 500);
                }
            }
        }

        if (!clickSuccess) {
            throw new Error('多次点击搜索按钮失败');
        }

        // 等待页面响应
        await this.safeDelay(3000, 5000);

        // 判断是否有结果
        const resultStatus = await this._checkSearchResults();

        if (resultStatus === 'keyword-error') {
            this.logger.warn(`关键词错误: ${keyword.substring(0, 50)}`);
            return {
                eid: '无',
                isRecruit: 'false',
                title: keyword,
                searchTime: new Date().toISOString(),
                doi: '',
                pubDate: '',
                remark: '关键词拼写错误'
            };
        }
        if (resultStatus !== 'found') {
            this.logger.warn(`未搜索到结果: ${keyword.substring(0, 50)}`);
            return {
                eid: '无',
                isRecruit: 'false',
                title: keyword,
                searchTime: new Date().toISOString(),
                doi: '',
                pubDate: ''
            };
        }

        // 提取详细信息
        return await this._extractPaperDetails(keyword);
    }

    /**
     * 检查搜索结果
     */
    async _checkSearchResults(keyword) {
        try {
            // 等待页面稳定（结果区域出现）
            await this.safeDelay(2000, 3000);

            // 优先检查“关键词错误”提示
            const hasKeywordError = await this.page.getByText(/One or more keywords were spelled incorrectly/i).isVisible().catch(() => false);
            if (hasKeywordError) {
                this.logger.info('检测到关键词拼写错误提示');
                return 'keyword-error';
            }

            // 检查是否有结果（通过 data-testid 的 header）
            const resultHeader = this.page.locator('h2[data-testid="label-search-results-header"]');
            const isResultHeaderVisible = await resultHeader.isVisible().catch(() => false);
            if (isResultHeaderVisible) {
                const headerText = await resultHeader.textContent();
                // 匹配 "1 document found" 或 "X documents found"
                const match = headerText.match(/(\d+)\s+document/);
                const count = match ? parseInt(match[1], 10) : 0;
                if (count > 0) {
                    this.logger.info(`找到 ${count} 篇文档`);
                    return 'found';
                } else {
                    // header 显示 0 document found（虽然通常不会）
                    return 'not-found';
                }
            }

            // 检查无结果提示（备选，以防 header 未及时出现）
            const noResultSpan = this.page.locator('span[data-testid="no-results-with-suggestion"]');
            const isNoResultVisible = await noResultSpan.isVisible().catch(() => false);
            if (isNoResultVisible) {
                this.logger.info('未检索到任何文档');
                return 'not-found';
            }

            // 检查是否有结果链接（通过标题文本匹配）
            const resultLinks = await this.page.$$('td.TableItems_cellTitle__xuAfQ a');
            if (resultLinks.length > 0) {
                this.logger.info('通过结果链接判断存在结果');
                return 'found';
            }

            // 超时或无法确定状态，按无结果处理
            this.logger.warn('无法确定搜索结果状态，按无结果处理');
            return 'not-found';
        } catch (error) {
            this.logger.warn(`检查结果时出错: ${error.message}`);
            return false;
        }
    }

    /**
     * 提取论文详细信息
     */
    async _extractPaperDetails(keyword) {
        try {
            // 等待包含标题的 span 出现
            const firstResultLink = this.page.locator('td.TableItems_cellTitle__xuAfQ a').first();
            await firstResultLink.waitFor({ state: 'visible', timeout: 15000 });
            await humanClick(this.page, firstResultLink);

            // await this.safeDelay(3000, 5000);
            // // 点击第一个结果
            // const firstResult = await this.page.$('div[data-testid="search-result"] a');
            // if (!firstResult) {
            //     throw new Error('未找到结果链接');
            // }

            // await humanClick(this.page, resultLink);
            await this.safeDelay(3000, 5000);

            // 点击"Show all information"
            const showAllButton = await this.page.$('text=Show all information');
            if (showAllButton) {
                await humanClick(this.page, showAllButton);
                await this.safeDelay(2000, 3000);
            }

            // 提取 EID
            let eid = '';
            try {
                const eidElement = await this.page.$('dd[data-testid="document-info-eid"]');
                if (eidElement) {
                    eid = await eidElement.textContent();
                    eid = eid.trim();
                }
            } catch (e) {
                this.logger.warn(`获取 EID 失败: ${e.message}`);
            }

            // 提取 DOI
            let doi = '';
            try {
                const doiElement = await this.page.$('dd[data-testid="document-info-doi"]');
                if (doiElement) {
                    doi = await doiElement.textContent();
                    doi = doi.trim();
                }
            } catch (e) {
                this.logger.warn(`获取 DOI 失败: ${e.message}`);
            }

            // 提取 Publication date
            let pubDate = '';
            try {
                const dateElement = await this.page.$('dd[data-testid="document-info-publication-date"]');
                if (dateElement) {
                    pubDate = await dateElement.textContent();
                    pubDate = pubDate.trim();
                }
            } catch (e) {
                this.logger.warn(`获取出版日期失败: ${e.message}`);
            }

            this.logger.info(`EID: ${eid}, DOI: ${doi}, Publication date: ${pubDate}`);

            // 返回上一页
            await this.page.goBack();
            await this.safeDelay(2000, 3000);

            return {
                eid: eid || '无',
                isRecruit: eid ? 'true' : 'false',
                title: keyword,
                searchTime: new Date().toISOString(),
                doi: doi,
                pubDate: pubDate
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
                eid: '无',
                isRecruit: 'false',
                title: keyword,
                searchTime: new Date().toISOString(),
                doi: '',
                pubDate: '',
                remark: `提取详情失败: ${error.message}`
            };
        }
    }

    /**
     * 提取数据
     */
    async extractData(searchResults) {
        this.logger.info('开始整理提取的数据');

        const successList = searchResults.filter(r => r.eid !== '无');
        const failedList = searchResults.filter(r => r.eid === '无');

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
            resultExcel: path.join(dataDir, `SCOPUS-${timestamp}.xlsx`)
        };

        // 导出 Excel
        this.excelExporter.exportScopusResults(
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
        this.logger.info('Scopus 爬虫收到停止请求');

        // 设置 Scopus 特有的停止标志
        this.shouldStop = true;

        // 清除 Scopus 特有的验证码状态
        this.state.waitingForCaptcha = false;
        this.state.captchaId = null;
        this.state.captchaImagePath = null;

        // 调用父类的通用停止逻辑
        await super.stop();

        this.logger.info('Scopus 爬虫已停止');
    }

    /**
     * 重置状态
     */
    resetState() {
        this.logger.info('重置爬虫状态');

        // 重置基础状态
        this.state = {
            isRunning: false,
            progress: 0,
            log: [],
            error: null,
            result: null
        };

        // 重置 Scopus 特有状态
        this.shouldStop = false;
        this.results = [];
        this.currentOutputDir = null;
        this.manualModeActive = false;

        // 重置验证码相关状态
        this.state.waitingForCaptcha = false;
        this.state.captchaId = null;
        this.state.captchaImagePath = null;

        // 取消所有待处理的干预会话
        this.interventionSession.cancelSource(this.crawlerType, '状态重置');

        this.logger.info('爬虫状态已重置');
    }



}

module.exports = ScopusCrawler;
