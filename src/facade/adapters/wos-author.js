const WosAuthorCrawler = require('../../crawlers/wos-author-crawler');

function createWosAuthorCrawlerFacade() {
  let crawlerInstance = null;

  function getCrawler() {
    if (!crawlerInstance) {
      crawlerInstance = new WosAuthorCrawler();
    }
    return crawlerInstance;
  }

  return {
    async start(authors, options = {}) {
      await getCrawler().crawl({ keywords: authors, options });
    },
    async stop() {
      if (crawlerInstance) {
        await crawlerInstance.stop();
      }
    },
    getState() {
      return getCrawler().getState();
    },
    resetState() {
      if (crawlerInstance) {
        crawlerInstance.resetState();
      }
    },
    capabilities: {
      source: 'wos-author',
      inputType: 'authors',
      supportsIntervention: true,
      interventionTypes: ['manual-login']
    }
  };
}

module.exports = { createWosAuthorCrawlerFacade };
