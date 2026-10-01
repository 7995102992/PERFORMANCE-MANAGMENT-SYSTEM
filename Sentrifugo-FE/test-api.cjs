const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  page.on('response', async response => {
    if (response.url().includes('/trips') && response.request().method() === 'GET') {
      console.log('GET', response.url());
      console.log('STATUS', response.status());
      try {
         console.log('BODY', (await response.text()).substring(0, 500));
      } catch (e) {}
    }
  });

  await page.goto('http://localhost:8004/login');
  await page.fill('input[type="email"]', 'manager1@acme.com');
  await page.fill('input[type="password"]', 'Password123!');
  await page.click('button:has-text("Log In")');
  
  await page.waitForTimeout(2000);
  await page.goto('http://localhost:8004/expenses/team-trips');
  await page.waitForTimeout(3000);
  
  await browser.close();
})();
