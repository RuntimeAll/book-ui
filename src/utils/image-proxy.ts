// Q' 卡 hotfix-4 — OSS 图代理 url 改写工具
//
// 背景：ai-book OSS bucket 配 x-oss-force-download:true / Content-Disposition:attachment，
// chrome 在 CORS 严格模式（<img crossorigin="anonymous">）下视为非法 image resource 拒绝渲染。
//
// 方案：FE 把 OSS URL 改写为 BE proxy URL（/api/teacher/image-proxy?url=...），
// BE 拉 OSS 流剥掉 Content-Disposition header 同源返。同源 → 无 CORS 边界问题。
//
// 详见 BE ImageProxyController.java + PRD §10.2 坑 #12

const OSS_HOST_PATTERN = /^https?:\/\/ai-book\.oss-cn-hangzhou\.aliyuncs\.com\//

/**
 * 把 OSS URL 改写为 BE proxy URL。
 * - 空值 / null 直接返空串（FE template v-if 自然不渲染）
 * - 已是 proxy 路径不二次包（防嵌套）
 * - 非 ai-book OSS 域名原样返（不强制走 proxy，未来其他 CDN 不阻塞）
 *
 * @example
 * proxyImage('https://ai-book.oss-cn-hangzhou.aliyuncs.com/question/x.png')
 *   → '/api/teacher/image-proxy?url=https%3A%2F%2Fai-book...'
 */
export function proxyImage(ossUrl: string | null | undefined): string {
  if (!ossUrl) return ''
  if (ossUrl.startsWith('/api/') || ossUrl.includes('/teacher/image-proxy')) return ossUrl
  if (!OSS_HOST_PATTERN.test(ossUrl)) return ossUrl
  return `/api/teacher/image-proxy?url=${encodeURIComponent(ossUrl)}`
}
