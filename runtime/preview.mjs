// Speed preview verification: opens the built app (served by `vite preview`) in headless Chromium, waits for it to
// render, and captures screenshots plus runtime diagnostics. Never reads or reports the job token.
// Visual QA & Refinement Engine (visual_qa_refiner): visits every relevant page (routes from the Build Specification
// plus internal links discovered on the homepage), at desktop/tablet/mobile on the homepage and desktop/mobile on the
// other pages, and tests navigation, the mobile menu, links and forms.
// Usage: node runtime/preview.mjs <url> <playwrightModulePath> [optionsJson]  → prints one JSON line with the result.
const [, , url, pwPath, optJson] = process.argv;
let opts = {}; try { opts = JSON.parse(optJson || "{}") || {}; } catch {}
const { chromium } = await import(pwPath);

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 820, height: 1180, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
  { name: "mobile", width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
];
const MAX_ROUTES = 6, MAX_SHOTS = 10;
const origin = new URL(url).origin;
const norm = (p) => { const s = String(p || "/").split(/[?#]/)[0].replace(/\/+$/, ""); return s || "/"; };
let shots = 0;
const MAX_LIST = 25;
const cut = (s, n = 400) => String(s ?? "").slice(0, n);

async function inspect(browser, vp, route = "/", extra = {}) {
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
    const res = await page.goto(new URL(route, origin).toString(), { waitUntil: "load", timeout: 30_000 });
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
  const fx = loaded ? await page.evaluate((min) => {
    const vis = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none" && +s.opacity !== 0; };
    const links = [...document.querySelectorAll("a[href]")].map((a) => ({ href: a.getAttribute("href") || "", text: (a.textContent || a.getAttribute("aria-label") || "").trim().slice(0, 40) }))
      .filter((l) => l.href.startsWith("/") || l.href.startsWith(location.origin) || /^[\w-]+\.html$/.test(l.href)).slice(0, 40);
    const forms = [...document.querySelectorAll("form")].slice(0, 6).map((f) => { const inputs = [...f.querySelectorAll("input:not([type=hidden]),select,textarea")]; return { fields: inputs.length, submit: !!f.querySelector("button:not([type=button]),input[type=submit]"), unlabeled: inputs.filter((i) => !(i.id && document.querySelector(`label[for="${CSS.escape(i.id)}"]`)) && !i.closest("label") && !i.getAttribute("aria-label") && !i.getAttribute("placeholder")).length }; });
    const small = [...document.querySelectorAll("a,button,[role=button]")].filter(vis).filter((el) => { const r = el.getBoundingClientRect(); return r.width < min && r.height < min; }).length;
    const navLinks = [...document.querySelectorAll("nav a, header a, [role=navigation] a")].filter(vis).length;
    return { links, forms, small, navLinks };
  }, 24).catch(() => null) : null;
  let mobileMenu = null;
  if (loaded && extra.menu) {
    // Mobile navigation test: find a visible menu toggle, click it, and confirm navigation links become visible.
    try {
      const sel = 'button[aria-label*="menu" i], button[aria-controls], button[aria-expanded], [class*="hamburger" i], [class*="menu-toggle" i], [class*="menuToggle"], [data-testid*="menu" i]';
      const t = page.locator(sel).filter({ visible: true }).first();
      if (await t.count()) {
        const before = fx?.navLinks ?? 0;
        await t.click({ timeout: 3000 });
        await page.waitForTimeout(600);
        const after = await page.evaluate(() => [...document.querySelectorAll("nav a, header a, [role=navigation] a, [role=dialog] a, aside a")].filter((el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none" && +s.opacity !== 0 && r.right > 0 && r.left < innerWidth; }).length);
        mobileMenu = { toggle: true, opened: after > before, linksBefore: before, linksAfter: after };
        if (mobileMenu.opened) await t.click({ timeout: 2000 }).catch(() => {});
      } else mobileMenu = { toggle: false, opened: false };
    } catch (e) { mobileMenu = { toggle: true, opened: false, error: cut(e.message, 200) }; }
  }
  let screenshot = null;
  if (shots < MAX_SHOTS) { try { screenshot = (await page.screenshot({ type: "jpeg", quality: vp.name === "desktop" ? 50 : 45, fullPage: false })).toString("base64"); shots++; } catch {} }
  let navCheck = null;
  if (loaded && extra.nav && fx) {
    // In-app navigation test: click the first internal link to another page and confirm the page changed.
    const target = fx.links.map((l) => norm(new URL(l.href, page.url()).pathname)).find((p) => p !== norm(route));
    if (target) {
      try {
        const link = page.locator(`a[href="${target}"], a[href="${target}/"], a[href="${origin}${target}"]`).filter({ visible: true }).first();
        if (await link.count()) {
          await link.click({ timeout: 3000 });
          await page.waitForTimeout(900);
          navCheck = { from: norm(route), to: target, ok: norm(new URL(page.url()).pathname) === target };
          if (!navCheck.ok) navCheck.error = `still on ${new URL(page.url()).pathname}`;
        }
      } catch (e) { navCheck = { from: norm(route), to: target, ok: false, error: cut(e.message, 200) }; }
    }
  }
  await ctx.close();
  return { route: norm(route), viewport: vp.name, width: vp.width, height: vp.height, loaded, loadError, status, consoleErrors, consoleWarnings, pageErrors, failedRequests, dom, screenshot,
    links: fx?.links?.slice(0, 25) ?? [], forms: fx?.forms ?? [], smallTapTargets: vp.name === "desktop" ? 0 : fx?.small ?? 0, mobileMenu, navCheck };
}

const browser = await chromium.launch({ headless: true });
const views = [];
try {
  const [desktop, tablet, mobile] = VIEWPORTS;
  const home = await inspect(browser, desktop, "/", { nav: true });
  views.push(home);
  // Page discovery: Build Specification routes + internal links found on the homepage (same origin, page-like paths).
  const found = (home.links || []).map((l) => { try { return norm(new URL(l.href, origin).pathname); } catch { return null; } }).filter((p) => p && !/\.(png|jpe?g|svg|webp|pdf|zip|css|js)$/i.test(p));
  const routes = [...new Set([...(Array.isArray(opts.routes) ? opts.routes : []).map(norm), ...found])].filter((r) => r !== "/" && r.startsWith("/")).slice(0, MAX_ROUTES - 1);
  views.push(await inspect(browser, tablet, "/", { menu: true }));
  views.push(await inspect(browser, mobile, "/", { menu: true }));
  for (const r of routes) views.push(await inspect(browser, desktop, r));
  for (const r of routes) views.push(await inspect(browser, mobile, r));
}
finally { await browser.close(); }
process.stdout.write(`\n@@PREVIEW@@${JSON.stringify({ url, views, routes: [...new Set(views.map((v) => v.route))] })}\n`);
