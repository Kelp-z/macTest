const WosCrawler = require('../../crawlers/wos-crawler');
const {cleanupCaptchaDir} = require("../../utils/common-utils");

function createWosCrawlerFacade() {
  const crawler = new WosCrawler();
  return {
    async start(keywords, options = {}) {
      // 生成任务ID和类型
      const taskId = options.taskId || `wos_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const taskType = options.taskType || 'WOS_SEARCH';
      // 设置任务信息
      crawler.taskId = taskId;
      crawler.taskType = taskType;

      crawler.state.isRunning = true;
      crawler.state.progress = 0;
      crawler.state.error = null;

      try {
        await crawler.beforeCrawl();
        await crawler.initBrowser(options);
        await crawler.login();

        const searchResults = await crawler.search({ keywords });
        const extractedData = await crawler.extractData(searchResults);
        const saveResult = await crawler.saveResults(extractedData);

        await crawler.afterCrawl();
        crawler.state.result = {
          ...extractedData,
          ...saveResult
        };
        // 检查是否全部失败
        await crawler.checkAndScreenshotAllFailed(extractedData);

        return {
          ...saveResult,
          successList: extractedData.successList,
          failedList: extractedData.failedList
        };
      } catch (error) {
        crawler.logger.error(`爬虫执行出错: ${error.message}`);
        if (!crawler.state.error) {
          crawler.state.error = crawler.errorHandler.format(error, crawler.crawlerType, {
            taskId,
            taskType
          });
          await crawler.takeErrorScreenshot();
        }
        crawler.state.isRunning = false;
        await crawler.cleanup();
        throw error;
      }finally {
        cleanupCaptchaDir(crawler.searchConfig?.CAPTCHA_DIR_NAME || 'captcha_temp', crawler.logger);
        // 关闭浏览器并标记为未运行
        if (crawler.state.isRunning) {
          crawler.state.isRunning = false;
          await crawler.cleanup();
        }
      }
    },

    async stop() {
      await crawler.stop();
    },

    getState() {
      return crawler.getState();
    },

    resetState() {
      crawler.resetState();
    },

    submitCaptcha(captchaId, captchaCode) {
      return crawler.submitCaptcha(captchaId, captchaCode);
    },

    confirmManual() {
      return crawler.confirmManual();
    },

    capabilities: {
      source: 'wos',
      inputType: 'keywords',
      supportsIntervention: true,
      interventionTypes: ['captcha', 'manual','manual-login']
    }
  };
}

module.exports = { createWosCrawlerFacade };
