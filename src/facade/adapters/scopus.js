const ScopusCrawler = require('../../crawlers/scopus-crawler');
const {cleanupCaptchaDir} = require("../../utils/common-utils");
const { app } = require('electron');
function createScopusCrawlerFacade() {
  const crawler = new ScopusCrawler();
  return {
    async start(keywords, options = {}) {
      const taskId = options.taskId || `scopus_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const taskType = options.taskType || 'SCOPUS_SEARCH';
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


        return {
          ...saveResult,
          successList: extractedData.successList,
          failedList: extractedData.failedList
        };
      } catch (error) {
        crawler.logger.error(`爬虫执行出错: ${error.message}`);
        // 记录错误但不清空 isRunning
        crawler.state.error = crawler.errorHandler.format(error, crawler.crawlerType);
        crawler.state.isRunning = false;
        await crawler.cleanup()
        throw error;
      } finally {
        // 清理验证码临时目录
        cleanupCaptchaDir(crawler.searchConfig?.CAPTCHA_DIR_NAME || 'captcha_temp', crawler.logger);
        // 无论成功还是失败，都要关闭浏览器并标记为未运行
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
    /**
     * 提交验证码
     */
    submitCaptcha(captchaId, captchaCode) {
      return crawler.submitCaptcha(captchaId, captchaCode);
    },
    /**
     * 确认手动操作
     */
    confirmManual() {
      return crawler.confirmManual();
    },
    capabilities: {
      source: 'scopus',
      inputType: 'keywords',
      supportsIntervention: true,
      interventionTypes: ['captcha', 'manual']
    }
  };
}

module.exports = { createScopusCrawlerFacade };
