const puppeteer = require('/Users/opoclaw1/opoclaw/node_modules/puppeteer');

const USERNAME = 'Thornopoclaw';
const PASSWORD = 'GOnza2002';

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function randomSleep(min, max) {
  const ms = min + Math.random() * (max - min);
  return sleep(ms);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins',
      '--window-size=1280,900',
    ],
    defaultViewport: { width: 1280, height: 900 }
  });

  const page = await browser.newPage();

  // Comprehensive automation masking
  await page.evaluateOnNewDocument(() => {
    // Overwrite the `webdriver` property
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
      configurable: true
    });
    // Make plugins non-empty
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        return [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
        ];
      }
    });
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en', 'es-MX', 'es']
    });
    // Add chrome object
    window.chrome = {
      runtime: {},
      loadTimes: function() {},
      csi: function() {},
      app: {}
    };
    // Fix permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  });

  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

  // Set extra headers
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9,es-MX;q=0.8,es;q=0.7',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
  });

  console.log('Opening x.com homepage first...');
  await page.goto('https://x.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomSleep(2000, 4000);

  // Simulate some mouse movement on homepage
  await page.mouse.move(640, 400, { steps: 20 });
  await randomSleep(500, 1000);
  await page.mouse.move(800, 300, { steps: 15 });
  await randomSleep(1000, 2000);

  console.log('Navigating to login page...');
  await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomSleep(2500, 4000);

  await page.screenshot({ path: '/tmp/x-slow-step1.png' });
  console.log('Login page loaded');

  const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 200));
  console.log('Page text:', bodyText.substring(0, 100));

  // Move mouse around naturally before clicking
  await page.mouse.move(400, 300, { steps: 25 });
  await randomSleep(300, 700);
  await page.mouse.move(600, 450, { steps: 20 });
  await randomSleep(500, 1000);

  const usernameInput = await page.waitForSelector('input[autocomplete="username"]', { timeout: 10000 });

  // Move to input naturally
  const inputBox = await usernameInput.boundingBox();
  await page.mouse.move(inputBox.x + inputBox.width / 2, inputBox.y + inputBox.height / 2, { steps: 30 });
  await randomSleep(200, 500);
  await usernameInput.click();
  await randomSleep(400, 800);

  // Type username with human-like delays
  for (const char of USERNAME) {
    await page.keyboard.type(char);
    await randomSleep(80, 180);
  }
  await randomSleep(1000, 2000);
  console.log('Username typed');

  // Move to Next button naturally
  const nextClicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const nextBtn = buttons.find(b => b.innerText && b.innerText.trim() === 'Next');
    if (nextBtn) {
      const rect = nextBtn.getBoundingClientRect();
      return { x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
    }
    return null;
  });

  if (nextClicked) {
    await page.mouse.move(nextClicked.x + (Math.random() - 0.5) * 20, nextClicked.y + (Math.random() - 0.5) * 10, { steps: 25 });
    await randomSleep(200, 400);
    await page.mouse.click(nextClicked.x, nextClicked.y);
    console.log('Clicked Next button at', nextClicked);
  } else {
    console.log('Next button not found, pressing Enter');
    await page.keyboard.press('Enter');
  }

  await randomSleep(3000, 5000);

  await page.screenshot({ path: '/tmp/x-slow-step2.png' });
  const afterNextText = await page.evaluate(() => document.body.innerText.substring(0, 300));
  console.log('After Next:', afterNextText.substring(0, 200));

  if (afterNextText.includes('Could not log you in')) {
    console.error('BLOCKED: X bot detection triggered even with slow approach');
    await browser.close();
    process.exit(3);
  }

  console.log('Not blocked! Proceeding...');
  await browser.close();
  process.exit(0);
})().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
