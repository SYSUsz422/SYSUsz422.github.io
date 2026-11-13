import { Box3, EdgesGeometry, Vector3 } from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { ConvexHull } from 'three/addons/math/ConvexHull.js';

const EPSILON = 1e-9;

function isFinitePoint(point) {
  return Array.isArray(point) && point.length === 3
    && Number.isFinite(point[0]) && Number.isFinite(point[1]) && Number.isFinite(point[2]);
}

function hasVolume(points) {
  if (points.length < 4) return false;
  const origin = points[0];
  const farthest = points.reduce((best, point) => (
    point.distanceToSquared(origin) > best.distanceToSquared(origin) ? point : best
  ));
  const direction = farthest.clone().sub(origin).normalize();
  let normal = new Vector3();
  for (const point of points) {
    const candidate = point.clone().sub(origin).cross(direction);
    if (candidate.lengthSq() > normal.lengthSq()) normal = candidate;
  }
  if (normal.length() <= EPSILON) return false;
  normal.normalize();
  return points.some((point) => Math.abs(normal.dot(point.clone().sub(origin))) > EPSILON);
}

export function buildHull(positions, targetPosition) {
  const degenerate = { geometry: null, edges: null, containsTarget: null, kind: 'degenerate' };
  if (!Array.isArray(positions) || positions.length < 4
    || !positions.every(isFinitePoint) || !isFinitePoint(targetPosition)) return degenerate;

  const sourcePoints = positions.map((point) => new Vector3(...point));
  const bounds = new Box3().setFromPoints(sourcePoints);
  const center = bounds.getCenter(new Vector3());
  const size = bounds.getSize(new Vector3());
  const scale = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(scale) || scale <= 0) return degenerate;

  // 归一化后再去重与判秩，让容差跟随编队尺度，而非世界坐标偏移。
  const points = [];
  for (const point of sourcePoints) {
    const normalized = point.clone().sub(center).divideScalar(scale);
    if (!points.some((other) => other.distanceToSquared(normalized) <= EPSILON ** 2)) points.push(normalized);
  }
  if (!hasVolume(points)) return degenerate;

  const hull = new ConvexHull().setFromPoints(points);
  hull.tolerance = Math.max(hull.tolerance, EPSILON);
  const target = new Vector3(...targetPosition).sub(center).divideScalar(scale);
  const containsTarget = hull.containsPoint(target);
  const geometry = new ConvexGeometry(points);
  // 先在归一化空间提取边，避免 EdgesGeometry 的定点去重吞掉微小编队。
  const edges = new EdgesGeometry(geometry, 18);
  for (const item of [geometry, edges]) {
    item.scale(scale, scale, scale);
    item.translate(center.x, center.y, center.z);
    if (!item.getAttribute('position').array.every(Number.isFinite)) {
      geometry.dispose();
      edges.dispose();
      return degenerate;
    }
  }
  return { geometry, edges, containsTarget, kind: 'volume' };
}
