import { z } from 'zod';
import { validDate } from './dates.js';
const collectionDate = z.string().refine(validDate, '日期必须为有效的 YYYY-MM-DD');
const httpUrl = z.string().max(4096).refine(value => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, '请输入有效的 HTTP/HTTPS 地址（不能包含用户名或密码）');
export const sourceSchema = z.object({
  name: z.string().trim().min(1).max(100), baseUrl: httpUrl,
  adapter: z.literal('html').default('html'), enabled: z.boolean(),
  collectionMode: z.enum(['all', 'updates', 'today', 'range']).default('all').transform(value => value === 'updates' ? 'today' : value),
  startDate: collectionDate.optional(), endDate: collectionDate.optional(),
  updatesSortedDescending: z.boolean().default(false),
  listPath: z.string().max(2048), detailLinkSelector: z.string().max(1000), titleSelector: z.string().max(1000),
  posterSelector: z.string().max(1000), descriptionSelector: z.string().max(1000), resourceSelector: z.string().max(1000), nextPageSelector: z.string().max(1000),
  requestIntervalMs: z.number().int().min(0).max(60000),
  concurrency: z.number().int().min(1).max(20).default(1),
  // Load older saved configurations while ignoring controls that no longer exist.
  maxPages: z.unknown().transform(() => 0), maxItems: z.unknown().transform(() => 0), maxResourcePages: z.unknown().transform(() => 0),
  respectRobots: z.unknown().transform(() => false), referer: z.unknown().transform(() => ''),
}).superRefine((value, context) => {
  if (value.collectionMode === 'range') {
    if (!value.startDate || !value.endDate) context.addIssue({ code: 'custom', message: '请选择完整的起止日期', path: ['startDate'] });
    else if (value.startDate > value.endDate) context.addIssue({ code: 'custom', message: '开始日期不能晚于结束日期', path: ['endDate'] });
  }
}).transform(value => value.collectionMode === 'range' ? value : { ...value, startDate: undefined, endDate: undefined });
export const collectionRequestSchema = z.object({
  mode: z.enum(['today', 'all', 'range']).optional(),
  startDate: collectionDate.optional(), endDate: collectionDate.optional(),
}).strict().refine(value => !value.startDate || !value.endDate || value.startDate <= value.endDate, { message: '开始日期不能晚于结束日期', path: ['endDate'] })
  .refine(value => !['today', 'all'].includes(value.mode || '') || (!value.startDate && !value.endDate), { message: '仅区间采集接受起止日期', path: ['mode'] });
export const settingsSchema = z.object({
  dailyTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, '时区无效'),
  schedulerEnabled: z.boolean(), probeEnabled: z.boolean(), sampleSegments: z.number().int().min(1).max(10),
  sampleBytes: z.number().int().min(16384).max(4194304), probeTimeoutMs: z.number().int().min(1000).max(60000),
  preferredQuality: z.enum(['highest', 'lowest']), maxRetries: z.number().int().min(0).max(4),
  resourceRefreshHours: z.number().int().min(1).max(720),
  userAgent: z.string().trim().min(3).max(300).refine(value => !/[\r\n]/.test(value)),
});
