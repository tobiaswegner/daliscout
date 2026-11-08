import {
  LegacyHidTransport, LubaTransport, USB_PRODUCT_ID, USB_VENDOR_ID,
  type DaliTransport, type DeviceStream
} from '@dali-scout/transports';
import type { DeviceInfo, DeviceList } from '../shared';

const VID_HEX = USB_VENDOR_ID.toString(16);
const LUBA_BAUD = 38400;

// Native modules are loaded lazily so the app still starts (and says why) when one is unavailable,
// e.g. libusb missing on Linux.
async function loadHid(): Promise<any> {
  const m: any = await import('node-hid');
  return m.default ?? m;
}
async function loadSerial(): Promise<any> {
  const m: any = await import('serialport');
  return m.SerialPort ? m : m.default;
}

export async function listDevices(): Promise<DeviceList> {
  const devices: DeviceInfo[] = [];
  const warnings: string[] = [];

  try {
    const HID = await loadHid();
    for (const d of HID.devices() as any[]) {
      if (d.vendorId === USB_VENDOR_ID && d.productId === USB_PRODUCT_ID && d.path) {
        devices.push({
          id: `hid:${d.path}`, kind: 'dali-usb-hid',
          label: `DALI USB (HID) ${d.serialNumber ? '#' + d.serialNumber : ''}`.trim(),
          detail: `${d.manufacturer ?? 'Lunatone/Tridonic'} · ${d.path}`
        });
      }
    }
  } catch (e) {
    warnings.push(`USB HID unavailable: ${(e as Error).message.split('\n')[0]}`);
  }

  try {
    const { SerialPort } = await loadSerial();
    for (const p of (await SerialPort.list()) as any[]) {
      const isLunatone = String(p.vendorId ?? '').toLowerCase() === VID_HEX;
      devices.push({
        id: `serial:${p.path}`, kind: isLunatone ? 'dali2-usb-serial' : 'serial',
        label: isLunatone ? `DALI-2 USB (LUBA) ${p.path}` : `Serial port ${p.path} (LUBA @ ${LUBA_BAUD})`,
        detail: [p.manufacturer, p.serialNumber && '#' + p.serialNumber].filter(Boolean).join(' ') || undefined
      });
    }
  } catch (e) {
    warnings.push(`Serial ports unavailable: ${(e as Error).message.split('\n')[0]}`);
  }

  // Lunatone devices first
  devices.sort((a, b) => Number(b.kind !== 'serial') - Number(a.kind !== 'serial'));
  return { devices, warnings };
}

export function createDeviceTransport(id: string): DaliTransport {
  const sep = id.indexOf(':');
  const type = id.slice(0, sep), path = id.slice(sep + 1);
  if (type === 'hid') return new LegacyHidTransport(() => openHid(path), { id: 'dali-usb' });
  if (type === 'serial') return new LubaTransport(() => openSerial(path), { id: 'luba' });
  throw new Error(`Unknown device id "${id}"`);
}

// ---- stream adapters ---------------------------------------------------------------------

async function openHid(path: string): Promise<DeviceStream> {
  const HID = await loadHid();
  const dev = new HID.HID(path);
  const dataCbs = new Set<(d: Uint8Array) => void>();
  const closeCbs = new Set<(e?: Error) => void>();
  dev.on('data', (buf: Buffer) => dataCbs.forEach((cb) => cb(new Uint8Array(buf))));
  dev.on('error', (e: Error) => closeCbs.forEach((cb) => cb(e)));
  return {
    // first byte is the HID report id; 0 = device uses unnumbered reports
    write: async (data) => { dev.write([0x00, ...data]); },
    onData: (cb) => { dataCbs.add(cb); return () => dataCbs.delete(cb); },
    onClose: (cb) => { closeCbs.add(cb); return () => closeCbs.delete(cb); },
    close: async () => { try { dev.close(); } catch { /* already closed */ } }
  };
}

async function openSerial(path: string): Promise<DeviceStream> {
  const { SerialPort } = await loadSerial();
  const port = new SerialPort({
    path, baudRate: LUBA_BAUD, dataBits: 8, parity: 'none', stopBits: 1, autoOpen: false
  });
  await new Promise<void>((resolve, reject) => port.open((e: Error | null) => (e ? reject(e) : resolve())));
  const dataCbs = new Set<(d: Uint8Array) => void>();
  const closeCbs = new Set<(e?: Error) => void>();
  port.on('data', (buf: Buffer) => dataCbs.forEach((cb) => cb(new Uint8Array(buf))));
  port.on('close', () => closeCbs.forEach((cb) => cb()));
  port.on('error', (e: Error) => closeCbs.forEach((cb) => cb(e)));
  return {
    write: (data) => new Promise<void>((resolve, reject) =>
      port.write(Buffer.from(data), (e: Error | null | undefined) => (e ? reject(e) : resolve()))),
    onData: (cb) => { dataCbs.add(cb); return () => dataCbs.delete(cb); },
    onClose: (cb) => { closeCbs.add(cb); return () => closeCbs.delete(cb); },
    close: () => new Promise<void>((resolve) => (port.isOpen ? port.close(() => resolve()) : resolve()))
  };
}
