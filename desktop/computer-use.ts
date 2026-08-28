import { createRequire } from 'node:module';
import { desktopCapturer, nativeImage, systemPreferences } from 'electron';

type NativeBitmap = {
  width: number;
  height: number;
  image: Buffer;
  byteWidth: number;
  bitsPerPixel: number;
};

type NativeComputer = {
  getScreenSize(): { width: number; height: number };
  getMousePos(): { x: number; y: number };
  moveMouse(x: number, y: number): void;
  dragMouse(x: number, y: number): void;
  mouseClick(button?: string, double?: boolean): void;
  scrollMouse(x: number, y: number): void;
  keyTap(key: string, modifiers?: string[]): void;
  typeString(value: string): void;
  typeStringDelayed(value: string, charactersPerMinute: number): void;
  screen: { capture(x?: number, y?: number, width?: number, height?: number): NativeBitmap };
};

export type ComputerAction = 'status' | 'screenshot' | 'move' | 'click' | 'drag' | 'type' | 'key' | 'scroll';

const require = createRequire(import.meta.url);
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const KEY_NAMES = new Set([
  'escape', 'tab', 'backspace', 'delete', 'enter', 'return', 'space', 'home', 'end', 'pageup', 'pagedown',
  'left', 'right', 'up', 'down', 'insert', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
  ...'abcdefghijklmnopqrstuvwxyz'.split(''),
  ...'0123456789'.split(''),
]);
const MODIFIER_NAMES = new Set(['alt', 'control', 'shift', 'cmd', 'meta', 'win', 'right_alt', 'right_control', 'right_shift', 'right_cmd', 'right_meta']);

let nativeComputer: NativeComputer | null = null;

function loadNativeComputer(): NativeComputer {
  if (nativeComputer) return nativeComputer;
  const packageName = process.platform === 'darwin'
    ? '@nut-tree-fork/libnut-darwin'
    : process.platform === 'win32'
      ? '@nut-tree-fork/libnut-win32'
      : process.platform === 'linux'
        ? '@nut-tree-fork/libnut-linux'
        : '';
  if (!packageName) throw new Error(`Computer Use is not supported on ${process.platform}`);
  nativeComputer = require(packageName) as NativeComputer;
  return nativeComputer;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return number;
}

function permissionStatus(): { screen: string; accessibility: string } {
  if (process.platform !== 'darwin') return { screen: 'not-required', accessibility: 'not-required' };
  return {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied',
  };
}

export function computerUseStatus() {
  const permissions = permissionStatus();
  const supported = process.platform === 'darwin'
    ? ['x64', 'arm64'].includes(process.arch)
    : ['win32', 'linux'].includes(process.platform) && process.arch === 'x64';
  const permissionsReady = process.platform !== 'darwin' || (permissions.screen === 'granted' && permissions.accessibility === 'granted');
  const base = {
    platform: process.platform,
    architecture: process.arch,
    screen: null,
    permissions,
  };
  if (!supported) return { ...base, available: false, error: `Computer Use is not supported on ${process.platform}/${process.arch}` };
  if (!permissionsReady) return { ...base, available: false };
  try {
    const screen = loadNativeComputer().getScreenSize();
    return { ...base, available: true, screen };
  } catch (error) {
    return { ...base, available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function requestComputerUsePermissions(): Promise<ReturnType<typeof computerUseStatus>> {
  if (process.platform === 'darwin') {
    systemPreferences.isTrustedAccessibilityClient(true);
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => []);
  }
  return computerUseStatus();
}

function statusResult() {
  const base = computerUseStatus();
  return base;
}

export async function performComputerAction(action: ComputerAction, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (action === 'status') return statusResult();
  const native = loadNativeComputer();
  const size = native.getScreenSize();

  if (action === 'screenshot') {
    const bitmap = native.screen.capture();
    const captured = nativeImage.createFromBitmap(bitmap.image, { width: bitmap.width, height: bitmap.height });
    const encoded = bitmap.width > 2_048 ? captured.resize({ width: 2_048, quality: 'good' }) : captured;
    const png = encoded.toPNG();
    if (!png.length || png.length > MAX_SCREENSHOT_BYTES) throw new Error('Desktop screenshot exceeded the 20 MB safety limit');
    return {
      imageBase64: png.toString('base64'),
      mimeType: 'image/png',
      width: encoded.getSize().width,
      height: encoded.getSize().height,
      coordinateWidth: size.width,
      coordinateHeight: size.height,
      scaleX: encoded.getSize().width / size.width,
      scaleY: encoded.getSize().height / size.height,
      cursor: native.getMousePos(),
    };
  }

  if (action === 'move' || action === 'click' || action === 'drag') {
    const x = integer(params.x, 'x', 0, Math.max(0, size.width - 1));
    const y = integer(params.y, 'y', 0, Math.max(0, size.height - 1));
    if (action === 'move') {
      native.moveMouse(x, y);
      return { ok: true, action, x, y };
    }
    if (action === 'drag') {
      if (params.startX !== undefined || params.startY !== undefined) {
        const startX = integer(params.startX, 'startX', 0, Math.max(0, size.width - 1));
        const startY = integer(params.startY, 'startY', 0, Math.max(0, size.height - 1));
        native.moveMouse(startX, startY);
      }
      native.dragMouse(x, y);
      return { ok: true, action, x, y };
    }
    const button = String(params.button || 'left').toLowerCase();
    if (!['left', 'middle', 'right'].includes(button)) throw new Error('button must be left, middle, or right');
    const clickCount = integer(params.clickCount ?? 1, 'clickCount', 1, 2);
    native.moveMouse(x, y);
    native.mouseClick(button, clickCount === 2);
    return { ok: true, action, x, y, button, clickCount };
  }

  if (action === 'type') {
    const value = String(params.text ?? '');
    if (!value || value.length > 5_000) throw new Error('text must contain 1-5000 characters');
    const intervalMs = integer(params.intervalMs ?? 0, 'intervalMs', 0, 1_000);
    if (intervalMs > 0) native.typeStringDelayed(value, Math.max(1, Math.floor(60_000 / intervalMs)));
    else native.typeString(value);
    return { ok: true, action, characters: value.length };
  }

  if (action === 'key') {
    const key = String(params.key || '').trim().toLowerCase();
    const modifiers = Array.isArray(params.modifiers) ? params.modifiers.map((item) => String(item).trim().toLowerCase()) : [];
    if (!KEY_NAMES.has(key)) throw new Error(`Unsupported key: ${key}`);
    if (modifiers.length > 4 || modifiers.some((item) => !MODIFIER_NAMES.has(item))) throw new Error('Unsupported keyboard modifier');
    native.keyTap(key, modifiers);
    return { ok: true, action, key, modifiers };
  }

  const deltaX = integer(params.deltaX ?? 0, 'deltaX', -1_000, 1_000);
  const deltaY = integer(params.deltaY ?? 0, 'deltaY', -1_000, 1_000);
  if (deltaX === 0 && deltaY === 0) throw new Error('At least one scroll delta must be non-zero');
  if (params.x !== undefined || params.y !== undefined) {
    const x = integer(params.x, 'x', 0, Math.max(0, size.width - 1));
    const y = integer(params.y, 'y', 0, Math.max(0, size.height - 1));
    native.moveMouse(x, y);
  }
  native.scrollMouse(deltaX, -deltaY);
  return { ok: true, action, deltaX, deltaY };
}
