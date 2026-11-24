const { test, expect } = require("@playwright/test");

test("duplicate sets are skipped and a correction stays on the same row", async function({ page }){
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

  const logic = await page.evaluate(function(){
    var now = 100000;
    var twice = mergeSetRows(
      [{n:1, weight:180, reps:12, confirmed:true, loggedAt:now}],
      [{n:1, weight:180, reps:12, loggedAt:now + 1000}],
      {date:"2026-11-24", dayId:1, exercise:"Deep Leg Press"}
    );
    var fixed = mergeSetRows(
      twice.rows,
      [{n:1, weight:190, reps:8, edit:true, loggedAt:now + 2000}],
      {date:"2026-11-24", dayId:1, exercise:"Deep Leg Press", mode:"edit"}
    );
    var both = mergeSetRows(
      [{n:1, weight:180, reps:10, loggedAt:now}],
      [{n:2, weight:180, reps:10, loggedAt:now + 3000}],
      {date:"2026-11-24", dayId:1, exercise:"Leg Press Calf Raise"}
    );
    return {
      skipped: twice.skipped.length,
      stillOne: twice.rows.length,
      corrected: fixed.rows.length===1 && fixed.rows[0].weight===190 && fixed.rows[0].reps===8,
      kept: both.rows.length
    };
  });
  expect(logic).toEqual({ skipped: 1, stillOne: 1, corrected: true, kept: 2 });

  await page.evaluate(function(){
    state.view = "workout";
    state.dayIdx = 0;
    state.logDate = "2026-11-24";
    state.open = {};
    loadDay(0);
    DAYS[0].exercises.forEach(function(ex, i){
      if (ex.name === "Deep Leg Press") state.open[i] = true;
    });
    renderApp();
  });
  const row = page.locator('.card.open tr[data-n="1"]');
  await row.locator(".sg-w").fill("180");
  await row.locator(".sg-r").fill("12");
  await row.locator(".sg-c").check();
  await page.locator(".card.open .save-btn").click();
  await page.locator(".card.open .save-btn").click();
  await expect(page.locator("#saveToast")).toHaveText("Already logged — skipped duplicate");

  const afterDup = await page.evaluate(function(){
    var hist = JSON.parse(localStorage.getItem("m165-history") || "[]");
    var session = hist.filter(function(h){ return h.id === "2026-11-24-1"; })[0];
    var ex = session.exercises.filter(function(e){ return e.name === "Deep Leg Press"; })[0];
    return { sets: ex.sets.length, weight: ex.sets[0].weight, reps: ex.sets[0].reps };
  });
  expect(afterDup).toEqual({ sets: 1, weight: 180, reps: 12 });

  await row.locator(".sg-w").fill("190");
  await row.locator(".sg-r").fill("8");
  await page.locator(".card.open .save-btn").click();
  const afterEdit = await page.evaluate(function(){
    var hist = JSON.parse(localStorage.getItem("m165-history") || "[]");
    var sessions = hist.filter(function(h){ return h.id === "2026-11-24-1"; });
    var ex = sessions[0].exercises.filter(function(e){ return e.name === "Deep Leg Press"; })[0];
    return { sessions: sessions.length, sets: ex.sets.length, weight: ex.sets[0].weight, reps: ex.sets[0].reps };
  });
  expect(afterEdit).toEqual({ sessions: 1, sets: 1, weight: 190, reps: 8 });

  const noisy = errors.filter(function(e){
    return e.indexOf("Failed to register a ServiceWorker") < 0 && e.indexOf("favicon") < 0;
  });
  expect(noisy).toEqual([]);
});
