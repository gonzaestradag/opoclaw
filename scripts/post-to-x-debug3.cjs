const puppeteer = require('/Users/opoclaw1/claudeclaw/node_modules/puppeteer');
const path = require('path');
const fs = require('fs');

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

(async () => {
  const tempDir = '/tmp/x-puppeteer-profile';

  // Copy fresh cookies
  const cookieSrc = '/tmp/x-chrome-profile/Cookies';
  const cookieDst = path.join(tempDir, 'Default', 'Cookies');
  if (fs.existsSync(cookieSrc)) {
    fs.copyFileSync(cookieSrc, cookieDst);
  }

  console.log('Launching Chrome...');
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    userDataDir: tempDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900'
    ],
    defaultViewport: { width: 1280, height: 900 }
  });

  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    delete navigator.__proto__.webdriver;
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
  });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

  console.log('Going to x.com/home...');
  await page.goto('https://x.com/home', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(4000);
  await page.screenshot({ path: '/tmp/x-home-debug.png' });

  const url = page.url();
  console.log('URL:', url);

  // Get all testid elements
  const testIds = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[data-testid]'));
    return els.map(el => el.getAttribute('data-testid')).filter(Boolean).slice(0, 50);
  });
  console.log('TestIDs found:', testIds.join(', '));

  // Try going to compose
  console.log('\nNavigating to compose/post...');
  await page.goto('https://x.com/compose/post', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(5000);
  await page.screenshot({ path: '/tmp/x-compose-debug.png' });

  const composeUrl = page.url();
  console.log('Compose URL:', composeUrl);

  const composeTestIds = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[data-testid]'));
    return els.map(el => el.getAttribute('data-testid')).filter(Boolean).slice(0, 50);
  });
  console.log('Compose TestIDs:', composeTestIds.join(', '));

  // Look for contenteditable elements
  const contentEditables = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[contenteditable="true"]'));
    return els.map(el => ({
      tag: el.tagName,
      class: el.className.substring(0, 50),
      testid: el.getAttribute('data-testid'),
      placeholder: el.getAttribute('data-placeholder'),
      text: el.innerText.substring(0, 50)
    }));
  });
  console.log('ContentEditable elements:', JSON.stringify(contentEditables, null, 2));

  // Get all roles
  const roles = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[role]'));
    return [...new Set(els.map(el => el.getAttribute('role')))];
  });
  console.log('Roles:', roles.join(', '));

  await browser.close();
})().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
