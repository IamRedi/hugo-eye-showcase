import { createRequire } from 'node:module'

/**
 * Shared ONNX Runtime session loader (CPU EP).
 * intraOpNumThreads=1: measured on this hardware — 112 ms/inf at 640×640 with
 * ~21 % of one core at 2 fps; the default core-wide pool spins hot between inferences
 * (7 threads ≈ 75 % CPU while idle); 2 threads measured 35 % — the second core is pure spin waste at this frame rate.
 */
export async function loadSession(modelPath) {
  const ort = await import('onnxruntime-node')
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    executionMode: 'sequential',
  })
  return { ort, session }
}
