import crypto from 'node:crypto'
import { maskSecrets } from '../config.js'
import { log } from '../log.js'

/**
 * Minimal ONVIF Profile S client (media + PTZ services) speaking raw SOAP with
 * WS-UsernameToken digest auth. No external dependencies.
 *
 * Credentials are only ever placed in the SOAP body (over LAN HTTP to the camera)
 * and are masked in every log/error path.
 */

export function createOnvifClient({ host, onvifPort, username, password }) {
  const baseUrl = `http://${host}:${onvifPort}`

  function wsSecurityHeader() {
    const nonce = crypto.randomBytes(16)
    const created = new Date().toISOString()
    const digest = crypto.createHash('sha1')
      .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(password)]))
      .digest('base64')
    return `
    <wsse:Security s:mustUnderstand="1">
      <wsse:UsernameToken>
        <wsse:Username>${escapeXml(username)}</wsse:Username>
        <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password>
        <wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/wss-wssecurity-secext-1.0.xsd#Base64Binary">${nonce.toString('base64')}</wsse:Nonce>
        <wsu:Created>${created}</wsu:Created>
      </wsse:UsernameToken>
    </wsse:Security>`
  }

  function envelope(body) {
    return `<?xml version="1.0" encoding="UTF-8"?>
  <s:Envelope
    xmlns:s="http://www.w3.org/2003/05/soap-envelope"
    xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
    xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
    <s:Header>${wsSecurityHeader()}</s:Header>
    <s:Body>${body}</s:Body>
  </s:Envelope>`
  }

  async function postSoap(service, body, action) {
    let response
    try {
      response = await fetch(`${baseUrl}/onvif/${service}_service`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/soap+xml; charset=utf-8',
          SOAPAction: action,
        },
        body: envelope(body),
        signal: AbortSignal.timeout(8000),
      })
    } catch (error) {
      throw new Error(`ONVIF ${service} unreachable: ${error.cause?.code ?? error.message}`)
    }
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`ONVIF ${service} failed (${response.status}): ${maskSecrets(text.slice(0, 200))}`)
    }
    return text
  }

  let cachedProfileToken = null

  async function getProfileToken() {
    if (cachedProfileToken) return cachedProfileToken
    const xml = await postSoap(
      'media',
      '<trt:GetProfiles xmlns:trt="http://www.onvif.org/ver10/media/wsdl"/>',
      'http://www.onvif.org/ver10/media/wsdl/GetProfiles',
    )
    const match =
      xml.match(/<[^>\s:]*:?Profiles[^>]*token="([^"]+)"/) ??
      xml.match(/<[^>\s:]*:?Profile[^>]*token="([^"]+)"/)
    if (!match?.[1]) throw new Error('ONVIF profile token not found')
    cachedProfileToken = match[1]
    return cachedProfileToken
  }

  return {
    baseUrl,
    async discover() {
      const xml = await postSoap(
        'media',
        '<trt:GetProfiles xmlns:trt="http://www.onvif.org/ver10/media/wsdl"/>',
        'http://www.onvif.org/ver10/media/wsdl/GetProfiles',
      )
      const profiles = [...xml.matchAll(/<[^>\s:]*:?Profiles[^>]*token="([^"]+)"[^>]*>/g)].map(m => m[1])
      const videoEnc = xml.match(/<[^>\s:]*:?VideoEncoder[^>]*>\s*<[^>\s:]*:?Resolution>\s*<[^>\s:]*:?Width>(\d+)<[^>]*>\s*<[^>\s:]*:?Height>(\d+)/)
      return {
        onvif: true,
        ptz: true,
        profiles,
        videoResolution: videoEnc ? { width: Number(videoEnc[1]), height: Number(videoEnc[2]) } : null,
      }
    },
    async getDeviceInformation() {
      const xml = await postSoap(
        'device',
        `<ttd:GetDeviceInformation xmlns:ttd="http://www.onvif.org/ver10/device/wsdl"/>`,
        'http://www.onvif.org/ver10/device/wsdl/GetDeviceInformation',
      )
      const pick = tag => {
        const m = xml.match(new RegExp(`<[^>\\s:]*:?${tag}[^>]*>([^<]+)<`))
        return m?.[1] ?? null
      }
      return {
        manufacturer: pick('Manufacturer'),
        model: pick('Model'),
        firmwareVersion: pick('FirmwareVersion'),
        serialNumber: pick('SerialNumber'),
        hardwareId: pick('HardwareId'),
      }
    },

    async getPtzServiceCapabilities() {
      const token = await getProfileToken()
      const xml = await postSoap(
        'ptz',
        `<tptz:GetServiceCapabilities xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
      <tptz:ProfileToken>${escapeXml(token)}</tptz:ProfileToken>
    </tptz:GetServiceCapabilities>`,
        'http://www.onvif.org/ver20/ptz/wsdl/GetServiceCapabilities',
      )
      const flag = name => {
        const m = xml.match(new RegExp(`<[^>\\s:]*:?${name}[^>]*>([^<]+)<`))
        return m?.[1] === 'true'
      }
      return {
        continuousMove: flag('ContinuousMove'),
        absoluteMove: flag('AbsoluteMove'),
        relativeMove: flag('RelativeMove'),
        status: flag('Status'),
        zoom: flag('Zoom'),
        eFlip: flag('EFlip'),
        reverse: flag('Reverse'),
      }
    },

    async getStatus() {
      const token = await getProfileToken()
      const xml = await postSoap(
        'ptz',
        `<tptz:GetStatus xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
      <tptz:ProfileToken>${escapeXml(token)}</tptz:ProfileToken>
    </tptz:GetStatus>`,
        'http://www.onvif.org/ver20/ptz/wsdl/GetStatus',
      )
      return extractPosition(xml)
    },
    async continuousMove(x, y, zoom = 0) {
      const token = await getProfileToken()
      await postSoap(
        'ptz',
        `<tptz:ContinuousMove xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">
      <tptz:ProfileToken>${escapeXml(token)}</tptz:ProfileToken>
      <tptz:Velocity>
        <tt:PanTilt x="${x.toFixed(3)}" y="${y.toFixed(3)}"/>
        <tt:Zoom x="${zoom.toFixed(3)}"/>
      </tptz:Velocity>
      <tptz:Timeout>PT1S</tptz:Timeout>
    </tptz:ContinuousMove>`,
        'http://www.onvif.org/ver20/ptz/wsdl/ContinuousMove',
      )
    },
    async stop() {
      const token = await getProfileToken()
      await postSoap(
        'ptz',
        `<tptz:Stop xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
      <tptz:ProfileToken>${escapeXml(token)}</tptz:ProfileToken>
      <tptz:PanTilt>true</tptz:PanTilt>
      <tptz:Zoom>true</tptz:Zoom>
    </tptz:Stop>`,
        'http://www.onvif.org/ver20/ptz/wsdl/Stop',
      )
    },
    async absoluteMove(position) {
      const token = await getProfileToken()
      await postSoap(
        'ptz',
        `<tptz:AbsoluteMove xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">
      <tptz:ProfileToken>${escapeXml(token)}</tptz:ProfileToken>
      <tptz:Position>
        <tt:PanTilt x="${position.pan.toFixed(5)}" y="${position.tilt.toFixed(5)}"/>
        <tt:Zoom x="${position.zoom.toFixed(5)}"/>
      </tptz:Position>
    </tptz:AbsoluteMove>`,
        'http://www.onvif.org/ver20/ptz/wsdl/AbsoluteMove',
      )
    },
  }
}

function extractPosition(xml) {
  const panTilt = xml.match(/<[^>\s:]*:?PanTilt[^>]*\sx="([^"]+)"[^>]*\sy="([^"]+)"/)
  const zoom = xml.match(/<[^>\s:]*:?Zoom[^>]*\sx="([^"]+)"/)
  if (!panTilt?.[1] || !panTilt?.[2]) {
    const status = xml.match(/<[^>\s:]*:?Status[^>]*>/)
    if (!status) throw new Error('ONVIF PTZ status not found')
    throw new Error('camera reported no PTZ position (idle or no position support)')
  }
  return {
    pan: Number(panTilt[1]),
    tilt: Number(panTilt[2]),
    zoom: zoom?.[1] ? Number(zoom[1]) : 0,
  }
}

export function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export const PTZ_SPEED = 0.45

export function vectorForCommand(command) {
  const s = PTZ_SPEED
  const vectors = {
    up: { x: 0, y: s },
    down: { x: 0, y: -s },
    left: { x: -s, y: 0 },
    right: { x: s, y: 0 },
    up_left: { x: -s, y: s },
    up_right: { x: s, y: s },
    down_left: { x: -s, y: -s },
    down_right: { x: s, y: -s },
    zoom_in: { x: 0, y: 0, zoom: s },
    zoom_out: { x: 0, y: 0, zoom: -s },
  }
  return vectors[command] ?? null
}

export function commandNames() {
  return ['up', 'down', 'left', 'right', 'up_left', 'up_right', 'down_left', 'down_right', 'zoom_in', 'zoom_out', 'stop']
}
