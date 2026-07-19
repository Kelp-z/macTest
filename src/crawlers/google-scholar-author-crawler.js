// src/crawlers/google-scholar-author-crawler.js
const BaseCrawler = require('../core/base-crawler');
const fs = require('fs');
const path = require('path');
const {humanClick, humanType, randomDelay} = require('../utils/playwright-utils');
const { isAnyCaptchaPresent, handleAnyCaptcha } = require('../utils/crawler-utils');
/**
 * Google Scholar 爬虫类
 * 继承自 BaseCrawler，实现具体的爬取逻辑
 */
class GoogleScholarAuthorCrawler extends BaseCrawler {
    constructor() {
        super('google-author');

        const crawlerConfig = this.configManager.getCrawlerConfig('google-author');
        this.searchConfig = {
            OUTPUT_BASE_DIR_NAME: crawlerConfig.OUTPUT_BASE_DIR_NAME ?? 'output/google_authors',
            PERSIST_PROFILE: crawlerConfig.PERSIST_PROFILE !== false,
            SEARCH_DELAY_MIN_MS: crawlerConfig.SEARCH_DELAY_MIN_MS ?? 5000,
            SEARCH_DELAY_MAX_MS: crawlerConfig.SEARCH_DELAY_MAX_MS ?? 12000
        };

        this.authorResultList = [];
        this.shouldStop = false;
        this.currentOutputDir = null;
    }
    /**
     * 爬取前准备
     */
    async beforeCrawl() {
        await super.beforeCrawl();
        this.logger.info('Google Scholar 作者爬虫初始化完成');
        this.shouldStop = false;
        this.authorResultList = [];

        const timestamp = new Date().toISOString().replace(/[-:\.T]/g, '').slice(0, 15);
        this.currentOutputDir = path.join(
            process.cwd(),
            this.searchConfig.OUTPUT_BASE_DIR_NAME,
            timestamp
        );

        if (!fs.existsSync(this.currentOutputDir)) {
            fs.mkdirSync(this.currentOutputDir, { recursive: true });
        }

        const dataDir = path.join(this.currentOutputDir, 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        this.logger.info(`输出目录已创建: ${this.currentOutputDir}`);
    }
    /**
     * 停止爬虫
     */
    async stop() {
        this.logger.info('Google Scholar 作者爬虫收到停止请求');

        // 设置特有的停止标志
        this.shouldStop = true;

        // 调用父类的通用停止逻辑
        await super.stop();

        this.logger.info('Google Scholar 作者爬虫已停止');
    }

    /**
     * 重置状态
     */
    resetState() {
        this.logger.info('重置 Google Scholar 作者爬虫状态');

        // 重置特有状态
        this.shouldStop = false;
        this.authorResultList = [];
        this.currentOutputDir = null;

        // 调用父类的通用重置逻辑
        super.resetState();

        this.logger.info('Google Scholar 作者爬虫状态已重置');
    }
    /**
     * 初始化浏览器（共享 Chromium + 作者检索标签）
     */
    async initBrowser() {
        await super.initBrowser();
        this.logger.info('浏览器已初始化（共享模式）');
    }

    /**
     * 登录（Google Scholar 不需要）
     */
    async login() {
        this.logger.info('Google Scholar 无需登录，跳过');
        return Promise.resolve();
    }
    /**
     * 执行搜索
     * @param {Object} params - 搜索参数
     * @param {Array} params.keywords - 作者姓名列表
     * @returns {Array} 搜索结果
     */
    async search(params) {
        const { keywords: rawInput, options = {} } = params;

        // 预处理输入：支持字符串数组或对象数组
        const authorNames = this._preprocessAuthors(rawInput);

        if (!authorNames || authorNames.length === 0) {
            throw new Error('作者列表不能为空');
        }

        this.logger.info(`开始检索，共 ${authorNames.length} 个作者`);

        for (let i = 0; i < authorNames.length; i++) {
            if (this.shouldStop || !this.state.isRunning) {
                this.logger.info('检测到停止信号，终止检索');
                break;
            }

            const authorName = authorNames[i];

            this.updateProgress(
                Math.round((i / authorNames.length) * 60) + 30,
                `处理第 ${i + 1}/${authorNames.length} 个作者: ${authorName}`
            );

            try {
                await this._processAuthorSearch(authorName);
            } catch (error) {
                this.logger.error(`作者 "${authorName}" 检索失败: ${error.message}`);
                this._recordFailedAuthor(authorName, error.message);
            }

            // 作者之间随机延迟，降低验证频率
            if (i < authorNames.length - 1) {
                await this._randomDelay(
                    this.searchConfig.SEARCH_DELAY_MIN_MS,
                    this.searchConfig.SEARCH_DELAY_MAX_MS
                );
            }
        }

        return this.authorResultList;
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
            return input.map(name => String(name).trim()).filter(Boolean);
        }

        // 对象数组（包含 name 或 authorName 字段）
        if (typeof firstItem === 'object' && firstItem !== null) {
            return input
                .map(item => item.name || item.authorName || '')
                .filter(Boolean)
                .map(name => String(name).trim());
        }

        this.logger.warn('未知输入类型');
        return [];
    }

    /**
     * 处理单个作者的搜索
     */
    async _processAuthorSearch(authorName) {
        const searchKeyword = this._generateAuthorSearchKeyword(authorName);
        this.logger.info(`开始检索作者: ${authorName}，关键词: ${searchKeyword}`);

        // 访问 Google Scholar 首页
        await this.page.goto('https://scholar.google.com', { timeout: 30000 });
        await this._randomDelay();

        // 检查验证码
        if (await isAnyCaptchaPresent(this.page)) {
            await handleAnyCaptcha(this.page, this._getCaptchaContext());
        }

        // 输入搜索词
        const searchInput = this.page.locator('#gs_hdr_tsi');
        await searchInput.waitFor({ state: 'visible', timeout: 10000 });
        await humanType(this.page, searchInput, searchKeyword);
        await this._randomDelay(800, 2000);

        // 提交搜索
        await this.page.keyboard.press('Enter');
        await this.page.waitForLoadState('networkidle');
        await this._randomDelay();

        // 再次检查验证码
        if (await isAnyCaptchaPresent(this.page)) {
            await handleAnyCaptcha(this.page, this._getCaptchaContext());
        }

        // 查找所有作者档案链接
        const allLinks = await this._findAllAuthorProfileLinks();

        if (allLinks.length === 0) {
            this.logger.warn(`未找到作者 ${authorName} 的个人学术档案链接`);
            this._recordFailedAuthor(authorName, '未找到作者档案');
            return;
        }

        this.logger.info(`找到 ${allLinks.length} 个作者档案链接`);

        // 遍历每个链接，处理作者档案
        for (let i = 0; i < allLinks.length; i++) {
            if (this.shouldStop || !this.state.isRunning) {
                this.logger.info('检测到停止信号，终止处理');
                break;
            }

            const linkUrl = allLinks[i];
            this.logger.info(`处理第 ${i + 1}/${allLinks.length} 个作者档案`);

            try {
                const authorInfo = await this._processSingleAuthor(linkUrl, searchKeyword);
                this.authorResultList.push(authorInfo);
                this.logger.info(`作者档案处理完成: ${authorInfo.authorName}`);
            } catch (error) {
                this.logger.error(`处理作者档案失败: ${error.message}`);
            }

            // 作者之间稍作等待
            if (i < allLinks.length - 1) {
                await this._randomDelay(3000, 6000);
            }
        }

        this.logger.info(`关键词 ${authorName} 处理完成，共处理 ${allLinks.length} 个作者`);
    }

    /**
     * 生成作者搜索关键词
     */
    _generateAuthorSearchKeyword(authorName) {
        const cleanAuthor = authorName.replace(/["']/g, '').trim();
        return `author:"${cleanAuthor}"`;
    }

    /**
     * 查找所有作者档案链接
     */
    async _findAllAuthorProfileLinks() {
        try {
            await this.page.waitForSelector('body', { timeout: 10000 });
            await this._randomDelay();

            // 定位作者列表表格
            const authorTable = await this.page.$('div.gs_r table');
            if (!authorTable) {
                this.logger.warn('未找到作者列表表格');
                return [];
            }

            // 查找所有指向作者档案的链接
            const linkElements = await authorTable.$$('a[href*="/citations?user="]');
            const links = [];

            for (const link of linkElements) {
                const href = await link.getAttribute('href');
                if (href) {
                    const fullUrl = href.startsWith('http') ? href : `https://scholar.google.com${href}`;
                    links.push(fullUrl);
                }
            }

            return links;
        } catch (error) {
            this.logger.error(`查找作者档案链接时出错: ${error.message}`);
            return [];
        }
    }

    /**
     * 处理单个作者档案
     */
    async _processSingleAuthor(authorUrl, searchKeyword) {
        this.logger.info(`处理作者档案: ${authorUrl}`);

        // 从 URL 中提取 user ID
        const urlObj = new URL(authorUrl);
        const userIdMatch = urlObj.search.match(/[?&]user=([^&]+)/);
        if (!userIdMatch) {
            throw new Error(`无法从 URL 中提取 user ID: ${authorUrl}`);
        }
        const userId = userIdMatch[1];

        // 在搜索结果页上根据 user ID 定位链接元素
        const link = await this.page.$(`a[href*="/citations?user=${userId}"]`);
        if (!link) {
            throw new Error(`无法在页面上找到 user ID 为 ${userId} 的链接`);
        }

        // 获取 target 属性
        const targetAttr = await link.getAttribute('target');

        let targetPage = this.page;

        if (targetAttr === '_blank') {
            // 新标签页打开
            const [newPage] = await Promise.all([
                this.page.context().waitForEvent('page', { timeout: 10000 }),
                humanClick(this.page, link)
            ]);
            targetPage = newPage;
            await targetPage.waitForLoadState('networkidle');

            // 检查验证码
            if (await isAnyCaptchaPresent(targetPage)) {
                await handleAnyCaptcha(targetPage, this._getCaptchaContext());
            }
        } else {
            // 当前页面导航
            await Promise.all([
                this.page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }),
                humanClick(this.page, link)
            ]);
            targetPage = this.page;

            // 检查验证码
            if (await isAnyCaptchaPresent(targetPage)) {
                await handleAnyCaptcha(targetPage, this._getCaptchaContext());
            }
        }

        // 提取作者信息
        const authorInfo = await this._extractAuthorInfoFromProfile(targetPage, authorUrl);

        // 如果是新打开的页面则关闭，并切换回原页面
        if (targetAttr === '_blank') {
            await targetPage.close();
            await this.page.bringToFront();
        } else {
            // 返回搜索结果页
            await this.page.goBack({ waitUntil: 'networkidle' });

            // 检查验证码
            if (await isAnyCaptchaPresent(this.page)) {
                await handleAnyCaptcha(this.page, this._getCaptchaContext());
            }
        }

        // 创建作者信息对象
        return {
            searchKeyword,
            authorName: authorInfo.authorName,
            totalHIndex: authorInfo.totalHIndex,
            recentHIndex: authorInfo.recentHIndex,
            profileUrl: authorUrl,
            institution: authorInfo.institution,
            emailVerified: authorInfo.emailVerified,
            searchTime: new Date().toLocaleString('zh-CN')
        };
    }

    /**
     * 从作者档案页提取信息
     */
    async _extractAuthorInfoFromProfile(page, profileUrl) {
        this.logger.info('开始从作者档案页提取信息...');

        let authorName = '';
        let totalHIndex = 'N/A';
        let recentHIndex = 'N/A';
        let institution = '';
        let emailVerified = '';

        try {
            // 等待表格出现
            await page.waitForSelector('#gsc_rsb_st', { timeout: 10000 });

            // 提取作者姓名
            const nameElement = await page.$('#gsc_prf_in');
            if (nameElement) {
                authorName = await nameElement.textContent();
                authorName = authorName ? authorName.trim() : '';
            }

            if (!authorName) {
                // 从图片 alt 获取
                const imgElement = await page.$('#gsc_prf_pup-img');
                if (imgElement) {
                    authorName = await imgElement.getAttribute('alt');
                    if (authorName) authorName = authorName.trim();
                }
            }

            this.logger.info(`作者姓名: ${authorName || '未找到'}`);

            // 提取 h 指数
            const rows = await page.$$('#gsc_rsb_st tbody tr');
            if (rows.length >= 2) {
                // 尝试通过文本定位 h 指数行
                let hIndexRow = null;
                for (const row of rows) {
                    const labelCell = await row.$('td.gsc_rsb_sc1');
                    if (!labelCell) continue;
                    const labelText = await labelCell.textContent();
                    if (!labelText) continue;

                    if (labelText.includes('h 指数') || labelText.toLowerCase().includes('h-index')) {
                        hIndexRow = row;
                        break;
                    }
                }

                // 如果未找到文本匹配的行，默认取第二行
                if (!hIndexRow) {
                    hIndexRow = rows[1];
                }

                // 提取数值
                if (hIndexRow) {
                    const valueCells = await hIndexRow.$$('td.gsc_rsb_std');
                    if (valueCells.length >= 2) {
                        totalHIndex = await valueCells[0].textContent();
                        recentHIndex = await valueCells[1].textContent();
                        totalHIndex = totalHIndex ? totalHIndex.trim() : 'N/A';
                        recentHIndex = recentHIndex ? recentHIndex.trim() : 'N/A';
                    }
                }
            }

            this.logger.info(`总计 h 指数: ${totalHIndex}`);
            this.logger.info(`近期 h 指数: ${recentHIndex}`);

            // 提取机构名称
            const institutionElement = await page.$('div.gsc_prf_il a.gsc_prf_ila');
            if (institutionElement) {
                institution = await institutionElement.textContent();
                institution = institution ? institution.trim() : '';
            }
            this.logger.info(`机构名称: ${institution || '未找到'}`);

            // 提取电子邮件验证信息
            const emailElement = await page.$('#gsc_prf_ivh');
            if (emailElement) {
                emailVerified = await emailElement.textContent();
                emailVerified = emailVerified ? emailVerified.trim() : '';
            }
            this.logger.info(`电子邮件验证: ${emailVerified || '未找到'}`);

        } catch (error) {
            this.logger.error(`提取作者信息时出错: ${error.message}`);
        }

        return {
            authorName: authorName || '未知作者',
            totalHIndex,
            recentHIndex,
            institution,
            emailVerified
        };
    }

    /**
     * 提取数据
     */
    async extractData(searchResults) {
        this.logger.info('开始整理提取的数据');

        return {
            successList: this.authorResultList,
            failedList: [],
            totalCount: this.authorResultList.length
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
            resultExcel: path.join(dataDir, `authors_${timestamp}.xlsx`)
        };

        // 导出 Excel
        this.excelExporter.exportGoogleAuthorResults(
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
    _recordFailedAuthor(authorName, reason) {
        this.authorResultList.push({
            searchKeyword: authorName,
            authorName,
            totalHIndex: '检索失败',
            recentHIndex: '检索失败',
            profileUrl: '',
            institution: '',
            emailVerified: '',
            searchTime: new Date().toLocaleString('zh-CN'),
            remark: `检索失败: ${reason}`
        });

        this.logger.info(`记录失败数据: ${reason}`);
    }

    /**
     * 检查验证码
     */
    // async _checkForCaptcha() {
    //     return await this._checkForCaptchaOnPage(this.page);
    // }

    /**
     * 检查指定页面的验证码
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
     * 在指定页面上手动处理验证码
     */
    // async _handleCaptchaManuallyOnPage(page) {
    //     this.logger.warn('⚠️ 检测到人机验证，请手动完成');
    //
    //     const screenshotPath = await this.browserManager.takeScreenshot(
    //         page,
    //         'captcha',
    //         path.join(this.currentOutputDir, 'screenshots')
    //     );
    //
    //     this.logger.info('请在浏览器窗口中完成验证...');
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
    //
    //     let waitTime = 0;
    //     const maxWaitTime = 600000;
    //     const checkInterval = 5000;
    //
    //     while (waitTime < maxWaitTime) {
    //         await page.waitForTimeout(checkInterval);
    //         waitTime += checkInterval;
    //
    //         if (!await isAnyCaptchaPresent(page)) {
    //             try {
    //                 const searchInput = await page.$('input[name="q"]');
    //                 if (searchInput) {
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
     * 随机延迟
     */
    async _randomDelay(min = 1000, max = 3000) {
        const delay = Math.floor(Math.random() * (max - min + 1)) + min;
        await this.page.waitForTimeout(delay);
    }
    // 获取验证码上下文
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
module.exports = GoogleScholarAuthorCrawler;
