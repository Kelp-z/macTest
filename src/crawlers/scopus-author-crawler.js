// src/crawlers/scopus-author-crawler.js
const BaseCrawler = require('../core/base-crawler');
const fs = require('fs');
const path = require('path');
const {humanClick, humanType} = require('../utils/playwright-utils');

/**
 * Scopus 作者爬虫类
 */
class ScopusAuthorCrawler extends BaseCrawler {
    constructor() {
        super('scopus-author');
        const crawlerConfig = this.configManager.getCrawlerConfig('scopus-author');
        this.SearchConfig = {
            OUTPUT_BASE_DIR_NAME: crawlerConfig.OUTPUT_BASE_DIR_NAME ?? 'output/scopus_authors'
        };

        this.authorsResultList = [];
        this.shouldStop = false;
        this.currentOutputDir = null;
        this.searchPageUrl = null;
    }

    async beforeCrawl() {
        await super.beforeCrawl();
        this.logger.info('Scopus 作者爬虫初始化完成');
        this.shouldStop = false;
        this.authorsResultList = [];

        const timestamp = new Date().toISOString().replace(/[-:\.T]/g, '').slice(0, 15);
        // 构建当前任务的输出目录路径
        this.currentOutputDir = path.join(
            process.cwd(),
            this.SearchConfig.OUTPUT_BASE_DIR_NAME,
            timestamp
        );
        if (!fs.existsSync(this.currentOutputDir)) {
            fs.mkdirSync(this.currentOutputDir, {recursive: true})
        }
        this.logger.info(`输出目录已创建: ${this.currentOutputDir}`);
    }

    /*
    * 初始化浏览器
    */
    async initBrowser() {
        this.browser = await this.browserManager.launch(this.configManager.browserOptions);
        const {page, context} = await this.browserManager.createPage(this.browser);
        this.page = page;
        this.context = context;
        this.logger.info('浏览器已初始化');
    }
    /**
     * 停止爬虫
     */
    async stop() {
        this.logger.info('Scopus 作者爬虫收到停止请求');

        // 设置特有的停止标志
        this.shouldStop = true;

        // 调用父类的通用停止逻辑
        await super.stop();

        this.logger.info('Scopus 作者爬虫已停止');
    }

    /**
     * 重置状态
     */
    resetState() {
        this.logger.info('重置 Scopus 作者爬虫状态');

        // 重置特有状态
        this.shouldStop = false;
        this.authorsResultList = [];
        this.currentOutputDir = null;
        this.searchPageUrl = null;

        // 调用父类的通用重置逻辑
        super.resetState();

        this.logger.info('Scopus 作者爬虫状态已重置');
    }
    /*
    * 登录
    * */
    async login() {
        this.logger.info('Scopus 作者检索无需登录');
        return Promise.resolve();
    }

    /**
     * 执行搜索
     * @param {Object} params - 搜索参数
     * @param {Array} params.keywords - 作者列表
     * @returns {Array} 搜索结果
     */
    async search(params) {
        const {keywords: rawInput, options = {}} = params;
        const authors = this._preprocessAuthors(rawInput);
        if (!authors || authors.length === 0) {
            throw new Error('作者列表不能为空');
        }

        this.logger.info(`开始检索，共${authors.length}个作者`);

        await this._navigateToAuthorSearchPage();
        const results = [];
        for (let i = 0; i < authors.length; i++) {
            if (this.shouldStop || !this.state.isRunning) {
                this.logger.info('检测到停止信号，终止检索');
                break;
            }
            //     检查浏览器状态
            if (!this.isBrowserAvailable()) {
                this.logger.warn('浏览器不可用，终止检索');
                break;
            }

            const author = authors[i];

            this.updateProgress(
                Math.round((i / authors.length) * 60) + 30,
                `处理第${i + 1}/${authors.length}个作者：${author.lastName} ${author.firstName}`
            );

            try {
                const result = await this._searchSingleAuthor(author);
                results.push(result);
                this.authorsResultList.push(result);
            } catch (error) {
                this.logger.error(`作者 "${author.lastName} ${author.firstName}" 检索失败: ${error.message}`);
                this._recordFailedAuthor(author, error.message);
            }
            // 作者之间随机延迟
            if (i < authors.length - 1) {
                await this._returnToSearchPage();
                await this.safeDelay(3000, 6000);
            }
        }
        return results;
    }
    /**
     * 返回搜索页
     */
    async _returnToSearchPage() {
        this.logger.info('正在返回作者搜索页...');

        try {
            // 尝试后退
            await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
        } catch (error) {
            this.logger.warn(`后退失败: ${error.message}，尝试重新导航`);
        }

        // 验证是否在搜索页
        const currentUrl = this.page.url();
        if (!currentUrl.includes('author.uri') && !currentUrl.includes('search')) {
            this.logger.warn('后退后不在搜索页，重新导航');
            await this.page.goto(this.searchPageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }

        // 等待搜索框出现
        try {
            await this.page.waitForSelector('input[name="searchterm1"]', { timeout: 10000 });
            this.logger.info('已成功返回作者搜索页面');
        } catch (error) {
            this.logger.error('返回搜索页失败，未找到搜索框');
            throw new Error('无法返回搜索页');
        }
    }

    /*
       * 预处理作者输出
       * */
    _preprocessAuthors(input) {
        if (!Array.isArray(input) || input.length === 0) {
            this.logger.error('输入数据为空');
            return [];
        }

        const firstItem = input[0];

        // 字符串数组（格式："LastName FirstName"）
        if (typeof firstItem === 'string') {
            return input.map(name => {
                const parts = name.trim().split(/\s+/);
                if (parts.length === 1) {
                    return {lastName: parts[0], firstName: '', orcid: ''};
                } else if (parts.length === 2) {
                    return {lastName: parts[0], firstName: parts[1], orcid: ''};
                } else {
                    const lastName = parts[0];
                    const firstName = parts.slice(1).join('  ');
                    return {lastName: lastName, firstName: firstName, orcid: ''};

                }
            }).filter(a => a.lastName);
        }
        if (typeof firstItem === 'object' && firstItem !== null) {
            return input.map(item => {
                const familyName = item.familyName || item.lastName || '';
                const givenName = item.givenName || item.firstName || '';

                if (familyName && givenName) {
                    return {
                        lastName: familyName,
                        firstName: givenName,
                        orcid: item.orcid || '',
                    };
                } else if (item.authorName) {
                    const nameParts = item.authorName.trim().split(/\s+/);
                    const lastName = nameParts[0];
                    const firstName = nameParts.slice(1).join('  ');
                    return {lastName: lastName, firstName: firstName,  orcid: item.orcid || ''};
                }
                this.logger.warn(`作者数据格式无效: ${JSON.stringify(item)}`);
                return null;
            }).filter(Boolean);
        }
        this.logger.warn('未知输出类型');
        return [];
    }

    /**
     * 导航到作者搜索页
     */
    async _navigateToAuthorSearchPage() {
        this.logger.info('正在导航到Scopus 作者搜索页');
        // 直接访问 Scopus 首页
        await this.page.goto('https://www.scopus.com/pages/home', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        this.logger.info('已到达 Scopus 首页');
        await this.safeDelay(2000, 3000);

        // 查找并点击 "Author Search" 链接
        await this._clickAuthorSearchLink();

        // 等待搜索页面加载
        await this.page.waitForSelector('input[name="searchterm1"]', {timeout: 15000});
        this.logger.info('已到达作者搜索页面');

    }

    /**
     * 点击 Author Search 链接
     */
    async _clickAuthorSearchLink() {
        this.logger.info('正在查找 "Author Search" 链接...');

        const selectors = [
            'a:has-text("Author Search")',
            'a:has-text("Author search")',
            'a:has-text("作者检索")',
            'a[href*="author.uri"]',
            'a[href*="/author/search"]'
        ];

        let authorSearchLink = null;
        for (const selector of selectors) {
            try {
                const link = await this.page.$(selector);
                if (link) {
                    authorSearchLink = link;
                    this.logger.info(`使用选择器 "${selector}" 找到链接`);
                    break;
                }
            } catch (error) {
                // 忽略错误，继续尝试下一个选择器
            }
        }

        if (!authorSearchLink) {
            throw new Error('未找到 "Author Search" 链接');
        }

        this.logger.info('点击 "Author Search" 链接...');
        await Promise.all([
            this.page.waitForNavigation({waitUntil: 'domcontentloaded', timeout: 30000}),
            humanClick(this.page, authorSearchLink)
        ]);

        await this.safeDelay(2000, 3000);
    }

    /**
     * 搜索单个作者
     */
    async _searchSingleAuthor(author) {
        this.logger.info(`\n--- 处理作者: ${author.lastName} ${author.firstName} ---`);

        let result;
        if (author.orcid && author.orcid.trim() !== '') {
            result = await this._searchByOrcid(author);
        } else {
            result = await this._searchByName(author);
        }

        return result;
    }

    /**
     * 通过 ORCID 搜索
     */
    async _searchByOrcid(author) {
        const orcid = author.orcid.trim();
        this.logger.info(`使用 ORCID 检索: ${orcid}`);

        // 定位 ORCID 输入框和按钮
        const orcidInput = await this.page.$('#orcidId');
        const orcidSubmitBtn = await this.page.$('#orcidSubmitBtn');

        if (!orcidInput || !orcidSubmitBtn) {
            this.logger.warn('未找到 ORCID 输入框或按钮，回退到姓名检索');
            return await this._searchByName(author);
        }

        // 填写 ORCID
        await orcidInput.fill('');
        await orcidInput.fill(orcid);

        // 点击搜索
        await Promise.all([
            this.page.waitForNavigation({waitUntil: 'domcontentloaded', timeout: 30000}),
            humanClick(this.page, orcidSubmitBtn)
        ]);

        const resultUrl = this.page.url();
        this.logger.info(`ORCID 搜索结果页 URL: ${resultUrl}`);
        await this.safeDelay(2000, 3000);

        // 检查是否无结果
        const bodyText = await this.page.locator('body').innerText();
        if (bodyText.includes('No authors were found')) {
            this.logger.warn(`ORCID ${orcid} 未检索到任何作者`);
            return {
                searchAuthor: {
                    lastName: author.lastName,
                    firstName: author.firstName,
                    orcid: author.orcid
                },
                resultPageUrl: resultUrl,
                totalResults: 0,
                authors: []
            };
        }

        // 检查是否直接跳转到作者详情页
        const isDetailPage = await this.page.$('h1[data-testid="author-profile-name"]');
        if (isDetailPage) {
            this.logger.info('ORCID 检索直接进入作者详情页');
            const details = await this._extractAuthorDetails(this.page.url(), `${author.firstName} ${author.lastName}`);
            if (details) {
                return {
                    searchAuthor: {
                        lastName: author.lastName,
                        firstName: author.firstName,
                        orcid: author.orcid
                    },
                    resultPageUrl: resultUrl,
                    totalResults: 1,
                    authors: [{
                        authorName: details.authorName,
                        authorUrl: this.page.url(),
                        affiliation: '',
                        city: '',
                        country: '',
                        details: details
                    }]
                };
            }
        }

        // 解析列表页
        return await this._parseSearchResults(author);
    }

    /**
     * 通过姓名搜索
     */
    async _searchByName(author) {
        this.logger.info(`使用姓名检索: ${author.lastName}, ${author.firstName}`);

        // 清空并填写姓名输入框
        const lastNameInput = await this.page.$('input[name="searchterm1"]');
        const firstNameInput = await this.page.$('input[name="searchterm2"]');

        if (!lastNameInput || !firstNameInput) {
            throw new Error('无法获取姓名输入框');
        }

        await lastNameInput.fill('');
        await firstNameInput.fill('');
        await humanType(this.page, lastNameInput, author.lastName);
        await humanType(this.page, firstNameInput, author.firstName);

        const submitBtn = await this.page.$('#authorSubmitBtn');
        if (!submitBtn) {
            throw new Error('找不到姓名搜索按钮');
        }

        await Promise.all([
            this.page.waitForNavigation({waitUntil: 'domcontentloaded', timeout: 30000}),
            humanClick(this.page, submitBtn)
        ]);

        const resultUrl = this.page.url();
        this.logger.info(`姓名搜索结果页 URL: ${resultUrl}`);
        await this.safeDelay(2000, 3000);

        // 解析结果
        return await this._parseSearchResults(author);
    }

    /**
     * 解析搜索结果页
     */
    async _parseSearchResults(author) {
        // 获取结果总数
        let totalResults = 0;
        const resultsCountSpan = await this.page.$('span.resultsCount');
        if (resultsCountSpan) {
            const countText = await resultsCountSpan.textContent();
            totalResults = parseInt(countText.trim(), 10) || 0;
            this.logger.info(`检索到 ${totalResults} 条作者结果`);
        }

        // 提取表格数据
        const authorItems = [];
        const tableExists = await this.page.$('#srchResultsList');

        if (tableExists) {
            const rows = await this.page.$$('#srchResultsList tbody tr.searchArea');
            this.logger.info(`找到 ${rows.length} 个作者条目`);

            for (const row of rows) {
                const authorLink = await row.$('td.authorResultsNamesCol a');
                let authorName = '', authorUrl = '';

                if (authorLink) {
                    authorName = await authorLink.textContent();
                    authorUrl = await authorLink.getAttribute('href');
                    authorName = authorName ? authorName.trim() : '';
                }

                const affiliationCell = await row.$('td.dataCol5');
                const cityCell = await row.$('td.dataCol6');
                const countryCell = await row.$('td.dataCol7');

                const affiliation = affiliationCell ? (await affiliationCell.textContent()).trim() : '';
                const city = cityCell ? (await cityCell.textContent()).trim() : '';
                const country = countryCell ? (await countryCell.textContent()).trim() : '';

                authorItems.push({
                    authorName,
                    authorUrl,
                    affiliation,
                    city,
                    country,
                    details: null
                });
            }
        }

        // 提取前5个作者的详情
        const maxDetails = 5;
        for (let idx = 0; idx < Math.min(authorItems.length, maxDetails); idx++) {
            if (this.shouldStop) break;

            const item = authorItems[idx];
            if (item.authorUrl) {
                this.logger.info(`正在提取第 ${idx + 1} 个作者的详情: ${item.authorName}`);
                const details = await this._extractAuthorDetails(item.authorUrl, item.authorName);
                item.details = details;
            }

            await this.safeDelay(1000, 2000);
        }

        return {
            searchAuthor: {
                lastName: author.lastName,
                firstName: author.firstName,
                orcid: author.orcid || ''
            },
            resultPageUrl: this.page.url(),
            totalResults,
            authors: authorItems
        };
    }

    /**
     * 提取作者详情
     */
    async _extractAuthorDetails(authorUrl, expectedAuthorName) {
        this.logger.info(`正在访问作者详情页: ${authorUrl}`);

        const newPage = await this.page.context().newPage();

        try {
            await newPage.goto(authorUrl, {waitUntil: 'domcontentloaded', timeout: 30000});
            await newPage.waitForSelector('h1[data-testid="author-profile-name"]', {timeout: 15000});

            await this.safeDelay(1000, 2000);

            // 提取作者姓名
            const h1 = await newPage.$('h1[data-testid="author-profile-name"]');
            if (!h1) {
                this.logger.warn(`未找到作者姓名 h1 元素`);
                return null;
            }

            const authorName = await h1.textContent();
            if (!authorName.trim()) {
                return null;
            }

            // 机构和国家
            let institutionCountry = '';
            const institutionSpan = await newPage.$('[data-testid="authorInstitution"]');
            if (institutionSpan) {
                const rawText = await institutionSpan.textContent();
                institutionCountry = rawText.replace(/此链接已禁用。?/g, '').trim();
            }

            // Scopus ID
            let scopusId = '';
            const scopusIdLi = await newPage.$('ul.AuthorHeader-module__FFjTx > li:nth-child(2)');
            if (scopusIdLi) {
                const text = await scopusIdLi.textContent();
                const match = text.match(/Scopus ID:\s*(\S+)/);
                if (match) scopusId = match[1];
            }

            // ORCID
            let orcid = '';
            const orcidLi = await newPage.$('ul.AuthorHeader-module__FFjTx > li:nth-child(3)');
            if (orcidLi) {
                const link = await orcidLi.$('a');
                if (link) {
                    const href = await link.getAttribute('href');
                    const orcidMatch = href.match(/orcid\.org\/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/);
                    if (orcidMatch) orcid = orcidMatch[1];
                }
            }

            // h-index
            let hIndex = '';
            const hIndexDiv = await newPage.$('[data-testid="metrics-section-h-index"]');
            if (hIndexDiv) {
                const span = await hIndexDiv.$('span[data-testid="unclickable-count"]');
                if (span) {
                    hIndex = await span.textContent();
                    hIndex = hIndex ? hIndex.trim() : '';
                }
            }

            return {
                authorName: authorName.trim(),
                institutionCountry,
                scopusId,
                orcid,
                hIndex
            };
        } catch (error) {
            this.logger.error(`提取作者详情页失败: ${error.message}`);
            return null;
        } finally {
            await newPage.close();
        }
    }

    /**
     * 提取数据
     */
    async extractData(searchResults) {
        this.logger.info('开始整理提取的数据');

        return {
            successList: this.authorsResultList,
            failedList: [],
            totalCount: this.authorsResultList.length
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
            resultExcel: path.join(dataDir, `scopus_authors_${timestamp}.xlsx`)
        };

        // 导出 Excel
        this.excelExporter.exportScopusAuthorResults(
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
            searchAuthor: {
                lastName: author.lastName,
                firstName: author.firstName,
                orcid: author.orcid || ''
            },
            resultPageUrl: '',
            totalResults: 0,
            authors: [],
            remark: `检索失败: ${reason}`
        });

        this.logger.info(`记录失败数据: ${reason}`);
    }
}

module.exports = ScopusAuthorCrawler;
