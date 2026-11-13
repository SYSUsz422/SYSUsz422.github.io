import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { buildHull } from './hull.js';
import { createVehicleMesh } from './actors.js?v=20261113-sky4';
import { createOceanVolume } from './environment.js?v=20261113-sky4';
import { createSkyBackdrop } from './sky.js?v=20261113-sky4';

const canvas = document.querySelector('#scene');
const statusEl = document.querySelector('#status');
const playButton = document.querySelector('#playButton');
const timeSlider = document.querySelector('#timeSlider');
const timeLabel = document.querySelector('#timeLabel');
const speedSelect = document.querySelector('#speedSelect');
const hullStatus = document.querySelector('#hullStatus');
const heightLabel = document.querySelector('#heightLabel');
const typeColors = { usv: 0xffc53d, uav: 0x42a8ff, uuv: 0x00dfa2, target: 0xff293d };
const settings = { hull: true, labels: false, trails: 'recent' };
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x07121e, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(39, 1, 0.1, 1000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.09;
controls.minDistance = 12;
controls.maxDistance = 260;
const clock = new THREE.Clock();
const trails = [];
const layerLabels = new THREE.Group();
const labelSprites = [];
let ocean;
let sky;
let oceanPhase = '';
let depthGuide;
let sceneData;
let frameIndex = 0;
let isPlaying = false;
let diveReplayActive = false;
let playbackAccumulator = 0;
let sampleDt = 0.1;
let vehicles = [];
let targetMesh;
let hullMesh;
let hullWire;
let surfaceSection;
let view = 'space';
let currentHullFrame = -1;
let lastHull = null;
let autoFrame = true;
controls.addEventListener('start', () => { autoFrame = false; });

scene.add(new THREE.HemisphereLight(0xe6f3ff, 0x173e56, 0.85));
const keyLight = new THREE.DirectionalLight(0xffffff, 3);
keyLight.position.set(-15, -30, 60);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x5ba9ff, 1.4);
rimLight.position.set(30, 30, -10);
scene.add(rimLight);
scene.add(layerLabels);

playButton.addEventListener('click', () => {
  if (!sceneData) return;
  isPlaying = !isPlaying;
  playbackAccumulator = 0;
  playButton.textContent = isPlaying ? '暂停' : '播放';
});
timeSlider.addEventListener('input', () => {
  if (!sceneData) return;
  isPlaying = false;
  diveReplayActive = false;
  playbackAccumulator = 0;
  playButton.textContent = '播放';
  setFrame(Number(timeSlider.value));
  fitView();
});
document.querySelector('#trailMode').addEventListener('change', event => {
  settings.trails = event.target.value;
  if (sceneData) updateTrails();
});
document.querySelector('#showHull').addEventListener('change', event => {
  settings.hull = event.target.checked;
  if (sceneData) updateFormationHull(frameIndex);
});
document.querySelector('#showLabels').addEventListener('change', event => {
  settings.labels = event.target.checked;
  updateLabels();
});
document.querySelectorAll('[data-view]').forEach(button => {
  button.addEventListener('click', () => {
    view = button.dataset.view;
    document.querySelectorAll('[data-view]').forEach(item => {
      item.setAttribute('aria-pressed', String(item === button));
    });
    if (sceneData) fitView();
  });
});
document.querySelector('#resetView').addEventListener('click', () => {
  if (sceneData) fitView();
});
document.querySelector('#fullscreenButton').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.querySelector('#app').requestFullscreen();
  } catch {
    statusEl.textContent = '当前嵌入环境不支持全屏，请通过独立演示页查看。';
  }
});

document.querySelector('#diveReplay').addEventListener('click', () => {
  if (!sceneData?.presentation) return;
  view = 'space';
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
  setFrame(sceneData.presentation.startIndex);
  fitView();
  speedSelect.value = '4';
  playbackAccumulator = 0;
  isPlaying = true;
  diveReplayActive = true;
  playButton.textContent = '暂停';
});
window.addEventListener('resize', resize);
loadScene();

async function loadScene() {
  try {
    const response = await fetch('./ship3_scene.json');
    if (!response.ok) throw new Error('无法加载仿真数据');
    sceneData = normalizeScene(await response.json());
    prepareDivePresentation();
    if (!sceneData.time?.length || !sceneData.target?.position?.length) {
      throw new Error('仿真数据不完整');
    }
    sampleDt = estimateSampleDt(sceneData.time);
    timeSlider.max = String(sceneData.time.length - 1);
    timeSlider.disabled = false;
    playButton.disabled = false;
    buildWorld();
    buildActors();
    buildFormationHull();
    buildDepthGuide();
    // 首屏展示已下潜的真实代表帧，时刻明确标注；时间轴保留完整 0–350 s 回放。
    setFrame(findFrameAtOrBefore(sceneData.time, 250));
    resize();
    fitView();
    statusEl.textContent = '15 个智能体 · 350 s 真实轨迹回放';
    animate();
  } catch (error) {
    console.error(error);
    statusEl.textContent = '场景加载失败，请刷新页面重试。';
    hullStatus.textContent = '数据不可用';
    playButton.disabled = true;
    timeSlider.disabled = true;
  }
}

function buildWorld() {
  const bounds = new THREE.Box3(new THREE.Vector3(...sceneData.bounds.min), new THREE.Vector3(...sceneData.bounds.max));
  sky = createSkyBackdrop(scene, bounds, sceneData.bounds.seaLevel ?? 0);
  ocean = createOceanVolume(scene, bounds, sceneData.bounds.seaLevel ?? 0, sceneData.bounds.seaFloor ?? -22);
  for (const [text, color] of [['AIR / 空中', '#99c9ff'], ['SEA LEVEL / 海平面', '#d5faff'], ['UNDERWATER / 水下', '#68ffdb']]) {
    layerLabels.add(createLabel(text, color, 12));
  }
}

function prepareDivePresentation() {
  const level = sceneData.bounds.seaLevel ?? 0;
  const firstSubmerged = sceneData.target.position.findIndex(point => point[2] < level - 0.05);
  if (firstSubmerged < 0) return;
  const startTime = Math.max(0, sceneData.time[firstSubmerged] - 8);
  const startIndex = findFrameAtOrBefore(sceneData.time, startTime);
  const bounds = new THREE.Box3();
  // 整个下潜阶段共用同一真实包络，直接跳转与连续播放得到同样的取景。
  for (let i = startIndex; i < sceneData.time.length; i++) {
    bounds.expandByPoint(toVector3(sceneData.target.position[i]));
    for (const agent of sceneData.agents) bounds.expandByPoint(toVector3(agent.position[i]));
  }
  bounds.expandByPoint(new THREE.Vector3(bounds.min.x, bounds.min.y, level));
  sceneData.presentation = { startIndex, bounds };
}

function updateOceanRegion() {
  const diving = sceneData.presentation && frameIndex >= sceneData.presentation.startIndex;
  const phase = diving ? 'dive' : 'overview';
  if (phase === oceanPhase) return;
  const bounds = diving ? sceneData.presentation.bounds
    : new THREE.Box3(new THREE.Vector3(...sceneData.bounds.min), new THREE.Vector3(...sceneData.bounds.max));
  ocean.setBounds(bounds);
  sky.setBounds(bounds);
  oceanPhase = phase;
}

function buildActors() {
  targetMesh = new THREE.Group();
  const targetVehicle = createVehicleMesh('uuv', typeColors.target);
  targetVehicle.scale.setScalar(1.35);
  targetMesh.add(targetVehicle);
  targetMesh.name = 'target-submersible';
  const targetLabel = createLabel('目标潜航器', '#ffb7bf', 13);
  targetLabel.position.set(0, 0, -1.1);
  targetMesh.userData.label = targetLabel;
  targetMesh.add(targetLabel);
  scene.add(targetMesh);
  addTrail(sceneData.target.position, typeColors.target);
  vehicles = sceneData.agents.map(agent => {
    const group = createVehicleMesh(agent.type, typeColors[agent.type]);
    const label = createLabel(agent.label, '#f2f8ff', 11);
    label.position.z = 1.7;
    label.visible = settings.labels;
    group.add(label);
    scene.add(group);
    addTrail(agent.position, typeColors[agent.type]);
    return { agent, group, label };
  });
}



function createLabel(text, color, fontSize = 12) {
  const image = document.createElement('canvas');
  image.width = 512;
  image.height = 80;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(image), transparent: true, depthWrite: false,
    sizeAttenuation: false,
  }));
  sprite.userData = { canvas: image, color, fontSize };
  paintLabel(sprite, text);
  labelSprites.push(sprite);
  updateLabelScale(sprite);
  return sprite;
}

function paintLabel(sprite, text) {
  const { canvas: image, color } = sprite.userData;
  const ctx = image.getContext('2d');
  ctx.clearRect(0, 0, image.width, image.height);
  ctx.font = '600 27px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = '#03101f';
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.strokeText(text, 256, 40);
  ctx.fillStyle = color;
  ctx.fillText(text, 256, 40);
  sprite.material.map.needsUpdate = true;
}

function updateLabelScale(sprite) {
  const factor = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.max(1, canvas.clientHeight);
  const width = 512 * sprite.userData.fontSize / 27 * factor;
  sprite.scale.set(width, width * 80 / 512, 1);
}

function addTrail(points, color) {
  const geometry = new THREE.BufferGeometry().setFromPoints(points.map(toVector3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(points.length * 3), 3));
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.65, depthWrite: false,
  }));
  line.renderOrder = 1;
  trails.push({ line, color: new THREE.Color(color) });
  scene.add(line);
}

function updateTrails() {
  for (const [index, { line, color }] of trails.entries()) {
    const seconds = index === 0 ? 60 : 12;
    const start = settings.trails === 'recent' ? Math.max(0, frameIndex - Math.round(seconds / sampleDt)) : 0;
    line.visible = settings.trails !== 'off';
    line.geometry.setDrawRange(start, frameIndex - start + 1);
    const colors = line.geometry.attributes.color;
    for (let i = start; i <= frameIndex; i++) {
      const age = (i - start) / Math.max(1, frameIndex - start);
      const brightness = 0.12 + age * 0.88;
      colors.setXYZ(i, color.r * brightness, color.g * brightness, color.b * brightness);
    }
    colors.needsUpdate = true;
  }
}

function buildFormationHull() {
  hullMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
    color: 0xe9c97b, transparent: true, opacity: 0.07,
    side: THREE.DoubleSide, depthWrite: false,
  }));
  hullMesh.renderOrder = 2;
  scene.add(hullMesh);
  hullWire = new LineSegments2(new LineSegmentsGeometry(), new LineMaterial({
    color: 0xf1d18b, linewidth: 1.35, transparent: true, opacity: 0.82, depthWrite: false,
  }));
  hullWire.renderOrder = 3;
  scene.add(hullWire);
  surfaceSection = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
    color: 0x9ccad6, transparent: true, opacity: 0.42, depthWrite: false,
  }));
  surfaceSection.renderOrder = 4;
  scene.add(surfaceSection);
}

function updateFormationHull(index) {
  if (index !== currentHullFrame) {
    const positions = sceneData.agents.map(agent => agent.position[index]);
    const result = buildHull(positions, sceneData.target.position[index]);
    hullMesh.geometry.dispose();
    hullWire.geometry.dispose();
    hullMesh.geometry = result.geometry ?? new THREE.BufferGeometry();
    const lineGeometry = new LineSegmentsGeometry();
    if (result.edges) lineGeometry.setPositions(result.edges.attributes.position.array);
    hullWire.geometry = lineGeometry;
    updateSurfaceSection(result.geometry);
    result.edges?.dispose();
    lastHull = result;
    currentHullFrame = index;
  }
  const valid = lastHull?.kind === 'volume';
  hullMesh.visible = settings.hull && valid;
  hullWire.visible = settings.hull && valid;
  surfaceSection.visible = settings.hull && valid && surfaceSection.geometry.attributes.position.count >= 3;
  hullStatus.textContent = valid
    ? (lastHull.containsTarget ? '目标在凸包内' : '目标在凸包外')
    : '当前点集未形成三维凸包';
  hullStatus.dataset.state = valid ? (lastHull.containsTarget ? 'inside' : 'outside') : 'degenerate';
}

function updateSurfaceSection(geometry) {
  const points = [];
  const level = sceneData.bounds.seaLevel ?? 0;
  const add = point => {
    if (!points.some(other => other.distanceToSquared(point) < 1e-10)) points.push(point);
  };
  if (geometry) {
    // 几何截面使用完整三角面，不能使用经过夹角筛选的显示棱线。
    const attr = geometry.attributes.position;
    for (let i = 0; i < attr.count; i += 3) {
      for (let edge = 0; edge < 3; edge++) {
        const a = new THREE.Vector3().fromBufferAttribute(attr, i + edge);
        const b = new THREE.Vector3().fromBufferAttribute(attr, i + (edge + 1) % 3);
        if ((a.z - level) * (b.z - level) > 0) continue;
        if (Math.abs(a.z - b.z) < 1e-8) {
          if (Math.abs(a.z - level) < 1e-8) { add(a); add(b); }
        } else add(a.lerp(b, (level - a.z) / (b.z - a.z)));
      }
    }
  }
  const center = points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).divideScalar(points.length || 1);
  points.sort((a, b) => Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x));
  surfaceSection.geometry.dispose();
  surfaceSection.geometry = new THREE.BufferGeometry().setFromPoints(points);
}

function setFrame(index) {
  frameIndex = THREE.MathUtils.clamp(index, 0, sceneData.time.length - 1);
  timeSlider.value = String(frameIndex);
  timeLabel.textContent = 't = ' + sceneData.time[frameIndex].toFixed(1) + ' s';
  const targetPos = toVector3(sceneData.target.position[frameIndex]);
  targetMesh.position.copy(targetPos);
  faceVelocity(targetMesh, sceneData.target.velocity[frameIndex]);
  for (const vehicle of vehicles) {
    vehicle.group.position.copy(toVector3(vehicle.agent.position[frameIndex]));
    faceVelocity(vehicle.group, vehicle.agent.velocity[frameIndex]);
  }
  updateFormationHull(frameIndex);
  updateTrails();
  updateHeight();
  updateLayerLabels();
  updateDepthGuide();
  updateOceanRegion();
}

function updateHeight() {
  const z = targetMesh.position.z - (sceneData.bounds.seaLevel ?? 0);
  const vz = sceneData.target.velocity[frameIndex][2];
  heightLabel.textContent = Math.abs(z) < 0.05 ? '0.0 m' : Math.abs(z).toFixed(1) + ' m';
  document.querySelector('#diveState').textContent = z > 0.05 ? '目标位于水上'
    : z >= -0.05 ? '目标位于海面' : vz < -0.005 ? '↓ 正在下潜' : '目标位于水下';
}

function buildDepthGuide() {
  const group = new THREE.Group();
  const projection = new THREE.Mesh(new THREE.TorusGeometry(1.3, 0.065, 8, 64),
    new THREE.MeshBasicMaterial({color: 0xff6978, toneMapped: false, depthWrite: false}));
  projection.renderOrder = 7;
  const line = new LineSegments2(new LineSegmentsGeometry(), new LineMaterial({
    color: 0xff8290, linewidth: 2.5, transparent: true, opacity: 0.95, depthWrite: false,
    dashed: true, dashSize: 0.55, gapSize: 0.28, toneMapped: false,
  }));
  line.renderOrder = 7;
  const label = createLabel('深度 0.0 m', '#ffd3da', 14);
  group.add(projection, line, label);
  scene.add(group);
  depthGuide = { group, projection, line, label };
}

function updateDepthGuide() {
  const position = targetMesh.position;
  const level = sceneData.bounds.seaLevel ?? 0;
  const depth = Math.max(0, level - position.z);
  depthGuide.projection.position.set(position.x, position.y, level + 0.04);
  depthGuide.label.position.set(position.x + 2.4, position.y, (position.z + level) / 2);
  paintLabel(depthGuide.label, '↓ ' + depth.toFixed(1) + ' m');
  const segments = [position.x, position.y, level, position.x, position.y, position.z];
  for (let z = level - 5; z > position.z; z -= 5) {
    segments.push(position.x - 0.4, position.y, z, position.x + 0.4, position.y, z);
  }
  depthGuide.line.geometry.dispose();
  depthGuide.line.geometry = new LineSegmentsGeometry().setPositions(segments);
  depthGuide.line.computeLineDistances();
  depthGuide.line.visible = depth > 0.05;
  depthGuide.label.visible = depth > 0.05;
  depthGuide.projection.visible = true;
}

function updateLabels() {
  vehicles.forEach(vehicle => { vehicle.label.visible = settings.labels; });
}

function faceVelocity(object, velocity) {
  const v = toVector3(velocity);
  if (v.lengthSq() > 1e-6) object.rotation.z = Math.atan2(v.y, v.x);
}

function fitView() {
  autoFrame = true;
  const { box, center, distance } = framing();
  controls.maxDistance = Math.max(260, distance * 1.5);
  const direction = view === 'top' ? new THREE.Vector3(0, -0.001, 1)
    : view === 'side' ? new THREE.Vector3(0.35, -1, 0.07)
    : new THREE.Vector3(1.05, -1.8, 0.55);
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(direction.normalize(), distance);
  camera.lookAt(center);
  controls.update();
  updateLayerLabels(box);
}

function framing() {
  const points = [targetMesh.position, ...vehicles.map(vehicle => vehicle.group.position)];
  const locked = sceneData.presentation && frameIndex >= sceneData.presentation.startIndex;
  const box = locked ? sceneData.presentation.bounds.clone() : new THREE.Box3().setFromPoints(points);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(10, size.length() / 2);
  const halfFov = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(1, camera.aspect));
  const distance = radius / Math.sin(halfFov) * 1.25;
  return { box, center, distance };
}

function updateLayerLabels(box = new THREE.Box3().setFromPoints(vehicles.map(vehicle => vehicle.group.position))) {
  const center = box.getCenter(new THREE.Vector3());
  layerLabels.position.set(0, 0, 0);
  layerLabels.children[0].position.set(box.min.x - 9, center.y, Math.max(6, box.max.z * 0.8));
  layerLabels.children[1].position.set(box.min.x - 9, center.y, sceneData.bounds.seaLevel ?? 0);
  layerLabels.children[2].position.set(box.min.x - 9, center.y, Math.min(-6, box.min.z * 0.8));
  layerLabels.visible = view !== 'top';
  if (targetMesh.userData?.label) targetMesh.userData.label.visible = view !== 'top';
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.25);
  if (isPlaying && sceneData) {
    playbackAccumulator += dt * Number(speedSelect.value);
    if (playbackAccumulator >= sampleDt) {
      const steps = Math.floor(playbackAccumulator / sampleDt);
      playbackAccumulator -= steps * sampleDt;
      const reachedEnd = diveReplayActive && frameIndex + steps >= sceneData.time.length - 1;
      const next = reachedEnd ? sceneData.time.length - 1 : (frameIndex + steps) % sceneData.time.length;
      setFrame(next);
      if (reachedEnd) {
        isPlaying = false;
        diveReplayActive = false;
        playButton.textContent = '播放';
      }
      if (next < steps) fitView();
    }
  }
  if (isPlaying && autoFrame) {
    // 缓慢调整取景范围；手动操作相机后停止跟随，复位可恢复。
    const { center, distance } = framing();
    const offset = camera.position.clone().sub(controls.target);
    const blend = 1 - Math.exp(-dt * 2.5);
    offset.setLength(THREE.MathUtils.lerp(offset.length(), distance, blend));
    controls.target.lerp(center, blend);
    camera.position.copy(controls.target).add(offset);
  }
  controls.update();
  ocean?.update(sceneData.time[frameIndex]);
  sky?.update(camera, sceneData.time[frameIndex]);
  renderer.render(scene, camera);
}

function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
  if (hullWire) hullWire.material.resolution.set(width, height);
  if (depthGuide) depthGuide.line.material.resolution.set(width, height);
  labelSprites.forEach(updateLabelScale);
  if (sceneData && targetMesh) fitView();
}

function estimateSampleDt(time) {
  if (!time || time.length < 2) return 0.1;
  return Math.max(0.016, time[1] - time[0]);
}

function normalizeScene(data) {
  if (!data || !Array.isArray(data.agents)) {
    return data;
  }

  const hasDelta = Array.isArray(data.target?.positionDelta)
    || data.agents.some((agent) => Array.isArray(agent.positionDelta));
  if (!hasDelta) {
    return data;
  }

  const scale = Number(data.metadata?.positionScale ?? 0.01);
  const dt = estimateSampleDt(data.time);

  for (const agent of data.agents) {
    if (!Array.isArray(agent.positionDelta)) {
      continue;
    }
    agent.position = decodePositionDelta(agent.positionDelta, scale);
    agent.velocity = velocityFromPositions(agent.position, dt);
    delete agent.positionDelta;
  }

  if (Array.isArray(data.target?.positionDelta)) {
    data.target.position = decodePositionDelta(data.target.positionDelta, scale);
    data.target.velocity = velocityFromPositions(data.target.position, dt);
    delete data.target.positionDelta;
  }

  return data;
}

function decodePositionDelta(flat, scale) {
  const positions = [];
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i + 2 < flat.length; i += 3) {
    x += flat[i];
    y += flat[i + 1];
    z += flat[i + 2];
    positions.push([x * scale, y * scale, z * scale]);
  }
  return positions;
}

function velocityFromPositions(positions, dt) {
  const step = dt > 0 ? dt : 0.1;
  const last = positions.length - 1;
  return positions.map((point, index) => {
    const lo = Math.max(index - 1, 0);
    const hi = Math.min(index + 1, last);
    const span = (hi - lo) * step;
    if (span <= 0) {
      return [0, 0, 0];
    }
    const a = positions[lo];
    const b = positions[hi];
    return [(b[0] - a[0]) / span, (b[1] - a[1]) / span, (b[2] - a[2]) / span];
  });
}

function findFrameAtOrBefore(time, limitSeconds) {
  let best = 0;
  for (let i = 0; i < time.length; i += 1) {
    if (time[i] <= limitSeconds) {
      best = i;
    } else {
      break;
    }
  }
  return best;
}

function toVector3(point) {
  return new THREE.Vector3(point[0], point[1], point[2]);
}
