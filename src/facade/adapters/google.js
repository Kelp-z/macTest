
const GoogleScholarCrawler = require('../../crawlers/google-scholar-crawler');

/** @returns {import('../types').CrawlerFacade} */
function createGoogleCrawlerFacade() {
    let crawlerInstance = null;

    function getCrawler() {
        if (!crawlerInstance) {
            crawlerInstance = new GoogleScholarCrawler();
        }
        return crawlerInstance;
    }

    return {
        // 启动爬虫，传入关键词列表和可选参数
        async start(keywords, options = {}) {
            try {
                const crawler = getCrawler();
                await crawler.crawl({ keywords, options });
            } catch (error) {
                //  统一的错误处理
                throw error; // 重新抛出，让调用方知道失败了
            }
        },

        // 停止爬虫
        async stop() {
            const crawler = getCrawler();
            await crawler.stop();

        },

        // 获取当前爬虫状态
        getState() {
            const crawler = getCrawler();
            return crawler.getState();
        },

        // 重置爬虫内部状态（浏览器常驻最小化，不关闭）
        resetState() {
            if (crawlerInstance) {
                crawlerInstance.resetState();
            }
        },

        // 重启爬虫
        async restart(keywords, options = {}) {
            const crawler = getCrawler();
            await crawler.stop();
            crawlerInstance = null;
            const newCrawler = new GoogleScholarCrawler();
            crawlerInstance = newCrawler;
            await newCrawler.crawl({ keywords, options });
        },

        // 描述该爬虫的能力
        capabilities: {
            source: 'google',
            inputType: 'keywords',
            supportsIntervention: true,
            interventionTypes: ['captcha-manual']
        }
    };
}

module.exports = { createGoogleCrawlerFacade };
