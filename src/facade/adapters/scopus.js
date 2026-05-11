const ScopusCrawler = require('../../crawlers/scopus-crawler');

function createScopusCrawlerFacade() {
  const crawler = new ScopusCrawler();
  return {
    async start(keywords, options = {}) {
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

        crawler.state.progress = 100;
        return {
          ...saveResult,
          successList: extractedData.successList,
          failedList: extractedData.failedList
        };
      } catch (error) {
        // 记录错误但不清空 isRunning
        crawler.state.error = crawler.errorHandler.format(error, crawler.crawlerType);
        crawler.state.isRunning = false;
        await crawler.cleanup()
        throw error;
      } finally {
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
