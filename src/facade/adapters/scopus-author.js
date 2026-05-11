const ScopusAuthorCrawler = require('../../crawlers/scopus-author-crawler');

function createScopusAuthorCrawlerFacade() {
    const crawler = new ScopusAuthorCrawler();
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
            source: 'scopus-author',
            inputType: 'authors',
            supportsIntervention: false,
            interventionTypes: []
        }
    };
}

module.exports = {createScopusAuthorCrawlerFacade};
