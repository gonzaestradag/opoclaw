const puppeteer = require('/Users/opoclaw1/claudeclaw/node_modules/puppeteer');

const USERNAME = 'Thornopoclaw';
const PASSWORD = 'GOnza2002';

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    executablePath: require('/Users/opoclaw1/claudeclaw/node_modules/puppeteer').executablePath()
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  console.log('Navigating to x.com/login...');
  await page.goto('https://x.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(2000);

  // Screenshot step 1
  await page.screenshot({ path: '/tmp/x-step1.png' });
  console.log('Screenshot 1 saved');

  // Find all inputs
  const inputs1 = await page.$$eval('input', els => els.map(el => ({type: el.type, name: el.name, placeholder: el.placeholder, autocomplete: el.autocomplete, id: el.id})));
  console.log('Inputs on login page:', JSON.stringify(inputs1));

  // Enter username
  const usernameInput = await page.$('input[autocomplete="username"], input[name="text"]');
  if (usernameInput) {
    await usernameInput.type(USERNAME, { delay: 50 });
    await sleep(500);
    console.log('Username entered');
  } else {
    console.log('No username input found');
    await browser.close();
    process.exit(1);
  }

  // Click Next
  const allBtns = await page.$$('[role="button"], button');
  let clicked = false;
  for (const btn of allBtns) {
    const text = await page.evaluate(el => el.innerText, btn).catch(() => '');
    if (text && text.toLowerCase().includes('next')) {
      await btn.click();
      clicked = true;
      console.log('Clicked Next');
      break;
    }
  }
  if (!clicked) {
    console.log('No Next button found, pressing Enter');
    await page.keyboard.press('Enter');
  }
  await sleep(2500);

  // Screenshot step 2
  await page.screenshot({ path: '/tmp/x-step2.png' });
  console.log('Screenshot 2 saved');

  const inputs2 = await page.$$eval('input', els => els.map(el => ({type: el.type, name: el.name, placeholder: el.placeholder, autocomplete: el.autocomplete, id: el.id, value: el.value})));
  console.log('Inputs after Next:', JSON.stringify(inputs2));

  const currentUrl = page.url();
  console.log('URL after Next:', currentUrl);

  // Get page title / heading text
  const headings = await page.$$eval('h1, h2, [data-testid="ocfEnterTextTitle"]', els => els.map(el => el.innerText));
  console.log('Headings:', JSON.stringify(headings));

  // Get all spans/divs with text that look like prompts
  const labels = await page.$$eval('label, span[class]', els => els.slice(0, 20).map(el => el.innerText.trim()).filter(t => t.length > 0 && t.length < 200));
  console.log('Labels:', JSON.stringify(labels.slice(0, 10)));

  await browser.close();
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
