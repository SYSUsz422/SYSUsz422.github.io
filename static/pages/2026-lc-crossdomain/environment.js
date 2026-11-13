import * as THREE from 'three';

const vertexShader = `
  varying vec3 vWorldPosition;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const surfaceShader = `
  uniform float uTime;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  varying vec3 vWorldPosition;
  void main() {
    vec2 p = vWorldPosition.xy;
    float a = dot(p, vec2(0.75, 0.30)) + uTime * 0.35;
    float b = dot(p, vec2(-0.28, 0.95)) - uTime * 0.24;
    // 只计算光色法线，不位移顶点，所有海面参考点仍位于真实海平面。
    vec2 slope = 0.025 * cos(a) * vec2(0.75, 0.30)
      + 0.018 * cos(b) * vec2(-0.28, 0.95);
    vec3 normal = normalize(vec3(-slope, 1.0));
    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    vec3 lightDirection = normalize(vec3(-0.4, -0.25, 0.9));
    float fresnel = pow(1.0 - clamp(abs(dot(normal, viewDirection)), 0.0, 1.0), 3.0);
    float reflection = pow(max(dot(normal, normalize(viewDirection + lightDirection)), 0.0), 64.0);
    float ripple = 0.5 + 0.5 * sin(a) * sin(b);
    vec3 color = mix(uDeep, uShallow, 0.48 + 0.12 * ripple + 0.18 * fresnel);
    color += vec3(0.08, 0.11, 0.12) * reflection;
    gl_FragColor = vec4(color, 0.23 + 0.06 * fresnel);
    #include <colorspace_fragment>
  }
`;

const wallShader = `
  uniform float uSeaLevel;
  uniform float uSeaFloor;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  varying vec3 vWorldPosition;
  void main() {
    float depth = clamp((uSeaLevel - vWorldPosition.z) / (uSeaLevel - uSeaFloor), 0.0, 1.0);
    vec3 color = mix(uShallow, uDeep, pow(depth, 0.75));
    gl_FragColor = vec4(color, 0.24 + 0.10 * depth);
    #include <colorspace_fragment>
  }
`;

/** 创建固定海平面与可透视内部的水体剖面；bounds 只使用 XY 包络。 */
export function createOceanVolume(scene, bounds, seaLevel = 0, seaFloor = -22) {
  if (!Number.isFinite(seaLevel) || !Number.isFinite(seaFloor) || seaFloor >= seaLevel) {
    throw new RangeError('海底必须低于有限的海平面高度');
  }
  const group = new THREE.Group();
  group.name = 'ocean-volume';
  const surfaceMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uDeep: { value: new THREE.Color(0x13638c) },
      uShallow: { value: new THREE.Color(0x33b0cc) },
    },
    vertexShader, fragmentShader: surfaceShader,
    side: THREE.DoubleSide, transparent: true, depthWrite: false, toneMapped: false,
  });
  surfaceMaterial.forceSinglePass = true;
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), surfaceMaterial);
  surface.name = 'ocean-surface';
  surface.renderOrder = -2;

  // 四个面的顶点均朝向水体外侧，BackSide 只显示远侧内壁，近侧自然剖开。
  const wallVertices = [];
  const faces = [
    [[0.5, -0.5, -1], [0.5, 0.5, -1], [0.5, 0.5, 0], [0.5, -0.5, 0]],
    [[-0.5, 0.5, -1], [-0.5, -0.5, -1], [-0.5, -0.5, 0], [-0.5, 0.5, 0]],
    [[0.5, 0.5, -1], [-0.5, 0.5, -1], [-0.5, 0.5, 0], [0.5, 0.5, 0]],
    [[-0.5, -0.5, -1], [0.5, -0.5, -1], [0.5, -0.5, 0], [-0.5, -0.5, 0]],
  ];
  for (const face of faces) {
    for (const index of [0, 1, 2, 0, 2, 3]) wallVertices.push(...face[index]);
  }
  const wallGeometry = new THREE.BufferGeometry();
  wallGeometry.setAttribute('position', new THREE.Float32BufferAttribute(wallVertices, 3));
  const walls = new THREE.Mesh(wallGeometry, new THREE.ShaderMaterial({
    uniforms: {
      uSeaLevel: { value: seaLevel }, uSeaFloor: { value: seaFloor },
      uShallow: { value: new THREE.Color(0x2582ae) },
      uDeep: { value: new THREE.Color(0x0b2946) },
    },
    vertexShader, fragmentShader: wallShader,
    side: THREE.BackSide, transparent: true, depthWrite: false, toneMapped: false,
  }));
  walls.name = 'ocean-section-walls';
  walls.renderOrder = -3;

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
    color: 0x0b2c47, transparent: true, opacity: 0.68, depthWrite: false, toneMapped: false,
  }));
  floor.name = 'ocean-floor';
  floor.renderOrder = -4;

  const grid = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
    color: 0x7cc9de, transparent: true, opacity: 0.24, depthWrite: false, toneMapped: false,
  }));
  grid.name = 'ocean-grid';
  grid.renderOrder = -1;
  const outlineGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, -0.5, 0),
    new THREE.Vector3(0.5, 0.5, 0), new THREE.Vector3(-0.5, 0.5, 0),
  ]);
  const surfaceOutline = new THREE.LineLoop(outlineGeometry, new THREE.LineBasicMaterial({
    color: 0x84d8e8, transparent: true, opacity: 0.62, depthWrite: false, toneMapped: false,
  }));
  surfaceOutline.name = 'ocean-surface-outline';
  const floorOutline = new THREE.LineLoop(outlineGeometry, new THREE.LineBasicMaterial({
    color: 0x4384a6, transparent: true, opacity: 0.28, depthWrite: false, toneMapped: false,
  }));
  floorOutline.name = 'ocean-floor-outline';
  group.add(floor, walls, surface, grid, surfaceOutline, floorOutline);

  function setBounds(box) {
    if (box.isEmpty() || ![box.min.x, box.min.y, box.max.x, box.max.y].every(Number.isFinite)) {
      throw new RangeError('水体需要有限且非空的 XY 包络');
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const width = Math.max(36, size.x + 16);
    const depth = Math.max(36, size.y + 16);
    surface.position.set(center.x, center.y, seaLevel);
    surface.scale.set(width, depth, 1);
    walls.position.set(center.x, center.y, seaLevel);
    walls.scale.set(width, depth, seaLevel - seaFloor);
    floor.position.set(center.x, center.y, seaFloor);
    floor.scale.set(width, depth, 1);
    surfaceOutline.position.set(center.x, center.y, seaLevel + 0.02);
    floorOutline.position.set(center.x, center.y, seaFloor + 0.01);
    surfaceOutline.scale.set(width, depth, 1);
    floorOutline.scale.set(width, depth, 1);

    // 网格固定为世界坐标中的 10 m 间隔，包络切换不会改变单位长度。
    const minX = center.x - width / 2;
    const maxX = center.x + width / 2;
    const minY = center.y - depth / 2;
    const maxY = center.y + depth / 2;
    const points = [];
    for (let x = Math.ceil(minX / 10) * 10; x <= maxX; x += 10) {
      points.push(x, minY, seaLevel + 0.015, x, maxY, seaLevel + 0.015);
    }
    for (let y = Math.ceil(minY / 10) * 10; y <= maxY; y += 10) {
      points.push(minX, y, seaLevel + 0.015, maxX, y, seaLevel + 0.015);
    }
    grid.geometry.dispose();
    grid.geometry = new THREE.BufferGeometry();
    grid.geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  }

  setBounds(bounds);
  scene.add(group);
  return {
    setBounds,
    update(elapsed) {
      surfaceMaterial.uniforms.uTime.value = Number.isFinite(elapsed) ? elapsed : 0;
    },
  };
}
