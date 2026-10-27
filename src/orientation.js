/**
 * Per-camera presentation orientation: rotate 0/90/180/270 + mirror + flip.
 * Applied consistently to live video, snapshots, recordings and thumbnails.
 * PTZ commands are remapped from SCREEN space to PHYSICAL camera space so the
 * pad/arrow-keys always move the picture the way the user sees it.
 */

export const ROTATIONS = [0, 90, 180, 270]

export function normalizeOrientation(o = {}) {
  let rotate = Number(o.rotate ?? 0)
  if (!ROTATIONS.includes(rotate)) rotate = 0
  return {
    rotate,
    mirror: Boolean(o.mirror),
    flip: Boolean(o.flip),
  }
}

/** ffmpeg -vf fragment implementing the orientation. */
export function videoFilters(o) {
  const { rotate, mirror, flip } = normalizeOrientation(o)
  const parts = []
  if (rotate === 90) parts.push('transpose=1')
  else if (rotate === 270) parts.push('transpose=2')
  else if (rotate === 180) parts.push('transpose=1', 'transpose=1')
  if (mirror) parts.push('hflip')
  if (flip) parts.push('vflip')
  return parts.length ? parts.join(',') : null
}

function swapLeftRight(cmd) {
  return cmd.replace(/left/g, '§').replace(/right/g, 'left').replace(/§/g, 'right')
}

function swapUpDown(cmd) {
  return cmd.replace(/up/g, '§').replace(/down/g, 'up').replace(/§/g, 'down')
}

/** Rotation-only mapping: what a screen direction means physically. */
function rotateMap(command, rotate) {
  if (rotate === 90) {
    // Image turned 90° CW: screen-up shows camera-left, etc.
    const m = {
      up: 'left', down: 'right', left: 'down', right: 'up',
      up_left: 'down_left', up_right: 'up_left', down_right: 'up_right', down_left: 'down_right',
    }
    return m[command] ?? command
  }
  if (rotate === 270) {
    const m = {
      up: 'right', down: 'left', left: 'up', right: 'down',
      up_left: 'up_right', up_right: 'down_right', down_right: 'down_left', down_left: 'up_left',
    }
    return m[command] ?? command
  }
  if (rotate === 180) {
    const m = {
      up: 'down', down: 'up', left: 'right', right: 'left',
      up_left: 'down_right', up_right: 'down_left', down_right: 'up_left', down_left: 'up_right',
    }
    return m[command] ?? command
  }
  return command
}

/**
 * Maps a UI command (screen intent) to the physical ONVIF command.
 * Order: rotation mapping, then mirror (L/R swap), then flip (U/D swap).
 * zoom_* and stop are orientation-independent.
 */
export function mapPtzCommand(command, o) {
  const { rotate, mirror, flip } = normalizeOrientation(o)
  let cmd = rotateMap(command, rotate)
  if (mirror) cmd = swapLeftRight(cmd)
  if (flip) cmd = swapUpDown(cmd)
  return cmd
}

/**
 * Maps a SCREEN-SPACE velocity {x, y} (+x = right, +y = down — the space the
 * tracker sees) to a PHYSICAL ONVIF velocity (+x = pan right, +y = tilt up —
 * vectorForCommand convention). Derived from the same tables as
 * mapPtzCommand: for every orientation the four cardinal unit vectors of
 * this transform agree with the command mapping (unit-tested both ways).
 */
export function screenVelocityToPhysical(v, o) {
  const { rotate, mirror, flip } = normalizeOrientation(o)
  // rotation transforms (screen y grows DOWN, ONVIF tilt +y grows UP — the
  // y-convention flip is already baked into each matrix)
  let x
  let y
  if (rotate === 90) { x = v.y; y = v.x }
  else if (rotate === 270) { x = -v.y; y = -v.x }
  else if (rotate === 180) { x = -v.x; y = v.y }
  else { x = v.x; y = -v.y }
  if (mirror) x = -x
  if (flip) y = -y
  return { x, y }
}
