import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import GUI from 'lil-gui';

const canvas = document.querySelector('#scene');
const statusEl = document.querySelector('#status');
const playButton = document.querySelector('#playButton');
const timeSlider = document.querySelector('#timeSlider');
const timeLabel = document.querySelector('#timeLabel');
const speedSelect = document.querySelector('#speedSelect');

const typeColors = {
  usv: 0xe34242,
  uav: 0x2f7ee6,
  uuv: 0x2eaa57,
  target: 0xf2f0dd,
};

const hullSettings = {
  visible: true,
  color: '#ffc857',
  opacity: 0.16,
  wireOpacity: 0.78,
};

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(0x071018, 1);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x071018, 70, 210);

const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 1000);
camera.up.set(0, 0, 1);
camera.position.set(52, -94, 52);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.target.set(24, -28, -2);
controls.maxDistance = 240;
controls.minDistance = 16;

const clock = new THREE.Clock();
let sceneData = null;
let frameIndex = 0;
let isPlaying = true;
let playbackAccumulator = 0;
let sampleDt = 0.1;
let vehicles = [];
let targetMesh = null;
let hullMesh = null;
let hullWire = null;
let hullFrameLimit = 0;
let currentHullFrame = -1;
let gui = null;
const hullGeometryCache = new Map();

initLights();
loadScene();
window.addEventListener('resize', resize);
playButton.addEventListener('click', () => {
  isPlaying = !isPlaying;
  playButton.textContent = isPlaying ? 'Pause' : 'Play';
});
timeSlider.addEventListener('input', () => {
  isPlaying = false;
  playButton.textContent = 'Play';
  setFrame(Number(timeSlider.value));
});

function initLights() {
  scene.add(new THREE.HemisphereLight(0xbce9ff, 0x102c39, 1.35));

  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(-40, -55, 90);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 220;
  sun.shadow.camera.left = -90;
  sun.shadow.camera.right = 90;
  sun.shadow.camera.top = 90;
  sun.shadow.camera.bottom = -90;
  scene.add(sun);
}

async function loadScene() {
  try {
    sceneData = await fetchJson('./ship2_scene.json');
    statusEl.textContent = `Loaded ${sceneData.metadata.sampleCount} samples from exported JSON`;
  } catch (error) {
    statusEl.textContent = 'Exported JSON not found. Falling back to realtime-2.jsonl.';
    sceneData = await loadJsonlFallback('../out/log/realtime-2.jsonl');
  }

  sampleDt = estimateSampleDt(sceneData.time);
  timeSlider.max = String(sceneData.time.length - 1);
  timeSlider.value = '0';
  playButton.textContent = 'Pause';

  buildWorld(sceneData);
  buildActors(sceneData);
  buildFormationHull(sceneData);
  initGui();
  setFrame(0);
  resize();
  animate();
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Cannot load ${url}`);
  }
  return response.json();
}

async function loadJsonlFallback(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Cannot load fallback ${url}`);
  }

  const text = await response.text();
  const rows = text.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const first = rows[0];
  const agentCount = first.state.agents.length;

  const agents = Array.from({ length: agentCount }, (_, index) => {
    const type = first.state.agents[index].type.toLowerCase();
    return {
      id: index + 1,
      type,
      label: `${type.toUpperCase()} ${index + 1}`,
      position: [],
      velocity: [],
      speed: [],
      control: [],
      controlNorm: [],
    };
  });

  const target = { position: [], velocity: [] };
  const time = [];

  for (const row of rows) {
    time.push(row.t);
    target.position.push(row.state.target.p);
    target.velocity.push(row.state.target.v);
    for (let i = 0; i < agentCount; i += 1) {
      const agentState = row.state.agents[i];
      const dydtStart = 6 + i * 18;
      const control = row.dydt ? row.dydt.slice(dydtStart + 3, dydtStart + 6) : [0, 0, 0];
      agents[i].position.push(agentState.p);
      agents[i].velocity.push(agentState.v);
      agents[i].speed.push(lengthOf(agentState.v));
      agents[i].control.push(control);
      agents[i].controlNorm.push(lengthOf(control));
    }
  }

  const allPositions = [target.position, ...agents.map((agent) => agent.position)].flat();
  const bounds = computeBounds(allPositions);

  return {
    metadata: {
      name: 'ship2_case2',
      source: url,
      sampleCount: rows.length,
      agentCount,
      timeUnit: 's',
      lengthUnit: 'm',
    },
    time,
    target,
    agents,
    bounds,
  };
}

function buildWorld(data) {
  const bounds = data.bounds;
  const min = new THREE.Vector3(...bounds.min);
  const max = new THREE.Vector3(...bounds.max);
  const center = min.clone().add(max).multiplyScalar(0.5);
  const size = max.clone().sub(min);

  controls.target.copy(center);
  controls.target.z = -2;
  camera.position.set(center.x + 58, center.y - 88, center.z + 54);

  const seaLevel = bounds.seaLevel ?? 0;
  const seaFloor = bounds.seaFloor ?? Math.min(-20, min.z - 4);
  const waterWidth = Math.max(size.x + 24, 90);
  const waterDepth = Math.max(size.y + 24, 90);
  const waterHeight = seaLevel - seaFloor;

  const sea = createSeaSurface(waterWidth, waterDepth);
  sea.position.set(center.x, center.y, seaLevel);
  scene.add(sea);

  const water = new THREE.Mesh(
    new THREE.BoxGeometry(waterWidth, waterDepth, waterHeight),
    new THREE.MeshPhysicalMaterial({
      color: 0x0b5d7e,
      transparent: true,
      opacity: 0.16,
      roughness: 0.55,
      metalness: 0,
      transmission: 0.18,
      depthWrite: false,
    }),
  );
  water.position.set(center.x, center.y, seaFloor + waterHeight / 2);
  scene.add(water);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(waterWidth, waterDepth),
    new THREE.MeshStandardMaterial({
      color: 0x17435a,
      roughness: 0.95,
      metalness: 0,
      transparent: true,
      opacity: 0.45,
    }),
  );
  floor.position.set(center.x, center.y, seaFloor);
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(Math.max(waterWidth, waterDepth), 18, 0x8fd4e8, 0x2d6374);
  grid.rotation.x = Math.PI / 2;
  grid.position.set(center.x, center.y, seaLevel + 0.015);
  grid.material.transparent = true;
  grid.material.opacity = 0.18;
  scene.add(grid);
}

function createSeaSurface(width, depth) {
  const geometry = new THREE.PlaneGeometry(width, depth, 70, 70);
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = 0.22 * Math.sin(x * 0.16) + 0.14 * Math.cos(y * 0.21);
    positions.setZ(i, z);
  }
  geometry.computeVertexNormals();

  const material = new THREE.MeshPhysicalMaterial({
    color: 0x4caac7,
    roughness: 0.16,
    metalness: 0,
    transparent: true,
    opacity: 0.58,
    clearcoat: 0.7,
    clearcoatRoughness: 0.22,
    side: THREE.DoubleSide,
  });

  const sea = new THREE.Mesh(geometry, material);
  sea.receiveShadow = true;
  return sea;
}

function buildActors(data) {
  targetMesh = createTarget();
  scene.add(targetMesh);
  drawLine(data.target.position, typeColors.target, 0.86, 2);

  vehicles = data.agents.map((agent) => {
    const group = new THREE.Group();
    group.name = agent.label;
    group.add(createVehicleMesh(agent.type));
    group.add(createLabelSprite(agent.label));
    scene.add(group);

    drawLine(agent.position, typeColors[agent.type] ?? 0xffffff, 0.62, 1);

    return { agent, group };
  });
}

function buildFormationHull(data) {
  hullFrameLimit = findFrameAtOrBefore(data.time, 18);

  const hullMaterial = new THREE.MeshStandardMaterial({
    color: hullSettings.color,
    transparent: true,
    opacity: hullSettings.opacity,
    roughness: 0.62,
    metalness: 0.02,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  hullMesh = new THREE.Mesh(new THREE.BufferGeometry(), hullMaterial);
  hullMesh.renderOrder = 2;
  hullMesh.visible = hullSettings.visible;
  scene.add(hullMesh);

  hullWire = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({
      color: hullSettings.color,
      transparent: true,
      opacity: hullSettings.wireOpacity,
    }),
  );
  hullWire.renderOrder = 3;
  hullWire.visible = hullSettings.visible;
  scene.add(hullWire);
}

function initGui() {
  gui = new GUI({ title: 'Scene controls' });
  gui.domElement.id = 'sceneGui';

  const hullFolder = gui.addFolder('Convex hull');
  hullFolder.add(hullSettings, 'visible').name('Show hull').onChange(applyHullSettings);
  hullFolder.addColor(hullSettings, 'color').name('Color').onChange(applyHullSettings);
  hullFolder.add(hullSettings, 'opacity', 0, 1, 0.01).name('Face opacity').onChange(applyHullSettings);
  hullFolder.add(hullSettings, 'wireOpacity', 0, 1, 0.01).name('Wire opacity').onChange(applyHullSettings);
  hullFolder.open();

  applyHullSettings();
}

function applyHullSettings() {
  if (!hullMesh || !hullWire) {
    return;
  }

  hullMesh.visible = hullSettings.visible;
  hullWire.visible = hullSettings.visible;
  hullMesh.material.color.set(hullSettings.color);
  hullMesh.material.opacity = hullSettings.opacity;
  hullMesh.material.needsUpdate = true;
  hullWire.material.color.set(hullSettings.color);
  hullWire.material.opacity = hullSettings.wireOpacity;
  hullWire.material.needsUpdate = true;
}

function createVehicleMesh(type) {
  const group = new THREE.Group();
  if (type === 'uav') {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.34, 0.24),
      material(typeColors.uav, 0.52, 0.25),
    );
    body.castShadow = true;
    group.add(body);

    const armMat = material(0xd9e7ef, 0.45, 0.15);
    const armA = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.08, 0.06), armMat);
    const armB = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.4, 0.06), armMat);
    group.add(armA, armB);

    for (const [x, y] of [[1.15, 1.15], [1.15, -1.15], [-1.15, 1.15], [-1.15, -1.15]]) {
      const rotor = new THREE.Mesh(
        new THREE.CylinderGeometry(0.32, 0.32, 0.035, 28),
        material(0x0c1a24, 0.35, 0.05),
      );
      rotor.position.set(x, y, 0.08);
      rotor.rotation.x = Math.PI / 2;
      rotor.castShadow = true;
      group.add(rotor);
    }
  } else if (type === 'usv') {
    const hull = new THREE.Mesh(
      new THREE.BoxGeometry(1.75, 0.82, 0.36),
      material(typeColors.usv, 0.72, 0.15),
    );
    hull.scale.z = 0.82;
    hull.castShadow = true;
    group.add(hull);

    const bow = new THREE.Mesh(
      new THREE.ConeGeometry(0.42, 0.72, 4),
      material(0xff6666, 0.65, 0.1),
    );
    bow.rotation.z = Math.PI / 4;
    bow.rotation.y = Math.PI / 2;
    bow.position.x = 1.13;
    bow.scale.y = 0.8;
    bow.castShadow = true;
    group.add(bow);

    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(0.62, 0.48, 0.34),
      material(0xf5f1db, 0.55, 0.08),
    );
    cabin.position.set(-0.22, 0, 0.35);
    cabin.castShadow = true;
    group.add(cabin);
  } else if (type === 'uuv') {
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.36, 1.6, 10, 24),
      material(typeColors.uuv, 0.5, 0.18),
    );
    body.rotation.z = Math.PI / 2;
    body.castShadow = true;
    group.add(body);

    const finMat = material(0xb8ead0, 0.45, 0.05);
    const finA = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.65), finMat);
    finA.position.x = -0.85;
    const finB = finA.clone();
    finB.rotation.x = Math.PI / 2;
    group.add(finA, finB);
  }

  return group;
}

function createTarget() {
  const group = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.68, 0),
    material(typeColors.target, 0.7, 0.1),
  );
  core.castShadow = true;
  group.add(core);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.88, 0.025, 8, 64),
    material(0x20242a, 0.45, 0.1),
  );
  ring.rotation.x = Math.PI / 2;
  group.add(ring);
  return group;
}

function createLabelSprite(text) {
  const canvas2d = document.createElement('canvas');
  canvas2d.width = 256;
  canvas2d.height = 64;
  const ctx = canvas2d.getContext('2d');
  ctx.fillStyle = 'rgba(5, 15, 23, 0.7)';
  ctx.fillRect(0, 0, canvas2d.width, canvas2d.height);
  ctx.font = '600 30px Segoe UI, Arial';
  ctx.fillStyle = '#eef8fb';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 34);

  const texture = new THREE.CanvasTexture(canvas2d);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  }));
  sprite.position.set(0, 0, 1.55);
  sprite.scale.set(3.8, 0.95, 1);
  return sprite;
}

function material(color, roughness, metalness) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness,
  });
}

function drawLine(points, color, opacity, width) {
  const geometry = new THREE.BufferGeometry().setFromPoints(points.map(toVector3));
  const line = new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      linewidth: width,
    }),
  );
  scene.add(line);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  controls.update();

  if (isPlaying && sceneData) {
    playbackAccumulator += dt * Number(speedSelect.value);
    if (playbackAccumulator >= sampleDt) {
      const steps = Math.floor(playbackAccumulator / sampleDt);
      playbackAccumulator -= steps * sampleDt;
      setFrame((frameIndex + steps) % sceneData.time.length);
    }
  }

  renderer.render(scene, camera);
}

function setFrame(index) {
  frameIndex = THREE.MathUtils.clamp(index, 0, sceneData.time.length - 1);
  timeSlider.value = String(frameIndex);
  timeLabel.textContent = `t = ${sceneData.time[frameIndex].toFixed(1)} s`;

  const targetPos = toVector3(sceneData.target.position[frameIndex]);
  targetMesh.position.copy(targetPos);
  faceVelocity(targetMesh, sceneData.target.velocity[frameIndex]);

  for (const vehicle of vehicles) {
    const pos = toVector3(vehicle.agent.position[frameIndex]);
    vehicle.group.position.copy(pos);
    faceVelocity(vehicle.group, vehicle.agent.velocity[frameIndex]);
  }

  updateFormationHull(Math.min(frameIndex, hullFrameLimit));
}

function updateFormationHull(index) {
  if (!hullMesh || !hullWire) {
    return;
  }
  if (index === currentHullFrame) {
    return;
  }

  const geometry = getHullGeometry(index);
  hullWire.geometry.dispose();
  hullMesh.geometry = geometry;
  hullWire.geometry = new THREE.EdgesGeometry(geometry, 18);
  currentHullFrame = index;
}

function getHullGeometry(index) {
  if (hullGeometryCache.has(index)) {
    return hullGeometryCache.get(index);
  }

  const points = sceneData.agents.map((agent) => toVector3(agent.position[index]));
  const geometry = new ConvexGeometry(points);
  geometry.computeVertexNormals();
  hullGeometryCache.set(index, geometry);
  return geometry;
}

function faceVelocity(object, velocity) {
  const v = toVector3(velocity);
  if (v.lengthSq() < 1e-6) {
    return;
  }
  const heading = Math.atan2(v.y, v.x);
  object.rotation.set(0, 0, heading);
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

function estimateSampleDt(time) {
  if (!time || time.length < 2) {
    return 0.1;
  }
  return Math.max(0.016, time[1] - time[0]);
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

function computeBounds(points) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i], point[i]);
      max[i] = Math.max(max[i], point[i]);
    }
  }
  const padding = [8, 8, 5];
  return {
    min: min.map((value, i) => value - padding[i]),
    max: max.map((value, i) => value + padding[i]),
    seaLevel: 0,
    seaFloor: Math.min(-20, min[2] - 4),
  };
}

function toVector3(point) {
  return new THREE.Vector3(point[0], point[1], point[2]);
}

function lengthOf(vector) {
  return Math.hypot(vector[0], vector[1], vector[2]);
}
