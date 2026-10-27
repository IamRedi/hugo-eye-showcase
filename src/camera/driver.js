/**
 * CameraDriver — the contract every camera adapter implements.
 *
 * HUGO Eye is camera-agnostic above this layer: API routes, patrol, health,
 * media indexing and the future HUGO Core DeviceAdapter all talk to this
 * interface only. Adding a new brand = adding one adapter module.
 *
 * Contract:
 *   id: string
 *   kind: string
 *   label(): string
 *   detectCapabilities(): Promise<{ rtsp, onvif, ptz, onvifProfiles, videoResolution }>
 *   health(): Promise<{ ok, rtspOk, onvifOk, position, detail, checkedAt }>
 *   getStatusPosition(): Promise<{ pan, tilt, zoom }>
 *   snapshot({ zone }): Promise<{ zone, relPath, jpeg:Buffer }>   // writes nothing itself
 *   liveStream(): Promise<{ contentType, stream, stop() }>        // sub stream preview
 *   ptzMove(command): Promise<void>          // named continuous moves (8-way + zoom)
 *   ptzStop(): Promise<void>
 *   gotoPosition({ pan, tilt, zoom }): Promise<void>
 *
 * Driver rules:
 *   - never log or expose credentials
 *   - never place credentials in process arguments (ffmpeg gets raw H.264 on stdin)
 *   - all movement goes through the global PTZ lock (src/ptzlock.js)
 */
export {}
