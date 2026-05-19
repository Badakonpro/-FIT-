const SUN_YAT_SEN_UNIVERSITY_CENTER = [23.0964, 113.2988];
const DEFAULT_MAP_ZOOM = 16;

const map = L.map("map").setView(
  SUN_YAT_SEN_UNIVERSITY_CENTER,
  DEFAULT_MAP_ZOOM
);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

let routePoints = [];
let polyline = null;
let paceChart = null;
let hrChart = null;
let previewData = null;
let previewTimer = null;
let previewIndex = 0;
let previewMarker = null;
let trackTransform = null;      // { centerLat, centerLng, scale, angle }
let trackHandleMarkers = [];    // [moveMarker, rotateMarker, scaleMarker]

function updateMessage(text, isError = false) {
  const el = document.getElementById("message");
  el.textContent = text || "";
  el.className = "message" + (isError ? " error" : "");
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function computeDistanceMeters(points) {
  if (!points || points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineDistance(
      points[i - 1].lat,
      points[i - 1].lng,
      points[i].lat,
      points[i].lng
    );
  }
  return total;
}

function updateDistanceInfo() {
  const el = document.getElementById("distanceInfo");
  if (!el) return;
  if (!routePoints || routePoints.length < 2) {
    el.textContent = "总距离约：0 公里";
    return;
  }
  const baseMeters = computeDistanceMeters(routePoints);
  const baseKm = baseMeters / 1000;
  const lapInput = document.getElementById("lapCount");
  const laps = Math.max(1, parseInt(lapInput?.value, 10) || 1);
  const totalKm = baseKm * laps;
  const baseStr = baseKm.toFixed(2);
  const totalStr = totalKm.toFixed(2);
  if (laps > 1) {
    el.textContent = `总距离约：${totalStr} 公里（基础：${baseStr} 公里 × ${laps} 圈）`;
  } else {
    el.textContent = `总距离约：${baseStr} 公里`;
  }
}

map.on("click", (e) => {
  if (trackTransform) return; // 操场变换模式下禁止手动添加点
  routePoints.push({ lat: e.latlng.lat, lng: e.latlng.lng });
  if (polyline) {
    polyline.setLatLngs(routePoints);
  } else {
    polyline = L.polyline(routePoints, { color: "#ff5722" }).addTo(map);
  }
  updateMessage(`已添加点数：${routePoints.length}`);
  updateDistanceInfo();
});

// ── 标准操场变换系统 ─────────────────────────────────────────
const TRACK_STRAIGHT   = 84.39;
const TRACK_RADIUS     = 36.5;
const TRACK_EAST_DIST  = TRACK_STRAIGHT / 2 + TRACK_RADIUS; // 东端距中心 (m)
const TRACK_NORTH_DIST = 75;  // 旋转把手距中心 (m)

function makeHandleIcon(bg, text) {
  return L.divIcon({
    className: "",
    html: `<div style="width:22px;height:22px;background:${bg};border:2px solid #fff;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;font-weight:700;box-shadow:0 1px 5px rgba(0,0,0,.5)">${text}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11]
  });
}

function trackMeters(centerLat) {
  return { lat: 111320, lng: 111320 * Math.cos(centerLat * Math.PI / 180) };
}

// 从变换参数生成操场轨迹点（无抖动）
function getTrackGeometry(centerLat, centerLng, scale, angle) {
  const HALF_S = TRACK_STRAIGHT / 2;
  const m = trackMeters(centerLat);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const pt = (x, y) => {
    const sx = x * scale, sy = y * scale;
    return {
      lat: centerLat + (sx * sin + sy * cos) / m.lat,
      lng: centerLng + (sx * cos - sy * sin) / m.lng
    };
  };
  const NS = 20, NC = 24, pts = [];
  for (let i = 0; i < NS; i++)
    pts.push(pt(-HALF_S + TRACK_STRAIGHT * i / NS, -TRACK_RADIUS));
  for (let i = 0; i <= NC; i++) {
    const a = -Math.PI / 2 + Math.PI * i / NC;
    pts.push(pt(HALF_S + TRACK_RADIUS * Math.cos(a), TRACK_RADIUS * Math.sin(a)));
  }
  for (let i = 1; i <= NS; i++)
    pts.push(pt(HALF_S - TRACK_STRAIGHT * i / NS, TRACK_RADIUS));
  for (let i = 1; i < NC; i++) {
    const a = Math.PI / 2 + Math.PI * i / NC;
    pts.push(pt(-HALF_S + TRACK_RADIUS * Math.cos(a), TRACK_RADIUS * Math.sin(a)));
  }
  // 闭合：回到起始点
  pts.push({ lat: pts[0].lat, lng: pts[0].lng });
  return pts;
}

// 旋转把手坐标（操场"正北"方向）
function rotateHandleLatLng() {
  const { centerLat, centerLng, scale, angle } = trackTransform;
  const d = TRACK_NORTH_DIST * scale;
  const m = trackMeters(centerLat);
  return L.latLng(
    centerLat + d * Math.cos(angle) / m.lat,
    centerLng - d * Math.sin(angle) / m.lng
  );
}

// 缩放把手坐标（操场"正东"端点）
function scaleHandleLatLng() {
  const { centerLat, centerLng, scale, angle } = trackTransform;
  const d = TRACK_EAST_DIST * scale;
  const m = trackMeters(centerLat);
  return L.latLng(
    centerLat + d * Math.sin(angle) / m.lat,
    centerLng + d * Math.cos(angle) / m.lng
  );
}

function redrawTrack() {
  if (!trackTransform) return;
  const { centerLat, centerLng, scale, angle } = trackTransform;
  const pts = getTrackGeometry(centerLat, centerLng, scale, angle);
  routePoints = pts;
  if (polyline) map.removeLayer(polyline);
  polyline = L.polygon(routePoints, { color: "#ff5722", fill: false, weight: 3 }).addTo(map);
  if (trackHandleMarkers.length === 3) {
    trackHandleMarkers[0].setLatLng([centerLat, centerLng]);
    trackHandleMarkers[1].setLatLng(rotateHandleLatLng());
    trackHandleMarkers[2].setLatLng(scaleHandleLatLng());
  }
  updateDistanceInfo();
}

function removeTrackHandles() {
  trackHandleMarkers.forEach(m => map.removeLayer(m));
  trackHandleMarkers = [];
}

function createTrackHandles() {
  removeTrackHandles();
  const { centerLat, centerLng } = trackTransform;

  // ① 移动把手（蓝色，中心）
  const moveMarker = L.marker([centerLat, centerLng], {
    icon: makeHandleIcon("#1976d2", "✥"),
    draggable: true, zIndexOffset: 1000
  }).addTo(map);
  moveMarker.on("drag", (e) => {
    trackTransform.centerLat = e.latlng.lat;
    trackTransform.centerLng = e.latlng.lng;
    redrawTrack();
  });

  // ② 旋转把手（橙色，正北方向）
  const rotMarker = L.marker(rotateHandleLatLng(), {
    icon: makeHandleIcon("#f57c00", "↻"),
    draggable: true, zIndexOffset: 1000
  }).addTo(map);
  rotMarker.on("drag", (e) => {
    const { centerLat, centerLng } = trackTransform;
    const m = trackMeters(centerLat);
    const dx = (e.latlng.lng - centerLng) * m.lng;
    const dy = (e.latlng.lat - centerLat) * m.lat;
    // 北方向: dx=-d·sin(a), dy=d·cos(a) → a=atan2(-dx,dy)
    trackTransform.angle = Math.atan2(-dx, dy);
    redrawTrack();
  });

  // ③ 缩放把手（绿色，正东端点）
  const scaleMarker = L.marker(scaleHandleLatLng(), {
    icon: makeHandleIcon("#388e3c", "⤢"),
    draggable: true, zIndexOffset: 1000
  }).addTo(map);
  scaleMarker.on("drag", (e) => {
    const { centerLat, centerLng, angle } = trackTransform;
    const m = trackMeters(centerLat);
    const dx = (e.latlng.lng - centerLng) * m.lng;
    const dy = (e.latlng.lat - centerLat) * m.lat;
    // 投影到当前"东"方向
    const projected = Math.cos(angle) * dx + Math.sin(angle) * dy;
    trackTransform.scale = Math.max(0.3, Math.min(5, projected / TRACK_EAST_DIST));
    redrawTrack();
  });

  trackHandleMarkers = [moveMarker, rotMarker, scaleMarker];
}
// ─────────────────────────────────────────────────────────────

const clearBtn = document.getElementById("clearRoute");
clearBtn.addEventListener("click", () => {
  routePoints = [];
  if (polyline) {
    map.removeLayer(polyline);
    polyline = null;
  }
  removeTrackHandles();
  trackTransform = null;
  updateMessage("轨迹已清除");
  updateDistanceInfo();
});

const trackPresetBtn = document.getElementById("trackPreset");
if (trackPresetBtn) {
  trackPresetBtn.addEventListener("click", () => {
    const center = map.getCenter();
    trackTransform = { centerLat: center.lat, centerLng: center.lng, scale: 1, angle: 0 };
    redrawTrack();
    createTrackHandles();
    updateMessage("已加载标准 400m 操场 — 拖动 ✥ 移动 · ↻ 旋转 · ⤢ 缩放");
  });
}

function dateToLocalInputValue(d) {
  const tzOffset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - tzOffset * 60000);
  return local.toISOString().slice(0, 16);
}

function rebuildExportTimes() {
  const container = document.getElementById("exportTimes");
  const exportInput = document.getElementById("exportCount");
  if (!container || !exportInput) return;

  const count = Math.max(1, Math.min(10, parseInt(exportInput.value, 10) || 1));

  // 默认基准时间：今天晚上 20:30
  const base = new Date();
  base.setHours(20, 30, 0, 0);

  container.innerHTML = "";

  for (let i = 0; i < count; i++) {
    const row = document.createElement("div");
    row.className = "export-time-row";

    const label = document.createElement("span");
    label.textContent = `第 ${i + 1} 份`;

    const timeInput = document.createElement("input");
    timeInput.type = "datetime-local";
    timeInput.className = "export-time-input";
    timeInput.dataset.index = String(i);

    // 每份间隔一天，并叠加 ±10 分钟随机抖动（多份时生效）
    const jitterMs = count > 1 ? (Math.random() - 0.5) * 2 * 10 * 60 * 1000 : 0;
    const d = new Date(base.getTime() + i * 24 * 60 * 60 * 1000 + jitterMs);
    timeInput.value = dateToLocalInputValue(d);

    const paceMinInput = document.createElement("input");
    paceMinInput.type = "number";
    paceMinInput.className = "export-pace-min";
    paceMinInput.min = "0";
    paceMinInput.step = "0.1";
    paceMinInput.value = "6";

    const paceSecInput = document.createElement("input");
    paceSecInput.type = "number";
    paceSecInput.className = "export-pace-sec";
    paceSecInput.min = "0";
    paceSecInput.max = "59.9";
    paceSecInput.step = "0.1";
    paceSecInput.value = "0";

    row.appendChild(label);
    row.appendChild(timeInput);
    row.appendChild(paceMinInput);
    row.appendChild(paceSecInput);
    container.appendChild(row);
  }
}

async function generateFit() {
  if (routePoints.length < 2) {
    updateMessage("请至少在地图上选择两个点形成轨迹", true);
    return;
  }

  const hrRest = parseInt(document.getElementById("hrRest").value, 10) || 60;
  const hrMax = parseInt(document.getElementById("hrMax").value, 10) || 180;
  const hrRampMinutes = parseFloat(document.getElementById("hrRampMinutes")?.value) || 3;

  const lapInput = document.getElementById("lapCount");
  const exportInput = document.getElementById("exportCount");
  const lapCount = Math.max(1, parseInt(lapInput?.value, 10) || 1);
  const exportCount = Math.max(
    1,
    Math.min(10, parseInt(exportInput?.value, 10) || 1)
  );

  const exportTimesContainer = document.getElementById("exportTimes");
  const timeInputs = exportTimesContainer
    ? Array.from(exportTimesContainer.querySelectorAll(".export-time-input"))
    : [];
  const paceMinInputs = exportTimesContainer
    ? Array.from(exportTimesContainer.querySelectorAll(".export-pace-min"))
    : [];
  const paceSecInputs = exportTimesContainer
    ? Array.from(exportTimesContainer.querySelectorAll(".export-pace-sec"))
    : [];

  if (timeInputs.length < exportCount || paceMinInputs.length < exportCount || paceSecInputs.length < exportCount) {
    updateMessage("导出份数与时间/配速行数不一致", true);
    return;
  }

  try {
    for (let i = 0; i < exportCount; i++) {
      updateMessage(`正在生成第 ${i + 1}/${exportCount} 个 FIT 文件，请稍候...`);

      const input = timeInputs[i];
      if (!input || !input.value) {
        updateMessage(`请为第 ${i + 1} 份设置开始日期时间`, true);
        return;
      }
      const fileStart = new Date(input.value);
      if (Number.isNaN(fileStart.getTime())) {
        updateMessage(`第 ${i + 1} 份的开始时间无效`, true);
        return;
      }

      const paceMinInput = paceMinInputs[i];
      const paceSecInput = paceSecInputs[i];
      if (paceMinInput && paceSecInput) {
        const pm = parseFloat(paceMinInput.value);
        const ps = parseFloat(paceSecInput.value);
        const sec = (Number.isFinite(pm) ? pm : 0) * 60 +
          (Number.isFinite(ps) ? ps : 0);
        if (!sec || sec <= 0) {
          updateMessage(`第 ${i + 1} 份的配速无效`, true);
          return;
        }

        var filePaceSecondsPerKm = sec;
      }

      const res = await fetch("/api/generate-fit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startTime: fileStart.toISOString(),
          points: routePoints,
          paceSecondsPerKm: filePaceSecondsPerKm,
          hrRest,
          hrMax,
          hrRampMinutes,
          lapCount,
          variantIndex: i + 1
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        updateMessage(err.error || "生成失败", true);
        return;
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = exportCount > 1 ? `run_${i + 1}.fit` : "run.fit";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    }
    updateMessage(`已生成 ${exportCount} 个 FIT 文件并开始下载`);
  } catch (e) {
    console.error(e);
    updateMessage("请求失败，请稍后重试", true);
  }
}

const genBtn = document.getElementById("generateFit");
genBtn.addEventListener("click", generateFit);

const lapInputInit = document.getElementById("lapCount");
if (lapInputInit) {
  lapInputInit.addEventListener("input", updateDistanceInfo);
}
const exportInputInit = document.getElementById("exportCount");
if (exportInputInit) {
  exportInputInit.addEventListener("input", rebuildExportTimes);
}
updateDistanceInfo();
rebuildExportTimes();

function renderPreviewCharts(preview) {
  if (!preview || !Array.isArray(preview.samples) || preview.samples.length === 0) {
    updateMessage("预览数据为空", true);
    return;
  }

  const labels = preview.samples.map((s) => (s.timeSec / 60).toFixed(1));
  const paceData = preview.samples.map((s) => {
    const speed = s.speed > 0 ? s.speed : 0.01;
    const secPerKm = 1000 / speed;
    return secPerKm / 60;
  });
  const hrData = preview.samples.map((s) => s.heartRate);

  const paceCtx = document.getElementById("paceChart").getContext("2d");
  const hrCtx = document.getElementById("hrChart").getContext("2d");

  if (paceChart) paceChart.destroy();
  if (hrChart) hrChart.destroy();

  paceChart = new Chart(paceCtx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "配速 (min/km)",
          data: paceData,
          borderColor: "#1976d2",
          tension: 0.4,
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          title: { display: true, text: "时间 (分钟)" }
        },
        y: {
          title: { display: true, text: "min/km" },
          reverse: true
        }
      }
    }
  });

  hrChart = new Chart(hrCtx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "心率 (bpm)",
          data: hrData,
          borderColor: "#e53935",
          tension: 0.4,
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          title: { display: true, text: "时间 (分钟)" }
        },
        y: {
          title: { display: true, text: "bpm" }
        }
      }
    }
  });
}

async function previewActivity() {
  if (routePoints.length < 2) {
    updateMessage("请至少在地图上选择两个点形成轨迹", true);
    return;
  }

  const exportTimesContainer = document.getElementById("exportTimes");
  const timeInputs = exportTimesContainer
    ? Array.from(exportTimesContainer.querySelectorAll(".export-time-input"))
    : [];
  const paceMinInputs = exportTimesContainer
    ? Array.from(exportTimesContainer.querySelectorAll(".export-pace-min"))
    : [];
  const paceSecInputs = exportTimesContainer
    ? Array.from(exportTimesContainer.querySelectorAll(".export-pace-sec"))
    : [];

  if (!timeInputs.length || !paceMinInputs.length || !paceSecInputs.length) {
    updateMessage("请先在导出列表中设置至少一份的时间和配速", true);
    return;
  }

  const firstTimeInput = timeInputs[0];
  if (!firstTimeInput.value) {
    const now = new Date();
    firstTimeInput.value = dateToLocalInputValue(now);
  }
  const start = new Date(firstTimeInput.value);
  if (Number.isNaN(start.getTime())) {
    updateMessage("预览使用的开始时间无效", true);
    return;
  }

  const firstPaceMinInput = paceMinInputs[0];
  const firstPaceSecInput = paceSecInputs[0];
  const pm = parseFloat(firstPaceMinInput.value);
  const ps = parseFloat(firstPaceSecInput.value);
  const paceSecondsPerKm = (Number.isFinite(pm) ? pm : 0) * 60 +
    (Number.isFinite(ps) ? ps : 0);
  if (!paceSecondsPerKm || paceSecondsPerKm <= 0) {
    updateMessage("预览使用的配速无效", true);
    return;
  }

  const hrRest = parseInt(document.getElementById("hrRest").value, 10) || 60;
  const hrMax = parseInt(document.getElementById("hrMax").value, 10) || 180;
  const hrRampMinutes = parseFloat(document.getElementById("hrRampMinutes")?.value) || 3;

  const lapInput = document.getElementById("lapCount");
  const lapCount = Math.max(1, parseInt(lapInput?.value, 10) || 1);

  updateMessage("正在生成预览，请稍候...");

  try {
    const res = await fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startTime: start.toISOString(),
        points: routePoints,
        paceSecondsPerKm,
        hrRest,
        hrMax,
        hrRampMinutes,
        lapCount
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      updateMessage(err.error || "预览失败", true);
      return;
    }

    const data = await res.json();
    renderPreviewCharts(data);

    const km = (data.totalDistanceMeters / 1000).toFixed(2);
    const min = (data.totalDurationSec / 60).toFixed(1);
    updateMessage(`预览已生成，总距离约 ${km} 公里，总时间约 ${min} 分钟`);
    previewData = data;
    previewIndex = 0;
    if (previewTimer) {
      clearInterval(previewTimer);
      previewTimer = null;
    }
    if (previewMarker) {
      map.removeLayer(previewMarker);
      previewMarker = null;
    }
    const samples = previewData.samples || [];
    if (samples.length > 0) {
      const first = samples[0];
      previewMarker = L.circleMarker([first.lat, first.lng], {
        radius: 6,
        color: "#1976d2"
      }).addTo(map);
      startPreviewPlayback();
    }
  } catch (e) {
    console.error(e);
    updateMessage("预览请求失败，请稍后重试", true);
  }
}

const previewBtn = document.getElementById("previewBtn");
if (previewBtn) {
  previewBtn.addEventListener("click", previewActivity);
}

function updateLiveInfo(sample) {
  const el = document.getElementById("liveInfo");
  if (!el || !sample) return;
  const t = Math.max(0, sample.timeSec || 0);
  const min = Math.floor(t / 60);
  const sec = Math.floor(t % 60);
  const speed = sample.speed > 0 ? sample.speed : 0.01;
  const secPerKm = 1000 / speed;
  const paceMin = Math.floor(secPerKm / 60);
  const paceSec = Math.round(secPerKm % 60);
  const paceStr = `${paceMin}'${paceSec.toString().padStart(2, "0")}"/km`;
  const hr = sample.heartRate || 0;
  el.textContent = `时间 ${min}:${sec.toString().padStart(2, "0")}  配速 ${paceStr}  心率 ${hr} bpm`;
}

function startPreviewPlayback() {
  const samples = previewData?.samples || [];
  if (!samples.length) return;

  const totalSamples = samples.length;
  const stepMs = 100;
  previewIndex = 0;

  if (previewTimer) {
    clearInterval(previewTimer);
  }

  previewTimer = setInterval(() => {
    if (previewIndex >= totalSamples) {
      clearInterval(previewTimer);
      previewTimer = null;
      return;
    }
    const s = samples[previewIndex];
    if (previewMarker && s.lat != null && s.lng != null) {
      previewMarker.setLatLng([s.lat, s.lng]);
    }
    updateLiveInfo(s);
    previewIndex += 1;
  }, stepMs);
}
