import * as THREE from 'three';

// 模型局部坐标：+X 朝前，+Z 朝上；世界位置由调用方控制。
export function createVehicleMesh(type, color) {
  const group = new THREE.Group();
  group.name = `${type}-vehicle`;
  const body = new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: type === 'uav' ? 0.32 : 0.16, roughness: 0.42, metalness: 0.18,
  });
  const trim = new THREE.MeshStandardMaterial({ color: 0xbdccd2, roughness: 0.48, metalness: 0.25 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x172734, roughness: 0.65, metalness: 0.22 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x506775, roughness: 0.34, metalness: 0.65 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x0c3449, roughness: 0.2, metalness: 0.38, emissive: 0x082638, emissiveIntensity: 0.1,
  });

  function part(name, geometry, material, position = [0, 0, 0]) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(...position);
    group.add(mesh);
    return mesh;
  }

  function beam(name, start, end, radius, material) {
    const a = new THREE.Vector3(...start);
    const b = new THREE.Vector3(...end);
    const direction = b.clone().sub(a);
    const mesh = part(name, new THREE.CylinderGeometry(radius, radius, direction.length(), 8), material);
    mesh.position.copy(a.add(b).multiplyScalar(0.5));
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    return mesh;
  }

  function cylinder(name, radius, height, material, position, axis = 'z') {
    const mesh = part(name, new THREE.CylinderGeometry(radius, radius, height, 20), material, position);
    if (axis === 'x') mesh.rotation.z = -Math.PI / 2;
    else mesh.rotation.x = Math.PI / 2;
    return mesh;
  }

  if (type === 'uav') {
    const shell = part('fuselage', new THREE.SphereGeometry(1, 24, 14), body, [0.02, 0, 0.02]);
    shell.scale.set(0.56, 0.34, 0.23);
    const canopy = part('canopy', new THREE.SphereGeometry(1, 20, 12), trim, [0.05, 0, 0.2]);
    canopy.scale.set(0.28, 0.21, 0.085);
    part('front-camera', new THREE.SphereGeometry(0.095, 12, 8), glass, [0.55, 0, -0.035]);

    const rotorMaterial = new THREE.MeshStandardMaterial({
      color: 0x8c9ca8, transparent: true, opacity: 0.21, depthWrite: false,
      side: THREE.DoubleSide, roughness: 0.65, metalness: 0.18,
    });
    for (const x of [-0.72, 0.72]) for (const y of [-0.72, 0.72]) {
      beam('arm', [x * 0.25, y * 0.25, 0], [x, y, 0.045], 0.055, body);
      cylinder('motor', 0.095, 0.15, metal, [x, y, 0.09]);
      cylinder('motor-cap', 0.105, 0.045, body, [x, y, 0.1825]);
      part('rotor-disc', new THREE.CircleGeometry(0.38, 32), rotorMaterial, [x, y, 0.23]);
      const blade = part('rotor-blade', new THREE.BoxGeometry(0.72, 0.055, 0.016), trim, [x, y, 0.24]);
      blade.rotation.z = Math.sign(x * y) * Math.PI / 6;
      cylinder('rotor-hub', 0.038, 0.04, metal, [x, y, 0.25]);
    }

    for (const y of [-0.42, 0.42]) {
      for (const x of [-0.34, 0.34]) {
        beam('landing-strut', [x, y * 0.55, -0.12], [x, y, -0.43], 0.025, metal);
      }
      beam('landing-skid', [-0.54, y, -0.44], [0.52, y, -0.44], 0.028, dark);
      beam('skid-tip', [0.52, y, -0.44], [0.62, y, -0.37], 0.028, dark);
    }
  } else if (type === 'usv') {
    const outline = [[1.2, 0], [0.42, 0.6], [-1.1, 0.52], [-1.1, -0.52], [0.42, -0.6]];
    const bottom = [[1.02, 0], [0.32, 0.32], [-1.02, 0.32], [-1.02, -0.32], [0.32, -0.32]];
    const vertices = [...outline.flatMap(([x, y]) => [x, y, 0.14]), ...bottom.flatMap(([x, y]) => [x, y, -0.34])];
    const indices = [];
    for (let i = 1; i < 4; i++) indices.push(0, i, i + 1, 5, i + 6, i + 5);
    for (let i = 0; i < 5; i++) {
      const next = (i + 1) % 5;
      indices.push(i, i + 5, next, next, i + 5, next + 5);
    }
    const hullGeometry = new THREE.BufferGeometry();
    hullGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    hullGeometry.setIndex(indices);
    const facetedHull = hullGeometry.toNonIndexed();
    facetedHull.computeVertexNormals();
    hullGeometry.dispose();
    part('hull', facetedHull, body);

    const deckShape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x * 0.91, y * 0.88)));
    part('deck', new THREE.ExtrudeGeometry(deckShape, { depth: 0.025, bevelEnabled: false }), body, [0, 0, 0.145]);
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i];
      const b = outline[(i + 1) % outline.length];
      beam('gunwale', [a[0], a[1], 0.15], [b[0], b[1], 0.15], 0.024, dark);
    }

    part('cabin', new THREE.BoxGeometry(0.68, 0.6, 0.33), body, [-0.14, 0, 0.335]);
    part('windscreen', new THREE.BoxGeometry(0.025, 0.5, 0.18), glass, [0.211, 0, 0.385]);
    for (const y of [-0.306, 0.306]) {
      part('side-window', new THREE.BoxGeometry(0.42, 0.022, 0.16), glass, [-0.08, y, 0.39]);
    }
    part('cabin-roof', new THREE.BoxGeometry(0.72, 0.65, 0.055), trim, [-0.14, 0, 0.525]);
    cylinder('antenna-base', 0.055, 0.06, dark, [-0.38, 0, 0.58]);
    cylinder('antenna', 0.014, 0.49, metal, [-0.38, 0, 0.85]);
    part('radome', new THREE.SphereGeometry(0.047, 10, 8), trim, [-0.38, 0, 1.1]);

    for (const side of [-1, 1]) {
      for (const x of [-0.97, -0.57]) {
        beam('rail-post', [x, side * 0.47, 0.17], [x, side * 0.47, 0.36], 0.014, metal);
      }
      beam('stern-rail', [-0.97, side * 0.47, 0.36], [-0.57, side * 0.47, 0.36], 0.015, metal);
    }
    part('outboard', new THREE.BoxGeometry(0.16, 0.2, 0.3), dark, [-1.18, 0, 0.04]);
    beam('outboard-shaft', [-1.18, 0, -0.08], [-1.18, 0, -0.36], 0.035, metal);
  } else if (type === 'uuv') {
    const shell = part('pressure-hull', new THREE.CapsuleGeometry(0.3, 1.46, 8, 24), body, [0.02, 0, 0]);
    shell.rotation.z = -Math.PI / 2;
    const sonar = part('sonar-dome', new THREE.SphereGeometry(1, 20, 12), dark, [1.025, 0, 0]);
    sonar.scale.set(0.14, 0.215, 0.215);
    cylinder('section-band', 0.304, 0.085, trim, [-0.43, 0, 0], 'x');
    const seam = part('hull-seam', new THREE.TorusGeometry(0.3, 0.011, 6, 32), metal, [0.48, 0, 0]);
    seam.rotation.y = Math.PI / 2;

    for (const side of [-1, 1]) {
      const finShape = new THREE.Shape([
        new THREE.Vector2(-0.48, side * 0.18), new THREE.Vector2(-0.8, side * 0.63),
        new THREE.Vector2(-1.015, side * 0.63), new THREE.Vector2(-0.89, side * 0.15),
      ]);
      const geometry = new THREE.ExtrudeGeometry(finShape, { depth: 0.045, bevelEnabled: false });
      part('horizontal-tail-fin', geometry, body, [0, 0, -0.0225]);
      const vertical = part('vertical-tail-fin', geometry, body, [0, 0.0225, 0]);
      vertical.rotation.x = Math.PI / 2;
    }

    cylinder('tail-shaft', 0.07, 0.22, metal, [-1.08, 0, 0], 'x');
    const shroud = part('propeller-shroud', new THREE.TorusGeometry(0.205, 0.035, 8, 28), dark, [-1.14, 0, 0]);
    shroud.rotation.y = Math.PI / 2;
    for (let i = 0; i < 3; i++) {
      const angle = i * Math.PI * 2 / 3;
      const blade = part('propeller-blade', new THREE.BoxGeometry(0.026, 0.15, 0.055), metal,
        [-1.145, Math.cos(angle) * 0.11, Math.sin(angle) * 0.11]);
      blade.rotation.x = angle;
    }
    const hub = part('propeller-hub', new THREE.SphereGeometry(0.07, 12, 8), metal, [-1.19, 0, 0]);
    hub.scale.x = 1.2;
  }

  return group;
}
