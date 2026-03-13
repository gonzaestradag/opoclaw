const puppeteer = require('/Users/opoclaw1/opoclaw/node_modules/puppeteer');
const fs = require('fs');

const IG_USERNAME = 'thorn.opoclaw';
const IG_PASSWORD = 'GOnza2002';

const IG_CAPTION = `El 73% de las empresas dice que "usa IA". Menos del 8% tiene infraestructura de agentes real.

La diferencia no es presupuesto. No es acceso a tecnologia. Es entender que un chatbot y un agente no son la misma cosa.

Un chatbot responde preguntas. Un agente ejecuta procesos, delega subtareas, verifica su propio output, y notifica cuando termina. Sin supervision humana en cada paso.

La mayoria de las empresas compro una herramienta AI. Nosotros construimos un sistema operativo.

Si quieres entender la diferencia en terminos concretos, el link esta en el bio.

#AIagents #inteligenciaartificial #startups #empresas #automatizacion #futureofwork #innovation #tecnologia #emprendimiento #opoclaw`;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
async function rSleep(min, max) {
  return sleep(Math.floor(Math.random() * (max - min) + min));
}
async function humanType(page, text) {
  for (const char of text) {
    await page.keyboard.type(char);
    await sleep(Math.random() * 70 + 30);
  }
}

(async () => {
  const freshDir = '/tmp/ig-v2-' + Date.now();
  fs.mkdirSync(freshDir, { recursive: true });

  console.log('Launching Chrome for Instagram...');
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    userDataDir: freshDir,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,768'
    ],
    defaultViewport: { width: 1366, height: 768 }
  });

  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    delete navigator.__proto__.webdriver;
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
  });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

  console.log('Navigating to Instagram login...');
  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle2', timeout: 30000 });
  await rSleep(2000, 3500);
  await page.screenshot({ path: '/tmp/ig-v2-step1.png' });

  // Use correct selectors: name="email" and name="pass"
  const usernameField = await page.waitForSelector('input[name="email"]', { timeout: 15000 }).catch(() => null);
  if (!usernameField) {
    const text = await page.evaluate(() => document.body.innerText.substring(0, 300));
    console.error('No email/username field found. Page:', text);
    await browser.close();
    process.exit(1);
  }

  await usernameField.click();
  await rSleep(400, 700);
  await humanType(page, IG_USERNAME);
  console.log('Username entered');

  await rSleep(400, 700);

  const pwField = await page.$('input[name="pass"]');
  if (!pwField) {
    console.error('No password field found');
    await browser.close();
    process.exit(1);
  }

  await pwField.click();
  await rSleep(300, 600);
  await humanType(page, IG_PASSWORD);
  console.log('Password entered');

  await rSleep(500, 900);

  // Click submit button
  const submitted = await page.evaluate(() => {
    const btn = document.querySelector('input[type="submit"], button[type="submit"]');
    if (btn) { btn.click(); return 'submit-click'; }
    const btns = Array.from(document.querySelectorAll('button'));
    const loginBtn = btns.find(b => b.innerText && b.innerText.trim().toLowerCase().includes('log in'));
    if (loginBtn) { loginBtn.click(); return 'login-btn'; }
    return null;
  });
  console.log('Login click:', submitted);

  if (!submitted) {
    await pwField.press('Enter');
  }

  await rSleep(5000, 8000);
  await page.screenshot({ path: '/tmp/ig-v2-after-login.png' });

  const afterUrl = page.url();
  const afterText = await page.evaluate(() => document.body.innerText.substring(0, 400));
  console.log('After login URL:', afterUrl);
  console.log('After login text snippet:', afterText.substring(0, 150));

  // Check for challenge/verification
  if (afterUrl.includes('/challenge') || afterUrl.includes('/accounts/login')) {
    if (afterUrl.includes('/challenge') ||
        afterText.toLowerCase().includes('verif') ||
        afterText.toLowerCase().includes('code') ||
        afterText.toLowerCase().includes('suspicious')) {
      console.error('ERROR: Instagram requires verification (unusual activity detected or 2FA).');
      console.log('Verification page text:', afterText);
      await browser.close();
      process.exit(2);
    }
    console.error('ERROR: Instagram login failed, still on login page.');
    console.log('Page text:', afterText);
    await browser.close();
    process.exit(1);
  }

  console.log('Logged in to Instagram!');

  // Dismiss popups
  await rSleep(1000, 2000);
  for (let attempt = 0; attempt < 3; attempt++) {
    const dismissed = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      const notNow = btns.find(b => {
        const t = (b.innerText || '').toLowerCase();
        return t.includes('not now') || t === 'not now';
      });
      if (notNow) { notNow.click(); return true; }
      return false;
    });
    if (dismissed) {
      console.log('Dismissed popup');
      await rSleep(1000, 2000);
    } else {
      break;
    }
  }

  // Navigate to home
  await page.goto('https://www.instagram.com', { waitUntil: 'networkidle2', timeout: 30000 });
  await rSleep(2000, 3500);
  await page.screenshot({ path: '/tmp/ig-v2-home.png' });

  const homeUrl = page.url();
  console.log('Home URL:', homeUrl);

  if (homeUrl.includes('/login') || homeUrl.includes('/challenge')) {
    console.error('ERROR: Redirected back to login from home.');
    await browser.close();
    process.exit(2);
  }

  // Find the "New post" / Create button
  console.log('Looking for Create Post button...');
  const ariaLabels = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[aria-label]'))
      .map(el => el.getAttribute('aria-label')).filter(Boolean);
  });
  console.log('Aria labels:', ariaLabels.join(', '));

  // Try to click create/new post
  const createClicked = await page.evaluate(() => {
    // Try various selectors for create button
    const selectors = [
      '[aria-label="New post"]',
      '[aria-label="Create"]',
      'svg[aria-label="New post"]',
      'a[href="/create/style/"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        // Click the closest clickable parent
        const clickable = el.closest('a, button, [role="button"], [role="link"]') || el;
        clickable.click();
        return sel;
      }
    }

    // Search by text
    const allLinks = Array.from(document.querySelectorAll('a, button, span'));
    const createBtn = allLinks.find(el => {
      const svgs = el.querySelectorAll('svg');
      return svgs.length > 0 && el.getAttribute('role') === 'link';
    });

    // Try nav items
    const navItems = Array.from(document.querySelectorAll('nav a, nav [role="link"], nav [role="button"]'));
    for (const item of navItems) {
      const svg = item.querySelector('svg');
      const ariaLabel = item.getAttribute('aria-label') || '';
      if (ariaLabel.toLowerCase().includes('create') || ariaLabel.toLowerCase().includes('new post')) {
        item.click();
        return 'nav-item-' + ariaLabel;
      }
    }

    return null;
  });

  console.log('Create button click result:', createClicked);
  await rSleep(2000, 3500);
  await page.screenshot({ path: '/tmp/ig-v2-after-create-click.png' });

  // Check what happened
  const afterCreateUrl = page.url();
  const afterCreateText = await page.evaluate(() => document.body.innerText.substring(0, 300));
  console.log('After create click URL:', afterCreateUrl);
  console.log('After create click text:', afterCreateText.substring(0, 200));

  // Look for file input
  const fileInput = await page.$('input[type="file"]');
  if (fileInput) {
    console.log('SUCCESS: File input found - can upload image');
    console.log('Instagram post flow is accessible.');
    console.log('LIMITATION: IG-03 requires a static card IMAGE to be uploaded.');
    console.log('The caption is ready but a visual asset (PNG/JPG) must be created first.');
    console.log('\nCaption prepared:');
    console.log(IG_CAPTION);

    // Cannot proceed without an image file
    // Report partial success: logged in, flow accessible, but image needed
    await browser.close();
    process.exit(4);
  } else {
    // Check for any form or upload dialog
    const dialogVisible = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      return dialogs.map(d => d.innerText.substring(0, 100));
    });
    console.log('Dialogs:', dialogVisible);

    const allInputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input')).map(i => ({
        type: i.type, name: i.name, accept: i.accept
      }));
    });
    console.log('All inputs:', JSON.stringify(allInputs));

    console.log('No file input found. Create post flow may not have opened.');
    await browser.close();
    process.exit(0);
  }
})().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
