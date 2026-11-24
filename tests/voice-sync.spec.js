const { test, expect } = require("@playwright/test");

const BIN = "6ae6c009ac6210605a62d670";
const API = "https://api.jsonbin.io/v3/b/" + BIN;

function localISO(d){
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function voiceRecord(date, sets){
  const id = date + "-1";
  const gridKey = "m165-setgrid-draft-" + date + "-1";
  const history = [{
    id: id,
    date: date,
    dayId: 1,
    dayTitle: "Lower A — Glute & Quad Strength",
    doneCount: 1,
    total: 6,
    exercises: [{
      name: "Deep Leg Press",
      weight: sets.map(function(s){ return (s.weight == null ? "—" : s.weight) + "x" + (s.reps == null ? "—" : s.reps); }).join(", "),
      bonus: "",
      topSet: null,
      sets: sets.map(function(s){
        return { n: s.n, weight: s.weight, reps: s.reps, note: s.note || "", confirmed: true };
      })
    }]
  }];
  const grid = {
    "Deep Leg Press": sets.map(function(s){
      return { n: s.n, weight: s.weight, reps: s.reps, note: "", confirmed: s.weight != null, planned: false, source: "voice" };
    })
  };
  const data = {};
  data["m165-history"] = history;
  data[gridKey] = grid;
  return { updatedAt: Date.now(), data: data, gridKey: gridKey, id: id };
}

function attachBin(page, bin){
  const errors = [];
  page.on("pageerror", function(err){ errors.push(String(err)); });
  page.on("console", function(msg){
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.route("https://api.jsonbin.io/**", async function(route){
    const url = route.request().url();
    const method = route.request().method();
    if (url.indexOf(BIN) < 0){
      await route.fulfill({ status: 599, body: "blocked real jsonbin" });
      return;
    }
    if (method === "PUT" && url.indexOf("/latest") < 0){
      const body = JSON.parse(route.request().postData() || "{}");
      bin.updatedAt = body.updatedAt || Date.now();
      bin.data = body.data || {};
      bin.puts.push(JSON.parse(JSON.stringify(bin.data)));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ record: { updatedAt: bin.updatedAt, data: bin.data } }) });
      return;
    }
    if (method === "GET"){
      bin.gets += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ record: { updatedAt: bin.updatedAt, data: bin.data }, metadata: { id: BIN } }) });
      return;
    }
    await route.fulfill({ status: 599, body: "blocked " + method });
  });
  return errors;
}

async function openLegPress(page, date){
  await page.evaluate(function(date){
    state.view = "workout";
    state.dayIdx = 0;
    state.logDate = date;
    state.open = {};
    loadDay(0);
    DAYS[0].exercises.forEach(function(ex, i){
      if (ex.name === "Deep Leg Press") state.open[i] = true;
    });
    renderApp();
  }, date);
}

test("two devices pick up a mocked Grok voice log and a later set", async function({ browser }){
  const today = localISO(new Date());
  const voice = voiceRecord(today, [
    { n: 1, weight: 193, reps: 10 },
    { n: 2, weight: null, reps: null }
  ]);
  const bin = { updatedAt: voice.updatedAt, data: voice.data, puts: [], gets: 0 };

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const laptop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageA = await phone.newPage();
  const pageB = await laptop.newPage();
  const errorsA = attachBin(pageA, bin);
  const errorsB = attachBin(pageB, bin);

  await pageA.goto("/index.html");
  await pageA.waitForFunction(function(args){
    const hist = JSON.parse(localStorage.getItem("m165-history") || "[]");
    return localStorage.getItem("m165-sync-id") === args.bin && hist.some(function(h){ return h.id === args.session; });
  }, { bin: BIN, session: voice.id });

  const paired = await pageA.evaluate(function(id){ return localStorage.getItem("m165-sync-id"); }, BIN);
  expect(paired).toBe(BIN);

  await openLegPress(pageA, today);
  await expect(pageA.locator(".card.open .sg-w").nth(0)).toHaveValue("193");
  await expect(pageA.locator(".card.open .sg-r").nth(0)).toHaveValue("10");
  await pageA.evaluate(function(){ state.view = "history"; renderApp(); });
  const histA = pageA.locator(".hist-entry").filter({ hasText: "Deep Leg Press" });
  await expect(histA).toContainText("Deep Leg Press");
  await expect(histA).toContainText("193");
  expect(errorsA.filter(function(e){ return e.indexOf("blocked real jsonbin") >= 0; })).toEqual([]);

  await openLegPress(pageA, today);
  const row = pageA.locator('.card.open tr[data-n="2"]');
  await row.locator(".sg-w").fill("225");
  await row.locator(".sg-r").fill("8");
  await row.locator(".sg-c").check();
  await pageA.locator(".card.open .save-btn").click();
  await expect.poll(function(){
    return bin.puts.some(function(data){
      const raw = JSON.stringify(data);
      return raw.indexOf("225") >= 0 && raw.indexOf("193") >= 0;
    });
  }, { timeout: 8000 }).toBe(true);

  await pageB.goto("/index.html");
  await pageB.waitForFunction(function(session){
    const hist = JSON.parse(localStorage.getItem("m165-history") || "[]");
    return localStorage.getItem("m165-sync-id") === "6ae6c009ac6210605a62d670" && hist.some(function(h){
      const ex = (h.exercises || []).filter(function(e){ return e.name === "Deep Leg Press"; })[0];
      if (!ex || h.id !== session) return false;
      const weights = (ex.sets || []).map(function(s){ return s.weight; });
      return weights.indexOf(193) >= 0 && weights.indexOf(225) >= 0;
    });
  }, voice.id);
  await openLegPress(pageB, today);
  await expect(pageB.locator(".card.open .sg-w").nth(0)).toHaveValue("193");
  await expect(pageB.locator(".card.open .sg-w").nth(1)).toHaveValue("225");

  const gridKey = voice.gridKey;
  const current = bin.data[gridKey];
  const grid = typeof current === "string" ? JSON.parse(current) : current;
  grid["Deep Leg Press"].push({ n: 3, weight: 245, reps: 6, note: "", confirmed: true, planned: false, source: "voice" });
  bin.data[gridKey] = grid;
  const histRaw = bin.data["m165-history"];
  const hist = typeof histRaw === "string" ? JSON.parse(histRaw) : histRaw;
  const session = hist.filter(function(h){ return h.id === voice.id; })[0];
  const ex = session.exercises.filter(function(e){ return e.name === "Deep Leg Press"; })[0];
  ex.sets.push({ n: 3, weight: 245, reps: 6, note: "", confirmed: true });
  bin.data["m165-history"] = hist;
  bin.updatedAt = Date.now() + 5000;

  await pageB.locator(".sync-pill").click();
  await expect(pageB.locator(".card.open .sg-w").nth(2)).toHaveValue("245", { timeout: 8000 });
  await expect(pageB.locator(".card.open .sg-r").nth(2)).toHaveValue("6");

  const noisy = function(list){
    return list.filter(function(e){
      return e.indexOf("Failed to register a ServiceWorker") < 0 && e.indexOf("favicon") < 0;
    });
  };
  expect(noisy(errorsA)).toEqual([]);
  expect(noisy(errorsB)).toEqual([]);
  expect(bin.gets).toBeGreaterThan(0);
});
