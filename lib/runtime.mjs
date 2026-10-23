import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export function supportedNode(version = process.versions.node) {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!parts) return false;
  const [, major, minor, patch] = parts.map(Number);
  const minimum = major === 24 ? [22, 1] : major === 26 ? [12, 1] : null;
  return Boolean(minimum && (minor > minimum[0] || minor === minimum[0] && patch >= minimum[1]));
}

export function assertSupportedNode() {
  if (!supportedNode()) throw new Error(`当前 Node.js ${process.version} 缺少项目要求的安全补丁。请使用 Node.js 24.22.1+（24.x）或 26.12.1+（26.x），Windows 可通过“启动平台.cmd”使用项目内运行时。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { assertSupportedNode(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
