const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', msg => logs.push(`console:${msg.type()}:${msg.text()}`));
  page.on('pageerror', err => logs.push(`pageerror:${err.message}`));
  await page.goto('https://erp-aastar-trading-sg.trade', {
    waitUntil: 'networkidle2',
    timeout: 20000
  });
  await new Promise(resolve => setTimeout(resolve, 2000));
  const info = await page.evaluate(() => ({
    title: document.title,
    body: document.body.innerText.slice(0, 500),
    rootLen: (document.getElementById('root')?.innerHTML || '').length
  }));
  console.log(JSON.stringify({ info, logs }, null, 2));
  await browser.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
