// 网络搜索工具：web_search（Bing 国内版 HTML 解析，无需 key）+ web_fetch（网页正文提取）
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type SearchResult = { title: string; url: string; snippet: string };

/**
 * 用 Bing 国内版搜索，返回前 maxResults 条结果（标题/链接/摘要）。
 * 无需任何 API key。
 */
export async function webSearch(query: string, maxResults = 5): Promise<SearchResult[]> {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!res.ok) throw new Error(`搜索请求失败: HTTP ${res.status}`);
  const html = await res.text();

  const results: SearchResult[] = [];
  // Bing 结果块: <li class="b_algo">…<h2><a href="…">标题</a></h2>…<p>摘要</p>…</li>
  const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(html)) && results.length < maxResults) {
    const chunk = block[0];
    const link = chunk.match(/<h2[^>]*><a[^>]*href="([^"]+)"/);
    const title = chunk.match(/<h2[^>]*><a[^>]*>([\s\S]*?)<\/a>/);
    const snippet = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (link && title) {
      results.push({
        title: stripTags(title[1]),
        url: link[1],
        snippet: stripTags(snippet?.[1] ?? ""),
      });
    }
  }
  return results;
}

/** 内网地址黑名单（防 SSRF）。 */
function isPrivateUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    if (host.startsWith("192.168.") || host.startsWith("10.")) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (host.startsWith("169.254.")) return true;
    return false;
  } catch {
    return true;
  }
}

/** 抓取网页正文纯文本（剥 script/style/标签），截断到 maxLen 字符。 */
export async function webFetch(rawUrl: string, maxLen = 8000): Promise<string> {
  if (!/^https?:\/\//i.test(rawUrl)) return "错误：仅支持 http/https 链接";
  if (isPrivateUrl(rawUrl)) return "错误：不允许访问内网地址";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(rawUrl, {
      headers: { "User-Agent": UA },
      redirect: "follow",
      signal: controller.signal,
    });
    const ct = res.headers.get("content-type") ?? "";
    if (!res.ok) return `抓取失败: HTTP ${res.status}`;
    if (!ct.includes("text/html") && !ct.includes("text/plain")) {
      return `(非文本内容，无法提取：${ct.split(";")[0]})`;
    }
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!text) return "(页面无文本内容，可能是纯 JS 渲染的页面)";
    return text.length > maxLen ? `${text.slice(0, maxLen)}\n…(内容过长已截断)` : text;
  } catch (err) {
    return `抓取失败: ${String(err)}`;
  } finally {
    clearTimeout(timer);
  }
}
