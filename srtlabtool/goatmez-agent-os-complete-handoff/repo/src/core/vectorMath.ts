export function l2Norm(vector: number[]): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

export function normalizeL2(vector: number[]): number[] {
  const norm = l2Norm(vector);
  if (!Number.isFinite(norm) || norm <= 0) return vector.map(() => 0);
  return vector.map((value) => value / norm);
}

export function dot(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length);
  let total = 0;
  for (let index = 0; index < size; index += 1) total += left[index] * right[index];
  return total;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || !right.length) return 0;
  const leftNorm = l2Norm(left);
  const rightNorm = l2Norm(right);
  if (!leftNorm || !rightNorm) return 0;
  const cosine = dot(left, right) / (leftNorm * rightNorm);
  if (!Number.isFinite(cosine)) return 0;
  return Math.max(-1, Math.min(1, cosine));
}
