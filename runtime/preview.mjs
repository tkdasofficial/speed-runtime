// Speed preview verification: opens the built app (served by `vite preview`) in headless Chromium, waits for it to
// render, and captures screenshots plus runtime diagnostics. Never reads or reports the job token.
// Usage: node runtime/preview.mjs <url> <playwrightModulePath>  → prints one JSON line with the result.
const [, , url, pwPath] = process.argv;
const { chromium } = await import(pwPath);

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
];
const MAX_LIST = 25;
const cut = (s, n = 400) => String(s ?? "").slice(0, n);

async function inspect(browser, vp) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor ?? 1 });
  const page = await ctx.newPage();
  const consoleErrors = [], consoleWarnings = [], pageErrors = [], failedRequests = [];
  page.on("console", (m) => {
    const t = m.type();
    if (t === "error" && consoleErrors.length < MAX_LIST) consoleErrors.push(cut(m.text()));
    else if (t === "warning" && consoleWarnings.length < 10) consoleWarnings.push(cut(m.text(), 200));
  });
  page.on("pageerror", (e) => { if (pageErrors.length < MAX_LIST) pageErrors.push(cut(`${e.name}: ${e.message}${e.stack ? `\n${e.stack.split("\n").slice(1, 4).join("\n")}` : ""}`, 700)); });
  page.on("requestfailed", (r) => { if (failedRequests.length < MAX_LIST) failedRequests.push({ url: cut(r.url(), 200), status: null, error: cut(r.failure()?.errorText, 120), type: r.resourceType() }); });
  page.on("response", (r) => { if (r.status() >= 400 && failedRequests.length < MAX_LIST) failedRequests.push({ url: cut(r.url(), 200), status: r.status(), error: null, type: r.request().resourceType() }); });

  let loaded = true, loadError = null, status = null;
  try {
    const res = await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    status = res?.status() ?? null;
  } catch (e) { loaded = false; loadError = cut(e.message, 300); }
  if (loaded) {
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    let last = -1;
    for (let i = 0; i < 16; i++) {
      const n = await page.evaluate(() => document.body ? document.body.innerHTML.length : 0).catch(() => 0);
      const loading = await page.evaluate(() => /^\s*(loading|please wait)\.{0,3}\s*$/i.test(document.body?.innerText ?? "")).catch(() => false);
      if (n === last && !loading) break;
      last = n;
      await page.waitForTimeout(500);
    }
  }
  const dom = loaded ? await page.evaluate(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const root = document.getElementById("root") || document.getElementById("app");
    let visible = 0, outside = 0;
    for (const el of document.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      if (r.width < 2 || r.height < 2 || s.visibility === "hidden" || s.display === "none" || +s.opacity === 0) continue;
      visible++;
      if (r.right > vw + 8 && s.position !== "fixed") outside++;
    }
    const imgs = [...document.images];
    return {
      title: document.title,
      bodyText: (document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1500),
      bodyTextLength: (document.body.innerText || "").trim().length,
      rootFound: !!root, rootChildren: root ? root.childElementCount : null, visibleElements: visible,
      headings: [...document.querySelectorAll("h1,h2,h3")].map((h) => h.textContent.trim()).filter(Boolean).slice(0, 15),
      hasNav: !!document.querySelector("nav, header, [role=navigation]"), hasFooter: !!document.querySelector("footer, [role=contentinfo]"),
      images: imgs.length, brokenImages: imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src).slice(0, 10),
      scrollWidth: document.documentElement.scrollWidth, viewportWidth: vw, horizontalOverflow: document.documentElement.scrollWidth > vw + 8,
      elementsOutsideViewport: outside, documentHeight: document.documentElement.scrollHeight, viewportHeight: vh,
      errorOverlay: !!document.querySelector("vite-error-overlay"),
      styles: (() => {
        // Browser-level style evidence: loaded sheets/rules, failed <link>s, class coverage and user-agent-default look.
        let rules = 0, unreadable = 0; const selectors = new Set();
        for (const sh of document.styleSheets) { try { const walk = (list) => { for (const r of list) { rules++; if (r.selectorText) for (const m of r.selectorText.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) selectors.add(m[1]); if (r.cssRules) walk(r.cssRules); } }; walk(sh.cssRules); } catch { unreadable++; } }
        const links = [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => ({ href: l.getAttribute("href"), loaded: !!l.sheet }));
        const classes = new Set(); for (const el of document.body.querySelectorAll("[class]")) for (const c of (el.getAttribute("class") || "").split(/\s+/)) if (/^[A-Za-z_][\w-]*$/.test(c)) classes.add(c);
        const unmatched = [...classes].filter((c) => !selectors.has(c));
        const bs = getComputedStyle(document.body), btn = document.querySelector("button"), a = document.querySelector("a");
        return { sheets: document.styleSheets.length, rules, unreadable, links, classCount: classes.size, unmatchedClasses: unmatched.slice(0, 20), unmatchedCount: unmatched.length,
          bodyMargin: bs.margin, bodyFont: bs.fontFamily.slice(0, 80), bodyBg: bs.backgroundColor,
          defaultLinkColor: a ? getComputedStyle(a).color === "rgb(0, 0, 238)" : null, defaultButton: btn ? getComputedStyle(btn).backgroundColor === "rgb(239, 239, 239)" || getComputedStyle(btn).backgroundColor === "rgb(240, 240, 240)" : null };
      })(),
    };
  }).catch((e) => ({ evaluateError: cut(e.message, 300) })) : null;
  let screenshot = null;
  try { screenshot = (await page.screenshot({ type: "jpeg", quality: vp.name === "desktop" ? 55 : 50, fullPage: false })).toString("base64"); } catch {}
  await ctx.close();
  return { viewport: vp.name, width: vp.width, height: vp.height, loaded, loadError, status, consoleErrors, consoleWarnings, pageErrors, failedRequests, dom, screenshot };
}

const browser = await chromium.launch({ headless: true });
const views = [];
try { for (const vp of VIEWPORTS) views.push(await inspect(browser, vp)); }
finally { await browser.close(); }
process.stdout.write(`\n@@PREVIEW@@${JSON.stringify({ url, views })}\n`);
