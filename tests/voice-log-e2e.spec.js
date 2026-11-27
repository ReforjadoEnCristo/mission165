const { test, expect } = require("@playwright/test");
const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BIN = "6ae6c009ac6210605a62d670";
const DATE = "2026-11-29";
const GRID_KEY = "m165-setgrid-draft-" + DATE + "-3";
const SESSION = DATE + "-3";
const RDL = "Smith Romanian Deadlift";
const EXT = "Leg Extension";

function parseField(data, key, fallback){
  const raw = data[key];
  if (raw == null) return fallback;
  if (typeof raw === "string") return JSON.parse(raw);
  return raw;
}

function startMockBin(){
  const bin = { updatedAt: 1000, data: {}, puts: 0 };
  const server = http.createServer(function(req, res){
    if (req.method === "GET" && (req.url || "").indexOf("/latest") >= 0){
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ record: { updatedAt: bin.updatedAt, data: bin.data }, metadata: { id: BIN } }));
      return;
    }
    if (req.method === "PUT"){
      const chunks = [];
      req.on("data", function(c){ chunks.push(c); });
      req.on("end", function(){
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        bin.updatedAt = body.updatedAt || Date.now();
        bin.data = body.data || {};
        bin.puts += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ record: { updatedAt: bin.updatedAt, data: bin.data } }));
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  return new Promise(function(resolve){
    server.listen(0, "127.0.0.1", function(){
      resolve({ server: server, bin: bin, port: server.address().port });
    });
  });
}

function runScript(port, backupDir, extra){
  return new Promise(function(resolve, reject){
    const args = [
      "tools/log_voice_to_m165.py",
      "--bin-url", "http://127.0.0.1:" + port + "/v3/b/" + BIN,
      "--access-key", "test-key",
      "--backup-dir", backupDir
    ].concat(extra);
    const child = spawn("python3", args, { cwd: path.resolve(__dirname, "..") });
    let out = "", err = "";
    child.stdout.on("data", function(d){ out += d; });
    child.stderr.on("data", function(d){ err += d; });
    child.on("close", function(code){
      if (code !== 0) reject(new Error(err || out || ("script exit " + code)));
      else resolve({ out: out.trim(), err: err.trim() });
    });
  });
}

function attachApp(page, bin){
  return page.route("https://api.jsonbin.io/**", async function(route){
    const method = route.request().method();
    const url = route.request().url();
    if (url.indexOf(BIN) < 0){
      await route.fulfill({ status: 599, body: "blocked real jsonbin" });
      return;
    }
    if (method === "GET"){
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ record: { updatedAt: bin.updatedAt, data: bin.data }, metadata: { id: BIN } })
      });
      return;
    }
    if (method === "PUT"){
      const body = JSON.parse(route.request().postData() || "{}");
      bin.updatedAt = body.updatedAt || Date.now();
      bin.data = body.data || {};
      bin.puts += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ record: { updatedAt: bin.updatedAt, data: bin.data } })
      });
      return;
    }
    await route.fulfill({ status: 599, body: "blocked " + method });
  });
}

async function openLowerB(page){
  await page.locator(".day-tab").nth(2).click();
  const date = page.locator("input.logfor-date");
  await date.fill(DATE);
  await date.dispatchEvent("change");
}

test("voice sets show on the Lower B card, a repeat does not duplicate, a typed set survives", async function({ browser }){
  test.setTimeout(90000);
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "m165-backup-"));
  const shotDir = "/opt/cursor/artifacts";
  fs.mkdirSync(shotDir, { recursive: true });
  const mock = await startMockBin();
  const bin = mock.bin;
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  const page = await phone.newPage();
  const errors = [];
  page.on("pageerror", function(err){ errors.push(String(err)); });
  await attachApp(page, bin);

  await page.goto("/index.html");
  await page.waitForFunction(function(){
    return localStorage.getItem("m165-sync-id") === "6ae6c009ac6210605a62d670";
  });
  // Let the phone's first snapshot land so the script merges into it instead of racing it.
  await expect.poll(function(){ return bin.puts; }, { timeout: 8000 }).toBeGreaterThan(0);

  const first = await runScript(mock.port, backupDir, [
    "--date", DATE, "--day-id", "3", "--exercise", "RDL",
    "--sets-json", JSON.stringify([
      { n: 1, weight: 185, reps: 10 },
      { n: 2, weight: 205, reps: 8 },
      { n: 3, weight: 225, reps: 6 }
    ])
  ]);
  expect(first.out).toContain("SYNCED OK");
  expect(first.out).toContain(RDL);
  expect(first.out).toContain("Lower B — Hinge & Hamstrings");
  expect(fs.readdirSync(backupDir).length).toBeGreaterThan(0);

  const written = parseField(bin.data, GRID_KEY, {});
  expect(Object.keys(written).filter(function(k){ return k.charAt(0) !== "_"; })).toEqual([RDL]);
  expect(written[RDL].map(function(s){ return s.weight + "x" + s.reps; })).toEqual(["185x10", "205x8", "225x6"]);
  expect(written[RDL].every(function(s){ return s.source === "voice" && s.planned === false; })).toBe(true);
  const session = parseField(bin.data, "m165-history", []).filter(function(h){ return h.id === SESSION; })[0];
  expect(session.dayTitle).toBe("Lower B — Hinge & Hamstrings");
  expect(session.total).toBe(6);
  expect(session.exercises[0].name).toBe(RDL);
  expect(session.exercises[0].sets.every(function(s){ return s.source === "voice"; })).toBe(true);

  await page.locator(".sync-pill").click();
  await page.waitForFunction(function(key){
    const raw = localStorage.getItem(key) || "";
    return raw.indexOf("185") >= 0 && raw.indexOf("Smith Romanian Deadlift") >= 0 && raw.indexOf('"source":"voice"') >= 0;
  }, GRID_KEY);

  const again = await runScript(mock.port, backupDir, [
    "--date", DATE, "--day-id", "3", "--exercise", "RDL",
    "--sets-json", JSON.stringify([{ n: 2, weight: 205, reps: 8 }])
  ]);
  expect(again.out).toContain("NO CHANGE");
  const afterDup = parseField(bin.data, GRID_KEY, {});
  expect(afterDup[RDL]).toHaveLength(3);

  await page.locator(".sync-pill").click();
  await openLowerB(page);
  const rdl = page.locator(".card", { hasText: RDL });
  await rdl.locator(".card-main").click();
  await expect(rdl.locator(".sg-w")).toHaveCount(3);
  await expect(rdl.locator("tr .sg-mic")).toHaveCount(3);
  await expect(rdl.locator(".ex-name .sg-mic")).toHaveCount(1);
  await expect(rdl.locator(".sg-w").nth(0)).toHaveValue("185");
  await expect(rdl.locator(".sg-r").nth(0)).toHaveValue("10");
  await expect(rdl.locator(".sg-w").nth(1)).toHaveValue("205");
  await expect(rdl.locator(".sg-r").nth(1)).toHaveValue("8");
  await expect(rdl.locator(".sg-w").nth(2)).toHaveValue("225");
  await expect(rdl.locator(".sg-r").nth(2)).toHaveValue("6");
  await rdl.locator(".sg-box").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shotDir, "screenshot_lower_b_voice_sets.png") });

  const ext = page.locator(".card", { hasText: EXT });
  await ext.locator(".card-main").click();
  const typed = ext.locator('tr[data-n="1"]');
  await typed.locator(".sg-w").fill("100");
  await typed.locator(".sg-r").fill("15");
  await typed.locator(".sg-c").check();
  await expect.poll(function(){
    const grid = parseField(bin.data, GRID_KEY, {});
    const row = (grid[EXT] || []).filter(function(s){ return s.n === 1; })[0];
    return row && String(row.weight) === "100" && String(row.reps) === "15";
  }, { timeout: 8000 }).toBe(true);

  const conflict = await runScript(mock.port, backupDir, [
    "--date", DATE, "--day-id", "3", "--exercise", EXT,
    "--sets-json", JSON.stringify([{ n: 1, weight: 200, reps: 10 }])
  ]);
  expect(conflict.out).toMatch(/NO CHANGE|SYNCED OK/);
  const kept = parseField(bin.data, GRID_KEY, {})[EXT].filter(function(s){ return s.n === 1; })[0];
  expect(String(kept.weight)).toBe("100");
  expect(String(kept.reps)).toBe("15");

  // A bin that disagrees anyway must still not replace the set typed on the phone.
  const grid = parseField(bin.data, GRID_KEY, {});
  grid[EXT] = grid[EXT].map(function(s){
    if (s.n !== 1) return s;
    return Object.assign({}, s, { weight: 999, reps: 4, source: "voice" });
  });
  bin.data[GRID_KEY] = JSON.stringify(grid);
  bin.updatedAt = Date.now() + 5000;
  await page.locator(".sync-pill").click();
  await expect(typed.locator(".sg-w")).toHaveValue("100", { timeout: 8000 });
  await expect(typed.locator(".sg-r")).toHaveValue("15");
  await expect(ext.locator(".last-logged")).toContainText("100");
  await expect(ext.locator(".last-logged")).not.toContainText("200");
  await expect(ext.locator(".last-logged")).not.toContainText("999");
  await expect(rdl.locator(".sg-w")).toHaveCount(3);
  await ext.locator(".sg-box").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shotDir, "screenshot_typed_set_survives_voice_merge.png") });

  const onPhone = await page.evaluate(function(sessionId){
    const hist = JSON.parse(localStorage.getItem("m165-history") || "[]");
    const session = hist.filter(function(h){ return h.id === sessionId; })[0];
    const ex = session.exercises.filter(function(e){ return e.name === "Smith Romanian Deadlift"; })[0];
    return {
      title: session.dayTitle,
      sets: ex.sets.map(function(s){ return { n: s.n, weight: s.weight, reps: s.reps, source: s.source || "" }; })
    };
  }, SESSION);
  expect(onPhone.title).toBe("Lower B — Hinge & Hamstrings");
  expect(onPhone.sets).toEqual([
    { n: 1, weight: 185, reps: 10, source: "voice" },
    { n: 2, weight: 205, reps: 8, source: "voice" },
    { n: 3, weight: 225, reps: 6, source: "voice" }
  ]);

  const noisy = errors.filter(function(e){
    return e.indexOf("Failed to register a ServiceWorker") < 0 && e.indexOf("favicon") < 0;
  });
  expect(noisy).toEqual([]);
  await phone.close();
  await new Promise(function(resolve){ mock.server.close(resolve); });
});
