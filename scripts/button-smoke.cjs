const { chromium } = require("playwright");

const baseUrl = process.env.SMOKE_URL || "http://127.0.0.1:5173";
const pages = [
  "Command",
  "Take Attendance",
  "My Calendar",
  "Master Calendar",
  "Messages",
  "Tasks",
  "Security Gates",
  "Attendance Monitor",
  "Classes",
  "Attendance",
  "Students",
  "People",
  "Academics",
  "Behavior",
  "Lunch",
  "Staff",
  "Admin",
  "Integrations",
  "Reports",
  "Charts",
  "Agent API",
  "FACTS Sync"
];

const skipButton = /export|print|submit|connect|create invite|backup|test connection|import|bulk|audit|review permissions|link siblings/i;

async function closeOverlays(page) {
  const close = page.locator("button").filter({ hasText: /^Close$/ }).first();
  if (await close.isVisible().catch(() => false)) {
    await close.click();
    await page.waitForTimeout(80);
  }
  const closeMenu = page.locator("button").filter({ hasText: /^Close Menu$/ }).first();
  if (await closeMenu.isVisible().catch(() => false)) {
    await closeMenu.click();
    await page.waitForTimeout(80);
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });

  for (const name of pages) {
    await closeOverlays(page);
    await page.evaluate((label) => {
      const buttons = Array.from(document.querySelectorAll("nav button"));
      const button = buttons.find((item) => (item.textContent || "").includes(label));
      if (!button) throw new Error(`Missing nav button: ${label}`);
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }, name);
    await page.waitForTimeout(150);
    const locator = page.locator("main button:visible");
    const count = Math.min(await locator.count(), 70);
    for (let i = 0; i < count; i += 1) {
      const button = locator.nth(i);
      const text = (await button.innerText({ timeout: 1000 }).catch(() => "")).trim();
      if (!text || skipButton.test(text)) continue;
      try {
        await button.click({ timeout: 1500 });
        await page.waitForTimeout(60);
        await closeOverlays(page);
      } catch (error) {
        errors.push(`Button failed on ${name}: ${text} (${error.message})`);
      }
    }
  }

  await browser.close();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log(`Button smoke passed across ${pages.length} pages.`);
})();
