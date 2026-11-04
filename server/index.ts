import 'dotenv/config';
import { Store } from './store.js';
import { Worker } from './worker.js';
import { createApp } from './app.js';
import { appClock } from './clock.js';

const store = new Store();
try { await store.init(); }
catch (error) {
  console.error('数据库初始化失败：', error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[连接信息已隐藏]') : '未知错误');
  await store.close(); process.exit(1);
}
const worker = new Worker(store);
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3001);
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.APP_AUTH_TOKEN) {
  console.error('开放局域网访问前请先设置 APP_AUTH_TOKEN'); await store.close(); process.exit(1);
}
const app = createApp(store, worker);
void appClock.start();
const server = app.listen(port, host, () => {
  console.log(`CloudMedia http://${host}:${port} · ${store.mode === 'postgres' ? 'PostgreSQL' : '本地文件模式'}`);
  worker.startScheduler();
});
server.on('error', async () => { console.error('监听端口失败，请检查 HOST/PORT'); appClock.stop(); await worker.stop(); await store.close(); process.exit(1); });
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  appClock.stop();
  server.close();
  try { await worker.stop(); } catch { console.error('服务退出前保存未完成，请检查数据库连接'); }
  try { await store.close(); } finally { process.exit(store.healthy ? 0 : 1); }
}
store.onFatal = () => { void shutdown(); };
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
