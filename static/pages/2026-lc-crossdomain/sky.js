import * as THREE from 'three';

const vertexShader = `
  varying vec3 vWorldPosition;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const fragmentShader = `
  uniform float uTime;
  uniform float uSeaLevel;
  uniform float uTop;
  uniform vec2 uCenter;
  uniform vec2 uRight;
  uniform vec3 uBackdrop;
  uniform vec3 uDeep;
  uniform vec3 uSea;
  uniform vec3 uHorizon;
  uniform vec3 uSky;
  uniform vec3 uCloud;
  varying vec3 vWorldPosition;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 cell = floor(p);
    vec2 f = fract(p);
    vec2 blend = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(cell), hash(cell + vec2(1.0, 0.0)), blend.x),
      mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0, 1.0)), blend.x), blend.y);
  }
  float cloudNoise(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 3; i++) {
      value += amplitude * noise(p);
      p = mat2(1.6, -1.2, 1.2, 1.6) * p + vec2(3.7, 8.1);
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    float height = vWorldPosition.z - uSeaLevel;
    vec3 underwater = mix(uDeep, uSea, smoothstep(-35.0, 0.0, height));
    vec3 sky = mix(uHorizon, uSky, smoothstep(0.0, 40.0, height));
    sky = mix(sky, uBackdrop, smoothstep(uTop * 0.45, uTop * 0.95, height));

    // 横向采用背景平面坐标，纵向始终采用世界高度，云不会随视角落入水下。
    float horizontal = dot(vWorldPosition.xy - uCenter, uRight);
    vec2 cloudPosition = vec2(horizontal * 0.085, height * 0.16);
    cloudPosition += vec2(uTime * 0.0018, 0.0);
    float cloudBand = smoothstep(4.0, 9.0, height) * (1.0 - smoothstep(24.0, 42.0, height));
    float cloud = smoothstep(0.43, 0.69, cloudNoise(cloudPosition)) * cloudBand;
    sky = mix(sky, uCloud, cloud * 0.24);

    vec3 color = mix(underwater, sky, smoothstep(-0.4, 0.8, height));
    color += uHorizon * (0.13 * exp(-abs(height) * 2.5));
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

/** 为 Z 朝上的海洋剖面增加远侧天光；海平线始终对应真实 seaLevel。 */
export function createSkyBackdrop(scene, bounds, seaLevel = 0) {
  if (!Number.isFinite(seaLevel)) throw new RangeError('天空需要有限的海平面高度');
  const uniforms = {
    uTime: { value: 0 }, uSeaLevel: { value: seaLevel }, uTop: { value: 100 },
    uCenter: { value: new THREE.Vector2() }, uRight: { value: new THREE.Vector2(1, 0) },
    uBackdrop: { value: new THREE.Color(0x07131e) },
    uDeep: { value: new THREE.Color(0x071420) },
    uSea: { value: new THREE.Color(0x123249) },
    uHorizon: { value: new THREE.Color(0x397c9e) },
    uSky: { value: new THREE.Color(0x173b60) },
    uCloud: { value: new THREE.Color(0xa1c9da) },
  };
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader, fragmentShader, side: THREE.FrontSide,
    depthWrite: false, depthTest: false, transparent: false, toneMapped: false,
  });
  const backdrop = new THREE.Mesh(geometry, material);
  backdrop.name = 'sky-cutaway-backdrop';
  // 先画背景，再画不透明模型及透明水体；背景不参与遮挡和透明排序。
  backdrop.renderOrder = -10000;
  const center = new THREE.Vector3();
  const cameraPosition = new THREE.Vector3();
  const viewDirection = new THREE.Vector3();
  const normal = new THREE.Vector3(1.05, -1.8, 0).normalize();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3(0, 0, 1);
  const basis = new THREE.Matrix4();
  let radius = 40;

  function setBounds(box) {
    if (box.isEmpty() || ![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite)) {
      throw new RangeError('天空需要有限且非空的场景包络');
    }
    box.getCenter(center);
    const size = box.getSize(new THREE.Vector3());
    const waterWidth = Math.max(36, size.x + 16);
    const waterDepth = Math.max(36, size.y + 16);
    // 平面退到水体四角之外，保持与原海洋剖面一致的真实海平面高度。
    radius = Math.hypot(waterWidth, waterDepth) / 2 + 10;
    const above = Math.max(80, radius * 2.5, box.max.z - seaLevel + 35);
    uniforms.uCenter.value.set(center.x, center.y);
    uniforms.uTop.value = above;
  }

  setBounds(bounds);
  scene.add(backdrop);
  return {
    setBounds,
    update(camera, elapsed) {
      camera.getWorldPosition(cameraPosition);
      camera.getWorldDirection(viewDirection);
      // 近垂直俯视无需天空，隐藏后避免垂直背景的退化投影。
      backdrop.visible = Math.abs(viewDirection.z) < 0.97;
      normal.set(cameraPosition.x - center.x, cameraPosition.y - center.y, 0);
      if (normal.lengthSq() < 1e-8) normal.set(1.05, -1.8, 0);
      normal.normalize();
      right.set(-normal.y, normal.x, 0);
      basis.makeBasis(right, up, normal);
      backdrop.quaternion.setFromRotationMatrix(basis);
      backdrop.position.set(center.x - normal.x * radius, center.y - normal.y * radius, cameraPosition.z);
      // 覆盖远裁剪范围，平面边缘始终位于空间和侧视视口以外。
      const span = 2 * camera.far * (1 + Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.max(1, camera.aspect));
      backdrop.scale.set(span, span, 1);
      uniforms.uRight.value.set(right.x, right.y);
      uniforms.uTime.value = Number.isFinite(elapsed) ? elapsed : 0;
    },
  };
}
