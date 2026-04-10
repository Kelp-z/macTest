const axios = require('axios');
const cheerio = require('cheerio');

// 爬虫状态（用于页面展示）
let crawlerStatus = {
    isRunning: false,
    progress: 0,
    result: [],
    error: null
};

/**
 * 核心爬虫函数
 * @param {Object} params - 爬虫参数（如目标URL、爬取页数等）
 * @returns {Promise}
 */
async function startCrawler(params) {
    try {
        // 更新爬虫状态
        crawlerStatus = {
            isRunning: true,
            progress: 0,
            result: [],
            error: null
        };

        const { targetUrl = 'https://example.com', pageNum = 1 } = params;
        const resultList = [];

        // 模拟多页爬取（示例）
        for (let i = 1; i <= pageNum; i++) {
            crawlerStatus.progress = Math.round((i / pageNum) * 100); // 更新进度
            const res = await axios.get(`${targetUrl}?page=${i}`);
            const $ = cheerio.load(res.data);

            // 示例：爬取页面标题和链接（根据目标网站调整）
            $('a').each((_, el) => {
                resultList.push({
                    title: $(el).text().trim(),
                    href: $(el).attr('href'),
                    page: i
                });
            });

            // 模拟爬取延迟
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // 爬取完成，更新状态
        crawlerStatus.isRunning = false;
        crawlerStatus.progress = 100;
        crawlerStatus.result = resultList;
        return resultList;

    } catch (err) {
        // 爬取出错，更新状态
        crawlerStatus.isRunning = false;
        crawlerStatus.error = err.message;
        throw err;
    }
}

/**
 * 获取爬虫当前状态
 * @returns {Object}
 */
function getCrawlerStatus() {
    return { ...crawlerStatus };
}

module.exports = {
    startCrawler,
    getCrawlerStatus
};
