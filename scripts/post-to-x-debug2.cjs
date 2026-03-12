const puppeteer = require('/Users/opoclaw1/opoclaw/node_modules/puppeteer');

const USERNAME = 'Thornopoclaw';
const PASSWORD = 'GOnza2002';

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    executablePath: require('/Users/opoclaw1/opoclaw/node_modules/puppeteer').executablePath()
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  console.log('Navigating to x.com/login...');
  await page.goto('https://x.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(2000);

  // Enter username
  const usernameInput = await page.$('input[autocomplete="username"]');
  await usernameInput.click({ clickCount: 3 });
  await usernameInput.type(USERNAME, { delay: 50 });
  await sleep(500);
  console.log('Username entered');

  // Get ALL role=button elements and their text
  const buttons = await page.$$eval('[role="button"]', els => els.map(el => ({
    text: el.innerText,
    tagName: el.tagName,
    class: el.className.substring(0, 50)
  })));
  console.log('All role=button elements:', JSON.stringify(buttons));

  // Try pressing Enter on the input instead
  await usernameInput.press('Enter');
  await sleep(3000);

  await page.screenshot({ path: '/tmp/x-step2b.png' });
  const inputs2 = await page.$$eval('input', els => els.map(el => ({type: el.type, name: el.name, autocomplete: el.autocomplete})));
  console.log('Inputs after Enter:', JSON.stringify(inputs2));
  console.log('URL:', page.url());

  // Check what's visible
  const allText = await page.evaluate(() => document.body.innerText.substring(0, 500));
  console.log('Page text:', allText);

  await browser.close();
})().catch(err => {
  console.error('Error:', err.message, err.stack);
  process.exit(1);
});
