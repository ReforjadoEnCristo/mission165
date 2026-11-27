const { test, expect } = require("@playwright/test");

test.use({ viewport: { width: 390, height: 844 } });

async function boot(page){
  const errors = [];
  page.on("pageerror", function(err){ errors.push(String(err)); });
  page.on("console", function(msg){ if (msg.type()==="error") errors.push(msg.text()); });
  await page.route("https://api.jsonbin.io/**", function(route){
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ record: { updatedAt: 1, data: {} }, metadata: { id: "6ae6c009ac6210605a62d670" } })
    });
  });
  await page.goto("/index.html");
  await page.waitForFunction(function(){ return window.__m165SelfCheckOk === true; });
  return errors;
}

async function openHipThrust(page){
  await page.evaluate(function(){
    state.view = "workout";
    state.dayIdx = 0;
    state.logDate = "2026-11-24";
    state.open = { 0: true };
    loadDay(0);
    renderApp();
  });
  await expect(page.locator(".card.open .ex-name")).toHaveText("Banded Barbell Hip Thrust");
}

function noisy(errors){
  return errors.filter(function(e){
    return e.indexOf("Failed to register a ServiceWorker") < 0 && e.indexOf("favicon") < 0;
  });
}

test("checking a set starts the prescribed rest", async function({ page }){
  const errors = await boot(page);
  await openHipThrust(page);
  const before = await page.evaluate(function(){ return { running: RA.running, ex: RA.ex }; });
  expect(before.running).toBe(false);

  const row = page.locator('.card.open tr[data-n="1"]');
  await row.locator(".sg-c").check();
  await expect(row).toHaveClass(/is-ok/);

  const started = await page.evaluate(function(){
    return { running: RA.running, base: RA.base, ex: RA.ex, left: RA.left, saved: !!localStorage.getItem("m165-rest-timer") };
  });
  expect(started.running).toBe(true);
  expect(started.base).toBe(120);
  expect(started.ex).toBe("Banded Barbell Hip Thrust");
  expect(started.left).toBeGreaterThan(100);
  expect(started.left).toBeLessThanOrEqual(120);
  expect(started.saved).toBe(true);
  await expect(page.locator(".card.open .t-main")).toHaveText("Pause");
  await expect(page.locator("#restChip")).toContainText("Rest");

  const endAt = await page.evaluate(function(){ return RA.endAt; });
  await page.evaluate(function(){ renderApp(); });
  const afterRender = await page.evaluate(function(){
    return { endAt: RA.endAt, running: RA.running, label: document.querySelector(".card.open .t-main").textContent };
  });
  expect(afterRender.endAt).toBe(endAt);
  expect(afterRender.running).toBe(true);
  expect(afterRender.label).toBe("Pause");

  await page.locator(".card.open .timer-box").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/opt/cursor/artifacts/rest_timer_autostart.png" });
  expect(noisy(errors)).toEqual([]);
});

test("manual start, pause, +15s, and presets still work", async function({ page }){
  const errors = await boot(page);
  await openHipThrust(page);
  await page.locator(".card.open .t-main").click();
  await expect(page.locator(".card.open .t-main")).toHaveText("Pause");
  const before = await page.evaluate(function(){ return RA.endAt; });
  await page.locator(".card.open .plus").click();
  const added = await page.evaluate(function(){ return { endAt: RA.endAt, running: RA.running }; });
  expect(added.running).toBe(true);
  expect(added.endAt - before).toBeGreaterThanOrEqual(14000);
  expect(added.endAt - before).toBeLessThanOrEqual(16000);
  await page.locator(".card.open .t-main").click();
  await expect(page.locator(".card.open .t-main")).toHaveText("Resume");
  expect(await page.evaluate(function(){ return RA.running; })).toBe(false);
  await page.locator(".card.open .rst").click();
  expect(await page.evaluate(function(){ return RA.ex; })).toBe(null);
  await expect(page.locator(".card.open .t-main")).toHaveText("Start");
  await page.locator('.card.open .t-pre[data-s="90"]').click();
  expect(await page.evaluate(function(){ return { running: RA.running, base: RA.base }; })).toEqual({ running: true, base: 90 });
  expect(noisy(errors)).toEqual([]);
});

test("voice checkbox starts rest and a sync pull does not", async function({ page }){
  const errors = await boot(page);
  await page.evaluate(function(){
    state.view = "workout";
    state.dayIdx = 0;
    state.logDate = "2026-11-24";
    state.open = { 0: true };
    loadDay(0);
    var ex = DAYS[0].exercises[0];
    writeRows(ex, [{ n: 1, weight: 185, reps: 6, confirmed: false, source: "voice", note: "", planned: false, loggedAt: Date.now() }]);
    renderApp();
  });
  await page.locator('.card.open tr[data-n="1"] .sg-c').check();
  expect(await page.evaluate(function(){
    return { running: RA.running, base: RA.base, ex: RA.ex };
  })).toEqual({ running: true, base: 120, ex: "Banded Barbell Hip Thrust" });

  await page.evaluate(function(){ raReset(RA.ex); });
  const synced = await page.evaluate(function(){
    applyPendingListToGrids([{
      id: "voice-late",
      date: state.logDate,
      dayId: DAYS[0].id,
      source: "voice",
      exercises: [{ name: "Banded Barbell Hip Thrust", sets: [{ n: 2, weight: 200, reps: 6, confirmed: true }] }]
    }]);
    return { running: !!RA.running, ex: RA.ex };
  });
  expect(synced).toEqual({ running: false, ex: null });
  expect(noisy(errors)).toEqual([]);
});

test("countdown follows the wall clock across background and reload", async function({ page }){
  const errors = await boot(page);
  await openHipThrust(page);
  await page.locator('.card.open tr[data-n="1"] .sg-c').check();
  const endAt = await page.evaluate(function(){ return RA.endAt; });

  const jumped = await page.evaluate(function(){
    clearInterval(RA.iv);
    RA.iv = null;
    RA.endAt = Date.now() + 25000;
    RA.base = 120;
    RA.running = true;
    RA.alerted = false;
    raPersist();
    document.dispatchEvent(new Event("visibilitychange"));
    return { running: RA.running, left: RA.left, alerted: RA.alerted };
  });
  expect(jumped.running).toBe(true);
  expect(jumped.alerted).toBe(false);
  expect(jumped.left).toBeGreaterThanOrEqual(24);
  expect(jumped.left).toBeLessThanOrEqual(25);

  const warn = await page.evaluate(function(){
    RA.running = true;
    RA.alerted = false;
    RA.warned = false;
    RA.warnDismissed = false;
    RA.base = 120;
    RA.endAt = Date.now() + 9000;
    raTick();
    var b = document.getElementById("restBanner");
    return { hidden: b.hidden, text: b.innerText, warned: RA.warned, running: RA.running };
  });
  expect(warn.running).toBe(true);
  expect(warn.warned).toBe(true);
  expect(warn.hidden).toBe(false);
  expect(warn.text).toMatch(/10 seconds/);

  const storedEnd = await page.evaluate(function(){
    RA.alerted = false;
    RA.warned = false;
    RA.bannerOff = false;
    RA.running = true;
    RA.base = 120;
    RA.ex = "Banded Barbell Hip Thrust";
    RA.endAt = Date.now() + 40000;
    raHideBanner();
    raPersist();
    return RA.endAt;
  });
  await page.reload();
  await page.waitForFunction(function(){ return window.__m165SelfCheckOk === true; });
  const restored = await page.evaluate(function(){
    var chip = document.getElementById("restChip");
    return { running: RA.running, endAt: RA.endAt, left: RA.left, ex: RA.ex, chip: chip ? chip.textContent : "" };
  });
  expect(restored.running).toBe(true);
  expect(restored.endAt).toBe(storedEnd);
  expect(restored.ex).toBe("Banded Barbell Hip Thrust");
  expect(restored.left).toBeGreaterThan(30);
  expect(restored.left).toBeLessThanOrEqual(40);
  expect(restored.chip).toMatch(/^Rest /);
  await page.screenshot({ path: "/opt/cursor/artifacts/rest_timer_after_reload.png" });

  await page.evaluate(function(){
    state.open = { 0: true };
    renderApp();
    clearInterval(RA.iv);
    RA.iv = null;
    RA.running = true;
    RA.alerted = false;
    RA.bannerOff = false;
    RA.endAt = Date.now() - 800;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("#restBanner")).toBeVisible();
  await expect(page.locator("#restBanner")).toContainText("Rest is over");
  await expect(page.locator(".card.open .timer-time")).toHaveText("0:00");
  await expect(page.locator(".card.open .timer-box")).toHaveAttribute("data-state", "done");
  await page.locator(".card.open .timer-box").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/opt/cursor/artifacts/rest_timer_time_up.png" });
  expect(noisy(errors)).toEqual([]);
});
