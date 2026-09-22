(function () {
  "use strict";

  // ===================================================================
  // Persistence — plain localStorage.
  //
  // Data model change: a single {startDate,startStatus} "plan" is
  // replaced by an array of SCHEDULE SEGMENTS:
  //   [{ startDate: "2026-09-19", startStatus: "FASTING" }, ...]
  // sorted ascending by startDate. The segment that applies to a given
  // date is the last one whose startDate <= that date. This lets the
  // user change the alternating pattern from a specific date onward
  // without rewriting history — see expectedStatus()/findSegment().
  //
  // Old installs only ever had "dawud-plan" in storage; loadSegments()
  // migrates that transparently into a one-segment array the first
  // time the new app runs, so existing users lose nothing.
  // ===================================================================
  var LS_SEGMENTS = "dawud-schedule-segments";
  var LS_PLAN_LEGACY = "dawud-plan";
  var LS_RECORDS = "dawud-records";
  var LS_THEME = "dawud-theme";
  var BACKUP_VERSION = 2;

  function loadSegments() {
    try {
      var raw = localStorage.getItem(LS_SEGMENTS);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return sortSegments(parsed);
      }
    } catch (e) {
      /* fall through to legacy migration */
    }
    try {
      var legacyRaw = localStorage.getItem(LS_PLAN_LEGACY);
      if (legacyRaw) {
        var legacy = JSON.parse(legacyRaw);
        if (legacy && legacy.startDate && legacy.startStatus) {
          var migrated = [{ startDate: legacy.startDate, startStatus: legacy.startStatus }];
          localStorage.setItem(LS_SEGMENTS, JSON.stringify(migrated));
          return migrated;
        }
      }
    } catch (e) {
      /* no legacy data either */
    }
    return null;
  }
  function sortSegments(segs) {
    return segs.slice().sort(function (a, b) {
      return a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0;
    });
  }
  function saveSegments(segs) {
    segments = sortSegments(segs);
    localStorage.setItem(LS_SEGMENTS, JSON.stringify(segments));
  }
  // Adds a new segment starting at `startDate`, replacing any existing
  // segment on that exact date (edge case: duplicate segment dates),
  // and keeps the array sorted (edge case: segments out of order).
  function addOrReplaceSegment(segs, newSeg) {
    var next = segs.filter(function (s) {
      return s.startDate !== newSeg.startDate;
    });
    next.push(newSeg);
    return sortSegments(next);
  }

  function loadRecords() {
    try {
      var raw = localStorage.getItem(LS_RECORDS);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }
  function saveRecords(r) {
    records = r;
    localStorage.setItem(LS_RECORDS, JSON.stringify(r));
  }
  function loadTheme() {
    var v = localStorage.getItem(LS_THEME);
    if (v) return v === "dark";
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch (e) {
      return false;
    }
  }
  function saveTheme(isDark) {
    dark = isDark;
    localStorage.setItem(LS_THEME, isDark ? "dark" : "light");
  }

  // ===================================================================
  // Pure schedule logic
  //
  // Expected status for a date is derived ONLY from schedule segments,
  // never from actual/recorded data — a missed (or changed) day can
  // never rewrite the schedule, and changing the schedule never
  // rewrites actual records. These are kept as two separate concepts
  // throughout the app.
  // ===================================================================
  function dateOnly(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  function toKey(d) {
    var x = dateOnly(d);
    return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
  }
  function fromKey(k) {
    var parts = k.split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }
  function daysBetween(a, b) {
    return Math.round((dateOnly(b) - dateOnly(a)) / 86400000);
  }
  function opposite(status) {
    return status === "FASTING" ? "REST" : "FASTING";
  }
  // The applicable segment for `date` is the latest one whose
  // startDate is <= date. Segments are kept sorted ascending, so this
  // is the last matching entry when scanning from the start.
  function findSegment(segs, date) {
    var d = dateOnly(date);
    var applicable = null;
    for (var i = 0; i < segs.length; i++) {
      if (dateOnly(fromKey(segs[i].startDate)) <= d) applicable = segs[i];
      else break;
    }
    return applicable;
  }
  // A date before the very first segment's startDate is not part of
  // the schedule at all (never extrapolated backwards).
  function isBeforePlanStart(segs, date) {
    if (!segs || segs.length === 0) return true;
    return dateOnly(date) < dateOnly(fromKey(segs[0].startDate));
  }
  function expectedStatus(segs, date) {
    var seg = findSegment(segs, date);
    if (!seg) return null;
    var days = daysBetween(fromKey(seg.startDate), date);
    var parity = ((days % 2) + 2) % 2;
    return parity === 0 ? seg.startStatus : opposite(seg.startStatus);
  }
  function getActual(recs, date) {
    var rec = recs[toKey(date)];
    return rec ? rec.actual : "UNRECORDED";
  }
  function isFutureDate(date) {
    return dateOnly(date) > dateOnly(new Date());
  }
  // Stats never count dates before the plan's very first segment
  // (clamp `from` upward) and never count future dates (clamp `to`
  // downward). Each date's expected status is resolved against
  // whichever segment applies to it, so schedule changes are reflected
  // correctly without special-casing.
  function computeStats(segs, recs, from, to) {
    var today = dateOnly(new Date());
    var planStart = segs.length ? dateOnly(fromKey(segs[0].startDate)) : today;
    var start = dateOnly(from) > planStart ? dateOnly(from) : planStart;
    var clampedTo = dateOnly(to) > today ? today : dateOnly(to);
    var empty = { expectedFasting: 0, expectedRest: 0, completedFasting: 0, missed: 0, unrecorded: 0 };
    if (clampedTo < start) return empty;
    var stats = Object.assign({}, empty);
    var cursor = new Date(start);
    while (cursor <= clampedTo) {
      var exp = expectedStatus(segs, cursor);
      if (exp === "FASTING") {
        stats.expectedFasting++;
        var actual = getActual(recs, cursor);
        if (actual === "FASTING") stats.completedFasting++;
        else if (actual === "MISSED") stats.missed++;
        else stats.unrecorded++;
      } else if (exp === "REST") {
        stats.expectedRest++;
      }
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    }
    return stats;
  }
  function consistencyPercent(stats) {
    if (stats.expectedFasting === 0) return 0;
    return Math.round((stats.completedFasting / stats.expectedFasting) * 100);
  }
  function todayKey() {
    return toKey(new Date());
  }
  function greeting() {
    var h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  }
  function formatDate(d) {
    return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  }

  // ===================================================================
  // Backup export / import (local file only — never uploaded anywhere)
  // ===================================================================
  function buildBackupPayload() {
    var recordsArr = Object.keys(records)
      .sort()
      .map(function (dateKey) {
        var r = records[dateKey];
        return {
          date: dateKey,
          expectedStatus: expectedStatus(segments, fromKey(dateKey)),
          actualStatus: r.actual,
          note: r.note || "",
        };
      });
    return {
      app: "DAWUD",
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      scheduleSegments: segments,
      plan: segments.length ? { startDate: segments[0].startDate, startStatus: segments[0].startStatus } : null,
      records: recordsArr,
      theme: dark ? "dark" : "light",
    };
  }
  window.exportData = function () {
    var payload = buildBackupPayload();
    var json = JSON.stringify(payload, null, 2);
    var blob = new Blob([json], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "DAWUD-backup-" + todayKey() + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 4000);
    showToast("Backup exported.");
  };

  // Validates that a parsed JSON object looks like a genuine, usable
  // DAWUD backup. Rejects anything corrupted/invalid gracefully by
  // returning a human-readable reason instead of throwing.
  function validateBackup(obj) {
    if (!obj || typeof obj !== "object") return { ok: false, reason: "That file isn't a valid DAWUD backup." };
    if (obj.app !== "DAWUD") return { ok: false, reason: "That file isn't a DAWUD backup." };
    if (typeof obj.version !== "number" || obj.version < 1) {
      return { ok: false, reason: "Unrecognized backup version." };
    }
    var segs = obj.scheduleSegments;
    if (!Array.isArray(segs) || segs.length === 0) {
      if (obj.plan && obj.plan.startDate && obj.plan.startStatus) {
        segs = [{ startDate: obj.plan.startDate, startStatus: obj.plan.startStatus }];
      } else {
        return { ok: false, reason: "Backup has no schedule data." };
      }
    }
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (!s || typeof s.startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.startDate) || (s.startStatus !== "FASTING" && s.startStatus !== "REST")) {
        return { ok: false, reason: "Backup schedule data is corrupted." };
      }
    }
    if (obj.records && !Array.isArray(obj.records)) {
      return { ok: false, reason: "Backup records are corrupted." };
    }
    return { ok: true, segments: segs };
  }
  window.triggerImport = function () {
    var input = document.getElementById("import-file-input");
    if (input) input.click();
  };
  window.handleImportFileSelected = function (inputEl) {
    var file = inputEl.files && inputEl.files[0];
    inputEl.value = "";
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch (e) {
        showToast("That file isn't valid JSON.");
        return;
      }
      var validation = validateBackup(parsed);
      if (!validation.ok) {
        showToast(validation.reason);
        return;
      }
      pendingImport = parsed;
      render();
    };
    reader.onerror = function () {
      showToast("Couldn't read that file.");
    };
    reader.readAsText(file);
  };
  window.cancelImport = function () {
    pendingImport = null;
    render();
  };
  window.confirmImport = function () {
    var obj = pendingImport;
    if (!obj) return;
    var segs = Array.isArray(obj.scheduleSegments) && obj.scheduleSegments.length ? obj.scheduleSegments : [{ startDate: obj.plan.startDate, startStatus: obj.plan.startStatus }];
    var recs = {};
    (obj.records || []).forEach(function (r) {
      if (r && r.date) recs[r.date] = { actual: r.actualStatus || "UNRECORDED", note: r.note || "" };
    });
    saveSegments(segs);
    saveRecords(recs);
    if (obj.theme === "dark" || obj.theme === "light") saveTheme(obj.theme === "dark");
    pendingImport = null;
    homeEditing = false;
    selectedDateKey = null;
    showToast("DAWUD data imported successfully.");
    render();
  };

  // ===================================================================
  // Small icon set — simple outline SVGs (no external icon library, so
  // the app stays fully self-contained/offline).
  // ===================================================================
  function icon(name, size) {
    size = size || 24;
    var paths = {
      home: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10.2V19a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-8.8"/>',
      calendar: '<rect x="4" y="5.5" width="16" height="15" rx="3.5"/><path d="M8 3.5v4M16 3.5v4M4.3 10.2h15.4"/>',
      chart: '<path d="M5 19V11"/><path d="M12 19V5"/><path d="M19 19v-6.5"/>',
      settings:
        '<circle cx="12" cy="12" r="3.1"/><path d="M12 4.2v2.3M12 17.5v2.3M4.2 12H6.5M17.5 12h2.3M6.7 6.7l1.6 1.6M15.7 15.7l1.6 1.6M6.7 17.3l1.6-1.6M15.7 8.3l1.6-1.6"/>',
      chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
      chevronRight: '<path d="M9 6l6 6-6 6"/>',
      check: '<path d="M5 13l4 4L19 7"/>',
      download: '<path d="M12 4v11.5M7.5 11.5 12 16l4.5-4.5"/><path d="M5 18.5h14"/>',
      upload: '<path d="M12 16.5V5M7.5 9.5 12 5l4.5 4.5"/><path d="M5 18.5h14"/>',
      clock: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.5V12l3.2 2"/>',
      trash: '<path d="M4.5 7h15M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-7.2 0 .7 11.4A2 2 0 0 0 10.5 20h3a2 2 0 0 0 2-1.6L16.2 7"/>',
    };
    return (
      '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      paths[name] + "</svg>"
    );
  }

  // ===================================================================
  // State
  // ===================================================================
  var segments = loadSegments();
  var records = loadRecords();
  var dark = loadTheme();
  var screen = "home";

  var ob = { step: 0, startDate: todayKey(), startStatus: null };
  var calendarMonth = dateOnly(new Date());
  var selectedDateKey = null;
  var homeEditing = false;
  var resetConfirming = false;
  var resetState = { startDate: todayKey(), startStatus: "FASTING" };

  // "Change schedule from a date" flow — used both from a Calendar day
  // detail sheet and from Settings → Schedule.
  var scheduleChangeState = null; // { startDate, startStatus } | null
  var showScheduleHistory = false;
  var segmentToDelete = null; // startDate string | null

  // Import confirmation (parsed+validated backup awaiting user OK)
  var pendingImport = null;

  // Transient toast notification
  var toastMessage = null;
  var toastTimer = null;
  function showToast(msg) {
    toastMessage = msg;
    render();
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastMessage = null;
      render();
    }, 2600);
  }

  // ===================================================================
  // Small render helpers
  // ===================================================================
  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }
  function primaryButton(label, onclick, disabled) {
    return (
      '<button class="btn btn-primary" onclick="' + onclick + '" ' + (disabled ? "disabled" : "") + ">" +
      esc(label) + "</button>"
    );
  }
  function secondaryButton(label, onclick) {
    return '<button class="btn btn-secondary" onclick="' + onclick + '">' + esc(label) + "</button>";
  }
  function textButton(label, onclick, cls) {
    return '<button class="' + (cls || "btn-text") + '" onclick="' + onclick + '">' + esc(label) + "</button>";
  }

  // ===================================================================
  // Onboarding
  // ===================================================================
  var OB_STEPS = ["welcome", "purpose", "start", "reminder"];

  window.obSetStartDate = function (v) {
    ob.startDate = v;
  };
  window.obSetStartStatus = function (v) {
    ob.startStatus = v;
    render();
  };
  window.obNext = function () {
    var canContinue = OB_STEPS[ob.step] !== "start" || ob.startStatus !== null;
    if (!canContinue) return;
    if (ob.step < OB_STEPS.length - 1) {
      ob.step++;
      render();
    } else {
      saveSegments([{ startDate: ob.startDate, startStatus: ob.startStatus }]);
      render();
    }
  };
  window.obBack = function () {
    if (ob.step > 0) {
      ob.step--;
      render();
    }
  };

  function renderOnboarding() {
    var step = OB_STEPS[ob.step];
    var body = "";

    if (step === "welcome") {
      body =
        '<h1 class="title-large" style="font-size:44px;margin-bottom:14px;">DAWUD</h1>' +
        '<p class="body-text text-secondary" style="font-size:19px;">A simple way to keep track<br/>of your Puasa Daud rhythm.</p>';
    } else if (step === "purpose") {
      var lines = [
        "Tells you whether today is a fasting day or a rest day.",
        "Lets you record what you actually did — with no judgment.",
        "Keeps your schedule steady, even if a day is missed.",
      ];
      body =
        '<h2 class="title-section" style="margin-bottom:22px;">What DAWUD does</h2>' +
        lines
          .map(function (line) {
            return (
              '<div style="display:flex;gap:12px;margin-bottom:18px;align-items:flex-start;">' +
              '<span style="width:6px;height:6px;border-radius:999px;background:var(--accent);margin-top:9px;flex-shrink:0;"></span>' +
              '<span class="body-text">' + esc(line) + "</span></div>"
            );
          })
          .join("");
    } else if (step === "start") {
      var choices = ["FASTING", "REST"]
        .map(function (s) {
          var selected = ob.startStatus === s;
          return (
            '<button onclick="obSetStartStatus(\'' + s + '\')" class="choice-btn' + (selected ? " selected" : "") + '">' +
            (s === "FASTING" ? "Fasting" : "Rest") + "</button>"
          );
        })
        .join('<div style="width:12px;"></div>');
      body =
        '<h2 class="title-section" style="margin-bottom:6px;">When did you start?</h2>' +
        '<p class="body-text text-secondary" style="margin-bottom:24px;">This is the only thing DAWUD needs to build your whole schedule.</p>' +
        '<p class="label-caps" style="margin-bottom:8px;">Start date</p>' +
        '<input type="date" value="' + esc(ob.startDate) + '" oninput="obSetStartDate(this.value)" ' +
        'style="display:block;width:100%;margin-bottom:26px;padding:14px;border-radius:var(--radius-sm);border:1px solid var(--border);' +
        'background:var(--surface);font-size:16px;box-sizing:border-box;" />' +
        '<p class="label-caps" style="margin-bottom:10px;">What was your first day?</p>' +
        '<div style="display:flex;gap:12px;">' + choices + "</div>";
    } else if (step === "reminder") {
      body =
        '<h2 class="title-section" style="margin-bottom:10px;">You\'re all set</h2>' +
        '<p class="body-text text-secondary">DAWUD will build your fasting/rest schedule from that starting point — and it will never shift, even if a day gets missed.</p>';
    }

    var canContinue = step !== "start" || ob.startStatus !== null;
    var progress = OB_STEPS.map(function (_, i) {
      return '<div style="flex:1;height:3px;border-radius:2px;background:' + (i === ob.step ? "var(--accent)" : "var(--border)") + ';transition:background-color 200ms ease;"></div>';
    }).join("");

    return (
      '<div style="display:flex;flex-direction:column;min-height:100vh;padding:28px 24px;box-sizing:border-box;">' +
      '<div class="ob-step" style="flex:1;display:flex;flex-direction:column;justify-content:center;">' + body + "</div>" +
      '<div style="display:flex;gap:6px;margin-bottom:22px;">' + progress + "</div>" +
      primaryButton(ob.step === OB_STEPS.length - 1 ? "Start using DAWUD" : "Continue", "obNext()", !canContinue) +
      "</div>"
    );
  }

  // ===================================================================
  // Home
  // ===================================================================
  window.recordToday = function (status) {
    var key = todayKey();
    var next = Object.assign({}, records);
    next[key] = { actual: status, note: (records[key] && records[key].note) || "" };
    saveRecords(next);
    homeEditing = false;
    render();
  };
  window.homeStartEdit = function () {
    homeEditing = true;
    render();
  };

  function renderRecordingArea(expected, actual) {
    if (expected === "FASTING") {
      if (actual === "UNRECORDED" || homeEditing) {
        return (
          '<p class="body-text text-secondary" style="margin-bottom:14px;">Today is your fasting day.</p>' +
          primaryButton("I fasted today", "recordToday('FASTING')") +
          '<div style="height:10px;"></div>' +
          textButton("I missed today", "recordToday('MISSED')", "btn-text")
        );
      }
      var fasted = actual === "FASTING";
      return recordedBanner(fasted ? "Recorded as fasted" : "Recorded as not fasted");
    }
    if (expected === "REST") {
      if (actual === "UNRECORDED" || homeEditing) {
        return (
          '<p class="body-text text-secondary" style="margin-bottom:14px;">Today is your rest day.</p>' +
          primaryButton("Confirm rest day", "recordToday('REST')")
        );
      }
      return recordedBanner("Rest day confirmed");
    }
    // expected === null: today is before the very first schedule segment
    return (
      '<p class="body-text text-secondary">Your plan starts on ' +
      esc(formatDate(fromKey(segments[0].startDate))) +
      ".</p>"
    );
  }
  function recordedBanner(text) {
    return (
      '<div style="display:flex;align-items:center;gap:12px;">' +
      '<span style="color:var(--accent);display:flex;">' + icon("check", 20) + "</span>" +
      '<span class="body-text" style="flex:1;">' + esc(text) + "</span>" +
      textButton("Edit", "homeStartEdit()") +
      "</div>"
    );
  }

  function renderHome() {
    var today = new Date();
    var todayExpected = expectedStatus(segments, today);
    var tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    var tomorrowExpected = expectedStatus(segments, tomorrow);
    var actual = getActual(records, today);

    var monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    var monthStats = computeStats(segments, records, monthStart, today);
    var percent = consistencyPercent(monthStats);

    var dateStr = today.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

    var statusLabel = todayExpected === "FASTING" ? "FASTING DAY" : todayExpected === "REST" ? "REST DAY" : "GETTING READY";

    var tomorrowRow = "";
    if (tomorrowExpected !== null) {
      tomorrowRow =
        '<div style="display:flex;align-items:baseline;padding:18px 0;border-top:1px solid var(--border);">' +
        '<span class="body-text text-secondary">Tomorrow</span><span style="flex:1;"></span>' +
        '<span class="body-text" style="font-weight:600;">' + (tomorrowExpected === "FASTING" ? "Fasting" : "Rest") + "</span></div>";
    }

    var monthSummary = "";
    if (monthStats.expectedFasting > 0 || monthStats.expectedRest > 0) {
      monthSummary =
        '<div style="border-top:1px solid var(--border);padding-top:18px;margin-top:4px;">' +
        '<p class="label-caps" style="margin-bottom:12px;">This month</p>' +
        '<div style="display:flex;">' +
        monthStatBlock(monthStats.completedFasting, "Fasted") +
        monthStatBlock(monthStats.missed, "Missed") +
        monthStatBlock(percent + "%", "Consistency") +
        "</div></div>";
    }

    // Last 7 days rhythm — shared with Stats, see renderLast7Days().
    var recentDaysHtml = renderLast7Days();

    // Always driven by the current schedule segments, so a schedule
    // change is reflected here immediately without any special-casing.
    var nextFasting = findNextFastingDay(today);
    var nextFastingHtml = "";
    if (nextFasting) {
      nextFastingHtml =
        '<div onclick="openDayDetail(\'' + toKey(nextFasting) + '\')" style="border-top:1px solid var(--border);padding:18px 0;margin-top:20px;cursor:pointer;">' +
        '<p class="label-caps" style="margin-bottom:8px;">Next fasting day</p>' +
        '<div class="body-text" style="font-weight:600;font-size:16.5px;margin-bottom:2px;">' +
        esc(nextFasting.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })) +
        "</div>" +
        '<div class="body-text text-secondary">Fasting</div>' +
        "</div>";
    }

    var viewCalendarLink =
      '<div style="border-top:1px solid var(--border);padding-top:18px;margin-top:20px;margin-bottom:8px;">' +
      textButton("View calendar →", "setScreen('calendar')", "btn-text") +
      "</div>";

    return (
      '<div class="screen-enter" style="padding:calc(20px + var(--safe-top)) 24px 0;">' +
      '<h1 class="title-large">' + greeting() + "</h1>" +
      '<p class="body-text text-secondary" style="margin-top:4px;margin-bottom:32px;">' + esc(dateStr) + "</p>" +
      '<p class="label-caps" style="margin-bottom:8px;">Today</p>' +
      '<div class="stat-number" style="font-size:38px;margin-bottom:10px;">' + esc(statusLabel) + "</div>" +
      renderRecordingArea(todayExpected, actual) +
      tomorrowRow +
      monthSummary +
      recentDaysHtml +
      nextFastingHtml +
      viewCalendarLink +
      "</div>"
    );
  }
  function monthStatBlock(value, label) {
    return (
      '<div style="flex:1;text-align:left;">' +
      '<div style="font-size:26px;font-weight:700;letter-spacing:-0.3px;">' + value + "</div>" +
      '<div class="body-text text-secondary" style="font-size:13.5px;margin-top:2px;">' + esc(label) + "</div>" +
      "</div>"
    );
  }

  // ===================================================================
  // Calendar
  // ===================================================================
  window.calendarPrevMonth = function () {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
    render();
  };
  window.calendarNextMonth = function () {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
    render();
  };
  window.openDayDetail = function (key) {
    selectedDateKey = key;
    render();
  };
  window.closeDayDetail = function () {
    selectedDateKey = null;
    render();
  };
  // Sets the ACTUAL record for a date. This never touches schedule
  // segments — recording (or re-recording) any day can never shift
  // what's expected on any other day.
  window.saveDayRecord = function (status) {
    var noteEl = document.getElementById("day-note");
    var note = noteEl ? noteEl.value : (records[selectedDateKey] && records[selectedDateKey].note) || "";
    var date = fromKey(selectedDateKey);
    if (isFutureDate(date)) return;
    var next = Object.assign({}, records);
    next[selectedDateKey] = { actual: status, note: note };
    saveRecords(next);
    render();
  };

  // Shared by Calendar, Home, and Stats, so all three read the exact
  // same visual language. Exactly four states, matching the Calendar
  // legend one-to-one:
  //   Expected fasting -> accent outline (not yet confirmed: future OR past-due)
  //   Fasted            -> accent filled
  //   Missed            -> warning filled
  //   Rest              -> secondary outline, low opacity
  function dotHtmlFor(day) {
    var expected = expectedStatus(segments, day);
    if (expected === null) return ""; // before the plan started
    if (expected === "REST") {
      return '<span class="cal-dot" style="background:none;border:1.3px solid var(--text-secondary);opacity:0.5;"></span>';
    }
    var actual = getActual(records, day);
    if (actual === "FASTING") return '<span class="cal-dot" style="background:var(--accent);"></span>';
    if (actual === "MISSED") return '<span class="cal-dot" style="background:var(--warning);"></span>';
    return '<span class="cal-dot" style="background:none;border:1.3px solid var(--accent);"></span>';
  }
  // Shared date-number + dot markup for every place that renders a
  // calendar-style cell (Calendar's month grid and the Last 7 Days
  // strip), so the "fasting days sit slightly higher" rhythm is
  // consistent everywhere rather than a Calendar-only special case.
  // Purely a visual hierarchy cue — never touches schedule/actual data.
  function cellContentHtml(day, fontSize) {
    var expected = expectedStatus(segments, day);
    var lifted = expected === "FASTING"; // covers fasted/missed/unrecorded/upcoming — anything in "fasting position"
    var numberColor = expected === "REST" ? "color:var(--text-secondary);" : "";
    return (
      '<span style="display:flex;flex-direction:column;align-items:center;gap:4px;' +
      (lifted ? "transform:translateY(-4px);" : "") + '">' +
      '<span style="font-size:' + fontSize + "px;" + numberColor + '">' + day.getDate() + "</span>" +
      dotHtmlFor(day) +
      "</span>"
    );
  }
  // Walks forward from `fromDate` (exclusive) using the CURRENT
  // schedule segments, so if the pattern changes this always reflects
  // the up-to-date answer rather than a cached/hardcoded one. Capped
  // so a pathological segment configuration can't loop forever.
  function findNextFastingDay(fromDate) {
    var cursor = dateOnly(fromDate);
    for (var i = 1; i <= 60; i++) {
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
      if (expectedStatus(segments, cursor) === "FASTING") return cursor;
    }
    return null;
  }

  // Streaks count consecutive successfully-FASTED expected-fasting
  // days. A scheduled REST day is skipped entirely (it neither
  // extends nor breaks a streak). A MISSED or UNRECORDED expected
  // fasting day resets the run to zero. This only ever reads
  // `records`/segments — it can't and doesn't feed back into the
  // schedule calculation.
  function computeStreaks(segs, recs, uptoDate) {
    if (!segs.length) return { current: 0, longest: 0 };
    var start = dateOnly(fromKey(segs[0].startDate));
    var end = dateOnly(uptoDate);
    var running = 0;
    var longest = 0;
    var cursor = new Date(start);
    while (cursor <= end) {
      var expected = expectedStatus(segs, cursor);
      if (expected === "FASTING") {
        var actual = getActual(recs, cursor);
        if (actual === "FASTING") {
          running++;
          if (running > longest) longest = running;
        } else {
          running = 0;
        }
      }
      // REST days: skip, running carries through unchanged.
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    }
    return { current: running, longest: longest };
  }

  // Compact 7-day rhythm strip, tappable per day (opens the same day
  // detail sheet as Calendar). Shared between Home and Stats so both
  // stay in sync automatically.
  function renderLast7Days() {
    var today = new Date();
    var days = [];
    for (var i = 6; i >= 0; i--) {
      days.push(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i));
    }
    var cells = days
      .map(function (day) {
        var isToday = dateOnly(day).getTime() === dateOnly(today).getTime();
        if (isBeforePlanStart(segments, day)) {
          return '<div class="cal-cell out-of-plan"><span style="font-size:12.5px;">' + day.getDate() + "</span></div>";
        }
        return (
          '<button onclick="openDayDetail(\'' + toKey(day) + '\')" class="cal-cell' + (isToday ? " today" : "") + '">' +
          cellContentHtml(day, 12.5) +
          "</button>"
        );
      })
      .join("");
    return (
      '<div style="border-top:1px solid var(--border);padding-top:18px;margin-top:20px;">' +
      '<p class="label-caps" style="margin-bottom:12px;">Last 7 days</p>' +
      '<div style="display:grid;grid-template-columns:repeat(7,1fr);">' + cells + "</div>" +
      "</div>"
    );
  }

  function renderCalendar() {
    var first = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
    var startWeekday = first.getDay();
    var daysInMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
    var today = dateOnly(new Date());

    var cellsHtml = "";
    for (var i = 0; i < startWeekday; i++) cellsHtml += "<div></div>";
    for (var d = 1; d <= daysInMonth; d++) {
      var day = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), d);
      var key = toKey(day);
      var isToday = day.getTime() === today.getTime();
      var outOfPlan = isBeforePlanStart(segments, day);

      if (outOfPlan) {
        cellsHtml += '<div class="cal-cell out-of-plan"><span style="font-size:15px;">' + d + "</span></div>";
        continue;
      }

      // Every in-plan date is tappable — past, today, and future alike.
      // The day detail sheet itself decides what's editable (see
      // renderDayDetail): full recording for past/today, read-only
      // "expected" preview for future dates.
      cellsHtml +=
        '<button onclick="openDayDetail(\'' + key + '\')" class="cal-cell' + (isToday ? " today" : "") + '">' +
        cellContentHtml(day, 15) +
        "</button>";
    }

    var monthLabel = calendarMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    var weekdayHeaders = ["S", "M", "T", "W", "T", "F", "S"]
      .map(function (w) {
        return '<div class="label-caps" style="text-align:center;padding:6px 0;">' + w + "</div>";
      })
      .join("");

    // Very subtle — small dots, muted secondary-colored labels, no
    // background/border box around it.
    var legend =
      '<div style="display:flex;flex-wrap:wrap;justify-content:center;gap:16px;margin-top:22px;opacity:0.85;">' +
      legendItem("var(--accent)", true, "Expected fasting") +
      legendItem("var(--accent)", false, "Fasted") +
      legendItem("var(--warning)", false, "Missed") +
      legendItem("var(--text-secondary)", true, "Rest") +
      "</div>";

    return (
      '<div class="screen-enter" style="padding:calc(20px + var(--safe-top)) 20px 0;">' +
      '<h1 class="title-large" style="margin-bottom:18px;padding-left:4px;">Calendar</h1>' +
      '<div style="display:flex;align-items:center;margin-bottom:8px;">' +
      '<button onclick="calendarPrevMonth()" style="background:none;border:none;color:var(--text);padding:8px;cursor:pointer;display:flex;" aria-label="Previous month">' + icon("chevronLeft", 20) + "</button>" +
      '<div style="flex:1;text-align:center;font-size:16px;font-weight:600;">' + esc(monthLabel) + "</div>" +
      '<button onclick="calendarNextMonth()" style="background:none;border:none;color:var(--text);padding:8px;cursor:pointer;display:flex;" aria-label="Next month">' + icon("chevronRight", 20) + "</button>" +
      "</div>" +
      '<div style="display:grid;grid-template-columns:repeat(7,1fr);">' + weekdayHeaders + "</div>" +
      '<div style="display:grid;grid-template-columns:repeat(7,1fr);row-gap:2px;">' + cellsHtml + "</div>" +
      legend +
      "</div>"
    );
  }
  function legendItem(color, outline, label) {
    var dotStyle = outline ? "background:none;border:1.3px solid " + color + ";" : "background:" + color + ";";
    return (
      '<div style="display:flex;align-items:center;gap:6px;">' +
      '<span class="cal-dot" style="' + dotStyle + '"></span>' +
      '<span class="body-text text-secondary" style="font-size:12.5px;">' + esc(label) + "</span></div>"
    );
  }

  function renderDayDetail() {
    var date = fromKey(selectedDateKey);
    var expected = expectedStatus(segments, date);
    var actual = getActual(records, date);
    var note = (records[selectedDateKey] && records[selectedDateKey].note) || "";
    var future = isFutureDate(date);
    var dateLabel = formatDate(date);

    var expectedLabel = expected === "FASTING" ? "Fasting day" : expected === "REST" ? "Rest day" : "—";
    var actualLabel = { FASTING: "Fasted", REST: "Rest confirmed", MISSED: "Missed", UNRECORDED: "Not recorded" }[actual];

    var body;
    if (expected === null) {
      body = '<p class="body-text text-secondary" style="margin-top:8px;">This date is before your plan started.</p>';
    } else if (future) {
      // Future dates show the expected status but are not recordable
      // yet — you can still open "Change schedule from this date" to
      // plan a change ahead of time.
      body =
        rowPair("Expected", expectedLabel) +
        '<p class="body-text text-secondary" style="margin:14px 0 18px;">This day hasn\'t happened yet.</p>' +
        textButton("Change schedule from this date", "openChangeSchedule('" + selectedDateKey + "')", "btn-text");
    } else {
      // Past or today: the user can set the actual record to ANY of
      // the four states, regardless of what was expected. Expected and
      // actual are shown side by side but are never conflated.
      var options = [
        ["FASTING", "Fasted"],
        ["MISSED", "Missed"],
        ["REST", "Rest"],
        ["UNRECORDED", "Unrecorded"],
      ];
      var grid = options
        .map(function (opt) {
          var selected = actual === opt[0];
          return (
            '<button onclick="saveDayRecord(\'' + opt[0] + '\')" class="choice-btn no-anim' + (selected ? " selected" : "") + '" style="padding:14px 0;font-size:15px;">' +
            esc(opt[1]) + "</button>"
          );
        })
        .join("");

      body =
        rowPair("Expected", expectedLabel) +
        rowPair("Actual", actualLabel) +
        '<p class="label-caps" style="margin:18px 0 8px;">Set actual record</p>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px;">' + grid + "</div>" +
        '<p class="label-caps" style="margin-bottom:8px;">Note</p>' +
        '<textarea id="day-note" rows="2" style="width:100%;padding:12px;border-radius:var(--radius-sm);border:1px solid var(--border);' +
        'background:var(--bg);color:var(--text);font-family:inherit;font-size:15px;resize:none;box-sizing:border-box;margin-bottom:18px;" ' +
        'onchange="saveDayRecord(\'' + actual + '\')">' + esc(note) + "</textarea>" +
        textButton("Change schedule from this date", "openChangeSchedule('" + selectedDateKey + "')", "btn-text");
    }

    return (
      '<div class="sheet-backdrop" onclick="closeDayDetail()">' +
      '<div class="sheet" onclick="event.stopPropagation()">' +
      '<div class="sheet-handle"></div>' +
      '<div style="display:flex;align-items:center;margin-bottom:18px;">' +
      '<h2 class="title-section" style="flex:1;">' + esc(dateLabel) + "</h2>" +
      textButton("Done", "closeDayDetail()") +
      "</div>" +
      body +
      "</div></div>"
    );
  }
  function rowPair(label, value) {
    return (
      '<div style="display:flex;align-items:center;padding:11px 0;border-bottom:1px solid var(--border);">' +
      '<span class="body-text text-secondary">' + esc(label) + '</span><span style="flex:1;"></span>' +
      '<span class="body-text" style="font-weight:600;">' + esc(value) + "</span></div>"
    );
  }

  // ===================================================================
  // Change schedule (creates a new schedule segment) + schedule history
  // ===================================================================
  window.openChangeSchedule = function (dateKey) {
    var date = fromKey(dateKey);
    var currentExpected = expectedStatus(segments, date);
    scheduleChangeState = { startDate: dateKey, startStatus: currentExpected || "FASTING" };
    selectedDateKey = null; // close the day-detail sheet underneath, if any
    render();
  };
  window.closeChangeSchedule = function () {
    scheduleChangeState = null;
    render();
  };
  window.setScheduleChangeDate = function (v) {
    scheduleChangeState.startDate = v;
  };
  window.setScheduleChangeStatus = function (v) {
    scheduleChangeState.startStatus = v;
    render();
  };
  window.confirmScheduleChange = function () {
    var next = addOrReplaceSegment(segments, {
      startDate: scheduleChangeState.startDate,
      startStatus: scheduleChangeState.startStatus,
    });
    saveSegments(next);
    var changedDate = fromKey(scheduleChangeState.startDate);
    scheduleChangeState = null;
    showToast("Schedule changed from " + formatDate(changedDate) + ".");
    render();
  };

  function renderChangeScheduleDialog() {
    var date = fromKey(scheduleChangeState.startDate);
    var statusButtons = ["FASTING", "REST"]
      .map(function (s) {
        var selected = scheduleChangeState.startStatus === s;
        return (
          '<button onclick="setScheduleChangeStatus(\'' + s + '\')" class="choice-btn' + (selected ? " selected" : "") + '" style="padding:14px 0;">' +
          (s === "FASTING" ? "Fasting" : "Rest") + "</button>"
        );
      })
      .join('<div style="width:10px;"></div>');

    return (
      '<div class="dialog-backdrop" onclick="closeChangeSchedule()">' +
      '<div class="dialog" onclick="event.stopPropagation()">' +
      '<h2 class="title-section" style="margin-bottom:10px;">Change schedule</h2>' +
      '<p class="body-text text-secondary" style="margin-bottom:18px;font-size:14.5px;">' +
      "This starts a new schedule segment — dates before it keep their original expected status, and any recorded history stays untouched." +
      "</p>" +
      '<p class="label-caps" style="margin-bottom:6px;">Starting from</p>' +
      '<input type="date" value="' + esc(scheduleChangeState.startDate) + '" oninput="setScheduleChangeDate(this.value)" ' +
      'style="display:block;width:100%;margin-bottom:16px;padding:12px;border-radius:var(--radius-sm);border:1px solid var(--border);' +
      'background:var(--bg);color:var(--text);font-family:inherit;box-sizing:border-box;" />' +
      '<p class="label-caps" style="margin-bottom:6px;">New expected status</p>' +
      '<div style="display:flex;gap:10px;margin-bottom:22px;">' + statusButtons + "</div>" +
      '<div style="display:flex;gap:10px;">' +
      '<div style="flex:1;">' + secondaryButton("Cancel", "closeChangeSchedule()") + "</div>" +
      '<div style="flex:1;">' + primaryButton("Change", "confirmScheduleChange()") + "</div>" +
      "</div></div></div>"
    );
  }

  window.openScheduleHistory = function () {
    showScheduleHistory = true;
    render();
  };
  window.closeScheduleHistory = function () {
    showScheduleHistory = false;
    render();
  };
  window.askDeleteSegment = function (startDate) {
    segmentToDelete = startDate;
    render();
  };
  window.cancelDeleteSegment = function () {
    segmentToDelete = null;
    render();
  };
  window.confirmDeleteSegment = function () {
    var next = segments.filter(function (s) {
      return s.startDate !== segmentToDelete;
    });
    saveSegments(next);
    segmentToDelete = null;
    showToast("Schedule change removed.");
    render();
  };

  function renderScheduleHistorySheet() {
    var today = dateOnly(new Date());
    var rows = segments
      .map(function (seg, i) {
        var label = i === 0 ? (seg.startStatus === "FASTING" ? "Fasting started" : "Rest started") : "Changed to " + (seg.startStatus === "FASTING" ? "Fasting" : "Rest");
        // Only a non-foundational segment that hasn't fully elapsed yet
        // (today or future) can be removed — the original plan start
        // can't be deleted here (use Reset schedule for that), and
        // deleting a past change would rewrite already-elapsed history.
        var deletable = i !== 0 && dateOnly(fromKey(seg.startDate)) >= today;
        return (
          '<div class="list-row" style="align-items:center;">' +
          '<div style="flex:1;">' +
          '<div class="body-text" style="font-weight:600;">' + esc(formatDate(fromKey(seg.startDate))) + "</div>" +
          '<div class="body-text text-secondary" style="font-size:13.5px;">' + esc(label) + "</div>" +
          "</div>" +
          (deletable
            ? '<button onclick="askDeleteSegment(\'' + seg.startDate + '\')" aria-label="Remove this schedule change" ' +
              'style="background:none;border:none;color:var(--destructive);padding:6px;cursor:pointer;display:flex;">' + icon("trash", 19) + "</button>"
            : "") +
          "</div>"
        );
      })
      .join("");

    return (
      '<div class="sheet-backdrop" onclick="closeScheduleHistory()">' +
      '<div class="sheet" onclick="event.stopPropagation()">' +
      '<div class="sheet-handle"></div>' +
      '<div style="display:flex;align-items:center;margin-bottom:18px;">' +
      '<h2 class="title-section" style="flex:1;">Schedule History</h2>' +
      textButton("Done", "closeScheduleHistory()") +
      "</div>" +
      '<div class="list-group">' + rows + "</div>" +
      "</div></div>"
    );
  }
  function renderDeleteSegmentConfirm() {
    return (
      '<div class="dialog-backdrop" onclick="cancelDeleteSegment()">' +
      '<div class="dialog" onclick="event.stopPropagation()">' +
      '<h2 class="title-section" style="margin-bottom:10px;">Remove this schedule change?</h2>' +
      '<p class="body-text text-secondary" style="margin-bottom:20px;font-size:14.5px;">Dates from ' + esc(formatDate(fromKey(segmentToDelete))) + ' onward will follow the previous schedule segment instead. Recorded history is not affected.</p>' +
      '<div style="display:flex;gap:10px;">' +
      '<div style="flex:1;">' + secondaryButton("Cancel", "cancelDeleteSegment()") + "</div>" +
      '<div style="flex:1;"><button class="btn" style="background:var(--destructive);color:#fff;" onclick="confirmDeleteSegment()">Remove</button></div>' +
      "</div></div></div>"
    );
  }

  // ===================================================================
  // Stats
  // ===================================================================
  function renderStats() {
    var today = new Date();
    var stats = computeStats(segments, records, fromKey(segments[0].startDate), today);
    var streaks = computeStreaks(segments, records, today);
    var totalElapsed = stats.expectedFasting + stats.expectedRest;
    var hasEnoughData = totalElapsed >= 4;
    var percent = consistencyPercent(stats);

    var content;
    if (!hasEnoughData) {
      content =
        '<p class="body-text text-secondary" style="margin-top:4px;">Keep recording your days.<br/>Your statistics will become more meaningful over time.</p>';
    } else {
      content =
        '<p class="label-caps" style="margin-bottom:10px;">Streak</p>' +
        rowPair("Current streak", streaks.current + (streaks.current === 1 ? " day" : " days")) +
        rowPair("Longest streak", streaks.longest + (streaks.longest === 1 ? " day" : " days")) +

        '<div style="text-align:left;margin:26px 0 8px;">' +
        '<p class="label-caps" style="margin-bottom:8px;">Consistency</p>' +
        '<div class="stat-number">' + percent + "%</div>" +
        "</div>" +

        '<p class="label-caps" style="margin:26px 0 10px;">Fasting rhythm</p>' +
        rowPair("Expected", stats.expectedFasting) +
        rowPair("Fasted", stats.completedFasting) +
        rowPair("Missed", stats.missed) +
        rowPair("Unrecorded", stats.unrecorded);
    }

    return (
      '<div class="screen-enter" style="padding:calc(20px + var(--safe-top)) 24px 0;">' +
      '<p class="label-caps" style="margin-bottom:6px;">Your progress</p>' +
      '<h1 class="title-large" style="margin-bottom:24px;">Statistics</h1>' +
      content +
      renderLast7Days() +
      "</div>"
    );
  }

  // ===================================================================
  // Settings
  // ===================================================================
  window.toggleDark = function () {
    saveTheme(!dark);
    render();
  };
  window.openResetConfirm = function () {
    resetConfirming = true;
    resetState = { startDate: todayKey(), startStatus: "FASTING" };
    render();
  };
  window.closeResetConfirm = function () {
    resetConfirming = false;
    render();
  };
  window.setResetStartDate = function (v) {
    resetState.startDate = v;
  };
  window.setResetStatus = function (v) {
    resetState.startStatus = v;
    render();
  };
  window.confirmReset = function () {
    // Resetting replaces the ENTIRE schedule history with a single new
    // segment — different from "Change schedule from a date", which
    // adds a segment and keeps everything before it. Either way,
    // `records` (actual history) is never touched here.
    saveSegments([{ startDate: resetState.startDate, startStatus: resetState.startStatus }]);
    resetConfirming = false;
    render();
  };

  function renderSettings() {
    var startLabel = formatDate(fromKey(segments[0].startDate));

    return (
      '<div class="screen-enter" style="padding:calc(20px + var(--safe-top)) 20px 0;">' +
      '<h1 class="title-large" style="margin-bottom:26px;padding-left:4px;">Settings</h1>' +

      '<p class="label-caps" style="margin:0 0 8px 4px;">Plan</p>' +
      '<div class="list-group" style="margin-bottom:26px;">' +
      '<div class="list-row"><span>Start date</span><span class="row-spacer"></span><span class="row-value">' + esc(startLabel) + "</span></div>" +
      '<div class="list-row"><span>Starting status</span><span class="row-spacer"></span><span class="row-value">' + (segments[0].startStatus === "FASTING" ? "Fasting" : "Rest") + "</span></div>" +
      "</div>" +

      '<p class="label-caps" style="margin:0 0 8px 4px;">Schedule</p>' +
      '<div class="list-group" style="margin-bottom:26px;">' +
      settingsRow("clock", "Change Schedule", "Start a new pattern from any date", "openChangeSchedule('" + todayKey() + "')") +
      settingsRow("calendar", "Schedule History", segments.length + (segments.length === 1 ? " segment" : " segments"), "openScheduleHistory()") +
      "</div>" +

      '<p class="label-caps" style="margin:0 0 8px 4px;">Appearance</p>' +
      '<div class="list-group" style="margin-bottom:26px;">' +
      '<div class="list-row"><span>Dark Mode</span><span class="row-spacer"></span>' + iosSwitch(dark, "toggleDark()") + "</div>" +
      "</div>" +

      '<p class="label-caps" style="margin:0 0 8px 4px;">Data</p>' +
      '<div class="list-group" style="margin-bottom:26px;">' +
      settingsRow("download", "Export Data", "Save a backup JSON file", "exportData()") +
      settingsRow("upload", "Import Data", "Restore from a backup file", "triggerImport()") +
      '<input type="file" id="import-file-input" accept="application/json" style="display:none" onchange="handleImportFileSelected(this)" />' +
      "</div>" +

      '<div class="list-group">' +
      '<div class="list-row tappable" onclick="openResetConfirm()" style="cursor:pointer;">' +
      '<span class="btn-destructive-text" style="padding:0;">Reset schedule</span>' +
      "</div></div>" +
      "</div>"
    );
  }
  function settingsRow(iconName, title, description, onclick) {
    return (
      '<div class="list-row tappable" onclick="' + onclick + '" style="cursor:pointer;">' +
      '<span style="color:var(--text-secondary);display:flex;">' + icon(iconName, 19) + "</span>" +
      '<div style="flex:1;">' +
      '<div class="body-text">' + esc(title) + "</div>" +
      (description ? '<div class="body-text text-secondary" style="font-size:13px;">' + esc(description) + "</div>" : "") +
      "</div>" +
      '<span style="color:var(--text-secondary);display:flex;">' + icon("chevronRight", 18) + "</span>" +
      "</div>"
    );
  }
  function iosSwitch(on, onclick) {
    return (
      '<button role="switch" aria-checked="' + (on ? "true" : "false") + '" onclick="' + onclick + '" ' +
      'style="width:48px;height:28px;border-radius:16px;border:none;padding:2px;cursor:pointer;' +
      "background:" + (on ? "var(--accent)" : "var(--border)") + ";transition:background-color 180ms ease;position:relative;flex-shrink:0;\">" +
      '<span style="display:block;width:24px;height:24px;border-radius:999px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.25);' +
      "transform:translateX(" + (on ? "20px" : "0") + ");transition:transform 180ms cubic-bezier(0.32,0.72,0,1);\"></span>" +
      "</button>"
    );
  }

  function renderResetDialog() {
    var statusButtons = ["FASTING", "REST"]
      .map(function (s) {
        var selected = resetState.startStatus === s;
        return (
          '<button onclick="setResetStatus(\'' + s + '\')" class="choice-btn' + (selected ? " selected" : "") + '" style="padding:14px 0;">' +
          (s === "FASTING" ? "Fasting" : "Rest") + "</button>"
        );
      })
      .join('<div style="width:10px;"></div>');

    return (
      '<div class="dialog-backdrop" onclick="closeResetConfirm()">' +
      '<div class="dialog" onclick="event.stopPropagation()">' +
      '<h2 class="title-section" style="margin-bottom:10px;">Reset schedule?</h2>' +
      '<p class="body-text text-secondary" style="margin-bottom:18px;font-size:14.5px;">This replaces your entire schedule history with a single new starting point. Your recorded history is kept, but every expected day will be recalculated from here.</p>' +
      '<p class="label-caps" style="margin-bottom:6px;">New start date</p>' +
      '<input type="date" value="' + esc(resetState.startDate) + '" oninput="setResetStartDate(this.value)" ' +
      'style="display:block;width:100%;margin-bottom:16px;padding:12px;border-radius:var(--radius-sm);border:1px solid var(--border);' +
      'background:var(--bg);color:var(--text);font-family:inherit;box-sizing:border-box;" />' +
      '<div style="display:flex;gap:10px;margin-bottom:22px;">' + statusButtons + "</div>" +
      '<div style="display:flex;gap:10px;">' +
      '<div style="flex:1;">' + secondaryButton("Cancel", "closeResetConfirm()") + "</div>" +
      '<div style="flex:1;">' + primaryButton("Reset", "confirmReset()") + "</div>" +
      "</div></div></div>"
    );
  }

  function renderImportConfirmDialog() {
    return (
      '<div class="dialog-backdrop" onclick="cancelImport()">' +
      '<div class="dialog" onclick="event.stopPropagation()">' +
      '<h2 class="title-section" style="margin-bottom:10px;">Import this backup?</h2>' +
      '<p class="body-text text-secondary" style="margin-bottom:20px;font-size:14.5px;">Your current DAWUD data will be replaced.</p>' +
      '<div style="display:flex;gap:10px;">' +
      '<div style="flex:1;">' + secondaryButton("Cancel", "cancelImport()") + "</div>" +
      '<div style="flex:1;">' + primaryButton("Import", "confirmImport()") + "</div>" +
      "</div></div></div>"
    );
  }

  // ===================================================================
  // Tab bar + root render
  // ===================================================================
  window.setScreen = function (s) {
    if (s === screen) return;
    screen = s;
    render();
  };

  function renderTabBar() {
    var items = [
      ["home", "Home", "home"],
      ["calendar", "Calendar", "calendar"],
      ["stats", "Stats", "chart"],
      ["settings", "Settings", "settings"],
    ];
    return (
      '<div class="tab-bar" role="tablist">' +
      items
        .map(function (it) {
          var key = it[0], label = it[1], iconName = it[2];
          var active = screen === key;
          return (
            '<button role="tab" aria-selected="' + (active ? "true" : "false") + '" aria-label="' + label + '" ' +
            'onclick="setScreen(\'' + key + '\')" class="tab-item' + (active ? " active" : "") + '">' +
            icon(iconName, 23) + "<span>" + label + "</span></button>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function render() {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");

    var root = document.getElementById("root");
    var shellStyle = "min-height:100vh;max-width:480px;margin:0 auto;position:relative;";

    if (!segments) {
      root.innerHTML = '<div style="' + shellStyle + '">' + renderOnboarding() + "</div>";
      return;
    }

    var screenHtml = "";
    if (screen === "home") screenHtml = renderHome();
    else if (screen === "calendar") screenHtml = renderCalendar();
    else if (screen === "stats") screenHtml = renderStats();
    else if (screen === "settings") screenHtml = renderSettings();

    // Overlays are independent of which tab is active, so a flow that
    // starts on one screen (e.g. "Change schedule" from a Calendar day)
    // can finish correctly even though it renders on top of any screen.
    var overlays = "";
    if (selectedDateKey) overlays += renderDayDetail();
    if (scheduleChangeState) overlays += renderChangeScheduleDialog();
    if (showScheduleHistory) overlays += renderScheduleHistorySheet();
    if (segmentToDelete) overlays += renderDeleteSegmentConfirm();
    if (resetConfirming) overlays += renderResetDialog();
    if (pendingImport) overlays += renderImportConfirmDialog();
    if (toastMessage) overlays += '<div class="toast">' + esc(toastMessage) + "</div>";

    root.innerHTML =
      '<div style="' + shellStyle + '">' +
      '<div style="padding-bottom:110px;">' + screenHtml + "</div>" +
      renderTabBar() +
      overlays +
      "</div>";
  }

  render();
})();
