// src/crawlers/google-scholar-crawler.js
const BaseCrawler = require('../core/base-crawler');
const fs = require('fs');
const path = require('path');
const { isAnyCaptchaPresent, handleAnyCaptcha,checkGoogleAntiBot } = require('../utils/crawler-utils');
const {humanClick, humanType, randomDelay} = require('../utils/playwright-utils');

/**
 * Google Scholar 爬虫类
 * 继承自 BaseCrawler，实现具体的爬取逻辑
 */
class GoogleScholarCrawler extends BaseCrawler {
    constructor() {
        super('google');

        // 合并配置
        const crawlerConfig = this.configManager.getCrawlerConfig('google');
        this.searchConfig = {
            PRECISE_SEARCH_ENABLED: crawlerConfig.PRECISE_SEARCH_ENABLED ?? true,
            TITLE_SIMILARITY_THRESHOLD: crawlerConfig.TITLE_SIMILARITY_THRESHOLD ?? 0.8,
            // 精确匹配时优先采用 Google 排名第 1 的结果（与手动搜索一致）
            PREFER_FIRST_RESULT: crawlerConfig.PREFER_FIRST_RESULT !== false,
            // 搜索时对标题加引号做短语检索
            QUOTED_TITLE_SEARCH: crawlerConfig.QUOTED_TITLE_SEARCH !== false,
            // 先用请求原文（完整 title/authors）判断第 1 条是否匹配，避免坏关键词误选后面结果
            MATCH_REQUEST_FIRST: crawlerConfig.MATCH_REQUEST_FIRST !== false,
            VISIT_CITATION_ENABLED: crawlerConfig.VISIT_CITATION_ENABLED ?? true,
            MAX_CITATION_PAGES: crawlerConfig.MAX_CITATION_PAGES ?? 2,
            OUTPUT_BASE_DIR_NAME: crawlerConfig.OUTPUT_BASE_DIR_NAME ?? 'output/google',
            PERSIST_PROFILE: crawlerConfig.PERSIST_PROFILE !== false,
            SEARCH_DELAY_MIN_MS: crawlerConfig.SEARCH_DELAY_MIN_MS ?? 5000,
            SEARCH_DELAY_MAX_MS: crawlerConfig.SEARCH_DELAY_MAX_MS ?? 12000
        };

        // 内部状态
        this.successPaperList = [];
        this.failedPaperList = [];
        this.shouldStop = false;
        this.currentOutputDir = null;
        this.fileIndex = 1;
        // 原始论文对象
        this.originalPapers = [];
        // 生成的关键词列表
        this.processedKeywords = [];
    }

    /**
     * 爬取前的准备工作
     */
    async beforeCrawl() {
        await super.beforeCrawl();
        this.logger.info('Google Scholar 爬虫初始化完成');

        this.shouldStop = false;
        this.successPaperList = [];
        this.failedPaperList = [];
        this.fileIndex = 1;
        this.originalPapers = [];
        this.processedKeywords = [];


        // 提前创建输出目录用于存储下载文件
        const timestamp = new Date().toISOString().replace(/[-:\.T]/g, '').slice(0, 15);
        this.currentOutputDir = path.join(
            process.cwd(),
            this.searchConfig.OUTPUT_BASE_DIR_NAME,
            timestamp
        );

        // 确保目录存在
        if (!fs.existsSync(this.currentOutputDir)) {
            fs.mkdirSync(this.currentOutputDir, {recursive: true});
        }

        const dataDir = path.join(this.currentOutputDir, 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, {recursive: true});
        }

        const endNoteDir = path.join(this.currentOutputDir, 'endnote_downloads');
        if (!fs.existsSync(endNoteDir)) {
            fs.mkdirSync(endNoteDir, {recursive: true});
        }

        this.logger.info(`输出目录已创建: ${this.currentOutputDir}`);


    }
    /**
     * 停止爬虫
     */
    async stop() {
        this.logger.info('Google Scholar 爬虫收到停止请求');

        // 设置 Google Scholar 特有的停止标志
        this.shouldStop = true;

        // 调用父类的通用停止逻辑
        await super.stop();

        this.logger.info('Google Scholar 爬虫已停止');
    }

    /**
     * 重置状态
     */
    resetState() {
        this.logger.info('重置 Google Scholar 爬虫状态');

        // 重置 Google Scholar 特有状态
        this.shouldStop = false;
        this.successPaperList = [];
        this.failedPaperList = [];
        this.fileIndex = 1;
        this.originalPapers = [];
        this.processedKeywords = [];
        this.currentOutputDir = null;

        // 调用父类的通用重置逻辑
        super.resetState();

        this.logger.info('Google Scholar 爬虫状态已重置');
    }
    /**
     * 初始化浏览器（走共享 Chromium + 本任务标签页；EndNote 目录仍按任务准备）
     */
    async initBrowser() {
        // 确保 EndNote 下载目录存在
        const endNoteDir = path.join(this.currentOutputDir, 'endnote_downloads');
        if (!fs.existsSync(endNoteDir)) {
            fs.mkdirSync(endNoteDir, {recursive: true});
        }

        await super.initBrowser();
        this.logger.info(`浏览器已初始化（共享模式），EndNote 下载目录: ${endNoteDir}`);
    }


    /**
     * 预处理输入数据，将各种格式转换为统一的关键词数组
     * @param {Array} input - 原始输入数据
     * @returns {Object} { keywords: Array, originalPapers: Array }
     */
    _preprocessInput(input) {
        let keywords = [];
        let originalPapers = [];
        if (!Array.isArray(input) || input.length === 0) {
            this.logger.error('输入数据为空');
            return {keywords, originalPapers};
        }
        const firstItem = input[0];

        if (typeof firstItem === 'object' && firstItem !== null && 'title' in firstItem) {
            this.logger.info('识别为论文对象数组，生成搜索关键词');
            originalPapers = input;

            keywords = input.map(paper => {
                //     优先使用标题字段
                if (paper.title && typeof paper.title === 'string') {
                    return paper.title.trim();
                } else if (paper.keyword && typeof paper.keyword === 'string') {
                    return paper.keyword.trim();
                } else {
                    // 标题加作者，生成一篇论文的完整显示名称，自动处理空值
                    const parts = [paper.title, paper.authors].filter(Boolean);
                    return parts.join(' ').trim() || '未知论文';
                }
            });
            this.logger.info(`已处理${keywords.length}个论文对象`);
        }
        //   字符串关键词数组处理
        else if (typeof firstItem === 'string') {
            this.logger.info('识别为字符串关键词列表');
            keywords = input.map(key => String(key).trim()).filter(Boolean);

            originalPapers = keywords.map(keyword => ({
                title: keyword,
                authors: '',
                abstract: '',
                citations: '',
                year: '',
                publication: '',
                remark: '',
                searchTime: '',
                resultCountFormatted: '',
                endNoteLink: '',
                downloadedFilePath: '',
                citationLink: ''
            }));
        }
        //     处理单个对象的情况
        else if (typeof firstItem === 'object' && firstItem !== null) {
            this.logger.info('识别为单个对象或特殊格式');
            // 尝试提取关键词
            if (firstItem.keywords && Array.isArray(firstItem.keywords)) {
                keywords = firstItem.keywords.map(k => String(k).trim()).filter(Boolean);
                originalPapers = keywords.map(keyword => ({title: keyword}));
            } else if (firstItem.keyword) {
                keywords = [String(firstItem.keyword).trim()];
                originalPapers = [{title: firstItem.keyword}];
            } else {
                this.logger.warn('无法从对象中提取关键词，使用默认值');
                keywords = ['test'];
                originalPapers = [{title: 'test'}];
            }
        } else {
            this.logger.warn('未知输入类型');
            return {keywords, originalPapers};
        }
        //     过滤空关键词
        keywords = keywords.filter(k => k && k.length > 0);
        if (keywords.length === 0) {
            this.logger.warn('处理后无有效关键词');
            return {keywords, originalPapers};
        }
        return {keywords, originalPapers};
    }

    /**
     * 登录（Google Scholar 不需要）
     */
    async login() {
        try {
            await this.page.goto('https://scholar.google.com', {
                timeout: 30000,
                waitUntil: 'domcontentloaded'
            });
            await this._randomDelay(1500, 3500);
            if (await isAnyCaptchaPresent(this.page)) {
                await handleAnyCaptcha(this.page, this._getCaptchaContext());
            }
        }catch (e){
            throw e;
        }
        this.logger.info('Google Scholar 无需登录');
        return Promise.resolve();
    }

    /**
     * 执行搜索
     * @param {Object} params - 搜索参数
     * @param {Array} params.keywords - 关键词列表
     * @param {Object} params.options - 选项
     * @returns {Array} 搜索结果
     */
    async search(params) {
        const {keywords: rawInput, options = {}} = params;

        // 保存 options 供后续使用
        this.currentOptions = options;

        const {keywords, originalPapers} = this._preprocessInput(rawInput);

        // 从 options 中获取任务类型
        this.taskType = options.taskType || 'GOOGLE_SCHOLAR_VERIFICATION';
        this.shouldVisitCitations = (this.taskType === 'GOOGLE_SCHOLAR_REFERENCE');

        this.logger.info(`任务类型: ${this.taskType}`);
        this.logger.info(`是否访问引用链接: ${this.shouldVisitCitations}`);
        this.logger.info(`开始搜索，共 ${keywords.length} 个关键词`);

        this.processedKeywords = keywords;
        this.originalPapers = originalPapers;
        if (!keywords || keywords.length === 0) {
            throw new Error('关键词列表不能为空');
        }

        this.logger.info(`开始搜索，共 ${keywords.length} 个关键词`);

        const results = [];

        for (let i = 0; i < keywords.length; i++) {
            if (this.shouldStop || !this.state.isRunning) {
                this.logger.info('检测到停止信号，终止搜索');
                break;
            }

            const keyword = keywords[i];


            this.updateProgress(
                Math.round((i / keywords.length) * 60) + 30,
                `处理第 ${i + 1}/${keywords.length} 个关键词: ${keyword}`
            );

            try {
                const requestPaper = originalPapers[i] || { title: keyword };
                const result = await this._searchSingleKeyword(keyword, options, requestPaper);
                results.push(result);
            } catch (error) {
                if (error.message === '遭遇谷歌反脚本检测，检索中断') {
                    this.logger.error(error.message);
                    // 记录为失败数据（带特殊标记）
                    const failedPaper = originalPapers[i] || {title: keyword};
                    this._recordFailedPaper(failedPaper, error.message);
                    throw error; // 重新抛出，中断外层循环
                }
                this.logger.error(`关键词 "${keyword}" 搜索失败: ${error.message}`);
                // 记录失败时也要关联原始论文
                const failedPaper = originalPapers[i] || {title: keyword};
                this._recordFailedPaper(failedPaper, error.message);

            }

            // 随机延迟，降低 Google 人机验证频率
            await this._randomDelay(
                this.searchConfig.SEARCH_DELAY_MIN_MS,
                this.searchConfig.SEARCH_DELAY_MAX_MS
            );
        }
        // 如果需要访问引用链接
        if (this.shouldVisitCitations && this.successPaperList.length > 0) {
            this.logger.info('开始访问引用链接...');
            this.updateProgress(70, '访问引用链接');
            try {
                await this._visitCitationLinks();
            } catch (error) {
                this.logger.error(`访问引用链接失败: ${error.message}`);
            }
        }
        return results;
    }


    /**
     * 访问引用链接并抓取引用文章
     */
    async _visitCitationLinks() {
        if (!this.successPaperList || this.successPaperList.length === 0) {
            this.logger.info('没有成功抓取的论文，跳过访问引用链接');
            return;
        }

        this.logger.info(`开始访问 ${this.successPaperList.length} 篇论文的引用链接`);
        const context = this.page.context();
        let visitedCount = 0;
        let failedCount = 0;

        for (let i = 0; i < this.successPaperList.length; i++) {
            if (this.shouldStop || !this.state.isRunning) {
                this.logger.info('检测到停止信号，终止引用链接访问');
                break;
            }

            const paper = this.successPaperList[i];
            const citationLink = paper.citationLink;

            if (!citationLink) {
                this.logger.info(`论文 ${i + 1}: 无引用链接，跳过`);
                continue;
            }

            this.logger.info(`论文 ${i + 1}/${this.successPaperList.length}: 正在访问引用链接`);

            // 为当前引用链接创建专属下载子目录
            const citationDownloadDir = path.join(this.currentOutputDir, 'endnote_downloads', 'citations', `citation_${i}`);
            if (!fs.existsSync(citationDownloadDir)) {
                fs.mkdirSync(citationDownloadDir, {recursive: true});
            }

            let newPage = null;
            const citingPapers = [];

            try {
                newPage = await context.newPage();
                await newPage.goto(citationLink, {timeout: 30000, waitUntil: 'networkidle'})
                    .catch(async (e) => {
                        this.logger.warn(`加载引用页面超时: ${e.message}，继续尝试...`);
                        await newPage.waitForTimeout(5000);
                    });

                // 检查验证码
                // if (await this._checkForHumanCaptchaOnPage(newPage)) {
                //     this.logger.warn(`引用页面检测到人机验证，需要手动处理`);
                //     try {
                //         await this._handleHumanCaptchaManuallyOnPage(newPage);
                //         this.logger.info(`引用页面验证码已解决，继续抓取`);
                //         await newPage.waitForTimeout(3000);
                //     } catch (captchaError) {
                //         this.logger.error(`引用页面验证码处理失败: ${captchaError.message}，跳过该引用链接`);
                //         failedCount++;
                //         continue;
                //     }
                // }
                if (await isAnyCaptchaPresent(newPage)) {
                    this.logger.warn(`引用页面检测到验证，需要手动处理`);

                    try {
                        await handleAnyCaptcha(newPage, this._getCaptchaContext());
                        this.logger.info(`引用页面验证码已解决，继续抓取`);
                        await newPage.waitForTimeout(3000);
                    } catch (captchaError) {
                        this.logger.error(`引用页面验证码处理失败: ${captchaError.message}，跳过该引用链接`);
                        failedCount++;
                        continue;
                    }
                }
                await newPage.waitForTimeout(3000);

                // 分页处理
                let currentPageNum = 1;
                let hasNextPage = true;

                while (hasNextPage && currentPageNum <= this.searchConfig.MAX_CITATION_PAGES) {
                    this.logger.info(`处理引用页面第 ${currentPageNum} 页`);

                    const articleResults = newPage.locator('#gs_res_ccl_mid .gs_r.gs_or.gs_scl');
                    const articleCount = await articleResults.count();
                    this.logger.info(`当前页找到 ${articleCount} 篇文章`);

                    if (articleCount === 0) {
                        this.logger.info('未找到文章列表，可能页面结构变化');
                        break;
                    }

                    // 遍历当前页每篇文章
                    for (let j = 0; j < articleCount; j++) {
                        const article = articleResults.nth(j);
                        try {
                            const title = await this._extractTitle(article);
                            const authors = await this._extractAuthors(article);
                            const publication = await this._extractPublication(article);
                            const year = this._extractYear(publication);
                            const citations = await this._extractCitations(article);
                            const citationLink = await this._extractCitationLinkFromPage(newPage, article);

                            let downloadedFilePath = '';
                            let endNoteLink = '';
                            let parsedEndNote = null;

                            // 如果配置了下载 EndNote，则执行下载
                            if (this.searchConfig.VISIT_CITATION_ENABLED) {
                                this.logger.info(`正在下载引用文章 ${j + 1} 的 EndNote 文件...`);

                                // 在当前页面点击下载
                                const downloadResult = await this._extractAndDownloadEndNoteFileOnPage(newPage, article, citationDownloadDir);

                                if (downloadResult.parsedEndNote) {
                                    downloadedFilePath = downloadResult.downloadedFilePath;
                                    endNoteLink = downloadResult.endNoteLink;
                                    parsedEndNote = downloadResult.parsedEndNote;

                                    this.logger.info(`引用文章 ${j + 1} EndNote 下载并解析成功`);
                                }
                            }

                            // 构建引用文章对象
                            const citingPaper = {
                                sourceArticle: paper.title,
                                title,
                                authors,
                                journal: publication,
                                year,
                                citations,
                                citationLink,
                                doi: parsedEndNote?.doi || '',
                                url: parsedEndNote?.url || '',
                                volume: parsedEndNote?.volume || '',
                                issue: parsedEndNote?.issue || '',
                                pages: parsedEndNote?.pages || '',
                                abstract: parsedEndNote?.abstract || '',
                                publicationType: parsedEndNote?.publicationType || '',
                                publisher: parsedEndNote?.publisher || '',
                                downloadedFilePath,
                                endNoteLink,
                                filePath: parsedEndNote?.filePath || ''
                            };

                            citingPapers.push(citingPaper);
                        } catch (err) {
                            this.logger.warn(`提取第 ${j + 1} 篇引用文章失败: ${err.message}`);
                        }

                        await this._randomDelay(2000, 4000);
                    }

                    this.logger.info(`当前页处理完成: 提取 ${citingPapers.length} 篇引用文章`);

                    // 检查是否有下一页
                    hasNextPage = false;
                    try {
                        const nextPageLink = newPage.locator('a:has-text("下一页")').first();
                        if (await nextPageLink.isVisible()) {
                            const href = await nextPageLink.getAttribute('href');
                            if (href) {
                                const nextUrl = new URL(href, newPage.url()).href;
                                this.logger.info(`找到下一页链接`);
                                await newPage.goto(nextUrl, {timeout: 30000, waitUntil: 'networkidle'})
                                    .catch(async (e) => {
                                        this.logger.warn(`加载下一页超时: ${e.message}`);
                                        await newPage.waitForTimeout(5000);
                                    });

                                if (await isAnyCaptchaPresent(newPage)) {
                                    this.logger.warn(`下一页检测到人机验证，停止翻页`);
                                    break;
                                }


                                await newPage.waitForTimeout(3000);
                                currentPageNum++;
                                hasNextPage = true;
                            }
                        }
                    } catch (e) {
                        this.logger.warn(`检查下一页时出错: ${e.message}，停止翻页`);
                    }
                }

                this.logger.info(`引用链接处理完成: 总共提取 ${citingPapers.length} 个引用文章`);
                visitedCount++;

                // 将引用文章列表附加到原始文章对象
                paper.citingPapers = citingPapers;

            } catch (error) {
                this.logger.error(`访问引用链接失败: ${error.message}`);
                failedCount++;
                paper.citingPapers = [];
            } finally {
                if (newPage) {
                    await newPage.close();
                }
            }

            await this._randomDelay(3000, 6000);
        }

        this.logger.info(`引用链接访问完成: 成功处理 ${visitedCount} 个链接, 失败 ${failedCount} 个链接`);
    }


    /**
     * 检查指定页面的人机验证
     */
    // async _checkForHumanCaptchaOnPage(page) {
    //     const captchaSelectors = [
    //         '#captcha-form',
    //         'form[action*="captcha"]',
    //         '.g-recaptcha',
    //         'iframe[src*="recaptcha"]',
    //         'div:has-text("请进行人机身份验证")',
    //         'div:has-text("unusual traffic")'
    //     ];
    //
    //     for (const selector of captchaSelectors) {
    //         try {
    //             const element = await page.$(selector);
    //             if (element && await element.isVisible()) {
    //                 return true;
    //             }
    //         } catch (error) {
    //             // 忽略错误
    //         }
    //     }
    //
    //     const url = page.url();
    //     if (url.includes('sorry') || url.includes('captcha')) {
    //         return true;
    //     }
    //
    //     return false;
    // }
    /**
     * 检测当前页面是否为验证码页面
     * @param {Page} page - Playwright 页面对象
     * @returns {Promise<boolean>}
     */
    // async  _checkForCaptchaPage(page) {
    //     const url = page.url();
    //     // URL 包含 /sorry/index 直接判定
    //     if (url.includes('/sorry/index')) return true;
    //
    //     // 检查页面文本特征
    //     const bodyText = await page.textContent('body');
    //     return bodyText.includes('请键入下图显示的字符以继续操作');
    // }
    /**
     * 在指定页面上手动处理验证码
     */
    // async _handleHumanCaptchaManuallyOnPage(page) {
    //     this.logger.warn('⚠️ 检测到人机验证，请手动完成');
    //
    //     const screenshotPath = await this.browserManager.takeScreenshot(
    //         page,
    //         'captcha',
    //         path.join(this.currentOutputDir, 'screenshots')
    //     );
    //
    //     // 发送 Socket.IO 事件通知前端
    //     const io = require('../infrastructure/socket-io-manager').getIo();
    //     if (io) {
    //         io.emit('user-intervention-required', {
    //             type: 'captcha-manual',
    //             source: 'google',
    //             data: {
    //                 message: '请在弹出的浏览器窗口中完成人机验证',
    //                 instruction: '验证完成后爬虫将自动继续，请勿关闭浏览器窗口。',
    //                 screenshotPath: screenshotPath ? `/screenshots/${path.basename(screenshotPath)}` : null,
    //                 timestamp: Date.now()
    //             }
    //         });
    //         this.logger.info('已发送人机验证提醒到前端');
    //     }
    //     this.logger.info('请在浏览器窗口中完成验证...');
    //
    //     let waitTime = 0;
    //     const maxWaitTime = 600000; //10分钟超时
    //     const checkInterval = 5000;
    //
    //     while (waitTime < maxWaitTime) {
    //
    //         if (this.shouldStop || !this.state.isRunning) {
    //             throw new Error('用户停止任务');
    //         }
    //         await page.waitForTimeout(checkInterval);
    //         waitTime += checkInterval;
    //
    //         if (!await this._checkForHumanCaptchaOnPage(page)) {
    //             try {
    //                 const searchResults = await page.$('#gs_res_ccl_mid');
    //                 if (searchResults) {
    //                     this.logger.info('验证已完成');
    //                     return;
    //                 }
    //             } catch (error) {
    //                 this.logger.info('页面已恢复正常');
    //                 return;
    //             }
    //         }
    //     }
    //
    //     throw new Error('验证码处理超时');
    // }

    // /**
    //  * 统一检测所有类型的验证码（人机验证 + 传统字符验证码）
    //  * @param {Page} page - 要检测的页面，默认 this.page
    //  * @returns {Promise<boolean>} 是否存在任何验证码
    //  */
    // async isAnyCaptchaPresent(page = null) {
    //     const targetPage = page || this.page;
    //
    //     // 检测传统字符验证码（URL 或页面文本）
    //     const url = targetPage.url();
    //     if (url.includes('/sorry/index')) return true;
    //
    //     try {
    //         const bodyText = await targetPage.textContent('body');
    //         if (bodyText.includes('请键入下图显示的字符以继续操作')) return true;
    //     } catch (e) {}
    //
    //     // 检测人机验证（原有逻辑）
    //     const captchaSelectors = [
    //         '#captcha-form',
    //         'form[action*="captcha"]',
    //         '.g-recaptcha',
    //         'iframe[src*="recaptcha"]',
    //         'div:has-text("请进行人机身份验证")',
    //         'div:has-text("unusual traffic")'
    //     ];
    //     for (const selector of captchaSelectors) {
    //         try {
    //             const element = await targetPage.$(selector);
    //             if (element && await element.isVisible()) return true;
    //         } catch (e) {}
    //     }
    //     return false;
    // }

    /**
     * 统一处理所有验证码（自动判断类型并调用相应处理）
     * @param {Page} page - 需要处理验证码的页面
     * @returns {Promise<void>}
     */
    // async handleAnyCaptcha(page = null) {
    //     const targetPage = page || this.page;
    //
    //     // 先检测传统字符验证码
    //     const url = targetPage.url();
    //     if (url.includes('/sorry/index')) {
    //         await this._handleTraditionalCaptchaOnPage(targetPage);
    //         return;
    //     }
    //
    //     let bodyText = '';
    //     try {
    //         bodyText = await targetPage.textContent('body');
    //     } catch (e) {}
    //     if (bodyText.includes('请键入下图显示的字符以继续操作')) {
    //         await this._handleTraditionalCaptchaOnPage(targetPage);
    //         return;
    //     }
    //
    //     // 否则按人机验证处理
    //     await this._handleCaptchaManuallyOnPage(targetPage);
    // }
    // async _handleTraditionalCaptchaOnPage(page) {
    //     this.logger.warn('⚠️ 检测到字符验证码，等待用户输入');
    //     // 发送前端弹窗，轮询等待验证码消失
    //     const io = require('../infrastructure/socket-io-manager').getIo();
    //     if (io) {
    //         io.emit('user-intervention-required', {
    //             type: 'captcha-manual',
    //             source: 'google',
    //             data: {
    //                 message: '请在浏览器窗口中输入验证码',
    //                 instruction: '请手动输入验证码并提交，完成后爬虫将自动继续',
    //                 timestamp: Date.now()
    //             }
    //         });
    //     }
    //     let waitTime = 0;
    //     const maxWaitTime = 600000;
    //     const checkInterval = 5000;
    //     while (waitTime < maxWaitTime) {
    //         if (this.shouldStop) throw new Error('用户停止任务');
    //         await page.waitForTimeout(checkInterval);
    //         waitTime += checkInterval;
    //         if (!await isAnyCaptchaPresent(page)) {
    //             this.logger.info('✅ 字符验证码已解决');
    //             return;
    //         }
    //     }
    //     throw new Error('字符验证码处理超时');
    // }
    /**
     * 从指定页面提取引用链接
     */
    async _extractCitationLinkFromPage(page, result) {
        try {
            const linkElement = result.locator("a:has-text('被引用次数'), a:has-text('Cited by')").first();
            if (await linkElement.isVisible()) {
                const href = await linkElement.getAttribute('href');
                if (href) {
                    return new URL(href, page.url()).href;
                }
            }
        } catch (e) {
            this.logger.warn(`提取引用链接失败: ${e.message}`);
        }
        return '';
    }

    /**
     * 从引用页面提取引用文章列表
     */
    async _extractCitingPapers(page, sourceTitle) {
        const citingPapers = [];
        try {
            const articleResults = page.locator('#gs_res_ccl_mid .gs_r.gs_or.gs_scl');
            const articleCount = await articleResults.count();
            this.logger.info(`当前页找到 ${articleCount} 篇引用文章`);

            for (let j = 0; j < Math.min(articleCount, 10); j++) {
                const article = articleResults.nth(j);
                try {
                    const title = await this._extractTitle(article);
                    const authors = await this._extractAuthors(article);
                    const publication = await this._extractPublication(article);
                    const year = this._extractYear(publication);
                    const citations = await this._extractCitations(article);

                    citingPapers.push({
                        sourceArticle: sourceTitle,
                        title,
                        authors,
                        journal: publication,
                        year,
                        citations,
                        doi: '',
                        url: ''
                    });
                } catch (err) {
                    this.logger.warn(`提取第 ${j + 1} 篇引用文章失败: ${err.message}`);
                }
            }
        } catch (error) {
            this.logger.error(`提取引用文章列表失败: ${error.message}`);
        }

        return citingPapers;
    }

    /**
     * 在指定页面上下载并解析 EndNote 文件
     * @param {Object} page - Playwright 页面对象
     * @param {Object} article - 文章元素
     * @param {string} downloadDir - 下载目录
     * @returns {Promise<Object>} 包含 endNoteLink, downloadedFilePath, parsedEndNote
     */
    async _extractAndDownloadEndNoteFileOnPage(page, article, downloadDir) {
        let endNoteLink = null;
        let downloadedFilePath = null;
        let parsedEndNote = null;

        try {
            let citeButton = article.locator('.gs_or_cit').first();
            if (!await citeButton.isVisible()) {
                citeButton = article.locator("a[class*='gs_or_cit']").first();
            }

            if (await citeButton.isVisible()) {
                this.logger.info('点击引用按钮...');
                await humanClick(page, citeButton);
                await randomDelay(page);

                // 等待引用弹窗出现
                await page.waitForSelector('#gs_cit', { timeout: 5000 }).catch(() => {
                    this.logger.warn('引用弹窗未出现');
                });

                // 等待 EndNote 链接出现
                await page.waitForSelector("#gs_cit .gs_citi[href*='scholar.enw']", { timeout: 5000 }).catch(() => {
                    this.logger.warn('EndNote 链接未出现');
                });

                const endNoteLinkElement = page.locator("#gs_cit .gs_citi[href*='scholar.enw']").first();
                if (await endNoteLinkElement.isVisible()) {
                    endNoteLink = await endNoteLinkElement.getAttribute('href');
                    this.logger.info(`EndNote链接: ${endNoteLink}`);

                    // 同时等待下载事件和点击操作
                    const [download] = await Promise.all([
                        page.waitForEvent('download', { timeout: 10000 }),
                        humanClick(page, endNoteLinkElement)
                    ]);

                    await randomDelay(page);

                    // 获取下载的文件路径
                    const tempFilePath = await download.path();
                    this.logger.info(`临时文件路径: ${tempFilePath}`);

                    if (tempFilePath && fs.existsSync(tempFilePath)) {
                        const timestamp = Date.now();
                        const targetFileName = `citation_${timestamp}.enw`;
                        downloadedFilePath = path.join(downloadDir, targetFileName);

                        // 复制到目标目录
                        fs.copyFileSync(tempFilePath, downloadedFilePath);
                        this.logger.info(`EndNote文件已保存到: ${downloadedFilePath}`);

                        // 立即解析
                        parsedEndNote = this._parseEndNoteFile(downloadedFilePath);
                    } else {
                        this.logger.error('下载的文件不存在或路径为空');
                    }

                    // 关闭引用弹窗
                    try {
                        const closeButton = page.locator('#gs_cit-x');
                        if (await closeButton.isVisible()) {
                            await humanClick(page, closeButton);
                            await randomDelay(page);
                        }
                    } catch (e) {
                        this.logger.warn(`关闭弹窗失败: ${e.message}`);
                    }
                } else {
                    this.logger.info('未找到 EndNote 下载链接');
                    // 尝试关闭弹窗
                    try {
                        const closeButton = page.locator('#gs_cit-x');
                        if (await closeButton.isVisible()) {
                            await humanClick(page, closeButton);
                        }
                    } catch (e) {
                        // 忽略
                    }
                }
            } else {
                this.logger.info('未找到引用按钮');
            }
        } catch (e) {
            this.logger.error(`下载EndNote失败: ${e.message}`);
            // 尝试关闭弹窗
            try {
                const closeButton = page.locator('#gs_cit-x');
                if (await closeButton.isVisible()) {
                    await humanClick(page, closeButton);
                }
            } catch (closeError) {
                // 忽略
            }
        }

        return { endNoteLink, downloadedFilePath, parsedEndNote };
    }

    /**
     * 构造更接近手动搜索的查询串（默认对标题加引号做短语检索）
     */
    _buildSearchQuery(keyword) {
        const text = String(keyword || '').trim();
        if (!text) return text;

        if (!this.searchConfig.QUOTED_TITLE_SEARCH) return text;
        // 已是引号包裹则不再重复加
        if ((text.startsWith('"') && text.endsWith('"')) ||
            (text.startsWith('“') && text.endsWith('”'))) {
            return text;
        }
        // 去掉内部双引号，避免破坏短语语法
        const escaped = text.replace(/"/g, '');
        return `"${escaped}"`;
    }

    /**
     * 搜索单个关键词
     * @param {string} keyword - 搜索用关键词（可能被切割，仅用于构造查询）
     * @param {Object} options
     * @param {Object} [requestPaper] - 原始请求数据（完整 title/authors，用于匹配裁判）
     */
    async _searchSingleKeyword(keyword, options, requestPaper = null) {
        const searchQuery = this._buildSearchQuery(keyword);
        this.logger.info(`正在搜索: ${searchQuery}`);

        // 已在 Scholar 上时复用页面，减少重复导航触发风控
        const currentUrl = this.page.url();
        const alreadyOnScholar = currentUrl.includes('scholar.google.');
        if (!alreadyOnScholar) {
            await this.page.goto('https://scholar.google.com', {
                timeout: 30000,
                waitUntil: 'domcontentloaded'
            });
            await this._randomDelay(1500, 3000);
        }

        // 检查验证码
        if (await isAnyCaptchaPresent(this.page)) {
            await handleAnyCaptcha(this.page, this._getCaptchaContext());
        }

        // 输入关键词
        const searchInput = this.page.locator('input[name="q"]').first();
        await searchInput.waitFor({state: 'visible', timeout: 10000});
        await humanType(this.page, searchInput, searchQuery);

        await this._randomDelay(1000, 2500);

        // 提交搜索
        await this.page.keyboard.press('Enter');
        await this.page.waitForLoadState('domcontentloaded');
        await this._randomDelay(2000, 4000);

        // 匹配裁判优先用请求原文；关键词仅作查询与兜底
        const extractedData = await this._extractSearchResults(keyword, requestPaper);

        return {
            keyword,
            success: extractedData.success,
            data: extractedData.data
        };
    }

    /**
     * 提取搜索结果
     * @param {string} keyword
     * @param {Object} [requestPaper]
     */
    async _extractSearchResults(keyword, requestPaper = null) {
        try {

            const antiBotCheck = await checkGoogleAntiBot(this.page, this.logger);
            if (antiBotCheck.isBlocked) {
                throw new Error('遭遇谷歌反脚本检测，检索中断');
            }
            // 等待搜索结果加载
            await this._waitForSearchOrCaptcha();
            // 查找结果列表
            const searchResults = this.page.locator('div[data-cid] .gs_ri, .gs_r .gs_ri, .gs_scl .gs_ri');
            const resultCount = await searchResults.count();

            if (resultCount === 0) {
                this.logger.warn(`未找到任何结果: ${keyword}`);
                this._recordFailedPaper(requestPaper || keyword, '未找到搜索结果');
                return {success: false, data: null};
            }

            this.logger.info(`找到 ${resultCount} 个结果`);

            // 根据配置选择精确搜索或泛化搜索
            if (this.searchConfig.PRECISE_SEARCH_ENABLED) {
                return await this._handlePreciseSearch(searchResults, resultCount, keyword, requestPaper);
            } else {
                return await this._handleGeneralSearch(searchResults, resultCount, keyword);
            }
        } catch (error) {
            this.logger.error(`提取搜索结果失败: ${error.message}`);
            this._recordFailedPaper(requestPaper || keyword, `提取结果出错: ${error.message}`);
            return {success: false, data: null};
        }
    }

    /**
     * 精确搜索模式：
     * 1) 先用「请求原文 title/authors」判断 Google 第 1 条是否匹配（避免坏关键词误选后面结果）
     * 2) 第 1 条不匹配时，再退回关键词相似度在前几条中优选
     */
    async _handlePreciseSearch(searchResults, resultCount, keyword, requestPaper = null) {
        const maxCheck = Math.min(resultCount, 5);
        const threshold = this.searchConfig.TITLE_SIMILARITY_THRESHOLD;
        const requestRef = requestPaper || { title: keyword, authors: '' };
        const requestTitle = (requestRef.title || requestRef.keyword || keyword || '').trim();
        const requestAuthors = (requestRef.authors || '').trim();

        const candidates = [];

        for (let i = 0; i < maxCheck; i++) {
            const result = searchResults.nth(i);
            try {
                // 在 _extractTitle 剥除前缀前，检测是否为引用条目
                const rawTitleLocator = result.locator('h3.gs_rt').first();
                const rawTitleText = await rawTitleLocator.textContent().catch(() => '');
                const isCitation = /^\s*\[(citation|引用)\]/i.test(rawTitleText);
                const title = await this._extractTitle(result);
                const authors = await this._extractAuthors(result);
                const requestSimilarity = this._matchAgainstRequest(requestTitle, requestAuthors, title, authors);
                const keywordSimilarity = this._calculateSimilarity(keyword, title, authors);
                candidates.push({
                    index: i,
                    result,
                    title,
                    authors,
                    isCitation,
                    requestSimilarity,
                    keywordSimilarity,
                    // 兼容旧字段名
                    similarity: keywordSimilarity
                });
                this.logger.info(
                    `候选 #${i + 1} 请求匹配=${requestSimilarity.toFixed(3)} ` +
                    `关键词匹配=${keywordSimilarity.toFixed(3)} 标题=${title}`
                );
            } catch (error) {
                this.logger.warn(`检查结果 ${i + 1} 失败: ${error.message}`);
            }
        }

        if (candidates.length === 0) {
            this._recordFailedPaper(requestRef, '精确搜索未找到匹配结果');
            return {success: false, data: null};
        }

        let chosen = candidates[0];
        let chosenBy = 'first';

        // 阶段①：在前几条中按「请求原文匹配度」优选（同分取靠前，尊重 Google 排名），
        //         而不是只看第 1 条，避免"revisited/survey"类标题抢走精确匹配（1.0）的位置
        let useKeywordFallback = false;
        if (this.searchConfig.MATCH_REQUEST_FIRST !== false) {
            const bestByRequest = candidates.reduce(
                (a, b) => (b.requestSimilarity > a.requestSimilarity ? b : a),
                candidates[0]
            );
            if (bestByRequest.requestSimilarity >= threshold) {
                chosen = bestByRequest;
                chosenBy = bestByRequest.index === 0 ? 'request-first' : 'request-best';
                this.logger.info(
                    `前 ${candidates.length} 条中请求匹配最高为第 ${bestByRequest.index + 1} 条` +
                    `（${bestByRequest.requestSimilarity.toFixed(3)} ≥ ${threshold}），采用之`
                );
            } else {
                this.logger.info(
                    `前 ${candidates.length} 条请求匹配均不达标（最高 ${bestByRequest.requestSimilarity.toFixed(3)} < ${threshold}），` +
                    `改用关键词相似度优选`
                );
                useKeywordFallback = true;
            }
        } else {
            useKeywordFallback = true;
        }

        // 阶段②：退回关键词相似度逻辑
        if (useKeywordFallback) {
            const bestByKeyword = candidates.reduce(
                (a, b) => (b.keywordSimilarity > a.keywordSimilarity ? b : a),
                candidates[0]
            );

            if (this.searchConfig.PREFER_FIRST_RESULT) {
                chosen = candidates[0];
                if (chosen.keywordSimilarity >= threshold ||
                    chosen.keywordSimilarity >= bestByKeyword.keywordSimilarity - 0.04) {
                    chosenBy = 'keyword-prefer-first';
                    if (chosen.index !== bestByKeyword.index) {
                        this.logger.info(
                            `关键词模式下保留第 1 条（${chosen.keywordSimilarity.toFixed(3)}），` +
                            `未改用第 ${bestByKeyword.index + 1} 条（${bestByKeyword.keywordSimilarity.toFixed(3)}）`
                        );
                    }
                } else {
                    chosen = bestByKeyword;
                    chosenBy = 'keyword-best';
                    this.logger.info(
                        `关键词模式下第 1 条偏低（${candidates[0].keywordSimilarity.toFixed(3)}），` +
                        `改用第 ${chosen.index + 1} 条（${chosen.keywordSimilarity.toFixed(3)}）`
                    );
                }
            } else {
                chosen = bestByKeyword;
                chosenBy = 'keyword-best';
            }
        }

        // 是否“匹配”以请求原文相似度为准（比关键词更可靠）
        const finalRequestScore = chosen.requestSimilarity != null
            ? chosen.requestSimilarity
            : this._matchAgainstRequest(requestTitle, requestAuthors, chosen.title, chosen.authors);
        const isMatch = finalRequestScore >= threshold || chosen.keywordSimilarity >= threshold;

        this.logger.info(
            `最终选用 #${chosen.index + 1}（策略=${chosenBy}，请求匹配=${finalRequestScore.toFixed(3)}）`
        );

        let bestMatch = await this._extractCompleteResult(
            chosen.result,
            requestTitle || keyword,
            isMatch
        );

        // 引用条目标记：Google Scholar 的 [CITATION] 结果原文链接可能失效
        if (chosen.isCitation) {
            bestMatch.remark += ' [CITATION引用]';
            this.logger.warn(`结果 #${chosen.index + 1} 是引用条目，原文链接可能失效`);
        }

        if (this.searchConfig.VISIT_CITATION_ENABLED) {
            this.logger.info(`正在下载 EndNote 文件（结果 #${chosen.index + 1}）...`);
            const downloadResult = await this._extractAndDownloadEndNoteFile(chosen.result);
            if (downloadResult.parsedEndNote) {
                bestMatch = this._updatePaperWithEndNote(
                    bestMatch,
                    downloadResult.parsedEndNote,
                    downloadResult.downloadedFilePath,
                    downloadResult.endNoteLink
                );
            }
        }

        this.successPaperList.push(bestMatch);
        return {success: true, data: bestMatch};
    }

    /**
     * 泛化搜索模式
     */
    async _handleGeneralSearch(searchResults, resultCount, keyword) {
        const maxResults = Math.min(resultCount, 10);
        let foundMatch = false;

        for (let i = 0; i < maxResults; i++) {
            const result = searchResults.nth(i);

            try {
                let paperInfo = await this._extractCompleteResult(result, keyword, false);

                // 如果配置了下载 EndNote，则执行下载
                if (this.searchConfig.VISIT_CITATION_ENABLED) {
                    this.logger.info(`正在下载结果 ${i + 1} 的 EndNote 文件`);
                    const downloadResult = await this._extractAndDownloadEndNoteFile(result);

                    if (downloadResult.parsedEndNote) {
                        paperInfo = this._updatePaperWithEndNote(
                            paperInfo,
                            downloadResult.parsedEndNote,
                            downloadResult.downloadedFilePath,
                            downloadResult.endNoteLink
                        );
                    }
                }

                this.successPaperList.push(paperInfo);
                foundMatch = true;
            } catch (error) {
                this.logger.warn(`提取结果 ${i + 1} 失败: ${error.message}`);
            }
        }

        return {success: foundMatch, data: this.successPaperList};
    }

    /**
     * 提取完整结果
     */
    async _extractCompleteResult(result, keyword, isMatch) {
        const title = await this._extractTitle(result);
        const authors = await this._extractAuthors(result);
        const publication = await this._extractPublication(result);
        const year = this._extractYear(publication);
        const abstractText = await this._extractAbstract(result);
        const citations = await this._extractCitations(result);
        const citationLink = await this._extractCitationLink(result);

        // 提取论文原文链接（用于后端验证引用条目链接是否有效）
        let paperUrl = '';
        try {
            const linkEl = result.locator('h3.gs_rt a').first();
            if (await linkEl.isVisible({ timeout: 2000 }).catch(() => false)) {
                const href = await linkEl.getAttribute('href');
                if (href && !href.startsWith('javascript:')) paperUrl = href;
            }
        } catch (e) {
            this.logger.debug('提取论文URL失败: ' + e.message);
        }

        const searchTime = new Date().toLocaleString('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        }).replace(/\//g, '-');

        return {
            recordNumber: '',
            title,
            authors,
            journal: publication,
            year,
            volume: '',
            issue: '',
            pages: '',
            abstract: abstractText,
            doi: '',
            url: paperUrl,
            publicationType: 'Unknown',
            publisher: '',
            filePath: '',
            citations,
            citationLink,
            remark: `${keyword} [${isMatch ? '匹配' : '不匹配'}]`,
            searchTime,
            resultCountFormatted: '1',
            endNoteLink: '',
            downloadedFilePath: ''
        };
    }

    /**
     * 关闭引用弹窗
     */
    async _closeCitationPopup() {
        try {
            const closeButton = this.page.locator('#gs_cit-x');
            if (await closeButton.isVisible()) {
                await humanClick(this.page, closeButton);
                await randomDelay(this.page);
                this.logger.info('已关闭引用弹窗');
                await this.page.waitForSelector('#gs_cit', {state: 'hidden', timeout: 3000});
            }
        } catch (e) {
            this.logger.warn(`关闭弹窗失败: ${e.message}`);
        }
    }

    /**
     * 提取数据（后处理）
     */
    async extractData(searchResults) {
        this.logger.info('开始整理提取的数据');

        return {
            successList: this.successPaperList,
            failedList: this.failedPaperList,
            totalCount: this.successPaperList.length + this.failedPaperList.length
        };
    }

    /**
     * 下载并解析 EndNote 文件
     * @param {Object} result - 搜索结果元素
     * @returns {Promise<Object>} 包含 endNoteLink, downloadedFilePath, parsedEndNote
     */
    async _extractAndDownloadEndNoteFile(result) {
        let endNoteLink = null;
        let downloadedFilePath = null;
        let parsedEndNote = null;

        try {
            let citeButton = result.locator('.gs_or_cit').first();
            if (!await citeButton.isVisible()) {
                citeButton = result.locator("a[class*='gs_or_cit']").first();
            }

            if (await citeButton.isVisible()) {
                this.logger.info('点击引用按钮...');
                await humanClick(this.page, citeButton);
                await randomDelay(this.page);
                await this.page.waitForSelector('#gs_cit', {timeout: 5000});
                await this.page.waitForSelector("#gs_cit .gs_citi[href*='scholar.enw']", {timeout: 5000});

                const endNoteLinkElement = this.page.locator("#gs_cit .gs_citi[href*='scholar.enw']").first();
                if (await endNoteLinkElement.isVisible()) {
                    endNoteLink = await endNoteLinkElement.getAttribute('href');
                    this.logger.info(`EndNote链接: ${endNoteLink}`);

                    // 确保下载目录存在
                    const endNoteDir = path.join(this.currentOutputDir, 'endnote_downloads');

                    // 同时等待下载事件和点击操作
                    const [download] = await Promise.all([
                        this.page.waitForEvent('download', {timeout: 10000}),
                        humanClick(this.page, endNoteLinkElement)
                    ]);

                    await randomDelay(this.page);

                    // 获取下载的文件路径（现在应该不为 null）
                    const tempFilePath = await download.path();
                    this.logger.info(`临时文件路径: ${tempFilePath}`);

                    if (tempFilePath && fs.existsSync(tempFilePath)) {
                        const targetFileName = `scholar_${this.fileIndex}.enw`;
                        this.fileIndex++;
                        downloadedFilePath = path.join(endNoteDir, targetFileName);

                        // 复制到目标目录
                        fs.copyFileSync(tempFilePath, downloadedFilePath);
                        this.logger.info(`EndNote文件已保存到: ${downloadedFilePath}`);

                        // 立即解析
                        parsedEndNote = this._parseEndNoteFile(downloadedFilePath);
                    } else {
                        this.logger.error('下载的文件不存在或路径为空');
                    }

                    await this._closeCitationPopup();
                } else {
                    this.logger.info('未找到 EndNote 下载链接');
                    await this._closeCitationPopup();
                }
            } else {
                this.logger.info('未找到引用按钮');
            }
        } catch (e) {
            this.logger.error(`下载EndNote失败: ${e.message}`);
            await this._closeCitationPopup();
        }

        return {endNoteLink, downloadedFilePath, parsedEndNote};
    }

    /**
     * 解析 EndNote 文件
     * @param {string} filePath - EndNote 文件路径
     * @returns {Object} 解析后的数据
     */
    _parseEndNoteFile(filePath) {
        try {
            let content;
            try {
                content = fs.readFileSync(filePath, 'utf8');
            } catch (e) {
                content = fs.readFileSync(filePath, 'latin1');
            }

            const lines = content.split(/\r?\n/);

            const fields = {
                '%T': 'title',
                '%A': 'authors',
                '%J': 'journal',
                '%D': 'year',
                '%V': 'volume',
                '%N': 'issue',
                '%P': 'pages',
                '%X': 'abstract',
                '%R': 'doi',
                '%U': 'url',
                '%TY': 'type',
                '%C': 'city',
                '%I': 'publisher',
                '%KW': 'keywords',
                '%PB': 'publisher',
                '%AU': 'authors',
                '%TI': 'title',
                '%0': 'publicationType',
            };

            const parsedData = {
                recordNumber: '',
                title: '',
                authors: '',
                journal: '',
                year: '',
                volume: '',
                issue: '',
                pages: '',
                abstract: '',
                doi: '',
                url: '',
                publicationType: '',
                publisher: '',
                filePath: filePath
            };

            const authorList = [];

            for (const line of lines) {
                if (!line || line.trim() === '') continue;

                const fieldCode = line.substring(0, 2);
                if (!fields[fieldCode]) continue;

                let value = line.substring(2).trim();
                if (!value) continue;

                switch (fieldCode) {
                    case '%A':
                    case '%AU':
                        authorList.push(value);
                        break;
                    case '%T':
                    case '%TI':
                        parsedData.title = value;
                        break;
                    case '%J':
                        parsedData.journal = value;
                        break;
                    case '%D':
                        const yearMatch = value.match(/\b(19|20)\d{2}\b/);
                        parsedData.year = yearMatch ? yearMatch[0] : value;
                        break;
                    case '%V':
                        parsedData.volume = value;
                        break;
                    case '%N':
                        parsedData.issue = value;
                        break;
                    case '%P':
                        parsedData.pages = value;
                        break;
                    case '%X':
                        parsedData.abstract = value;
                        break;
                    case '%R':
                        parsedData.doi = value;
                        break;
                    case '%U':
                        parsedData.url = value;
                        break;
                    case '%TY':
                    case '%0':
                        parsedData.publicationType = value;
                        break;
                    case '%I':
                    case '%PB':
                        parsedData.publisher = value;
                        break;
                    default:
                        break;
                }
            }

            if (authorList.length > 0) {
                parsedData.authors = authorList.join('; ');
            }

            const fileName = path.basename(filePath);
            const numMatch = fileName.match(/\d+/);
            parsedData.recordNumber = numMatch ? numMatch[0] : '0';

            return {
                recordNumber: parsedData.recordNumber,
                title: parsedData.title || '未找到标题',
                authors: parsedData.authors || '未找到作者',
                journal: parsedData.journal || '未找到期刊',
                year: parsedData.year || '未找到年份',
                volume: parsedData.volume || '无',
                issue: parsedData.issue || '无',
                pages: parsedData.pages || '无',
                abstract: parsedData.abstract || '未找到摘要',
                doi: parsedData.doi || '无',
                url: parsedData.url || '无',
                publicationType: parsedData.publicationType || 'Unknown',
                publisher: parsedData.publisher || '无',
                filePath: parsedData.filePath
            };
        } catch (error) {
            this.logger.error(`解析文件 ${filePath} 失败: ${error.message}`);
            return {
                recordNumber: '0',
                title: `解析失败: ${error.message}`,
                authors: '',
                journal: '',
                year: '',
                volume: '',
                issue: '',
                pages: '',
                abstract: '',
                doi: '',
                url: '',
                publicationType: 'Error',
                publisher: '',
                filePath: filePath
            };
        }
    }

    /**
     * 更新论文信息（使用 EndNote 数据补充）
     * @param {Object} paperInfo - 原始论文信息
     * @param {Object} endNoteData - EndNote 解析数据
     * @param {string} downloadedFilePath - 下载的文件路径
     * @param {string} endNoteLink - EndNote 链接
     * @returns {Object} 更新后的论文信息
     */
    _updatePaperWithEndNote(paperInfo, endNoteData, downloadedFilePath, endNoteLink) {
        if (!endNoteData) return paperInfo;

        return {
            ...paperInfo,
            // 优先使用 EndNote 解析的数据
            authors: endNoteData.authors !== '未找到作者' ? endNoteData.authors : paperInfo.authors,
            journal: endNoteData.journal !== '未找到期刊' ? endNoteData.journal : paperInfo.journal,
            year: endNoteData.year !== '未找到年份' ? endNoteData.year : paperInfo.year,
            volume: endNoteData.volume !== '无' ? endNoteData.volume : paperInfo.volume,
            issue: endNoteData.issue !== '无' ? endNoteData.issue : paperInfo.issue,
            pages: endNoteData.pages !== '无' ? endNoteData.pages : paperInfo.pages,
            abstract: endNoteData.abstract !== '未找到摘要' ? endNoteData.abstract : paperInfo.abstract,
            doi: endNoteData.doi !== '无' ? endNoteData.doi : paperInfo.doi,
            url: endNoteData.url !== '无' ? endNoteData.url : paperInfo.url,
            publicationType: endNoteData.publicationType !== 'Unknown' ? endNoteData.publicationType : paperInfo.publicationType,
            publisher: endNoteData.publisher !== '无' ? endNoteData.publisher : paperInfo.publisher,
            // 保留页面抓取的数据
            citations: paperInfo.citations,
            citationLink: paperInfo.citationLink,
            // 添加 EndNote 相关信息
            downloadedFilePath: downloadedFilePath || '',
            endNoteLink: endNoteLink || '',
            filePath: endNoteData.filePath || ''
        };
    }

    /**
     * 保存结果
     */
    async saveResults(data) {
        this.logger.info('开始保存结果');

        // currentOutputDir 已在 beforeCrawl 中创建
        const timestamp = path.basename(this.currentOutputDir);

        const dataDir = path.join(this.currentOutputDir, 'data');
        const endNoteDir = path.join(this.currentOutputDir, 'endnote_downloads');

        const filePaths = {
            successExcel: path.join(dataDir, `success_${timestamp}.xlsx`),
            failedExcel: path.join(dataDir, `failed_${timestamp}.xlsx`),
            endnoteDir: endNoteDir
        };

        // 导出 Excel
        this.excelExporter.exportGoogleScholarResults(
            data.successList,
            data.failedList,
            filePaths
        );

        return {
            successCount: data.successList.length,
            failedCount: data.failedList.length,
            outputDir: this.currentOutputDir,
            filePaths
        };
    }

    /**
     * 爬取后的清理工作
     */
    async afterCrawl() {
        await super.afterCrawl();
        this.logger.info(`爬取完成，成功: ${this.successPaperList.length}，失败: ${this.failedPaperList.length}`);
    }

    //  辅助方法


    /**
     * 检查验证码
     */
    // async _checkForCaptcha() {
    //     const captchaSelectors = [
    //         '#captcha-form',
    //         'form[action*="captcha"]',
    //         '.g-recaptcha',
    //         'iframe[src*="recaptcha"]',
    //         'div:has-text("请进行人机身份验证")',
    //         'div:has-text("unusual traffic")'
    //     ];
    //
    //     for (const selector of captchaSelectors) {
    //         try {
    //             const element = await this.page.$(selector);
    //             if (element && await element.isVisible()) {
    //                 return true;
    //             }
    //         } catch (error) {
    //             // 忽略错误
    //         }
    //     }
    //
    //     // 检查 URL
    //     const url = this.page.url();
    //     if (url.includes('sorry') || url.includes('captcha')) {
    //         return true;
    //     }
    //
    //     return false;
    // }

    /**
     * 手动处理验证码
     */
    // async _handleCaptchaManually() {
    //     this.logger.warn('⚠️ 检测到人机验证，请手动完成');
    //
    //     // 截图
    //     const screenshotPath = await this.browserManager.takeScreenshot(
    //         this.page,
    //         'captcha',
    //         path.join(this.currentOutputDir || process.cwd(), 'screenshots')
    //     );
    //
    //     // 等待用户手动完成（这里可以集成 intervention-session）
    //     this.logger.info('请在浏览器窗口中完成验证...');
    //
    //     // 轮询检查验证是否完成
    //     let waitTime = 0;
    //     const maxWaitTime = 600000; // 10分钟
    //     const checkInterval = 5000;
    //
    //     while (waitTime < maxWaitTime) {
    //         await this.page.waitForTimeout(checkInterval);
    //         waitTime += checkInterval;
    //
    //         if (!await this._checkForCaptcha()) {
    //             // 检查是否有搜索结果
    //             try {
    //                 const searchResults = await this.page.$('#gs_res_ccl_mid');
    //                 if (searchResults) {
    //                     this.logger.info('✅ 验证已完成');
    //                     return;
    //                 }
    //             } catch (error) {
    //                 this.logger.info('✅ 页面已恢复正常');
    //                 return;
    //             }
    //         }
    //     }
    //
    //     throw new Error('验证码处理超时');
    // }

    /**
     * 等待搜索结果或验证码
     */
    async _waitForSearchOrCaptcha(timeout = 30000) {
        try {
            await this.page.waitForTimeout(3000);
            if (await isAnyCaptchaPresent(this.page)) {
                await handleAnyCaptcha(this.page, this._getCaptchaContext());
            }
            await this.page.waitForSelector('#gs_res_ccl_mid', { timeout });
        } catch (error) {
            if (await isAnyCaptchaPresent(this.page)) {
                await handleAnyCaptcha(this.page, this._getCaptchaContext());
                await this._waitForSearchOrCaptcha(timeout);
            }
        }
    }
    /**
     * 提取标题
     */
    async _extractTitle(result) {
        const selectors = ['h3.gs_rt a', 'h3.gs_rt', '.gs_rt a', '.gs_rt'];

        for (const selector of selectors) {
            try {
                const titleElement = result.locator(selector).first();
                if (await titleElement.isVisible()) {
                    let title = await titleElement.textContent();
                    title = title.replace(/^\[PDF\]\s*/, '')
                        .replace(/^\[HTML\]\s*/, '')
                        .replace(/^\[CITATION\]\s*/i, '')
                        .replace(/^\[引用\]\s*/, '')
                        .trim();
                    if (title) return title;
                }
            } catch (e) {
                // 继续尝试下一个选择器
            }
        }

        return '未找到标题';
    }

    /**
     * 提取作者
     */
    async _extractAuthors(result) {
        try {
            const authorDiv = result.locator('div.gs_a').first();
            if (await authorDiv.isVisible()) {
                const fullText = await authorDiv.textContent();
                if (fullText.includes('-')) {
                    return fullText.split('-')[0].trim();
                }
                return fullText.trim();
            }
        } catch (e) {
            this.logger.warn(`提取作者失败: ${e.message}`);
        }
        return '未找到作者';
    }

    /**
     * 提取出版信息
     */
    async _extractPublication(result) {
        try {
            const authorDiv = result.locator('div.gs_a').first();
            if (await authorDiv.isVisible()) {
                const fullText = await authorDiv.textContent();
                if (fullText.includes('-')) {
                    return fullText.split('-')[1].trim();
                }
                return fullText.trim();
            }
        } catch (e) {
            this.logger.warn(`提取出版信息失败: ${e.message}`);
        }
        return '';
    }

    /**
     * 提取摘要
     */
    async _extractAbstract(result) {
        try {
            const abstractElement = result.locator('div.gs_rs').first();
            if (await abstractElement.isVisible()) {
                const text = await abstractElement.textContent();
                return text.trim() || '未找到摘要';
            }
        } catch (e) {
            this.logger.warn(`提取摘要失败: ${e.message}`);
        }
        return '未找到摘要';
    }

    /**
     * 提取引用数
     */
    async _extractCitations(result) {
        try {
            const citationElement = result.locator("a:has-text('被引用次数'), a:has-text('Cited by')").first();
            if (await citationElement.isVisible()) {
                const text = await citationElement.textContent();
                const match = text.match(/\d+/);
                return match ? match[0] : '0';
            }
        } catch (e) {
            this.logger.warn(`提取引用数失败: ${e.message}`);
        }
        return '0';
    }

    /**
     * 提取引用链接
     */
    async _extractCitationLink(result) {
        try {
            const linkElement = result.locator("a:has-text('被引用次数'), a:has-text('Cited by')").first();
            if (await linkElement.isVisible()) {
                const href = await linkElement.getAttribute('href');
                if (href) {
                    return new URL(href, this.page.url()).href;
                }
            }
        } catch (e) {
            this.logger.warn(`提取引用链接失败: ${e.message}`);
        }
        return '';
    }

    /**
     * 提取年份
     */
    _extractYear(text) {
        const match = text.match(/\b(19|20)\d{2}\b/);
        return match ? match[0] : '';
    }

    /**
     * 归一化标题文本，便于相似度比较
     */
    _normalizeTitleText(text) {
        return String(text || '')
            .toLowerCase()
            .replace(/\u2026/g, ' ')          // …
            .replace(/\.{2,}/g, ' ')          // ...
            .replace(/\[(pdf|html|citation)\]/gi, ' ')
            .replace(/[^\p{L}\p{N}\s]/gu, ' ') // 去掉标点，保留字母数字
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * 用请求原文（完整 title + authors）与搜索结果比对，避免坏关键词误判
     */
    _matchAgainstRequest(requestTitle, requestAuthors, resultTitle, resultAuthors) {
        const titleScore = this._calculateSimilarity(requestTitle, resultTitle, resultAuthors);
        if (!requestAuthors || !resultAuthors) {
            return titleScore;
        }
        const authorScore = this._calculateAuthorOverlap(requestAuthors, resultAuthors);
        // 标题已较好且作者有重叠时略微加分；标题很低时不靠作者硬抬
        if (titleScore >= 0.55 && authorScore >= 0.25) {
            return Math.min(1, titleScore + 0.12 * authorScore);
        }
        return titleScore;
    }

    /**
     * 作者字段粗略重叠度（分号/逗号分隔的姓氏或完整片段）
     */
    _calculateAuthorOverlap(requestAuthors, resultAuthors) {
        const splitAuthors = (text) => String(text || '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s,;.&-]/gu, ' ')
            .split(/[,;&]+|\band\b/i)
            .map(s => s.trim())
            .filter(s => s.length > 1);

        const reqParts = splitAuthors(requestAuthors);
        const resNorm = this._normalizeTitleText(resultAuthors);
        if (reqParts.length === 0 || !resNorm) return 0;

        let hit = 0;
        for (const part of reqParts) {
            const tokens = part.split(/\s+/).filter(t => t.length > 1);
            // 取姓氏倾向：最后一段，或整段
            const key = tokens.length ? tokens[tokens.length - 1] : part;
            if (key && resNorm.includes(key)) hit++;
        }
        return hit / reqParts.length;
    }

    /**
     * 计算标题相似度
     */
    _calculateSimilarity(keyword, title, authors) {
        const keywordNorm = this._normalizeTitleText(keyword);
        const titleNorm = this._normalizeTitleText(title);

        if (!keywordNorm || !titleNorm) return 0;

        // 第一步：过滤停用词（统一数据源，后续所有比较都基于过滤后的词）
        const STOP_WORDS = new Set([
            'the', 'a', 'an', 'of', 'in', 'for', 'and', 'to', 'with', 'on',
            'by', 'from', 'is', 'as', 'at', 'or', 'its', 'their'
        ]);
        const filterWords = (text) => text.split(' ').filter(w => w.length > 1 && !STOP_WORDS.has(w));
        let keywordWords = filterWords(keywordNorm);
        let titleWordsArr = filterWords(titleNorm);
        // 过滤后无有效词时回退到不过滤
        if (keywordWords.length === 0) keywordWords = keywordNorm.split(' ').filter(w => w.length > 1);
        if (titleWordsArr.length === 0) titleWordsArr = titleNorm.split(' ').filter(w => w.length > 1);
        if (keywordWords.length === 0) return 0;

        const titleWords = new Set(titleWordsArr);
        const keywordWordsSet = new Set(keywordWords);

        // 第二步：词级别包含检查（基于过滤后的词数组，而非原始字符串）
        const kwIsSubset = keywordWords.every(w => titleWords.has(w));
        const titleIsSubset = titleWordsArr.every(w => keywordWordsSet.has(w));

        if (kwIsSubset && titleIsSubset) {
            // 词集合完全相同（允许词数不同，如停用词差异）
            return 1.0;
        }
        if (titleIsSubset) {
            // 结果的词全部在关键词中（Scholar截断标题），长度越接近越可信
            return 0.8 + 0.2 * (titleWordsArr.length / keywordWords.length);
        }
        if (kwIsSubset) {
            // 关键词的词全部在结果中（关键词只是标题的一部分）
            return 0.6 + 0.3 * (keywordWords.length / titleWordsArr.length);
        }

        // 第三步：词袋重叠 + Jaccard
        let matchCount = 0;
        for (const word of keywordWords) {
            if (titleWords.has(word)) {
                matchCount++;
            }
        }
        const overlap = matchCount / keywordWords.length;

        // Jaccard 作为补充，避免短标题偶然高分
        const intersection = keywordWords.filter(w => titleWords.has(w)).length;
        const union = new Set([...keywordWords, ...titleWordsArr]).size || 1;
        const jaccard = intersection / union;

        return Math.max(overlap, jaccard);
    }

    /**
     * 记录失败的论文
     */
    _recordFailedPaper(paper, reason) {
        const searchTime = new Date().toLocaleString('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        }).replace(/\//g, '-');
        // 支持传入对象或字符串
        let title, authors, keyword;
        if (typeof paper === 'object' && paper !== null) {
            title = paper.title || '未知标题';
            authors = paper.authors || '';
            keyword = title;
        } else {
            title = String(paper);
            authors = '';
            keyword = title;
        }
        this.failedPaperList.push({
            recordNumber: '',
            title: keyword,
            authors: '',
            journal: '',
            year: '',
            volume: '',
            issue: '',
            pages: '',
            abstract: `检索失败: ${reason}`,
            doi: '',
            url: '',
            publicationType: 'Failed',
            publisher: '',
            filePath: '',
            citations: '0',
            citationLink: '',
            remark: `${keyword} [检索失败: ${reason}]`,
            searchTime,
            resultCountFormatted: '0',
            endNoteLink: '',
            downloadedFilePath: ''
        });

        this.logger.info(`记录失败数据: ${reason}`);
    }

    /**
     * 随机延迟
     */
    async _randomDelay(min = 1000, max = 3000) {
        const delay = Math.floor(Math.random() * (max - min + 1)) + min;
        await this.page.waitForTimeout(delay);
    }
    _getCaptchaContext() {
        return {
            logger: this.logger,
            browserManager: this.browserManager,
            browser: this.browser,
            getCurrentOutputDir: () => this.currentOutputDir,
            shouldStopRef: () => this.shouldStop,
            isRunningRef: () => this.state?.isRunning ?? true
        };
    }

}

module
    .exports = GoogleScholarCrawler;
