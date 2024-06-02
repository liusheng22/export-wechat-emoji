// sleep(1000)
export function sleep(ms: number = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
