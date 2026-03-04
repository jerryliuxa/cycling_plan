const resultEl = document.getElementById("result");
const planBtn = document.getElementById("planBtn");
const resetBtn = document.getElementById("resetBtn");

const map = L.map("map");

L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
  maxZoom: 17,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a>',
}).addTo(map);

let startMarker = null;
let endMarker = null;
let routeLayer = null;

const iconStart = L.icon({
  iconUrl: "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-green.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});

const iconEnd = L.icon({
  iconUrl: "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});

async function locateByIP() {
  try {
    const resp = await fetch("https://ipapi.co/json/");
    if (!resp.ok) throw new Error("IP 地理定位失败");
    const data = await resp.json();
    const lat = Number(data.latitude);
    const lon = Number(data.longitude);
    const city = data.city || "当前位置";

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("无效坐标");

    map.setView([lat, lon], 12);
    resultEl.textContent = `已定位到：${city}\n请点击地图设置起点和终点。`;
  } catch (error) {
    map.setView([39.9042, 116.4074], 11);
    resultEl.textContent = "IP 定位失败，已默认显示北京。请点击地图设置起点和终点。";
  }
}

function updateButtons() {
  planBtn.disabled = !(startMarker && endMarker);
}

map.on("click", (e) => {
  if (!startMarker) {
    startMarker = L.marker(e.latlng, { icon: iconStart }).addTo(map).bindPopup("起点").openPopup();
    resultEl.textContent = "已设置起点，请继续点击设置终点。";
  } else if (!endMarker) {
    endMarker = L.marker(e.latlng, { icon: iconEnd }).addTo(map).bindPopup("终点").openPopup();
    resultEl.textContent = "已设置终点，点击“规划路线”。";
  } else {
    endMarker.setLatLng(e.latlng);
    resultEl.textContent = "已更新终点，点击“规划路线”重新计算。";
  }
  updateButtons();
});

resetBtn.addEventListener("click", () => {
  if (startMarker) map.removeLayer(startMarker);
  if (endMarker) map.removeLayer(endMarker);
  if (routeLayer) map.removeLayer(routeLayer);
  startMarker = null;
  endMarker = null;
  routeLayer = null;
  resultEl.textContent = "已重置。请点击地图设置起点和终点。";
  updateButtons();
});

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(x));
}

function getUCICategory(score) {
  if (score >= 240) return "HC";
  if (score >= 160) return "1级";
  if (score >= 80) return "2级";
  if (score >= 40) return "3级";
  if (score >= 20) return "4级";
  return "非分类";
}

async function fetchRoutes(start, end) {
  const url = `https://router.project-osrm.org/route/v1/bicycle/${start.lng},${start.lat};${end.lng},${end.lat}?overview=full&geometries=geojson&alternatives=true&steps=false`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("路线服务请求失败");
  const data = await resp.json();
  if (!data.routes?.length) throw new Error("未找到可用路线");
  return data.routes;
}

async function fetchElevations(coordinates) {
  const sampleStep = Math.max(1, Math.floor(coordinates.length / 80));
  const sampled = coordinates.filter((_, idx) => idx % sampleStep === 0);
  const points = sampled.map((c) => `${c[1]},${c[0]}`).join("|");
  const url = `https://api.opentopodata.org/v1/srtm90m?locations=${encodeURIComponent(points)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("高程服务请求失败");
  const data = await resp.json();
  return sampled.map((coord, idx) => ({ coord, elevation: data.results?.[idx]?.elevation ?? 0 }));
}

function analyzeRoute(route, elevPoints) {
  let gain = 0;
  let uphillDistance = 0;

  for (let i = 1; i < elevPoints.length; i += 1) {
    const prev = elevPoints[i - 1];
    const cur = elevPoints[i];
    const dist = haversineMeters(prev.coord, cur.coord);
    const delta = cur.elevation - prev.elevation;
    if (delta > 0) {
      gain += delta;
      uphillDistance += dist;
    }
  }

  const distanceKm = route.distance / 1000;
  const avgUphillGradient = uphillDistance > 0 ? (gain / uphillDistance) * 100 : 0;
  const climbScore = (uphillDistance / 1000) * avgUphillGradient;
  const uci = getUCICategory(climbScore);

  // 综合代价：距离 + 爬升惩罚（每 1m 爬升折算为 15m 平路代价）
  const effortCost = route.distance + gain * 15;

  return {
    gain,
    distanceKm,
    avgUphillGradient,
    climbScore,
    uci,
    effortCost,
  };
}

planBtn.addEventListener("click", async () => {
  try {
    planBtn.disabled = true;
    resultEl.textContent = "正在计算路线与坡度，请稍候…";

    const routes = await fetchRoutes(startMarker.getLatLng(), endMarker.getLatLng());
    const analyzed = [];

    for (const route of routes) {
      const elevPoints = await fetchElevations(route.geometry.coordinates);
      analyzed.push({
        route,
        ...analyzeRoute(route, elevPoints),
      });
    }

    analyzed.sort((a, b) => a.effortCost - b.effortCost);
    const best = analyzed[0];

    if (routeLayer) map.removeLayer(routeLayer);
    routeLayer = L.geoJSON(best.route.geometry, {
      style: { color: "#22c55e", weight: 5, opacity: 0.9 },
    }).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });

    const alternativesText = analyzed
      .map(
        (r, idx) =>
          `方案${idx + 1}: ${r.distanceKm.toFixed(1)} km | 爬升 ${r.gain.toFixed(0)} m | 均坡 ${r.avgUphillGradient.toFixed(1)}% | UCI ${r.uci}`
      )
      .join("\n");

    resultEl.textContent = `推荐路线（坡度优先）\n距离：${best.distanceKm.toFixed(1)} km\n累计爬升：${best.gain.toFixed(0)} m\n上坡平均坡度：${best.avgUphillGradient.toFixed(1)}%\nUCI等级：${best.uci}（分值 ${best.climbScore.toFixed(1)}）\n\n备选路线：\n${alternativesText}`;
  } catch (error) {
    resultEl.textContent = `规划失败：${error.message}`;
  } finally {
    updateButtons();
  }
});

locateByIP();
