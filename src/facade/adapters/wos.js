const WosCrawler = require('../../crawlers/wos-crawler');
const {cleanupCaptchaDir} = require("../../utils/common-utils");

function createWosCrawlerFacade() {
  const crawler = new WosCrawler();
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
        crawler.state.error = crawler.errorHandler.format(error, crawler.crawlerType);
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
