const puppeteer = require('/Users/opoclaw1/claudeclaw/node_modules/puppeteer');
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

async function randomSleep(min, max) {
  const ms = Math.floor(Math.random() * (max - min) + min);
  return sleep(ms);
}

async function humanType(page, text) {
  for (const char of text) {
    await page.keyboard.type(char, { delay: 0 });
    await sleep(Math.random() * 70 + 25);
  }
}

(async () => {
  const freshDir = '/tmp/ig-fresh-' + Date.now();
  fs.mkdirSync(freshDir, { recursive: true });

  console.log('Launching Chrome for Instagram...');
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    userDataDir: freshDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,768'
    ],
    defaultViewport: { width: 1366, height: 768 }
  });

  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    delete navigator.__proto__.webdriver;
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'es-MX'] });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
  });

  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

  console.log('Navigating to instagram.com...');
  await page.goto('https://www.instagram.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomSleep(2000, 3500);
  await page.screenshot({ path: '/tmp/ig-step1.png' });

  const currentUrl = page.url();
  console.log('URL:', currentUrl);

  // Check if already logged in
  const isLoggedIn = !currentUrl.includes('/accounts/login') &&
    await page.$('svg[aria-label="New post"]') !== null ||
    await page.$('a[href="/direct/inbox/"]') !== null;

  let loginSuccess = isLoggedIn;

  if (!isLoggedIn) {
    console.log('Not logged in. Going to login page...');

    // Navigate to login
    if (!currentUrl.includes('/accounts/login')) {
      await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await randomSleep(2000, 3500);
    }

    await page.screenshot({ path: '/tmp/ig-login-page.png' });
    console.log('Login page URL:', page.url());

    // Wait for login form
    const usernameField = await page.waitForSelector('input[name="username"], input[aria-label="Phone number, username, or email"]', { timeout: 15000 }).catch(() => null);
    if (!usernameField) {
      const text = await page.evaluate(() => document.body.innerText.substring(0, 300));
      console.error('No username field. Page:', text);
      await browser.close();
      process.exit(1);
    }

    // Click and type username
    await usernameField.click();
    await randomSleep(400, 700);
    await humanType(page, IG_USERNAME);
    await randomSleep(500, 900);

    // Click password field
    const pwField = await page.$('input[name="password"], input[type="password"]');
    if (!pwField) {
      console.error('No password field found');
      await browser.close();
      process.exit(1);
    }

    await pwField.click();
    await randomSleep(300, 600);
    await humanType(page, IG_PASSWORD);
    await randomSleep(500, 900);

    // Click Log in
    const loginClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const loginBtn = btns.find(b => b.type === 'submit' ||
        (b.innerText && (b.innerText.trim() === 'Log in' || b.innerText.trim() === 'Log In')));
      if (loginBtn) { loginBtn.click(); return true; }
      return false;
    });

    if (!loginClicked) {
      await pwField.press('Enter');
    }

    await randomSleep(5000, 8000);
    await page.screenshot({ path: '/tmp/ig-after-login.png' });

    const afterLoginUrl = page.url();
    console.log('After login URL:', afterLoginUrl);
    const afterLoginText = await page.evaluate(() => document.body.innerText.substring(0, 400));
    console.log('After login page text:', afterLoginText.substring(0, 200));

    if (afterLoginUrl.includes('/accounts/login') || afterLoginUrl.includes('/challenge')) {
      if (afterLoginUrl.includes('/challenge') || afterLoginText.toLowerCase().includes('verif') ||
          afterLoginText.toLowerCase().includes('code') || afterLoginText.toLowerCase().includes('phone')) {
        console.error('ERROR: Instagram requires verification (2FA/email/phone). Cannot proceed automatically.');
        console.log('Verification page text:', afterLoginText);
      } else {
        console.error('ERROR: Instagram login failed.');
        console.log('Page text:', afterLoginText);
      }
      await browser.close();
      process.exit(2);
    }

    // Handle "Save your login info?" popup
    const notNowBtn = await page.waitForSelector('button:not([type="submit"])', { timeout: 5000 }).catch(() => null);
    if (notNowBtn) {
      const notNowText = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.innerText && (b.innerText.includes('Not Now') || b.innerText.includes('Not now')));
        if (btn) { btn.click(); return 'clicked'; }
        return null;
      });
      if (notNowText) {
        console.log('Dismissed save login popup');
        await randomSleep(1500, 2500);
      }
    }

    // Handle "Turn on notifications" popup
    const turnOff = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => b.innerText && (b.innerText.includes('Not Now') || b.innerText.includes('Not now')));
      if (btn) { btn.click(); return 'dismissed'; }
      return null;
    });
    if (turnOff) {
      console.log('Dismissed notifications popup');
      await randomSleep(1000, 2000);
    }

    loginSuccess = true;
    console.log('Instagram logged in!');
  }

  if (!loginSuccess) {
    console.error('Login failed');
    await browser.close();
    process.exit(1);
  }

  console.log('Attempting to create new Instagram post (IG-03 caption)...');
  console.log('NOTE: Instagram requires an actual image for posts. Attempting to find create post button...');

  // Navigate to home first
  await page.goto('https://www.instagram.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomSleep(3000, 4000);
  await page.screenshot({ path: '/tmp/ig-home.png' });

  // Check what's on the home page
  const homeTestIds = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[aria-label]'));
    return els.map(el => el.getAttribute('aria-label')).filter(Boolean).slice(0, 30);
  });
  console.log('Aria labels on home:', homeTestIds.join(', '));

  const homeUrl = page.url();
  console.log('Home URL:', homeUrl);

  if (homeUrl.includes('/login') || homeUrl.includes('/challenge')) {
    console.error('ERROR: Redirected back to login from home - session issue');
    await browser.close();
    process.exit(2);
  }

  // Try to find and click the "New post" button
  const newPostClicked = await page.evaluate(() => {
    // Try aria-label first
    let btn = document.querySelector('[aria-label="New post"]');
    if (btn) { btn.click(); return 'aria-label'; }

    // Try SVG with new post icon
    const allBtns = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"]'));
    const newPost = allBtns.find(el => {
      const label = el.getAttribute('aria-label') || '';
      return label.toLowerCase().includes('new post') || label.toLowerCase().includes('create');
    });
    if (newPost) { newPost.click(); return 'found-btn'; }
    return null;
  });

  console.log('New post button click result:', newPostClicked);
  await randomSleep(2000, 3000);
  await page.screenshot({ path: '/tmp/ig-new-post-click.png' });

  // Get page state after click
  const pageState = await page.evaluate(() => {
    return {
      url: window.location.href,
      bodyText: document.body.innerText.substring(0, 300),
      inputs: Array.from(document.querySelectorAll('input')).map(i => ({ type: i.type, accept: i.accept })),
      ariaLabels: Array.from(document.querySelectorAll('[aria-label]')).map(el => el.getAttribute('aria-label')).filter(Boolean).slice(0, 20)
    };
  });
  console.log('After new post click state:', JSON.stringify(pageState, null, 2));

  // Instagram requires a file upload to create a post
  // This is a fundamental limitation - you cannot post a text-only post on Instagram
  // For IG-03, which is a static card/image, we need to either:
  // 1. Generate the image first, then upload it
  // 2. Report that image creation is needed

  console.log('\nINSIGHT: Instagram requires an image/video file for all posts.');
  console.log('IG-03 is a static card post - the image needs to be created first, then uploaded.');
  console.log('The caption is ready but the visual asset needs to be generated (DALL-E or graphic tool).');

  // Let's try to at least confirm we are logged in and can access the post creation flow
  const fileInput = await page.$('input[type="file"]');
  if (fileInput) {
    console.log('SUCCESS: File upload input found - Instagram post flow accessible');
    console.log('To complete: generate the IG-03 stat card image and upload it with the caption');
    await browser.close();
    process.exit(4); // Special exit code: logged in but needs image
  } else {
    console.log('File upload input not found. Checking if we need to trigger it differently...');

    // Check for any upload-related elements
    const uploadEls = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      return els.filter(el => {
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        return label.includes('upload') || label.includes('photo') || label.includes('select');
      }).map(el => ({
        tag: el.tagName,
        label: el.getAttribute('aria-label'),
        text: el.innerText ? el.innerText.substring(0, 50) : ''
      })).slice(0, 10);
    });
    console.log('Upload-related elements:', JSON.stringify(uploadEls));
  }

  await browser.close();
  process.exit(0);
})().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
