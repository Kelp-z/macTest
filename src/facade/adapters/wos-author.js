const WosAuthorCrawler = require('../../crawlers/wos-author-crawler');

function createWosAuthorCrawlerFacade() {
  const crawler = new WosAuthorCrawler();
  return {
    async start(authors, options = {}) {
      await crawler.crawl({ keywords: authors, options });
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
    capabilities: {
      source: 'wos-author',
      inputType: 'authors',
      supportsIntervention: true,
      interventionTypes: []
    }
  };
}

module.exports = { createWosAuthorCrawlerFacade };
