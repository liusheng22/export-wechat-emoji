// url 参数 => object
export function parseUrlParams(url: string): Record<string, string> {
  const params: Record<string, string> = {}
  const urlParams = new URLSearchParams(url)
  for (const [key, value] of urlParams.entries()) {
    params[key] = value
  }
  return params
}

// 获取 url 中某个 key 的 value
export function getUrlParam(url: string, key: string): string | null {
  const params = new URL(url).searchParams
  return params.get(key)
}
