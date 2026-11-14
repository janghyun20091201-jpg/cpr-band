// =====================================================================
//  DeviceLink — 웨어러블(ESP32)과 블루투스(BLE)로 연결
//   · Web Bluetooth (Chrome/Edge, HTTPS 또는 localhost 필요)
//
//  ESP32 → 웹 (한 줄에 하나, '\n'으로 끝남)
//   D,<깊이 mm>[,<압력 kg×10>[,<기울기 도×10>]]       ← 실시간 값
//   C,<누적횟수>,<깊이 mm>,<분당속도>,<이완%>[,<최대압력 kg×10>,<잔여압력 kg×10>,<기울기 도×10>]
//                                                   ← 압박 1회 완료마다
//   #<아무 텍스트>                                    ← 디버그 로그(무시됨)
//
//  웹 → ESP32
//   START | STOP | BPM,<n>
// =====================================================================
import { CONFIG } from './config.js';

const enc = new TextEncoder();
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const tenth = (v) => (num(v) == null ? null : Number(v) / 10);

export class DeviceLink extends EventTarget {
  constructor() {
    super();
    this.kind = null;        // 'ble' | null
    this.name = '';
    this.hasForce = false;   // FSR 압력 값을 보내는 기기인지
    this._buf = '';
    this._writeQ = Promise.resolve();
  }

  get connected() { return this.kind !== null; }

  static support() {
    return {
      secure: window.isSecureContext,
      ble: 'bluetooth' in navigator,
    };
  }

  async connectBLE() {
    if (!('bluetooth' in navigator)) {
      throw new Error('이 브라우저는 Web Bluetooth를 지원하지 않아요. PC/안드로이드의 Chrome 또는 Edge를 사용하세요.');
    }
    await this.disconnect();
    const { service, rx, tx, namePrefix } = CONFIG.ble;
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix }, { services: [service] }],
      optionalServices: [service],
    });
    this._emit('status', { connecting: true });
    device.addEventListener('gattserverdisconnected', () => {
      if (this.kind === 'ble' && this._bleDevice === device) this._lost();
    });
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(service);
    this._tx = await svc.getCharacteristic(tx);
    this._rx = await svc.getCharacteristic(rx);
    const dec = new TextDecoder();
    this._tx.addEventListener('characteristicvaluechanged', (e) => this._chunk(dec.decode(e.target.value)));
    await this._tx.startNotifications();
    this._bleDevice = device;
    this._set('ble', device.name || namePrefix);
  }

  async disconnect() {
    const kind = this.kind;
    this.kind = null;
    try {
      if (kind === 'ble' && this._bleDevice?.gatt?.connected) this._bleDevice.gatt.disconnect();
    } catch (e) { console.warn(e); }
    this._bleDevice = null;
    this._tx = this._rx = null;
    if (kind) this._emit('status', { connected: false });
  }

  /** ESP32로 명령 보내기 (자동으로 '\n' 붙음) */
  send(cmd) {
    if (!this.kind) return Promise.resolve();
    const data = enc.encode(cmd + '\n');
    // BLE는 동시에 두 번 쓰면 에러가 나므로 순서대로 큐 처리
    this._writeQ = this._writeQ.then(async () => {
      try {
        if (this._rx) {
          if (this._rx.properties.writeWithoutResponse) await this._rx.writeValueWithoutResponse(data);
          else await this._rx.writeValue(data);
        }
      } catch (e) {
        console.warn('[device] send failed', cmd, e);
      }
    });
    return this._writeQ;
  }

  _set(kind, name) {
    this.kind = kind;
    this.name = name;
    this._buf = '';
    this.hasForce = false;
    this._emit('status', { connected: true, kind, name });
  }

  _lost() {
    this.kind = null;
    this._emit('status', { connected: false, lost: true });
  }

  _chunk(text) {
    this._buf += text;
    let i;
    while ((i = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, i).trim();
      this._buf = this._buf.slice(i + 1);
      if (line) this._line(line);
    }
    if (this._buf.length > 1024) this._buf = ''; // 쓰레기 데이터 방지
  }

  /** 한 줄 해석 — 프로토콜을 바꾸면 여기만 고치면 됨 */
  _line(line) {
    if (line.startsWith('#')) return;
    const [type, ...a] = line.split(',');
    switch (type.trim().toUpperCase()) {
      case 'D': {
        const kg = tenth(a[1]);
        if (kg != null) this.hasForce = true;
        this._emit('depth', { cm: Number(a[0]) / 10, kg, tilt: tenth(a[2]) });
        break;
      }
      case 'C':
        this._emit('compression', {
          count: Number(a[0]),
          depth: Number(a[1]) / 10,  // mm → cm
          rate: Number(a[2]),
          recoil: Number(a[3]),
          peakKg: tenth(a[4]),
          residualKg: tenth(a[5]),
          tilt: tenth(a[6]),
        });
        break;
      default:
        break;
    }
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
