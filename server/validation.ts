import { z } from 'zod';
const httpUrl = z.string().max(4096).refine(value => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, '请输入有效的 HTTP/HTTPS 地址（不能包含用户名或密码）');
export const sourceSchema = z.object({
  name: z.string().trim().min(1).max(100), baseUrl: httpUrl,
  adapter: z.enum(['maccms', 'html', 'json']), enabled: z.boolean(),
  collectionMode: z.enum(['all', 'updates']).default('all'),
  updatesSortedDescending: z.boolean().default(false),
  listPath: z.string().max(2048), detailLinkSelector: z.string().max(1000), titleSelector: z.string().max(1000),
  posterSelector: z.string().max(1000), descriptionSelector: z.string().max(1000), resourceSelector: z.string().max(1000), nextPageSelector: z.string().max(1000),
  jsonItemsPath: z.string().max(200), jsonTitleField: z.string().max(200), jsonUrlField: z.string().max(200),
  requestIntervalMs: z.number().int().min(1000).max(60000), maxPages: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), maxItems: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  maxResourcePages: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  respectRobots: z.boolean(), referer: z.union([z.literal(''), httpUrl]),
}).refine(value => value.collectionMode !== 'updates' || value.adapter === 'html', { message: '按更新日期采集需要 HTML 页面适配器', path: ['collectionMode'] });
const collectionDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD').refine(value => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, '日期无效');
export const collectionRequestSchema = z.object({
  startDate: collectionDate.optional(), endDate: collectionDate.optional(),
}).strict().refine(value => !value.startDate || !value.endDate || value.startDate <= value.endDate, { message: '开始日期不能晚于结束日期', path: ['endDate'] });
export const settingsSchema = z.object({
  dailyTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, '时区无效'),
  schedulerEnabled: z.boolean(), probeEnabled: z.boolean(), sampleSegments: z.number().int().min(1).max(10),
  sampleBytes: z.number().int().min(16384).max(4194304), probeTimeoutMs: z.number().int().min(1000).max(60000),
  preferredQuality: z.enum(['highest', 'lowest']), maxRetries: z.number().int().min(0).max(4),
  resourceRefreshHours: z.number().int().min(1).max(720),
  userAgent: z.string().trim().min(3).max(300).refine(value => !/[\r\n]/.test(value)),
});
