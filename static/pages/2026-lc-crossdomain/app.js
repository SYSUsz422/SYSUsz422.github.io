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

const timeSettings = {
  freezeAfter18s: true,
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
let positionFolder = null;
const vehiclePositions = {};
const hullGeometryCache = new Map();

initLights();
loadScene();
window.addEventListener('resize', resize);
playButton.addEventListener('click', () => {
  isPlaying = !isPlaying;
  playButton.textContent = isPlaying ? '暂停' : '播放';
});
timeSlider.addEventListener('input', () => {
  isPlaying = false;
  playButton.textContent = '播放';
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
    statusEl.textContent = `已从导出的 JSON 加载 ${sceneData.metadata.sampleCount} 个样本`;
  } catch (error) {
    statusEl.textContent = '未找到导出的 JSON，回退到 realtime-2.jsonl';
    sceneData = await loadJsonlFallback('../out/log/realtime-2.jsonl');
  }

  sampleDt = estimateSampleDt(sceneData.time);
  timeSlider.max = String(sceneData.time.length - 1);
  timeSlider.value = '0';
  playButton.textContent = '暂停';

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
  gui = new GUI({ title: '场景控制' });
  gui.domElement.id = 'sceneGui';

  positionFolder = gui.addFolder('位置监控');
  for (const vehicle of vehicles) {
    const label = vehicle.agent.label;
    vehiclePositions[label] = { x: 0, y: 0, z: 0 };
    const sub = positionFolder.addFolder(label);
    sub.add(vehiclePositions[label], 'x').name('X').listen().disable();
    sub.add(vehiclePositions[label], 'y').name('Y').listen().disable();
    sub.add(vehiclePositions[label], 'z').name('Z').listen().disable();
  }

  const hullFolder = gui.addFolder('凸包');
  hullFolder.add(hullSettings, 'visible').name('显示凸包').onChange(applyHullSettings);
  hullFolder.addColor(hullSettings, 'color').name('颜色').onChange(applyHullSettings);
  hullFolder.add(hullSettings, 'opacity', 0, 1, 0.01).name('面透明度').onChange(applyHullSettings);
  hullFolder.add(hullSettings, 'wireOpacity', 0, 1, 0.01).name('线框透明度').onChange(applyHullSettings);

  gui.add(timeSettings, 'freezeAfter18s').name('目标下潜后不再更新姿态');

  gui.close();

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
    // 更逼真的四旋翼无人机
    const bodyMat = material(typeColors.uav, 0.4, 0.3);
    const darkMat = material(0x1a1a2e, 0.3, 0.1);
    const armMat = material(0x8a8a9a, 0.35, 0.25);

    // 机身主体 - 流线型
    const bodyGeom = new THREE.BoxGeometry(1.2, 0.4, 0.18);
    const body = new THREE.Mesh(bodyGeom, bodyMat);
    body.castShadow = true;
    group.add(body);

    // 机身上盖 - 圆润
    const topCover = new THREE.Mesh(
      new THREE.BoxGeometry(0.8, 0.3, 0.08),
      material(0x3a7bd5, 0.35, 0.3),
    );
    topCover.position.set(0, 0, 0.13);
    group.add(topCover);

    // 摄像头/传感器
    const camera = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 16, 16),
      darkMat,
    );
    camera.position.set(0.5, 0, -0.1);
    camera.castShadow = true;
    group.add(camera);

    // 四个机臂
    const armPositions = [
      { x: 0.7, y: 0.7, angle: Math.PI / 4 },
      { x: 0.7, y: -0.7, angle: -Math.PI / 4 },
      { x: -0.7, y: 0.7, angle: 3 * Math.PI / 4 },
      { x: -0.7, y: -0.7, angle: -3 * Math.PI / 4 },
    ];

    for (const pos of armPositions) {
      // 机臂
      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.06, 0.05),
        armMat,
      );
      arm.position.set(pos.x / 2, pos.y / 2, 0.05);
      arm.rotation.z = pos.angle;
      arm.castShadow = true;
      group.add(arm);

      // 电机
      const motor = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.06, 0.1, 12),
        darkMat,
      );
      motor.position.set(pos.x, pos.y, 0.08);
      group.add(motor);

      // 螺旋桨 - 更逼真
      const bladeGeom = new THREE.BoxGeometry(0.5, 0.06, 0.01);
      for (let i = 0; i < 2; i++) {
        const blade = new THREE.Mesh(bladeGeom, material(0x4a4a5a, 0.4, 0.15));
        blade.position.set(pos.x, pos.y, 0.14);
        blade.rotation.z = pos.angle + i * Math.PI;
        blade.castShadow = true;
        group.add(blade);
      }

      // 起落架
      if (pos.x > 0 && pos.y > 0) {
        const legGeom = new THREE.CylinderGeometry(0.015, 0.015, 0.2, 8);
        const leg1 = new THREE.Mesh(legGeom, armMat);
        leg1.position.set(pos.x - 0.15, pos.y - 0.15, -0.15);
        group.add(leg1);
        const leg2 = new THREE.Mesh(legGeom, armMat);
        leg2.position.set(pos.x + 0.15, pos.y + 0.15, -0.15);
        group.add(leg2);
      }
    }
  } else if (type === 'usv') {
    // 更逼真的无人船
    const hullMat = material(typeColors.usv, 0.6, 0.2);
    const darkMat = material(0x2a2a3a, 0.4, 0.15);
    const cabinMat = material(0xe8e4d0, 0.5, 0.1);

    // 船体 - 使用多个几何体组合
    const hullBase = new THREE.Mesh(
      new THREE.BoxGeometry(2.0, 0.9, 0.3),
      hullMat,
    );
    hullBase.castShadow = true;
    group.add(hullBase);

    // 船体上部 - 略窄
    const hullTop = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 0.8, 0.15),
      hullMat,
    );
    hullTop.position.set(0, 0, 0.22);
    hullTop.castShadow = true;
    group.add(hullTop);

    // 船头 - 尖形
    const bowGeom = new THREE.ConeGeometry(0.45, 0.8, 4);
    const bow = new THREE.Mesh(bowGeom, hullMat);
    bow.rotation.z = Math.PI / 4;
    bow.rotation.y = Math.PI / 2;
    bow.position.x = 1.3;
    bow.scale.y = 0.85;
    bow.castShadow = true;
    group.add(bow);

    // 驾驶舱
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.55, 0.4),
      cabinMat,
    );
    cabin.position.set(-0.15, 0, 0.45);
    cabin.castShadow = true;
    group.add(cabin);

    // 驾驶舱窗户
    const windowMat = material(0x87ceeb, 0.2, 0.4);
    const window1 = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, 0.56, 0.15),
      windowMat,
    );
    window1.position.set(0.2, 0, 0.45);
    group.add(window1);

    // 桅杆/天线
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, 0.6, 8),
      darkMat,
    );
    mast.position.set(-0.3, 0, 0.9);
    group.add(mast);

    // 雷达
    const radar = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.02, 0.12),
      darkMat,
    );
    radar.position.set(-0.3, 0, 1.15);
    group.add(radar);

    // 船尾设备
    const sternEquip = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.4, 0.2),
      darkMat,
    );
    sternEquip.position.set(-0.8, 0, 0.25);
    group.add(sternEquip);

    // 舷号标记
    const idMat = material(0xffffff, 0.5, 0.1);
    const idPlate = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.01, 0.1),
      idMat,
    );
    idPlate.position.set(0.5, 0.46, 0.2);
    group.add(idPlate);
  } else if (type === 'uuv') {
    // 更逼真的无人潜航器
    const bodyMat = material(typeColors.uuv, 0.45, 0.2);
    const darkMat = material(0x1a2a1a, 0.35, 0.15);
    const finMat = material(0x7ab87a, 0.4, 0.1);

    // 主体 - 流线型鱼雷形状
    const bodyGeom = new THREE.CapsuleGeometry(0.38, 1.8, 12, 24);
    const body = new THREE.Mesh(bodyGeom, bodyMat);
    body.rotation.z = Math.PI / 2;
    body.castShadow = true;
    group.add(body);

    // 鼻锥 - 更尖锐
    const noseCone = new THREE.Mesh(
      new THREE.ConeGeometry(0.38, 0.5, 16),
      bodyMat,
    );
    noseCone.rotation.z = -Math.PI / 2;
    noseCone.position.x = 1.35;
    noseCone.castShadow = true;
    group.add(noseCone);

    // 尾锥
    const tailCone = new THREE.Mesh(
      new THREE.ConeGeometry(0.38, 0.4, 16),
      bodyMat,
    );
    tailCone.rotation.z = Math.PI / 2;
    tailCone.position.x = -1.3;
    tailCone.castShadow = true;
    group.add(tailCone);

    // 传感器窗口
    const sensorMat = material(0x00ff88, 0.2, 0.5);
    for (let i = 0; i < 3; i++) {
      const sensor = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.05, 0.02, 12),
        sensorMat,
      );
      sensor.position.set(0.5 - i * 0.4, 0, 0.39);
      sensor.rotation.x = Math.PI / 2;
      group.add(sensor);
    }

    // 主翼 - 十字形尾翼
    const wingMat = finMat;
    const wing1 = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.7, 0.35),
      wingMat,
    );
    wing1.position.set(-1.0, 0, 0);
    wing1.castShadow = true;
    group.add(wing1);

    const wing2 = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.35, 0.7),
      wingMat,
    );
    wing2.position.set(-1.0, 0, 0);
    wing2.castShadow = true;
    group.add(wing2);

    // 螺旋桨
    const propHub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 0.15, 12),
      darkMat,
    );
    propHub.position.set(-1.45, 0, 0);
    propHub.rotation.z = Math.PI / 2;
    group.add(propHub);

    const bladeGeom = new THREE.BoxGeometry(0.02, 0.35, 0.06);
    for (let i = 0; i < 4; i++) {
      const blade = new THREE.Mesh(bladeGeom, material(0x5a5a6a, 0.4, 0.2));
      blade.position.set(-1.5, 0, 0);
      blade.rotation.x = (i * Math.PI) / 2;
      blade.castShadow = true;
      group.add(blade);
    }

    // 背鳍 - 通信天线
    const dorsalFin = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.04, 0.2),
      finMat,
    );
    dorsalFin.position.set(0.2, 0, 0.45);
    group.add(dorsalFin);
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

  const shouldFreeze = timeSettings.freezeAfter18s && targetPos.z < -0.143;

  if (!shouldFreeze) {
    faceVelocity(targetMesh, sceneData.target.velocity[frameIndex]);
  }

  for (const vehicle of vehicles) {
    const pos = toVector3(vehicle.agent.position[frameIndex]);
    vehicle.group.position.copy(pos);
    if (!shouldFreeze) {
      faceVelocity(vehicle.group, vehicle.agent.velocity[frameIndex]);
    }
    const label = vehicle.agent.label;
    if (vehiclePositions[label]) {
      vehiclePositions[label].x = parseFloat(pos.x.toFixed(2));
      vehiclePositions[label].y = parseFloat(pos.y.toFixed(2));
      vehiclePositions[label].z = parseFloat(pos.z.toFixed(2));
    }
  }

  if (timeSettings.freezeAfter18s) {
    updateFormationHull(Math.min(frameIndex, hullFrameLimit));
    if (shouldFreeze) {
      hullMesh.visible = false;
      hullWire.visible = false;
    } else {
      hullMesh.visible = hullSettings.visible;
      hullWire.visible = hullSettings.visible;
    }
  } else {
    updateFormationHull(frameIndex);
    hullMesh.visible = hullSettings.visible;
    hullWire.visible = hullSettings.visible;
  }
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
