import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Encoder, Profile } from "@garmin/fitsdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

function toSemicircles(deg) {
  return Math.round((deg * 2147483648) / 180);
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

function offsetPointMeters(point, offsetLatMeters, offsetLonMeters) {
  const metersPerDegLat = 111320;
  const metersPerDegLon =
    111320 * Math.cos((point.lat * Math.PI) / 180);
  return {
    lat: point.lat + offsetLatMeters / metersPerDegLat,
    lng: point.lng + offsetLonMeters / metersPerDegLon
  };
}

function buildClosedBasePoints(points) {
  if (!points || points.length < 2) return points || [];
  const first = points[0];
  const last = points[points.length - 1];
  const d = haversineDistance(first.lat, first.lng, last.lat, last.lng);
  if (d < 5) {
    return points;
  }
  const closed = points.slice();
  closed.push({ lat: first.lat, lng: first.lng });
  return closed;
}

// Catmull-Rom 样条插值：在四个控制点间生成一段平滑曲线
function catmullRomPoint(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return {
    lat: 0.5 * (2 * p1.lat + (-p0.lat + p2.lat) * t + (2 * p0.lat - 5 * p1.lat + 4 * p2.lat - p3.lat) * t2 + (-p0.lat + 3 * p1.lat - 3 * p2.lat + p3.lat) * t3),
    lng: 0.5 * (2 * p1.lng + (-p0.lng + p2.lng) * t + (2 * p0.lng - 5 * p1.lng + 4 * p2.lng - p3.lng) * t2 + (-p0.lng + 3 * p1.lng - 3 * p2.lng + p3.lng) * t3)
  };
}

// 对路线点做 Catmull-Rom 平滑插值，目标点间距约 targetSpacingMeters 米
function smoothInterpolatePoints(points, targetSpacingMeters = 3) {
  if (!points || points.length < 2) return points || [];
  const n = points.length;
  const result = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n - 1, i + 2)];
    const segLen = haversineDistance(p1.lat, p1.lng, p2.lat, p2.lng);
    const steps = Math.max(2, Math.round(segLen / targetSpacingMeters));
    for (let j = 0; j < steps; j++) {
      result.push(catmullRomPoint(p0, p1, p2, p3, j / steps));
    }
  }
  result.push(points[n - 1]);
  return result;
}

function computeSamples(allPoints, distances, totalDist, paceSecondsPerKm, hrRestVal, hrMaxVal, hrRampMinutes) {
  const totalDistanceKm = totalDist / 1000;
  const targetDurationSec = totalDistanceKm * paceSecondsPerKm;

  const avgSpeedTarget = totalDist / targetDurationSec;
  const rampFrac = Math.min(0.75, Math.max(0.01, ((hrRampMinutes || 3) * 60) / targetDurationSec));
  const baseSpeedFactor = 0.98 + Math.random() * 0.06;
  const phase1 = Math.random() * Math.PI * 2;
  const phase2 = Math.random() * Math.PI * 2;

  const n = allPoints.length;
  const instSpeedRaw = new Array(n);
  const hrValues = new Array(n);

  let currentHr = hrRestVal;

  for (let i = 0; i < n; i++) {
    const frac = distances[i] / totalDist;

    const longWave = 0.04 * Math.sin(frac * Math.PI * 2 + phase1);
    const shortWave = 0.02 * Math.sin(frac * Math.PI * 6 + phase2);
    const speedRaw =
      avgSpeedTarget * baseSpeedFactor * (1 + longWave + shortWave);
    instSpeedRaw[i] = speedRaw;

    const effort = Math.min(
      1,
      Math.max(0, speedRaw / (avgSpeedTarget || 1e-6))
    );

    let intensityBase;
    if (frac < rampFrac) {
      const f = frac / rampFrac;
      intensityBase = 0.4 + 0.4 * f;
    } else if (frac < rampFrac + 0.7 * (1 - rampFrac)) {
      const f = (frac - rampFrac) / (0.7 * (1 - rampFrac));
      intensityBase = 0.8 + 0.05 * Math.sin(f * Math.PI * 2);
    } else {
      const stableEnd = rampFrac + 0.7 * (1 - rampFrac);
      const f = (frac - stableEnd) / Math.max(1e-6, 1 - stableEnd);
      intensityBase = 0.85 + 0.1 * f;
    }

    const intensity = Math.min(
      1,
      Math.max(0, 0.7 * intensityBase + 0.3 * effort)
    );

    const hrTarget = hrRestVal + (hrMaxVal - hrRestVal) * intensity;
    currentHr += (hrTarget - currentHr) * 0.08;
    const hrJitter = (Math.random() - 0.5) * 1.5;
    const hrValue = Math.round(
      Math.min(hrMaxVal, Math.max(hrRestVal, currentHr + hrJitter))
    );
    hrValues[i] = hrValue;
  }

  // 对瞬时速度做移动平均平滑（窗口 5）
  const smoothWindow = 5;
  const halfW = Math.floor(smoothWindow / 2);
  const instSpeedSmoothed = instSpeedRaw.map((_, i) => {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - halfW); j <= Math.min(n - 1, i + halfW); j++) {
      sum += instSpeedRaw[j]; cnt++;
    }
    return sum / cnt;
  });

  const segDurationsRaw = new Array(Math.max(0, n - 1));
  let rawDuration = 0;
  for (let i = 1; i < n; i++) {
    const ds = distances[i] - distances[i - 1];
    const v = instSpeedSmoothed[i] > 0 ? instSpeedSmoothed[i] : avgSpeedTarget;
    const dt = ds / v;
    segDurationsRaw[i - 1] = dt;
    rawDuration += dt;
  }

  const scale = rawDuration > 0 ? targetDurationSec / rawDuration : 1;

  const samples = [];
  let t = 0;
  samples.push({
    timeSec: 0,
    distance: distances[0],
    speed: instSpeedSmoothed[0] / scale,
    heartRate: hrValues[0],
    lat: allPoints[0].lat,
    lng: allPoints[0].lng
  });

  for (let i = 1; i < n; i++) {
    const dt = segDurationsRaw[i - 1] * scale;
    t += dt;
    samples.push({
      timeSec: t,
      distance: distances[i],
      speed: instSpeedSmoothed[i] / scale,
      heartRate: hrValues[i],
      lat: allPoints[i].lat,
      lng: allPoints[i].lng
    });
  }

  const totalDurationSec = samples.length
    ? samples[samples.length - 1].timeSec
    : targetDurationSec;

  return { samples, totalDurationSec };
}

app.post("/api/preview", (req, res) => {
  try {
    const {
      startTime,
      points,
      paceSecondsPerKm,
      hrRest,
      hrMax,
      hrRampMinutes,
      lapCount
    } = req.body || {};

    if (!startTime || !points || !Array.isArray(points) || points.length < 2) {
      return res.status(400).json({
        error: "缺少参数：需要 startTime、至少两个轨迹点 points"
      });
    }

    const startDate = new Date(startTime);
    if (Number.isNaN(startDate.getTime())) {
      return res.status(400).json({ error: "startTime 格式不正确" });
    }

    const pace = Number(paceSecondsPerKm) > 0 ? Number(paceSecondsPerKm) : 360;
    const hrRestVal = Number.isFinite(Number(hrRest)) ? Number(hrRest) : 60;
    const hrMaxVal = Number.isFinite(Number(hrMax)) ? Number(hrMax) : 180;
    const hrRampMin = Number.isFinite(Number(hrRampMinutes)) && Number(hrRampMinutes) > 0 ? Number(hrRampMinutes) : 3;
    const lapsRaw = Number(lapCount);
    const laps = Number.isFinite(lapsRaw) && lapsRaw > 0 ? Math.floor(lapsRaw) : 1;

    const basePoints = buildClosedBasePoints(points);
    const smoothBase = smoothInterpolatePoints(basePoints);
    const allPoints = [];
    const usedLaps = laps > 0 ? laps : 1;

    for (let lapIndex = 0; lapIndex < usedLaps; lapIndex++) {
      for (let i = 0; i < smoothBase.length; i++) {
        const p = smoothBase[i];
        allPoints.push(p);
      }
    }

    const distances = [0];
    let totalDist = 0;
    for (let i = 1; i < allPoints.length; i++) {
      const d = haversineDistance(
        allPoints[i - 1].lat,
        allPoints[i - 1].lng,
        allPoints[i].lat,
        allPoints[i].lng
      );
      totalDist += d;
      distances.push(totalDist);
    }

    if (totalDist === 0) {
      return res.status(400).json({ error: "轨迹距离为 0，请绘制更长的路线" });
    }

    const { samples, totalDurationSec } = computeSamples(
      allPoints,
      distances,
      totalDist,
      pace,
      hrRestVal,
      hrMaxVal,
      hrRampMin
    );

    return res.json({
      totalDistanceMeters: totalDist,
      totalDurationSec,
      samples
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "生成预览失败" });
  }
});

app.post("/api/generate-fit", (req, res) => {
  try {
    const {
      startTime,
      points,
      paceSecondsPerKm,
      hrRest,
      hrMax,
      hrRampMinutes,
      lapCount,
      variantIndex
    } = req.body || {};

    if (!startTime || !points || !Array.isArray(points) || points.length < 2) {
      return res.status(400).json({
        error: "缺少参数：需要 startTime、至少两个轨迹点 points"
      });
    }

    const startDate = new Date(startTime);
    if (Number.isNaN(startDate.getTime())) {
      return res.status(400).json({ error: "startTime 格式不正确" });
    }

    const pace = Number(paceSecondsPerKm) > 0 ? Number(paceSecondsPerKm) : 360;
    const hrRestVal = Number.isFinite(Number(hrRest)) ? Number(hrRest) : 60;
    const hrMaxVal = Number.isFinite(Number(hrMax)) ? Number(hrMax) : 180;
    const hrRampMin = Number.isFinite(Number(hrRampMinutes)) && Number(hrRampMinutes) > 0 ? Number(hrRampMinutes) : 3;
    const lapsRaw = Number(lapCount);
    const laps = Number.isFinite(lapsRaw) && lapsRaw > 0 ? Math.floor(lapsRaw) : 1;
    const variantRaw = Number(variantIndex);
    const variant =
      Number.isFinite(variantRaw) && variantRaw > 0
        ? Math.floor(variantRaw)
        : 1;

    const basePoints = buildClosedBasePoints(points);
    const smoothBase = smoothInterpolatePoints(basePoints);
    const allPoints = [];
    const usedLaps = laps > 0 ? laps : 1;

    for (let lapIndex = 0; lapIndex < usedLaps; lapIndex++) {
      // 逐点平滑随机游走抖动，模拟真实 GPS 噪声（每点独立，无整体平移）
      let noiseX = 0, noiseY = 0;
      for (let i = 0; i < smoothBase.length; i++) {
        const p = smoothBase[i];
        let noisyPoint;
        if (usedLaps === 1) {
          noisyPoint = p;
        } else {
          // 自回归随机游走：alpha=0.92 保证相邻点噪声相关（路径平滑）
          noiseX = noiseX * 0.92 + (Math.random() - 0.5) * 0.7;
          noiseY = noiseY * 0.92 + (Math.random() - 0.5) * 0.7;
          // 限幅 ±2m，避免漂移过大
          noiseX = Math.max(-2, Math.min(2, noiseX));
          noiseY = Math.max(-2, Math.min(2, noiseY));
          noisyPoint = offsetPointMeters(p, noiseX, noiseY);
        }
        allPoints.push(noisyPoint);
      }
    }

    const distances = [0];
    let totalDist = 0;
    for (let i = 1; i < allPoints.length; i++) {
      const d = haversineDistance(
        allPoints[i - 1].lat,
        allPoints[i - 1].lng,
        allPoints[i].lat,
        allPoints[i].lng
      );
      totalDist += d;
      distances.push(totalDist);
    }

    if (totalDist === 0) {
      return res.status(400).json({ error: "轨迹距离为 0，请绘制更长的路线" });
    }

    const { samples, totalDurationSec } = computeSamples(
      allPoints,
      distances,
      totalDist,
      pace,
      hrRestVal,
      hrMaxVal,
      hrRampMin
    );

    const encoder = new Encoder();

    encoder.onMesg(Profile.MesgNum.FILE_ID, {
      manufacturer: "development",
      product: 1,
      timeCreated: startDate,
      type: "activity"
    });

    encoder.onMesg(Profile.MesgNum.DEVICE_INFO, {
      timestamp: startDate,
      manufacturer: "development",
      product: 1,
      serialNumber: 1
    });

    const avgSpeed = totalDist / totalDurationSec;

    const sessionEnd = new Date(startDate.getTime() + totalDurationSec * 1000);

    encoder.onMesg(Profile.MesgNum.SESSION, {
      timestamp: sessionEnd,
      startTime: startDate,
      totalElapsedTime: totalDurationSec,
      totalTimerTime: totalDurationSec,
      totalDistance: totalDist,
      sport: "running",
      subSport: "generic",
      avgSpeed
    });

    encoder.onMesg(Profile.MesgNum.ACTIVITY, {
      timestamp: sessionEnd,
      totalTimerTime: totalDurationSec,
      numSessions: 1,
      type: "manual"
    });

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const timestamp = new Date(startDate.getTime() + s.timeSec * 1000);

      encoder.onMesg(Profile.MesgNum.RECORD, {
        timestamp,
        positionLat: toSemicircles(allPoints[i].lat),
        positionLong: toSemicircles(allPoints[i].lng),
        distance: s.distance,
        speed: s.speed,
        heartRate: s.heartRate
      });
    }

    const uint8Array = encoder.close();
    const buffer = Buffer.from(uint8Array);

    res.setHeader("Content-Type", "application/vnd.ant.fit");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=run_${variant}.fit`
    );
    return res.send(buffer);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "生成 FIT 文件失败" });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
