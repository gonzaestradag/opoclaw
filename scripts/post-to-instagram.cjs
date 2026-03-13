const puppeteer = require('/Users/opoclaw1/opoclaw/node_modules/puppeteer');
const path = require('path');
const { execSync } = require('child_process');

const USERNAME = 'thorn.opoclaw';
const PASSWORD = 'GOnza2002';

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
  return sleep(min + Math.random() * (max - min));
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

  console.log('Navigating to Instagram login...');
  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomSleep(3000, 5000);

  // Accept cookies if presented
  const cookieBtn = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const accept = btns.find(b => b.innerText && (b.innerText.toLowerCase().includes('accept') || b.innerText.toLowerCase().includes('allow') || b.innerText.toLowerCase().includes('i accept')));
    if (accept) { accept.click(); return true; }
    return false;
  });
  if (cookieBtn) {
    console.log('Accepted cookies');
    await sleep(1000);
  }

  const inputs = await page.$$eval('input', els => els.map(el => ({type: el.type, name: el.name, placeholder: el.placeholder, autocomplete: el.autocomplete})));
  console.log('Inputs:', JSON.stringify(inputs));

  // Find username input - Instagram uses name="email" for the username/email field on web
  const usernameInput = await page.$('input[name="email"], input[name="username"], input[autocomplete="username"]');
  if (!usernameInput) {
    console.error('Username/email field not found');
    await page.screenshot({ path: '/tmp/ig-no-field.png' });
    await browser.close();
    process.exit(1);
  }

  await usernameInput.click();
  await randomSleep(300, 600);
  for (const char of USERNAME) {
    await page.keyboard.type(char);
    await randomSleep(60, 150);
  }
  await randomSleep(500, 900);
  console.log('Username entered');

  // Password
  const passwordInput = await page.$('input[name="pass"], input[name="password"], input[type="password"]');
  if (!passwordInput) {
    console.error('Password field not found');
    await browser.close();
    process.exit(1);
  }

  await passwordInput.click();
  await randomSleep(300, 600);
  for (const char of PASSWORD) {
    await page.keyboard.type(char);
    await randomSleep(60, 150);
  }
  await randomSleep(500, 900);
  console.log('Password entered');

  // Click login
  const loginBtn = await page.$('button[type="submit"]');
  if (loginBtn) {
    await loginBtn.click();
    console.log('Clicked submit');
  } else {
    await passwordInput.press('Enter');
  }

  await sleep(8000);
  await page.screenshot({ path: '/tmp/ig-after-login.png' });

  const postLoginUrl = page.url();
  console.log('Post-login URL:', postLoginUrl);
  const postLoginText = await page.evaluate(() => document.body.innerText.substring(0, 500));
  console.log('Text:', postLoginText.substring(0, 300));

  if (postLoginUrl.includes('/accounts/login') || postLoginUrl.includes('/challenge') || postLoginUrl.includes('/error')) {
    const lower = postLoginText.toLowerCase();
    if (lower.includes('suspicious') || lower.includes('verify') || lower.includes('code') || lower.includes('confirm') || lower.includes('challenge')) {
      console.error('ERROR: Verification/2FA required');
      process.exit(2);
    }
    if (lower.includes('incorrect') || lower.includes('wrong') || lower.includes('password')) {
      console.error('ERROR: Wrong credentials');
      process.exit(1);
    }
    console.error('ERROR: Redirected back to login or error page');
    process.exit(3);
  }

  console.log('Login appears successful!');

  // Wait for page to fully load and dismiss any dialogs
  await sleep(2000);

  // Handle "Save your login info?" dialog
  const dismissed1 = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    const notNow = btns.find(b => {
      const t = b.innerText || '';
      return t.includes('Not now') || t.includes('Not Now') || t.includes('No, gracias') || t.includes('Ahora no');
    });
    if (notNow) { notNow.click(); return true; }
    return false;
  });
  if (dismissed1) {
    console.log('Dismissed save login dialog');
    await sleep(1500);
  }

  // Handle notifications dialog
  const dismissed2 = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    const notNow = btns.find(b => {
      const t = b.innerText || '';
      return t.includes('Not now') || t.includes('Not Now') || t.includes('No, gracias');
    });
    if (notNow) { notNow.click(); return true; }
    return false;
  });
  if (dismissed2) {
    console.log('Dismissed notifications dialog');
    await sleep(1500);
  }

  await page.screenshot({ path: '/tmp/ig-home.png' });
  console.log('Instagram home page loaded');

  // We need to create an image file for the stat card to post to Instagram
  // For now, let's try using the Instagram web create post flow with a pre-made image
  // First, let's check what the + button looks like
  const navContent = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[role="link"], [aria-label]')).slice(0, 20).map(el => ({
      tag: el.tagName,
      label: el.getAttribute('aria-label') || '',
      text: el.innerText?.substring(0, 30) || '',
      href: el.getAttribute('href') || ''
    }));
  });
  console.log('Nav items:', JSON.stringify(navContent.slice(0, 10)));

  // Create the stat card image for IG-03
  console.log('\nCreating stat card image for IG-03...');

  // We'll create a simple HTML/CSS card and screenshot it
  const statCardHtml = `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1080px; height: 1080px;
    background: #0a0e1a;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
  }
  .card {
    width: 900px;
    text-align: center;
    padding: 60px;
  }
  .small-header {
    font-size: 18px;
    letter-spacing: 4px;
    color: #0d9488;
    text-transform: uppercase;
    margin-bottom: 40px;
    font-weight: 600;
  }
  .headline {
    font-size: 72px;
    font-weight: 800;
    color: #ffffff;
    line-height: 1.1;
    margin-bottom: 30px;
  }
  .divider {
    width: 120px;
    height: 3px;
    background: #0d9488;
    margin: 30px auto;
  }
  .body-text {
    font-size: 36px;
    color: #e2e8f0;
    line-height: 1.5;
    margin-bottom: 20px;
  }
  .muted {
    font-size: 22px;
    color: #94a3b8;
    margin-top: 50px;
    letter-spacing: 2px;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="small-header">Estado actual de la IA en negocios</div>
    <div class="headline">El 73% de las empresas<br>dice que "usa IA".</div>
    <div class="divider"></div>
    <div class="body-text">Menos del 8% tiene<br>infraestructura de agentes.</div>
    <div class="body-text" style="color: #94a3b8;">El resto tiene<br>un chatbot glorificado.</div>
    <div class="muted">OpoClaw — opoclaw.com</div>
  </div>
</body>
</html>`;

  // Write HTML to temp file and screenshot it
  const fs = require('fs');
  const htmlPath = '/tmp/ig-stat-card.html';
  const imgPath = '/tmp/ig-stat-card.png';
  fs.writeFileSync(htmlPath, statCardHtml);

  const imgPage = await browser.newPage();
  await imgPage.setViewport({ width: 1080, height: 1080 });
  await imgPage.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded' });
  await sleep(500);
  await imgPage.screenshot({ path: imgPath, fullPage: false });
  await imgPage.close();
  console.log('Stat card image created at:', imgPath);

  // Now try to create a new Instagram post with this image
  // Click the + button to create a new post
  const createBtnClicked = await page.evaluate(() => {
    // Find create/new post button
    const selectors = [
      '[aria-label="New post"]',
      '[aria-label="Create"]',
      '[data-visualcompletion="ignore-dynamic"]',
      'svg[aria-label="New post"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const parent = el.closest('a, button, [role="button"]') || el;
        parent.click();
        return sel;
      }
    }
    // Try finding by href containing /create
    const links = Array.from(document.querySelectorAll('a'));
    const createLink = links.find(a => a.href && a.href.includes('/create'));
    if (createLink) { createLink.click(); return 'create link'; }
    return null;
  });
  console.log('Create button clicked:', createBtnClicked);
  await sleep(2000);

  await page.screenshot({ path: '/tmp/ig-create-dialog.png' });

  // Look for file upload input
  const fileInput = await page.$('input[type="file"]');
  if (fileInput) {
    console.log('Found file input, uploading image...');
    await fileInput.uploadFile(imgPath);
    await sleep(3000);
    await page.screenshot({ path: '/tmp/ig-uploaded.png' });
    console.log('Image uploaded');
  } else {
    console.log('No file input found. Create dialog may not have opened.');
    const dialogText = await page.evaluate(() => document.body.innerText.substring(0, 400));
    console.log('Current page text:', dialogText.substring(0, 200));
  }

  console.log('\n=== Instagram session established ===');
  console.log('Screenshots saved to /tmp/ig-*.png for verification');

  await browser.close();
  process.exit(0);
})().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
